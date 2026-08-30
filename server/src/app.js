import "dotenv/config";
import crypto from "node:crypto";
import { fork } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PassThrough, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import express from "express";
import cors from "cors";
import multer from "multer";
import ExcelJS from "exceljs";
import iconv from "iconv-lite";
import sharp from "sharp";
import yauzl from "yauzl";
import {
  createThumbnail,
  thumbnailStoragePath,
  uploadFilePath,
} from "./image-assets.js";
import {
  db,
  imageSelectColumns,
  scoreFilterKeys,
  scoreNumericFields,
  skippableScoreFields,
  projectSelectColumns,
  subjectSelectColumns,
  userSelectColumns,
} from "./sqlite.js";
import { createAdminDashboardService } from "./services/admin-dashboard.js";
import { createAdminScoringService } from "./services/admin-scoring.js";

const app = express();
const taskImageSelectColumns =
  "id AS _id, subjectId, filename, originalPath, storagePath, thumbnailPath, category, directory, isInfographic, prompt";
const taskListImageSelectColumns =
  "id AS _id, filename, storagePath, thumbnailPath";
const uploadDir = path.resolve(process.env.UPLOAD_DIR || "uploads");
const zipUploadDir = path.join(uploadDir, "_zips");
const chunkUploadDir = path.join(uploadDir, "_chunks");
const resumableUploadDir = path.join(uploadDir, "_resumable");
const feedbackUploadDir = path.join(uploadDir, "feedback");
const imageExts = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"]);
const feedbackImageExts = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const tusVersion = "1.0.0";
const resumableUploadExpiryMs = 24 * 60 * 60 * 1000;
const resumableUploadMaxChunkBytes = 16 * 1024 * 1024;
const taskTemplateRoles = new Set([
  "target",
  "filler",
  "anchor_low",
  "anchor_high",
  "boundary",
]);

await fs.mkdir(uploadDir, { recursive: true });
await fs.mkdir(zipUploadDir, { recursive: true });
await fs.mkdir(chunkUploadDir, { recursive: true });
await fs.mkdir(resumableUploadDir, { recursive: true });
await fs.mkdir(feedbackUploadDir, { recursive: true });

const corsOrigin = process.env.CORS_ORIGIN?.trim();
app.use(
  cors({
    origin: corsOrigin || false,
    credentials: true,
    exposedHeaders: [
      "Location",
      "Upload-Length",
      "Upload-Metadata",
      "Upload-Offset",
      "Upload-Expires",
      "Tus-Resumable",
      "Tus-Version",
      "Tus-Extension",
      "Tus-Max-Size",
    ],
  }),
);
app.use(express.json({ limit: "2mb" }));

function positiveLimit(name, fallback) {
  const configured = Number(process.env[name]);
  return Number.isFinite(configured) && configured > 0 ? configured : fallback;
}

const maxZipBytes = positiveLimit("MAX_ZIP_BYTES", 1024 * 1024 * 1024 * 100)
const maxArchiveEntries = positiveLimit("MAX_ARCHIVE_ENTRIES", 50000);
const maxArchiveUncompressedBytes = positiveLimit(
  "MAX_ARCHIVE_UNCOMPRESSED_BYTES",
  20 * 1024 * 1024 * 1024,
);
const maxImageUncompressedBytes = positiveLimit(
  "MAX_IMAGE_UNCOMPRESSED_BYTES",
  128 * 1024 * 1024,
);
const maxChunkCount = positiveLimit("MAX_CHUNK_COUNT", 10000);
const imageImportConcurrency = Math.min(
  16,
  Math.max(1, Math.floor(positiveLimit("IMAGE_IMPORT_CONCURRENCY", 4))),
);

const upload = multer({
  dest: zipUploadDir,
  limits: { fileSize: maxZipBytes },
});

const chunkUpload = multer({
  storage: multer.diskStorage({
    destination(req, _file, callback) {
      let destination;
      try {
        destination = chunkDir(req.params.uploadId);
      } catch (error) {
        callback(error);
        return;
      }
      fs.mkdir(destination, { recursive: true })
        .then(() => callback(null, destination))
        .catch(callback);
    },
    filename(req, _file, callback) {
      const index = Number(req.params.index);
      if (!Number.isInteger(index) || index < 0 || index >= maxChunkCount) {
        callback(httpError(400, "分片序号不正确"));
        return;
      }
      callback(null, `${String(index).padStart(6, "0")}.part`);
    },
  }),
  // 保留足够的 multipart 边界余量，前端单片为 12MB。
  limits: { fileSize: 16 * 1024 * 1024 },
});

const feedbackUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: 5,
    fileSize: 10 * 1024 * 1024,
  },
  fileFilter(_req, file, callback) {
    const ext = path.extname(file.originalname || "").toLowerCase();
    if (
      !feedbackImageExts.has(ext) ||
      !String(file.mimetype || "").startsWith("image/")
    ) {
      callback(httpError(400, "反馈图片仅支持 JPG、PNG、WebP 格式"));
      return;
    }
    callback(null, true);
  },
});

const taskAllocationUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: 1,
    fileSize: 5 * 1024 * 1024,
  },
  fileFilter(_req, file, callback) {
    const ext = path.extname(file.originalname || "").toLowerCase();
    if (ext !== ".xlsx") {
      callback(httpError(400, "分配表仅支持 XLSX 文件"));
      return;
    }
    callback(null, true);
  },
});

const importJobs = new Map();
const taskGenerationJobs = new Map();
const activeTaskGenerationBySubject = new Map();
const sessionSeenWriteAt = new Map();
const subjectTaskReportCache = new Map();
const subjectTaskReportCacheTtlMs = 15 * 1000;
const sessionSeenWriteIntervalMs = 5 * 60 * 1000;
// Keep task generation transactions large enough to amortize SQLite commit
// overhead without holding the write lock for the entire job.
const TASK_WRITE_BATCH_SIZE = 500;
const TASK_ASSIGN_BATCH_SIZE = 500;
const sessionDurationMs = 7 * 24 * 60 * 60 * 1000;

function taskGenerationJobDto(job) {
  const payload = {
    jobId: job.jobId,
    subjectId: job.subjectId,
    projectId: job.subjectId,
    status: job.status,
    stage: job.stage,
    progress: job.progress,
    message: job.message || null,
  };
  if (job.result) payload.result = job.result;
  return payload;
}

function yieldToEventLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}

const insertSubjectStmt = db.prepare(`
  INSERT INTO subjects (id, name, originalFilename, importBatch, storageRoot, sourceZipPath, imageCount, categoryCount, status, createdAt, updatedAt)
  VALUES (@id, @name, @originalFilename, @importBatch, @storageRoot, @sourceZipPath, 0, 0, 'importing', @createdAt, @updatedAt)
`);

const updateSubjectCountsStmt = db.prepare(`
  UPDATE subjects
  SET imageCount = @imageCount,
      categoryCount = @categoryCount,
      status = @status,
      updatedAt = @updatedAt
  WHERE id = @id
`);

const selectSubjectByIdStmt = db.prepare(
  `SELECT ${subjectSelectColumns}
   FROM subjects
   WHERE id = ? AND deletionRequestedAt IS NULL`,
);
const selectSubjectPendingDeletionStmt = db.prepare(
  `SELECT ${subjectSelectColumns}
   FROM subjects
   WHERE id = ? AND deletionRequestedAt IS NOT NULL`,
);
const selectSubjectsStmt = db.prepare(
  `SELECT ${subjectSelectColumns}
   FROM subjects
   WHERE deletionRequestedAt IS NULL
   ORDER BY createdAt DESC`,
);
const selectProjectByIdStmt = db.prepare(`
  SELECT ${projectSelectColumns}
  FROM projects
  JOIN subjects ON subjects.id = projects.packageId
  WHERE projects.id = ?
    AND projects.deletionRequestedAt IS NULL
`);
const selectProjectByNameStmt = db.prepare(`
  SELECT id
  FROM projects
  WHERE deletionRequestedAt IS NULL
    AND TRIM(name) COLLATE NOCASE = ?
  LIMIT 1
`);
const selectProjectsStmt = db.prepare(`
  SELECT ${projectSelectColumns}
  FROM projects
  JOIN subjects ON subjects.id = projects.packageId
  WHERE projects.deletionRequestedAt IS NULL
  ORDER BY projects.createdAt DESC, projects.id ASC
`);
const selectProjectPackagesStmt = db.prepare(`
  SELECT subjects.id AS _id,
         subjects.name,
         subjects.originalFilename,
         subjects.imageCount,
         subjects.categoryCount,
         subjects.status,
         subjects.createdAt,
         subjects.updatedAt,
         COUNT(subject_task_templates.id) AS taskTemplateCount
  FROM project_packages
  JOIN subjects ON subjects.id = project_packages.packageId
  LEFT JOIN subject_task_templates
    ON subject_task_templates.subjectId = subjects.id
  WHERE project_packages.projectId = ?
    AND subjects.deletionRequestedAt IS NULL
  GROUP BY project_packages.projectId,
           project_packages.packageId,
           project_packages.createdAt,
           subjects.id,
           subjects.name,
           subjects.originalFilename,
           subjects.imageCount,
           subjects.categoryCount,
           subjects.status,
           subjects.createdAt,
           subjects.updatedAt
  ORDER BY project_packages.createdAt ASC, subjects.createdAt ASC, subjects.id ASC
`);
const insertProjectStmt = db.prepare(`
  INSERT INTO projects (
    id, name, icon, packageId, taskStatus, createdAt, updatedAt
  ) VALUES (
    @id, @name, @icon, @packageId, 'task_pending', @createdAt, @updatedAt
  )
`);
const insertProjectPackageStmt = db.prepare(`
  INSERT OR IGNORE INTO project_packages (projectId, packageId, createdAt)
  VALUES (@projectId, @packageId, @createdAt)
`);
const deleteProjectPackagesStmt = db.prepare(
  "DELETE FROM project_packages WHERE projectId = ?",
);
const updateProjectStmt = db.prepare(`
  UPDATE projects
  SET name = @name,
      icon = @icon,
      packageId = @packageId,
      updatedAt = @updatedAt
  WHERE id = @id
    AND deletionRequestedAt IS NULL
`);
const updateProjectTaskStatusStmt = db.prepare(`
  UPDATE projects
  SET taskStatus = @taskStatus,
      updatedAt = @updatedAt
  WHERE id = @id
`);
const selectProjectTaskCountStmt = db.prepare(
  "SELECT COUNT(*) AS total FROM rating_tasks WHERE projectId = ?",
);
const deleteUncompletedProjectTasksStmt = db.prepare(
  "DELETE FROM rating_tasks WHERE projectId = ? AND status <> 'completed'",
);
const deleteProjectUserLinksStmt = db.prepare(
  "DELETE FROM user_projects WHERE projectId = ?",
);
const deleteProjectStmt = db.prepare(
  "DELETE FROM projects WHERE id = ? AND deletionRequestedAt IS NULL",
);
const selectPackageProjectCountStmt = db.prepare(
  `SELECT COUNT(*) AS total
   FROM project_packages
   JOIN projects ON projects.id = project_packages.projectId
   WHERE project_packages.packageId = ?
     AND projects.deletionRequestedAt IS NULL`,
);
const selectTeamByIdStmt = db.prepare(
  "SELECT id, name, status, createdAt, updatedAt FROM teams WHERE id = ?",
);
const selectTeamByNameStmt = db.prepare(
  "SELECT id, name, status, createdAt, updatedAt FROM teams WHERE name = ? COLLATE NOCASE",
);
const selectTeamsStmt = db.prepare(`
  SELECT teams.id, teams.name, teams.status, teams.createdAt, teams.updatedAt,
         COUNT(DISTINCT user_teams.userId) AS userCount,
         COUNT(DISTINCT project_teams.projectId) AS projectCount
  FROM teams
  LEFT JOIN user_teams ON user_teams.teamId = teams.id
  LEFT JOIN project_teams ON project_teams.teamId = teams.id
  GROUP BY teams.id
  ORDER BY teams.name COLLATE NOCASE ASC
`);
const insertTeamStmt = db.prepare(`
  INSERT INTO teams (id, name, status, createdAt, updatedAt)
  VALUES (@id, @name, 'enabled', @createdAt, @updatedAt)
`);
const updateTeamStmt = db.prepare(`
  UPDATE teams
  SET name = COALESCE(@name, name),
      status = COALESCE(@status, status),
      updatedAt = @updatedAt
  WHERE id = @id
`);
const deleteTeamStmt = db.prepare("DELETE FROM teams WHERE id = ?");
const selectTeamUsageStmt = db.prepare(`
  SELECT
    (SELECT COUNT(*) FROM user_teams WHERE teamId = ?) AS userCount,
    (SELECT COUNT(*) FROM project_teams WHERE teamId = ?) AS projectCount
`);
const selectUserTeamsStmt = db.prepare(`
  SELECT teams.id, teams.name, teams.status
  FROM user_teams
  JOIN teams ON teams.id = user_teams.teamId
  WHERE user_teams.userId = ?
  ORDER BY teams.name COLLATE NOCASE ASC
`);
const selectDisabledTeamForUserStmt = db.prepare(`
  SELECT teams.id, teams.name
  FROM user_teams
  JOIN teams ON teams.id = user_teams.teamId
  WHERE user_teams.userId = ?
    AND teams.status = 'disabled'
  ORDER BY teams.name COLLATE NOCASE ASC
  LIMIT 1
`);
const deleteUserTeamsStmt = db.prepare("DELETE FROM user_teams WHERE userId = ?");
const insertUserTeamStmt = db.prepare(`
  INSERT OR IGNORE INTO user_teams (userId, teamId, createdAt)
  VALUES (@userId, @teamId, @createdAt)
`);
const selectProjectTeamsStmt = db.prepare(`
  SELECT teams.id, teams.name, teams.status
  FROM project_teams
  JOIN teams ON teams.id = project_teams.teamId
  WHERE project_teams.projectId = ?
  ORDER BY teams.name COLLATE NOCASE ASC
`);
const deleteProjectTeamsStmt = db.prepare("DELETE FROM project_teams WHERE projectId = ?");
const insertProjectTeamStmt = db.prepare(`
  INSERT OR IGNORE INTO project_teams (projectId, teamId, createdAt)
  VALUES (@projectId, @teamId, @createdAt)
`);
const selectImageByIdStmt = db.prepare(
  `SELECT ${imageSelectColumns} FROM images WHERE id = ?`,
);
const selectUserAuthByUsernameStmt = db.prepare(
  "SELECT id, username, password, role, status, lastLoginAt, createdAt, updatedAt FROM users WHERE username = ? AND role = 'admin'",
);
const selectScorerByUsernameStmt = db.prepare(
  "SELECT id, username, password, role, status, lastLoginAt, createdAt, updatedAt FROM users WHERE username = ? AND role = 'scorer'",
);
const selectAllScorerNamesStmt = db.prepare(`
  SELECT username
  FROM users
  WHERE role = 'scorer'
  ORDER BY username COLLATE NOCASE ASC
`);
const selectUserByUsernameStmt = db.prepare(
  `SELECT ${userSelectColumns} FROM users WHERE username = ?`,
);
const selectUserByIdStmt = db.prepare(
  `SELECT ${userSelectColumns} FROM users WHERE id = ?`,
);
const selectScorerUserCountStmt = db.prepare(
  `SELECT COUNT(*) AS total
   FROM users
   WHERE role = 'scorer'`,
);
const insertSessionStmt = db.prepare(`
  INSERT INTO user_sessions (tokenHash, userId, expiresAt, createdAt, lastSeenAt)
  VALUES (@tokenHash, @userId, @expiresAt, @createdAt, @lastSeenAt)
`);
const selectSessionUserStmt = db.prepare(`
  SELECT users.id, users.username, users.role, users.status, users.lastLoginAt, users.createdAt, users.updatedAt
  FROM user_sessions
  JOIN users ON users.id = user_sessions.userId
  WHERE user_sessions.tokenHash = ?
    AND user_sessions.expiresAt > ?
`);
const updateSessionSeenStmt = db.prepare(
  "UPDATE user_sessions SET lastSeenAt = ? WHERE tokenHash = ?",
);
const deleteSessionStmt = db.prepare(
  "DELETE FROM user_sessions WHERE tokenHash = ?",
);
const deleteExpiredSessionsStmt = db.prepare(
  "DELETE FROM user_sessions WHERE expiresAt <= ?",
);
const insertImportJobStmt = db.prepare(`
  INSERT INTO import_jobs (
    uploadId, originalFilename, totalChunks, protocol, uploadLength, uploadOffset,
    metadata, status, stage, progress, message, resultJson, createdAt, updatedAt, expiresAt
  ) VALUES (
    @uploadId, @originalFilename, @totalChunks, @protocol, @uploadLength, @uploadOffset,
    @metadata, @status, @stage, @progress, @message, @resultJson, @createdAt, @updatedAt, @expiresAt
  )
`);
const updateImportJobStmt = db.prepare(`
  UPDATE import_jobs
  SET status = @status,
      stage = @stage,
      progress = @progress,
      message = @message,
      resultJson = @resultJson,
      protocol = @protocol,
      uploadLength = @uploadLength,
      uploadOffset = @uploadOffset,
      metadata = @metadata,
      updatedAt = @updatedAt,
      expiresAt = @expiresAt
  WHERE uploadId = @uploadId
`);
const selectImportJobStmt = db.prepare(
  "SELECT * FROM import_jobs WHERE uploadId = ?",
);
const deleteImportJobStmt = db.prepare(
  "DELETE FROM import_jobs WHERE uploadId = ?",
);
const deleteExpiredImportJobsStmt = db.prepare(
  "DELETE FROM import_jobs WHERE expiresAt <= ?",
);
const insertFeedbackStmt = db.prepare(`
  INSERT INTO feedbacks (
    id, title, type, description, imagePaths, status,
    submitter, submittedAt, reply, repliedBy, repliedAt, updatedAt
  ) VALUES (
    @id, @title, @type, @description, @imagePaths, 'pending',
    @submitter, @submittedAt, NULL, NULL, NULL, @updatedAt
  )
`);
const selectFeedbackByIdStmt = db.prepare(
  "SELECT * FROM feedbacks WHERE id = ?",
);
const selectFeedbackMessagesStmt = db.prepare(`
  SELECT id, feedbackId, author, authorRole, content, createdAt
  FROM feedback_messages
  WHERE feedbackId = ?
  ORDER BY createdAt ASC, id ASC
`);
const selectFeedbackMessageExistsStmt = db.prepare(
  "SELECT 1 FROM feedback_messages WHERE feedbackId = ? LIMIT 1",
);
const insertFeedbackMessageStmt = db.prepare(`
  INSERT INTO feedback_messages (id, feedbackId, author, authorRole, content, createdAt)
  VALUES (@id, @feedbackId, @author, @authorRole, @content, @createdAt)
`);
const updateFeedbackReplyStmt = db.prepare(`
  UPDATE feedbacks
  SET status = @status,
      reply = @reply,
      repliedBy = @repliedBy,
      repliedAt = @repliedAt,
      updatedAt = @updatedAt
  WHERE id = @id
`);
const selectFeedbackImagePathsBySubmitterStmt = db.prepare(
  "SELECT imagePaths FROM feedbacks WHERE submitter = ?",
);
const selectAssignedTaskForImageStmt = db.prepare(`
  SELECT 1
  FROM rating_task_items
  JOIN rating_tasks ON rating_tasks.id = rating_task_items.taskId
  JOIN images ON images.id = rating_task_items.imageId
  WHERE rating_tasks.scorer = ?
    AND rating_tasks.status IN ('assigned', 'completed')
    AND (images.storagePath = ? OR images.thumbnailPath = ?)
  LIMIT 1
`);
const selectScorerUsersPageStmt = db.prepare(`
  SELECT ${userSelectColumns}
  FROM users
  WHERE role = 'scorer'
  ORDER BY createdAt DESC, username COLLATE NOCASE ASC
  LIMIT ? OFFSET ?
`);
const updateUserLoginStmt = db.prepare(`
  UPDATE users
  SET lastLoginAt = @lastLoginAt,
      updatedAt = @updatedAt
  WHERE id = @id
`);
const insertScorerUserStmt = db.prepare(`
  INSERT INTO users (id, username, password, role, status, lastLoginAt, createdAt, updatedAt)
  VALUES (@id, @username, @password, 'scorer', 'enabled', @lastLoginAt, @createdAt, @updatedAt)
`);
const updateScorerUserStmt = db.prepare(`
  UPDATE users
  SET password = COALESCE(@password, password),
      status = COALESCE(@status, status),
      updatedAt = @updatedAt
  WHERE id = @id
    AND role = 'scorer'
`);
const deleteScorerUserStmt = db.prepare(
  "DELETE FROM users WHERE id = ? AND role = 'scorer'",
);
const selectAssignedTaskCountByScorerStmt = db.prepare(
  "SELECT COUNT(*) AS total FROM rating_tasks WHERE scorer = ? AND status = 'assigned'",
);
const taskVersion = "v3";
const taskCriteria = [
  "overall",
  "creativity",
  "mood",
  "composition",
  "color",
  "lighting",
  "realism",
  "detail",
  "promptAlignment",
  "textCorrectness",
  "anatomyNormality",
  "informationClarity",
  "designQuality",
  "typography",
];
const taskExclusionCriteria = new Set([
  "realism",
  "textCorrectness",
  "anatomyNormality",
]);
const taskCorrectnessCriteria = new Set([
  "textCorrectness",
  "anatomyNormality",
]);
const taskCriterionLabels = {
  overall: "整体美感总分",
  creativity: "辨识度与创意感",
  mood: "情绪与意境传达",
  composition: "构图与视觉层级",
  color: "色彩配比",
  lighting: "光照/光影",
  realism: "（肖像/摄像）真实感",
  detail: "细节与逻辑分辨率",
  discomfort: "不舒适",
  promptAlignment: "Prompt alignment",
  textCorrectness: "文字：正确性",
  anatomyNormality: "肢体：正常性",
  informationClarity: "信息传达是否突出/明确",
  designQuality: "整体设计感",
  typography: "文字设计感",
};
const selectTaskRowsPageStmt = db.prepare(`
  SELECT id, subjectId, projectId, taskVersion, taskType, status, scorer, ranking, excludedImageIds, correctImageIds, rankingRelations,
         submissionMode, rankingActionCount, startedAt, completedAt, durationMs, editedAt, editCount,
         rollbackCount, lastRolledBackAt, lastRolledBackBy, imageKey, createdAt, updatedAt
  FROM rating_tasks
  WHERE projectId = ? AND taskVersion = ?
  ORDER BY taskType ASC, createdAt ASC, id ASC
  LIMIT ? OFFSET ?
`);
const selectAssignedTaskRowsPageStmt = db.prepare(`
  SELECT rating_tasks.id, rating_tasks.subjectId, rating_tasks.projectId, rating_tasks.taskVersion,
         rating_tasks.taskType, rating_tasks.status, rating_tasks.scorer, rating_tasks.ranking, rating_tasks.excludedImageIds, rating_tasks.correctImageIds, rating_tasks.rankingRelations,
         rating_tasks.submissionMode, rating_tasks.rankingActionCount,
         rating_tasks.startedAt, rating_tasks.completedAt, rating_tasks.durationMs, rating_tasks.editedAt, rating_tasks.editCount,
         rating_tasks.rollbackCount, rating_tasks.lastRolledBackAt, rating_tasks.lastRolledBackBy,
         rating_tasks.imageKey, rating_tasks.createdAt, rating_tasks.updatedAt,
         projects.name AS subjectName
  FROM rating_tasks
  JOIN projects ON projects.id = rating_tasks.projectId
  WHERE rating_tasks.taskVersion = ?
    AND rating_tasks.scorer = ?
    AND rating_tasks.status = 'assigned'
    AND (? IS NULL OR rating_tasks.projectId = ?)
  ORDER BY rating_tasks.updatedAt DESC, rating_tasks.id ASC
  LIMIT ? OFFSET ?
`);
const selectAssignedTaskCountStmt = db.prepare(`
  SELECT COUNT(*) AS total
  FROM rating_tasks
  WHERE taskVersion = ?
    AND scorer = ?
    AND status = 'assigned'
    AND (? IS NULL OR projectId = ?)
`);
const selectScorerTaskStatsStmt = db.prepare(`
  SELECT
    SUM(CASE WHEN status = 'assigned' THEN 1 ELSE 0 END) AS pendingTasks,
    SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completedTasks
  FROM rating_tasks
  WHERE taskVersion = ?
    AND scorer = ?
    AND (? IS NULL OR projectId = ?)
`);
const selectScorerProjectCountStmt = db.prepare(`
  SELECT COUNT(DISTINCT projectId) AS total
  FROM rating_tasks
  WHERE taskVersion = ?
    AND scorer = ?
    AND status IN ('assigned', 'completed')
`);
const selectTaskByIdStmt = db.prepare(`
  SELECT id, subjectId, projectId, taskVersion, taskType, status, scorer, ranking, excludedImageIds, correctImageIds, rankingRelations,
         submissionMode, rankingActionCount, startedAt, completedAt, durationMs, editedAt, editCount,
         rollbackCount, lastRolledBackAt, lastRolledBackBy, imageKey, createdAt, updatedAt
  FROM rating_tasks
  WHERE id = ?
`);
const selectTaskImageIdsStmt = db.prepare(`
  SELECT imageId
  FROM rating_task_items
  WHERE taskId = ?
  ORDER BY position ASC, imageId ASC
`);
const completeAssignedTaskStmt = db.prepare(`
  UPDATE rating_tasks
  SET status = 'completed',
      ranking = @ranking,
      excludedImageIds = @excludedImageIds,
      correctImageIds = @correctImageIds,
      rankingRelations = @rankingRelations,
      submissionMode = @submissionMode,
      rankingActionCount = @rankingActionCount,
      startedAt = @startedAt,
      completedAt = @completedAt,
      durationMs = @durationMs,
      updatedAt = @updatedAt
  WHERE id = @id
    AND status = 'assigned'
    AND scorer = @scorer
`);
const updateCompletedTaskStmt = db.prepare(`
  UPDATE rating_tasks
  SET ranking = @ranking,
      excludedImageIds = @excludedImageIds,
      correctImageIds = @correctImageIds,
      rankingRelations = @rankingRelations,
      submissionMode = @submissionMode,
      rankingActionCount = @rankingActionCount,
      editedAt = @editedAt,
      editCount = COALESCE(editCount, 0) + 1,
      updatedAt = @updatedAt
  WHERE id = @id
    AND status = 'completed'
    AND scorer = @scorer
`);
const insertRatingTaskStmt = db.prepare(`
  INSERT OR IGNORE INTO rating_tasks (
    id, subjectId, projectId, taskVersion, round, taskType, status, scorer, ranking, assignmentKey, imageKey, createdAt, updatedAt
  ) VALUES (
    @id, @subjectId, @projectId, @taskVersion, @round, @taskType, 'pending', NULL, NULL, @assignmentKey, @imageKey, @createdAt, @updatedAt
  )
`);
const insertRatingTaskItemStmt = db.prepare(`
  INSERT OR IGNORE INTO rating_task_items (taskId, imageId, position, role)
  VALUES (@taskId, @imageId, @position, @role)
`);
const insertSubjectTaskTemplateStmt = db.prepare(`
  INSERT INTO subject_task_templates (
    id, subjectId, sourceTaskId, round, criterion, imageKey, selectionKey, createdAt
  ) VALUES (
    @id, @subjectId, @sourceTaskId, @round, @criterion, @imageKey, @selectionKey, @createdAt
  )
`);
const insertSubjectTaskTemplateItemStmt = db.prepare(`
  INSERT INTO subject_task_template_items (templateId, imageId, position, role)
  VALUES (@templateId, @imageId, @position, @role)
`);
const selectSubjectTaskTemplatesStmt = db.prepare(`
  SELECT id, subjectId, sourceTaskId, round, criterion, imageKey, selectionKey
  FROM subject_task_templates
  WHERE subjectId = ?
  ORDER BY selectionKey ASC, id ASC
`);
const updateSubjectTaskStatusStmt = db.prepare(`
  UPDATE projects
  SET taskStatus = @taskStatus, updatedAt = @updatedAt
  WHERE id = @id
`);
const selectProjectTaskStatsStmt = db.prepare(`
  SELECT total, pending, assigned, completed
  FROM project_task_stats
  WHERE projectId = ? AND taskVersion = ?
`);
const selectPendingProjectTaskIdsStmt = db.prepare(`
  SELECT id
  FROM rating_tasks
  WHERE projectId = ?
    AND taskVersion = ?
    AND status = 'pending'
    AND scorer IS NULL
  ORDER BY assignmentKey ASC, id ASC
  LIMIT ?
`);
const selectSubjectScorerNamesStmt = db.prepare(`
  SELECT DISTINCT scorer
  FROM rating_tasks
  WHERE projectId = ?
    AND scorer IS NOT NULL
    AND TRIM(scorer) <> ''
`);
const selectSubjectAssignedScorerCountsStmt = db.prepare(`
  SELECT scorer, COUNT(*) AS taskCount
  FROM rating_tasks
  WHERE projectId = ?
    AND taskVersion = ?
    AND status = 'assigned'
    AND scorer IS NOT NULL
    AND TRIM(scorer) <> ''
  GROUP BY scorer
  ORDER BY scorer COLLATE NOCASE ASC
`);
const selectAvailableSubjectScorersStmt = db.prepare(`
  SELECT ${userSelectColumns}
  FROM users
  WHERE role = 'scorer'
    AND status = 'enabled'
    AND NOT EXISTS (
      SELECT 1
      FROM rating_tasks
      WHERE rating_tasks.projectId = ?
        AND rating_tasks.scorer = users.username
    )
    AND NOT EXISTS (
      SELECT 1
      FROM user_teams
      JOIN teams ON teams.id = user_teams.teamId
      WHERE user_teams.userId = users.id
        AND teams.status = 'disabled'
    )
  ORDER BY username COLLATE NOCASE ASC
`);
const selectReassignableTaskIdsStmt = db.prepare(`
  SELECT id
  FROM rating_tasks
  WHERE projectId = ?
    AND taskVersion = ?
    AND status = 'pending'
    AND scorer IS NULL
  ORDER BY assignmentKey ASC, id ASC
  LIMIT ?
`);
const selectReassignableTaskIdsByScorerStmt = db.prepare(`
  SELECT id
  FROM rating_tasks
  WHERE projectId = ?
    AND taskVersion = ?
    AND status = 'assigned'
    AND scorer = ?
  ORDER BY assignmentKey ASC, id ASC
  LIMIT ?
`);
const reassignTaskStmt = db.prepare(`
  UPDATE rating_tasks
  SET scorer = @scorer,
      updatedAt = @updatedAt
  WHERE id = @id
    AND projectId = @projectId
    AND taskVersion = @taskVersion
    AND status = 'assigned'
`);
const assignUnassignedTaskStmt = db.prepare(`
  UPDATE rating_tasks
  SET scorer = @scorer,
      status = 'assigned',
      updatedAt = @updatedAt
  WHERE id = @id
    AND projectId = @projectId
    AND taskVersion = @taskVersion
    AND status = 'pending'
    AND scorer IS NULL
`);
const deleteSubjectTasksStmt = db.prepare(
  "DELETE FROM rating_tasks WHERE subjectId = ?",
);
const markSubjectForDeletionStmt = db.prepare(`
  UPDATE subjects
  SET deletionRequestedAt = @deletionRequestedAt,
      updatedAt = @updatedAt
  WHERE id = @id AND deletionRequestedAt IS NULL
`);
const selectSubjectStoragePathsStmt = db.prepare(
  "SELECT storagePath FROM images WHERE subjectId = ?",
);
const deleteQueuedSubjectStmt = db.prepare(
  "DELETE FROM subjects WHERE id = ? AND deletionRequestedAt IS NOT NULL",
);
const insertImageStmt = db.prepare(`
  INSERT OR IGNORE INTO images (
    id, subjectId, filename, originalPath, storagePath, thumbnailPath, mimeType, category, directory, isInfographic, prompt, catalogData, importBatch,
    overall, creativity, mood, composition, color, lighting, realism, detail, discomfort,
    promptAlignment, textCorrectness, anatomyNormality, informationClarity, designQuality, typography,
    comment, ratedAt, createdAt, updatedAt
  ) VALUES (
    @id, @subjectId, @filename, @originalPath, @storagePath, @thumbnailPath, @mimeType, @category, @directory, @isInfographic, @prompt, @catalogData, @importBatch,
    NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
    NULL, NULL, NULL, NULL, NULL, NULL,
    NULL, NULL, @createdAt, @updatedAt
  )
`);
const updateImageScoreStmt = db.prepare(`
  UPDATE images
  SET overall = @overall,
      scorer = @scorer,
      creativity = @creativity,
      mood = @mood,
      composition = @composition,
      color = @color,
      lighting = @lighting,
      realism = @realism,
      detail = @detail,
      discomfort = @discomfort,
      promptAlignment = @promptAlignment,
      promptAlignmentState = @promptAlignmentState,
      textCorrectness = @textCorrectness,
      textCorrectnessState = @textCorrectnessState,
      anatomyNormality = @anatomyNormality,
      anatomyNormalityState = @anatomyNormalityState,
      informationClarity = @informationClarity,
      informationClarityState = @informationClarityState,
      designQuality = @designQuality,
      designQualityState = @designQualityState,
      typography = @typography,
      typographyState = @typographyState,
      comment = @comment,
      ratedAt = @ratedAt,
      updatedAt = @updatedAt
  WHERE id = @id
`);

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function archiveImportError(status, message, cause) {
  const error = httpError(status, message);
  error.isArchiveImportError = true;
  if (cause) error.cause = cause;
  return error;
}

function normalizeArchiveImportError(error) {
  if (error?.isArchiveImportError || error?.status) return error;

  if (error?.code === "ENOSPC") {
    return archiveImportError(
      507,
      "服务器磁盘空间不足，无法保存解压后的图片",
      error,
    );
  }
  if (error?.code === "EACCES" || error?.code === "EPERM") {
    return archiveImportError(500, "服务器上传目录没有读写权限", error);
  }
  if (error?.code === "SQLITE_BUSY") {
    return archiveImportError(503, "数据库正被其他操作占用，请稍后重试", error);
  }

  return archiveImportError(
    500,
    "导入过程中发生未预期错误，已清理本次上传内容，请重试",
    error,
  );
}

function cleanRelative(value) {
  return value
    .replace(/\\/g, "/")
    .split("/")
    .filter((segment) => segment && segment !== "." && segment !== "..")
    .map((item) => item.replace(/[^\p{L}\p{N}._-]/gu, "_"))
    .join("/");
}

function decodeZipEntryPath(entry) {
  const rawPath = entry?.pathBuffer;
  if (!Buffer.isBuffer(rawPath) || !rawPath.length)
    return String(entry?.path ?? "");

  const utf8Path = rawPath.toString("utf8");
  const isUtf8Flagged =
    Boolean(Number(entry?.flags ?? 0) & 0x800) || entry?.isUnicode;
  const isValidUtf8 = Buffer.from(utf8Path, "utf8").equals(rawPath);
  if (isUtf8Flagged || isValidUtf8) return utf8Path;

  // 很多 Windows 压缩工具写入中文文件名时没有设置 UTF-8 标记，而是使用 CP936。
  return iconv.decode(rawPath, "cp936");
}

function normalizeCatalogPath(value) {
  return cleanRelative(String(value ?? "")).toLocaleLowerCase();
}

function normalizeCatalogFilename(value) {
  const normalized = normalizeCatalogPath(value);
  return normalized ? path.posix.basename(normalized) : "";
}

function isInfographicPath(relative) {
  const directories = cleanRelative(String(relative ?? ""))
    .split("/")
    .filter(Boolean);
  directories.pop();
  return directories.some((directory) => directory.trim() === "信息图");
}

function catalogRowForManifest(row) {
  if (!row || typeof row !== "object") return null;
  const { catalog_row: nestedCatalogRow, ...manifestRow } = row;
  if (!nestedCatalogRow || typeof nestedCatalogRow !== "object") return row;

  // ZIP manifest 的顶层保存来源和目标文件名，catalog_row 保存原始目录信息。
  // 合并两者，确保详情、Prompt 和文件路径都能保留下来。
  return { ...manifestRow, ...nestedCatalogRow };
}

function addCatalogRowsToIndex(index, catalog) {
  if (!Array.isArray(catalog?.rows)) return false;

  catalog.rows.forEach((row) => {
    const catalogRow = catalogRowForManifest(row);
    if (!catalogRow) return;
    const pathKeys = [
      row.src_rel_path,
      catalogRow.src_rel_path,
    ];
    pathKeys.forEach((value) => {
      const relativePath = normalizeCatalogPath(value);
      if (!relativePath) return;
      const key = `path:${relativePath}`;
      if (!index.has(key)) {
        index.set(key, catalogRow);
        return;
      }
      if (JSON.stringify(index.get(key)) !== JSON.stringify(catalogRow)) {
        index.set(key, null);
      }
    });

    const filenameKeys = [
      row.dest_rel_path,
      row.image_filename,
      catalogRow.dest_rel_path,
      catalogRow.image_filename,
      row.src_rel_path,
      catalogRow.src_rel_path,
    ];
    filenameKeys.forEach((value) => {
      const filename = normalizeCatalogFilename(value);
      if (!filename) return;
      const key = `filename:${filename}`;
      if (!index.has(key)) {
        index.set(key, catalogRow);
        return;
      }
      // A duplicate filename is ambiguous across folders. Do not attach another
      // image's prompt or manifest details to the wrong image.
      if (JSON.stringify(index.get(key)) !== JSON.stringify(catalogRow)) {
        index.set(key, null);
      }
    });
  });

  return true;
}

async function loadArchiveManifests(zip) {
  const manifestEntry = zip.files.find((entry) => {
    if (entry.type === "Directory") return false;
    return normalizeCatalogPath(decodeZipEntryPath(entry)) === "manifest.json";
  });
  if (!manifestEntry) return [];
  const maxManifestBytes = 64 * 1024 * 1024;
  if (archiveEntryUncompressedSize(manifestEntry) > maxManifestBytes) {
    throw archiveImportError(413, "manifest.json 超过允许大小");
  }

  try {
    const manifestBuffer = await manifestEntry.buffer();
    if (manifestBuffer.length > maxManifestBytes) {
      throw archiveImportError(413, "manifest.json 超过允许大小");
    }
    const manifest = JSON.parse(manifestBuffer.toString("utf8"));
    if (!Array.isArray(manifest?.rows)) {
      throw new Error("manifest.json 缺少 rows 数据");
    }
    return [manifest];
  } catch (error) {
    if (error?.isArchiveImportError) throw error;
    throw archiveImportError(422, "压缩包根目录的 manifest.json 无效", error);
  }
}

async function loadArchiveTaskManifest(zip) {
  const taskEntry = zip.files.find((entry) => {
    if (entry.type === "Directory") return false;
    const name = normalizeCatalogPath(decodeZipEntryPath(entry));
    return name === "tasks.json" || name === "task.json";
  });
  if (!taskEntry) return null;

  const maxTaskManifestBytes = 64 * 1024 * 1024;
  if (archiveEntryUncompressedSize(taskEntry) > maxTaskManifestBytes) {
    throw archiveImportError(413, "tasks.json exceeds the allowed size");
  }

  try {
    const taskBuffer = await taskEntry.buffer();
    if (taskBuffer.length > maxTaskManifestBytes) {
      throw archiveImportError(413, "tasks.json exceeds the allowed size");
    }
    const taskManifest = JSON.parse(taskBuffer.toString("utf8"));
    if (!Array.isArray(taskManifest?.tasks)) {
      throw new Error("tasks must be an array");
    }
    return taskManifest;
  } catch (error) {
    if (error?.isArchiveImportError) throw error;
    throw archiveImportError(422, "Invalid root tasks.json", error);
  }
}

async function loadImageCatalogIndex(archiveManifests = []) {
  const index = new Map();
  for (const manifest of archiveManifests) {
    addCatalogRowsToIndex(index, manifest);
  }

  return index;
}

function catalogEntryForImage(catalogIndex, rawRelative, relative) {
  const relativePaths = [rawRelative, relative]
    .map(normalizeCatalogPath)
    .filter(Boolean);
  for (const relativePath of relativePaths) {
    const key = `path:${relativePath}`;
    if (catalogIndex.has(key)) return catalogIndex.get(key);
  }

  const filenames = [rawRelative, relative]
    .map(normalizeCatalogFilename)
    .filter(Boolean);
  for (const filename of filenames) {
    const key = `filename:${filename}`;
    if (catalogIndex.has(key)) return catalogIndex.get(key);
  }
  return null;
}

function addTaskReference(index, key, image) {
  if (!key) return;
  if (!index.has(key)) {
    index.set(key, image);
    return;
  }
  if (index.get(key)?.id !== image.id) index.set(key, null);
}

function buildTaskImageReferenceIndex(imageRecords) {
  const pathIndex = new Map();
  const filenameIndex = new Map();
  imageRecords.forEach((image) => {
    addTaskReference(
      pathIndex,
      normalizeCatalogPath(image.originalPath),
      image,
    );
    addTaskReference(
      filenameIndex,
      normalizeCatalogFilename(image.filename),
      image,
    );
  });
  return { pathIndex, filenameIndex };
}

function taskImageReference(value) {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    return (
      value.src_rel_path ??
      value.originalPath ??
      value.path ??
      value.filename ??
      value.image
    );
  }
  return "";
}

function resolveTaskImage(imageReferenceIndex, reference) {
  const normalizedPath = normalizeCatalogPath(reference);
  if (imageReferenceIndex.pathIndex.has(normalizedPath)) {
    return imageReferenceIndex.pathIndex.get(normalizedPath);
  }

  const normalizedFilename = normalizeCatalogFilename(reference);
  return imageReferenceIndex.filenameIndex.get(normalizedFilename);
}

function taskItemRole(value) {
  const role = String(value?.role ?? "target");
  if (!taskTemplateRoles.has(role)) {
    throw archiveImportError(422, `Unsupported task item role: ${role}`);
  }
  return role;
}

function buildTaskTemplateRecords(subjectId, taskManifest, imageRecords, createdAt) {
  if (!taskManifest) return [];
  if (!taskManifest.tasks.length) {
    throw archiveImportError(422, "tasks.json does not contain any tasks");
  }

  const imageReferenceIndex = buildTaskImageReferenceIndex(imageRecords);
  const sourceTaskIds = new Set();
  const taskKeys = new Set();
  const failedTasks = [];

  const taskTemplates = taskManifest.tasks.map((rawTask, index) => {
    try {
    if (!rawTask || typeof rawTask !== "object" || Array.isArray(rawTask)) {
      throw archiveImportError(422, `tasks[${index}] must be an object`);
    }

    const sourceTaskId = String(rawTask.id ?? `task-${index + 1}`).trim();
    if (!sourceTaskId || sourceTaskId.length > 160 || sourceTaskIds.has(sourceTaskId)) {
      throw archiveImportError(422, `tasks[${index}] has an invalid or duplicate id`);
    }
    sourceTaskIds.add(sourceTaskId);

    const criterion = String(rawTask.criterion ?? "").trim();
    if (!taskCriteria.includes(criterion)) {
      throw archiveImportError(422, `tasks[${index}].criterion is not supported`);
    }

    if (!Array.isArray(rawTask.images) || rawTask.images.length < 1 || rawTask.images.length > 5) {
      throw archiveImportError(422, `tasks[${index}].images must contain 1 to 5 images`);
    }

    const usedImageIds = new Set();
    const items = rawTask.images.map((rawItem, itemIndex) => {
      const reference = String(taskImageReference(rawItem) ?? "").trim();
      const image = resolveTaskImage(imageReferenceIndex, reference);
      if (!image) {
        const label = reference || `images[${itemIndex}]`;
        throw archiveImportError(
          422,
          `tasks[${index}] references an unknown or ambiguous image: ${label}`,
        );
      }
      if (usedImageIds.has(image.id)) {
        throw archiveImportError(422, `tasks[${index}] contains the same image more than once`);
      }
      usedImageIds.add(image.id);
      return {
        imageId: image.id,
        position: itemIndex,
        role: taskItemRole(rawItem),
      };
    });

    const imageKey = items.map((item) => item.imageId).sort().join("|");
    const taskKey = `${criterion}|${imageKey}`;
    if (taskKeys.has(taskKey)) {
      throw archiveImportError(422, `tasks[${index}] duplicates another task group`);
    }
    taskKeys.add(taskKey);

      return {
      id: crypto.randomUUID(),
      subjectId,
      sourceTaskId,
      round: 1,
      criterion,
      imageKey,
      selectionKey: crypto.randomInt(1, 2147483647),
      createdAt,
      items,
      };
    } catch (error) {
      const sourceTaskId = rawTask?.id ?? `task-${index + 1}`;
      const message = error?.message || String(error);
      failedTasks.push({
        index,
        id: String(sourceTaskId),
        message,
      });
      console.warn(`Skipping invalid task ${index} (${sourceTaskId}): ${message}`);
      return null;
    }
  }).filter(Boolean);

  return { taskTemplates, failedTasks };
}

function catalogPrompt(entry) {
  const prompt = entry?.actual_input_prompt ?? entry?.prompt;
  const text = typeof prompt === "string" ? prompt.trim() : "";
  return text || null;
}

function parseCatalogData(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function cleanFolderName(value, fallback = "upload") {
  const cleaned = String(value)
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean)
    .join("_")
    .replace(/\s+/g, "_")
    .replace(/[^\p{L}\p{N}._-]/gu, "_")
    .replace(/^[._-]+|[._-]+$/g, "");
  return cleaned || fallback;
}

function detectArchiveRoot(entries) {
  const roots = new Set();
  let hasNestedImage = false;

  for (const entry of entries) {
    const relative = cleanRelative(
      decodeZipEntryPath(entry) || entry.entryName,
    );
    if (!relative) continue;
    const parts = relative.split("/");
    roots.add(parts[0]);
    if (parts.length > 1) hasNestedImage = true;
  }

  return roots.size === 1 && hasNestedImage ? [...roots][0] : null;
}

function stripArchiveRoot(relative, root) {
  if (!root) return relative;
  const parts = relative.split("/");
  return parts[0] === root ? parts.slice(1).join("/") : relative;
}

function archiveEntryUncompressedSize(entry) {
  const size = Number(
    entry?.uncompressedSize ??
      entry?.vars?.uncompressedSize ??
      entry?.size ??
      0,
  );
  return Number.isFinite(size) && size > 0 ? size : 0;
}

async function assertArchiveLimits(zip, zipPath) {
  const zipStat = await fs.stat(zipPath);
  if (zipStat.size > maxZipBytes) {
    throw archiveImportError(413, "ZIP 文件超过服务器允许的大小限制");
  }
  if (zip.files.length > maxArchiveEntries) {
    throw archiveImportError(413, "ZIP 文件条目数量超过允许上限");
  }
  const totalUncompressed = zip.files.reduce(
    (total, entry) => total + archiveEntryUncompressedSize(entry),
    0,
  );
  if (totalUncompressed > maxArchiveUncompressedBytes) {
    throw archiveImportError(413, "ZIP 解压后的总大小超过允许上限");
  }
}

function decompressionLimit(maxBytes, relative) {
  let total = 0;
  return new Transform({
    transform(chunk, _encoding, callback) {
      total += chunk.length;
      if (total > maxBytes) {
        callback(
          archiveImportError(413, `图片“${relative}”解压后超过允许大小`),
        );
        return;
      }
      callback(null, chunk);
    },
  });
}

function openZip64Archive(zipPath) {
  return new Promise((resolve, reject) => {
    yauzl.open(
      zipPath,
      { lazyEntries: true, decodeStrings: false, autoClose: false },
      (error, archive) => {
      if (error) {
        reject(error);
        return;
      }
      const entries = [];
      archive.on("entry", (rawEntry) => {
        const pathBuffer = Buffer.isBuffer(rawEntry.fileName)
          ? rawEntry.fileName
          : Buffer.from(rawEntry.fileName);
        const entry = {
          type: pathBuffer[pathBuffer.length - 1] === 47 ? "Directory" : "File",
          path: pathBuffer.toString("utf8"),
          pathBuffer,
          uncompressedSize: rawEntry.uncompressedSize,
          vars: { uncompressedSize: rawEntry.uncompressedSize },
          stream() {
            const output = new PassThrough();
            archive.openReadStream(rawEntry, (streamError, stream) => {
              if (streamError) {
                output.destroy(streamError);
                return;
              }
              stream.on("error", (readError) => output.destroy(readError));
              stream.pipe(output);
            });
            return output;
          },
          async buffer() {
            const chunks = [];
            for await (const chunk of entry.stream()) chunks.push(chunk);
            return Buffer.concat(chunks);
          },
        };
        entries.push(entry);
        archive.readEntry();
      });
      archive.once("end", () => resolve({ files: entries, close: () => archive.close() }));
      archive.once("error", reject);
      archive.readEntry();
      },
    );
  });
}

function isMacMetadataEntry(relative) {
  if (!relative) return true;
  if (relative === ".DS_Store" || relative.endsWith("/.DS_Store")) return true;
  return relative
    .split("/")
    .some((segment) => segment === "__MACOSX" || segment.startsWith("._"));
}

async function allocateSubjectStorageRoot(subjectName, subjectId) {
  const baseName = cleanFolderName(
    subjectName,
    `subject-${subjectId.slice(0, 8)}`,
  );
  let candidate = baseName;
  let attempt = 0;

  while (true) {
    try {
      await fs.access(path.join(uploadDir, candidate));
      attempt += 1;
      candidate = `${baseName}-${subjectId.slice(0, 8)}${attempt > 1 ? `-${attempt}` : ""}`;
    } catch {
      return candidate;
    }
  }
}

function validateUploadId(uploadId) {
  if (!/^[a-z0-9-]{8,128}$/i.test(uploadId)) {
    throw httpError(400, "上传标识不正确");
  }
}

function chunkDir(uploadId) {
  validateUploadId(uploadId);
  return path.join(chunkUploadDir, uploadId);
}

function chunkFilePath(uploadId, index) {
  return path.join(
    chunkDir(uploadId),
    `${String(index).padStart(6, "0")}.part`,
  );
}

function resumableSessionDir(uploadId) {
  validateUploadId(uploadId);
  return path.join(resumableUploadDir, uploadId);
}

function resumableSessionMetaPath(uploadId) {
  return path.join(resumableSessionDir(uploadId), "upload.json");
}

function resumableSessionFilePath(uploadId) {
  return path.join(resumableSessionDir(uploadId), "upload.zip");
}

function resumableUploadExpiresAt() {
  return new Date(Date.now() + resumableUploadExpiryMs).toISOString();
}

function tusMetadataHeaderValue(value) {
  return Buffer.from(String(value || ""), "utf8").toString("base64");
}

function parseTusMetadataHeader(header) {
  const metadata = {};
  const raw = String(header || "").trim();
  if (!raw) return metadata;

  for (const pair of raw.split(",")) {
    const entry = pair.trim();
    if (!entry) continue;
    const separator = entry.indexOf(" ");
    const key = (separator >= 0 ? entry.slice(0, separator) : entry).trim();
    if (!key) continue;
    const encodedValue = separator >= 0 ? entry.slice(separator + 1).trim() : "";
    if (!encodedValue) {
      metadata[key.toLowerCase()] = "";
      continue;
    }
    try {
      metadata[key.toLowerCase()] = Buffer.from(encodedValue, "base64").toString(
        "utf8",
      );
    } catch {
      throw httpError(400, "上传元数据格式不正确");
    }
  }

  return metadata;
}

function requireTusResumableHeader(req) {
  const version = String(req.headers["tus-resumable"] || "");
  if (!version) throw httpError(412, "缺少 Tus-Resumable 请求头");
  if (version !== tusVersion) throw httpError(412, "Tus 版本不受支持");
}

function resumableUploadResponseHeaders(session, offset) {
  return {
    "Cache-Control": "no-store",
    "Location": `/api/import/uploads/${session.uploadId}`,
    "Tus-Resumable": tusVersion,
    "Tus-Version": tusVersion,
    "Tus-Extension": "creation,termination",
    "Tus-Max-Size": String(maxZipBytes),
    "Upload-Expires": session.expiresAt,
    "Upload-Length": String(session.uploadLength),
    "Upload-Metadata": `filename ${tusMetadataHeaderValue(session.originalFilename)}`,
    "Upload-Offset": String(offset),
  };
}

function resumableUploadDto(session, offset) {
  return {
    uploadId: session.uploadId,
    uploadUrl: `/api/import/uploads/${session.uploadId}`,
    originalFilename: session.originalFilename,
    uploadLength: session.uploadLength,
    offset,
    status: session.status,
    expiresAt: session.expiresAt,
  };
}

function writeJsonFileAtomic(filePath, value) {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  return fs
    .writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8")
    .then(() => fs.rename(tempPath, filePath))
    .catch(async (error) => {
      await fs.unlink(tempPath).catch(() => {});
      throw error;
    });
}

async function loadResumableUploadSession(uploadId) {
  validateUploadId(uploadId);
  const dir = resumableSessionDir(uploadId);
  const metaPath = resumableSessionMetaPath(uploadId);
  const filePath = resumableSessionFilePath(uploadId);

  try {
    const raw = await fs.readFile(metaPath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.uploadId !== uploadId) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      return null;
    }

    const expiresAt = Date.parse(parsed.expiresAt || "");
    if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      return null;
    }

    const uploadLength = Number(parsed.uploadLength);
    if (!Number.isFinite(uploadLength) || uploadLength <= 0) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      return null;
    }

    const stat = await fs.stat(filePath);
    if (!stat.isFile()) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      return null;
    }
    if (stat.size > uploadLength) {
      throw httpError(409, "上传会话已损坏，请重新上传");
    }

    return {
      uploadId,
      originalFilename: String(parsed.originalFilename || ""),
      uploadLength,
      status: String(parsed.status || "uploading"),
      createdAt: String(parsed.createdAt || ""),
      updatedAt: String(parsed.updatedAt || ""),
      expiresAt: String(parsed.expiresAt || resumableUploadExpiresAt()),
      dir,
      metaPath,
      filePath,
      offset: stat.size,
    };
  } catch (error) {
    if (error?.status) throw error;
    if (error?.code === "ENOENT") {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      return null;
    }
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    return null;
  }
}

async function saveResumableUploadSession(session) {
  await fs.mkdir(resumableSessionDir(session.uploadId), { recursive: true });
  await writeJsonFileAtomic(resumableSessionMetaPath(session.uploadId), {
    uploadId: session.uploadId,
    originalFilename: session.originalFilename,
    uploadLength: session.uploadLength,
    status: session.status,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    expiresAt: session.expiresAt,
  });
}

async function createResumableUploadSession(originalFilename, uploadLength) {
  const uploadId = crypto.randomUUID();
  const createdAt = nowIso();
  const session = {
    uploadId,
    originalFilename,
    uploadLength,
    status: "uploading",
    createdAt,
    updatedAt: createdAt,
    expiresAt: resumableUploadExpiresAt(),
  };

  await fs.mkdir(resumableSessionDir(uploadId), { recursive: true });
  await fs.writeFile(resumableSessionFilePath(uploadId), "");
  await saveResumableUploadSession(session);
  return session;
}

async function cleanupResumableUploadSession(uploadId) {
  await fs.rm(resumableSessionDir(uploadId), {
    recursive: true,
    force: true,
  });
}

async function sweepResumableUploadSessions() {
  const entries = await fs.readdir(resumableUploadDir, { withFileTypes: true }).catch(() => []);
  const now = Date.now();
  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const uploadId = entry.name;
        if (!/^[a-z0-9-]{8,128}$/i.test(uploadId)) {
          await fs.rm(path.join(resumableUploadDir, uploadId), {
            recursive: true,
            force: true,
          }).catch(() => {});
          return;
        }
        const session = await loadResumableUploadSession(uploadId);
        if (!session) return;
        const expiresAt = Date.parse(session.expiresAt || "");
        if (!Number.isFinite(expiresAt) || expiresAt <= now || session.status !== "uploading") {
          await cleanupResumableUploadSession(uploadId).catch(() => {});
        }
      }),
  );
}

function normalizeTusFilename(filename) {
  return path.basename(String(filename || "").replace(/\\/g, "/")).trim();
}

function byteLimitTransform(maxBytes, message) {
  let total = 0;
  return new Transform({
    transform(chunk, _encoding, callback) {
      total += chunk.length;
      if (total > maxBytes) {
        callback(httpError(413, message));
        return;
      }
      callback(null, chunk);
    },
  });
}

const resumableUploadLocks = new Map();

async function withResumableUploadLock(uploadId, task) {
  while (resumableUploadLocks.has(uploadId)) {
    await resumableUploadLocks.get(uploadId);
  }

  let release = () => {};
  const lock = new Promise((resolve) => {
    release = resolve;
  });
  resumableUploadLocks.set(uploadId, lock);
  try {
    return await task();
  } finally {
    resumableUploadLocks.delete(uploadId);
    release();
  }
}

async function importZipArchive(
  zipPath,
  originalFilename,
  { removeSource = true, onProgress } = {},
) {
  const batch = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const subjectId = crypto.randomUUID();
  const subjectName =
    path.basename(originalFilename, path.extname(originalFilename)) ||
    originalFilename;
  const createdAt = nowIso();
  let subjectDir;
  let transactionOpen = false;
  let zip;

  try {
    try {
      zip = await openZip64Archive(zipPath);
      await assertArchiveLimits(zip, zipPath);
    } catch (error) {
      if (error?.isArchiveImportError) throw error;
      throw archiveImportError(
        400,
        "无法读取 ZIP 压缩包，请确认文件完整且未损坏",
        error,
      );
    }

    let imageEntries;
    try {
      imageEntries = zip.files.filter((entry) => {
        if (entry.type === "Directory") return false;
        const relative = cleanRelative(decodeZipEntryPath(entry));
        return (
          Boolean(relative) &&
          !isMacMetadataEntry(relative) &&
          imageExts.has(path.extname(relative).toLowerCase())
        );
      });
    } catch (error) {
      throw archiveImportError(
        400,
        "无法解析 ZIP 文件目录，请确认压缩包未损坏",
        error,
      );
    }

    if (!imageEntries.length) {
      throw archiveImportError(
        422,
        "压缩包中未发现可导入图片。仅支持 JPG、JPEG、PNG、WEBP、GIF 文件",
      );
    }

    const archiveManifests = await loadArchiveManifests(zip);
    const archiveTaskManifest = await loadArchiveTaskManifest(zip);
    const catalogIndex = await loadImageCatalogIndex(archiveManifests);
    const storageRoot = await allocateSubjectStorageRoot(
      subjectName,
      subjectId,
    );
    subjectDir = path.join(uploadDir, storageRoot);
    const sourceZipPath = path.posix.join(storageRoot, "source.zip");
    let imported = 0;
    let skipped = 0;
    let catalogMatched = 0;
    const directories = new Set();
    const imageRecords = [];
    const seenOriginalPaths = new Set();

    await fs.mkdir(subjectDir, { recursive: true });
    await fs.copyFile(zipPath, uploadFilePath(uploadDir, sourceZipPath));

    const processImageEntry = async (entry, entryIndex) => {
      if (entry.type === "Directory") return null;
      const rawRelative = cleanRelative(decodeZipEntryPath(entry));
      // Keep the original relative path. Images can appear in any ZIP directory;
      // only root-level JSON files are treated as import metadata.
      const relative = rawRelative;
      if (isMacMetadataEntry(relative)) return null;
      const ext = path.extname(relative).toLowerCase();
      if (!relative || !imageExts.has(ext)) return null;
      if (seenOriginalPaths.has(relative)) return { skipped: 1 };
      seenOriginalPaths.add(relative);

      const catalogEntry = catalogEntryForImage(
        catalogIndex,
        rawRelative,
        relative,
      );
      const isInfographic = isInfographicPath(relative) ? 1 : 0;
      const directory = isInfographic ? "信息图" : "";
      const category = isInfographic ? "信息图" : "未分类";
      const imageId = crypto.randomUUID();
      const relativeDir = path.posix.dirname(relative);
      const storagePath = path.posix.join(
        storageRoot,
        relativeDir === "." ? "" : relativeDir,
        `${imageId}${ext}`,
      );
      let thumbnailPath = thumbnailStoragePath(storagePath);
      const storedPath = uploadFilePath(uploadDir, storagePath);
      let storedThumbnailPath = uploadFilePath(uploadDir, thumbnailPath);

      try {
        await fs.mkdir(path.dirname(storedPath), { recursive: true });
        await pipeline(
          entry.stream(),
          decompressionLimit(maxImageUncompressedBytes, relative),
          createWriteStream(storedPath),
        );
      } catch (error) {
        await fs.unlink(storedPath).catch(() => {});
        await fs.unlink(storedThumbnailPath).catch(() => {});
        if (
          error?.code === "ENOSPC" ||
          error?.code === "EACCES" ||
          error?.code === "EPERM"
        ) {
          throw archiveImportError(
            500,
            `保存图片“${relative}”时失败，请检查服务器上传目录`,
            error,
          );
        }
        return { skipped: 1 };
      }

      try {
        await createThumbnail(storedPath, storedThumbnailPath);
      } catch (error) {
        // A bad extension or unsupported encoding must not discard the original.
        console.warn(`Thumbnail generation failed for ${relative}; using original image`, error);
        thumbnailPath = storagePath;
        storedThumbnailPath = storedPath;
      }
      return { record: {
        id: imageId,
        subjectId,
        filename: path.basename(relative),
        originalPath: relative,
        storagePath,
        thumbnailPath,
        mimeType:
          ext === ".jpg" || ext === ".jpeg"
            ? "image/jpeg"
            : `image/${ext.slice(1)}`,
        category,
        directory,
        isInfographic,
        prompt: catalogPrompt(catalogEntry),
        catalogData: catalogEntry ? JSON.stringify(catalogEntry) : null,
        importBatch: batch,
        createdAt,
        updatedAt: createdAt,
      }, directory: Boolean(directory), catalogMatched: Boolean(catalogEntry) };
    };

    for (let start = 0; start < imageEntries.length; start += imageImportConcurrency) {
      const settledResults = await Promise.allSettled(
        imageEntries
          .slice(start, start + imageImportConcurrency)
          .map((entry, offset) => processImageEntry(entry, start + offset)),
      );
      const failedResult = settledResults.find((result) => result.status === "rejected");
      if (failedResult) throw failedResult.reason;
      const results = settledResults.map((result) => result.value);
      for (const result of results) {
        skipped += result?.skipped || 0;
        if (!result?.record) continue;
        imageRecords.push(result.record);
        if (result.directory) directories.add(result.record.directory);
        catalogMatched += result.catalogMatched ? 1 : 0;
        imported++;
      }
      onProgress?.({
        current: Math.min(start + imageImportConcurrency, imageEntries.length),
        total: imageEntries.length,
      });
    }

    if (!imported) {
      throw archiveImportError(422, "压缩包中的图片均无法导入");
    }

    const { taskTemplates, failedTasks } = buildTaskTemplateRecords(
      subjectId,
      archiveTaskManifest,
      imageRecords,
      createdAt,
    );

    // All archive I/O and image validation has completed before this write
    // transaction. Keep read indexes in place so imports do not rebuild the
    // entire images table while holding SQLite's writer lock.
    db.exec("BEGIN IMMEDIATE");
    transactionOpen = true;
    insertSubjectStmt.run({
      id: subjectId,
      name: subjectName,
      originalFilename,
      importBatch: batch,
      storageRoot,
      sourceZipPath,
      createdAt,
      updatedAt: createdAt,
    });
    for (const imageRecord of imageRecords) {
      const result = insertImageStmt.run(imageRecord);
      if (result.changes === 0) {
        throw archiveImportError(
          409,
          `图片“${imageRecord.originalPath}”重复，无法导入`,
        );
      }
    }
    for (const taskTemplate of taskTemplates) {
      const { items: _items, ...templateRecord } = taskTemplate;
      insertSubjectTaskTemplateStmt.run(templateRecord);
      for (const item of taskTemplate.items) {
        insertSubjectTaskTemplateItemStmt.run({
          templateId: taskTemplate.id,
          ...item,
        });
      }
    }

    const updatedAt = nowIso();
    updateSubjectCountsStmt.run({
      id: subjectId,
      imageCount: imported,
      categoryCount: directories.size,
      status: "imported",
      updatedAt,
    });

    db.exec("COMMIT");
    transactionOpen = false;
    const subject = selectSubjectByIdStmt.get(subjectId);
    return {
      subject: subjectDto(subject),
      batch,
      imported,
      skipped,
      catalogMatched,
      catalogUnmatched: imported - catalogMatched,
      taskTemplateCount: taskTemplates.length,
      taskFailedCount: failedTasks.length,
      taskFailures: failedTasks,
    };
  } catch (error) {
    if (transactionOpen) {
      try {
        db.exec("ROLLBACK");
      } catch (rollbackError) {
        console.error("Failed to roll back ZIP import", rollbackError);
      }
    }

    // Covers failures after a commit as well as older databases with partial imports.
    try {
      db.prepare("DELETE FROM subjects WHERE id = ?").run(subjectId);
    } catch (cleanupError) {
      console.error("Failed to clean up ZIP import record", cleanupError);
    }
    if (subjectDir) {
      await fs.rm(subjectDir, { recursive: true, force: true }).catch(() => {});
    }
    throw normalizeArchiveImportError(error);
  } finally {
    zip?.close();
    if (removeSource) await fs.unlink(zipPath).catch(() => {});
  }
}

async function runResumableImportJob(job) {
  try {
    job.status = "importing";
    job.stage = "正在解析并导入图片";
    job.progress = 0;
    persistImportJob(job);

    job.result = await importZipArchive(job.zipPath, job.originalFilename, {
      onProgress: ({ current, total }) => {
        job.progress = Math.min(99, Math.round((current / total) * 100));
        if (job.progress !== job.lastPersistedProgress) {
          job.lastPersistedProgress = job.progress;
          persistImportJob(job);
        }
      },
    });

    job.status = "completed";
    job.stage = "导入完成";
    job.progress = 100;
    persistImportJob(job);
  } catch (error) {
    const normalized = normalizeArchiveImportError(error);
    job.status = "failed";
    job.stage = "导入失败";
    job.message = normalized.message || "导入失败，请重试";
    persistImportJob(job);
    console.error(`Resumable ZIP import failed (${job.uploadId})`, error);
  } finally {
    await cleanupResumableUploadSession(job.uploadId).catch(() => {});

    // 保留结果一段时间，允许前端在短暂断线后继续查询本次任务。
    setTimeout(
      () => {
        importJobs.delete(job.uploadId);
        deleteImportJobStmt.run(job.uploadId);
      },
      24 * 60 * 60 * 1000,
    ).unref();
  }
}

function importJobExpiry() {
  return new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
}

function importJobDto(job) {
  const payload = {
    uploadId: job.uploadId,
    status: job.status,
    stage: job.stage,
    progress: job.progress,
    message: job.message || null,
  };
  if (job.result) payload.result = job.result;
  return payload;
}

function importJobFromRow(row) {
  if (!row) return null;
  let result = null;
  if (row.resultJson) {
    try {
      result = JSON.parse(row.resultJson);
    } catch {
      result = null;
    }
  }
  return {
    uploadId: row.uploadId,
    originalFilename: row.originalFilename,
    totalChunks: row.totalChunks,
    protocol: row.protocol || "chunked",
    uploadLength: row.uploadLength,
    uploadOffset: row.uploadOffset,
    metadata: row.metadata,
    status: row.status,
    stage: row.stage,
    progress: row.progress,
    message: row.message,
    result,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
  };
}

function persistImportJob(job) {
  job.expiresAt = job.expiresAt || importJobExpiry();
  const updatedAt = nowIso();
  updateImportJobStmt.run({
    uploadId: job.uploadId,
    status: job.status,
    stage: job.stage,
    progress: job.progress,
    message: job.message || null,
    resultJson: job.result ? JSON.stringify(job.result) : null,
    protocol: job.protocol || "chunked",
    uploadLength: job.uploadLength ?? null,
    uploadOffset: job.uploadOffset ?? 0,
    metadata: job.metadata ?? null,
    updatedAt,
    expiresAt: job.expiresAt,
  });
}

async function mergeChunkedZip(job) {
  let totalBytes = 0;
  const partPaths = [];

  for (let index = 0; index < job.totalChunks; index++) {
    const partPath = chunkFilePath(job.uploadId, index);
    let stat;
    try {
      stat = await fs.stat(partPath);
    } catch {
      throw httpError(400, `缺少第 ${index + 1} 个分片`);
    }
    if (!stat.isFile() || stat.size <= 0) {
      throw httpError(400, `第 ${index + 1} 个分片无效`);
    }
    totalBytes += stat.size;
    if (totalBytes > maxZipBytes) {
      throw httpError(413, "ZIP 文件超过服务器允许的大小限制");
    }
    partPaths.push(partPath);
  }

  const output = await fs.open(job.zipPath, "w");
  let mergedBytes = 0;
  try {
    for (const partPath of partPaths) {
      for await (const chunk of createReadStream(partPath)) {
        await output.write(chunk);
        mergedBytes += chunk.length;
        job.progress = Math.min(
          15,
          Math.round((mergedBytes / totalBytes) * 15),
        );
      }
    }
  } finally {
    await output.close();
  }
}

async function runChunkedImportJob(job) {
  try {
    job.status = "merging";
    job.stage = "正在合并上传分片";
    job.progress = 0;
    persistImportJob(job);
    await mergeChunkedZip(job);

    job.status = "importing";
    job.stage = "正在解析并导入图片";
    job.progress = 15;
    persistImportJob(job);
    job.result = await importZipArchive(job.zipPath, job.originalFilename, {
      onProgress: ({ current, total }) => {
        job.progress = Math.min(99, 15 + Math.round((current / total) * 84));
        if (job.progress !== job.lastPersistedProgress) {
          job.lastPersistedProgress = job.progress;
          persistImportJob(job);
        }
      },
    });
    job.status = "completed";
    job.stage = "导入完成";
    job.progress = 100;
    persistImportJob(job);
  } catch (error) {
    const normalized = normalizeArchiveImportError(error);
    job.status = "failed";
    job.stage = "导入失败";
    job.message = normalized.message || "导入失败，请重试";
    persistImportJob(job);
    console.error(`Chunked ZIP import failed (${job.uploadId})`, error);
  } finally {
    await fs.rm(job.dir, { recursive: true, force: true }).catch(() => {});
    await fs.unlink(job.zipPath).catch(() => {});

    // 保留结果一段时间，允许前端在短暂断线后继续查询本次任务。
    setTimeout(
      () => {
        importJobs.delete(job.uploadId);
        deleteImportJobStmt.run(job.uploadId);
      },
      24 * 60 * 60 * 1000,
    ).unref();
  }
}

function nowIso() {
  return new Date().toISOString();
}

function clampScore(value, fallback) {
  if (value === null || value === undefined || value === "") return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  const rounded = Math.round(number);
  return Math.max(1, Math.min(10, rounded));
}

function parseScoreValue(value, key) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  if (
    !Number.isFinite(number) ||
    !Number.isInteger(number) ||
    number < 1 ||
    number > 10
  ) {
    throw httpError(400, `${key} 必须是 1-10 的整数`);
  }
  return number;
}

function scoreStateColumn(key) {
  return `${key}State`;
}

function parseScoreState(value, key) {
  if (value === null || value === undefined || value === "") return null;
  const state = String(value);
  if (!["unrated", "rated", "not_applicable"].includes(state)) {
    throw httpError(400, `${key} 状态不正确`);
  }
  return state;
}

function parseScoreRange(value) {
  if (!Array.isArray(value)) return [1, 10];
  const min = clampScore(value[0], 1);
  const max = clampScore(value[1], 10);
  return [Math.min(min, max), Math.max(min, max)];
}

function parseNullableBoolean(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value === 1 || value === "1" || value === "true") return 1;
  if (value === 0 || value === "0" || value === "false") return 0;
  throw httpError(400, "不舒适字段格式不正确");
}

function parseComment(value) {
  if (value === null || value === undefined) return "";
  const text = String(value).trim();
  if (text.length > 2000) throw httpError(400, "备注不能超过 2000 字");
  return text;
}

const feedbackTypes = new Set(["platform_bug", "scoring_rule", "other"]);
const feedbackStatuses = new Set(["pending", "processing", "resolved"]);

function parseFeedbackText(value, label, maxLength) {
  const text = String(value ?? "").trim();
  if (!text) throw httpError(400, `${label}不能为空`);
  if (text.length > maxLength)
    throw httpError(400, `${label}不能超过 ${maxLength} 个字符`);
  return text;
}

function parseFeedbackType(value) {
  const type = String(value ?? "").trim();
  if (!feedbackTypes.has(type)) throw httpError(400, "问题类型不正确");
  return type;
}

function parseFeedbackStatus(value) {
  const status = String(value ?? "").trim();
  if (!feedbackStatuses.has(status)) throw httpError(400, "处理状态不正确");
  return status;
}

function parseFeedbackImagePaths(value) {
  try {
    const paths = JSON.parse(value || "[]");
    return Array.isArray(paths)
      ? paths.filter(
          (item) => typeof item === "string" && item.startsWith("feedback/"),
        )
      : [];
  } catch {
    return [];
  }
}

function feedbackDto(row) {
  if (!row) return null;
  const imagePaths = parseFeedbackImagePaths(row.imagePaths);
  return {
    id: row.id,
    title: row.title,
    type: row.type,
    description: row.description,
    status: row.status,
    submitter: row.submitter,
    submittedAt: row.submittedAt,
    reply: row.reply ?? "",
    repliedBy: row.repliedBy ?? null,
    repliedAt: row.repliedAt ?? null,
    updatedAt: row.updatedAt,
    messages: selectFeedbackMessagesStmt.all(row.id).map((message) => ({
      id: message.id,
      author: message.author,
      authorRole: message.authorRole,
      content: message.content,
      createdAt: message.createdAt,
    })),
    images: imagePaths.map((imagePath) => ({
      path: imagePath,
      url: `/files/${imagePath}`,
    })),
  };
}

function listFeedbacks(query = {}) {
  const page = Math.max(Number(query.page) || 1, 1);
  const pageSize = Math.min(Math.max(Number(query.pageSize) || 10, 1), 100);
  const clauses = [];
  const params = [];
  const status = query.status ? parseFeedbackStatus(query.status) : null;

  if (status) {
    clauses.push("status = ?");
    params.push(status);
  }

  const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
  const total = db
    .prepare(`SELECT COUNT(*) AS total FROM feedbacks${where}`)
    .get(...params).total;
  const items = db
    .prepare(
      `SELECT * FROM feedbacks${where} ORDER BY submittedAt DESC, id DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, pageSize, (page - 1) * pageSize)
    .map(feedbackDto);
  return { total, page, pageSize, items };
}

async function createFeedback(user, body = {}, files = []) {
  const title = parseFeedbackText(body.title, "问题标题", 200);
  const type = parseFeedbackType(body.type);
  const description = parseFeedbackText(body.description, "问题描述", 5000);
  const id = crypto.randomUUID();
  const submittedAt = nowIso();
  const storedPaths = [];

  try {
    for (const file of files) {
      const extension = path.extname(file.originalname || "").toLowerCase();
      if (!feedbackImageExts.has(extension))
        throw httpError(400, "反馈图片仅支持 JPG、PNG、WebP 格式");
      try {
        await sharp(file.buffer).metadata();
      } catch {
        throw httpError(400, "反馈图片文件无法识别");
      }
      const filename = `${crypto.randomUUID()}${extension}`;
      const relativePath = `feedback/${filename}`;
      await fs.writeFile(path.join(feedbackUploadDir, filename), file.buffer);
      storedPaths.push(relativePath);
    }

    insertFeedbackStmt.run({
      id,
      title,
      type,
      description,
      imagePaths: JSON.stringify(storedPaths),
      submitter: user.username,
      submittedAt,
      updatedAt: submittedAt,
    });
    return feedbackDto(selectFeedbackByIdStmt.get(id));
  } catch (error) {
    await Promise.all(
      storedPaths.map((relativePath) =>
        fs.unlink(path.join(uploadDir, relativePath)).catch(() => {}),
      ),
    );
    throw error;
  }
}

function assertFeedbackAccess(feedback, user) {
  if (!feedback) throw httpError(404, "问题反馈不存在");
  if (user?.role !== "admin" && feedback.submitter !== user?.username) {
    throw httpError(403, "无权访问该反馈");
  }
}

function addFeedbackMessage(id, body, user) {
  const feedback = selectFeedbackByIdStmt.get(id);
  if (!feedback) throw httpError(404, "问题反馈不存在");
  if (feedback.status === "resolved") {
    throw httpError(409, "该反馈已解决，不能继续回复");
  }
  const content = parseFeedbackText(
    body?.content ?? body?.reply,
    "回复内容",
    5000,
  );
  const requestedStatus = body?.status
    ? parseFeedbackStatus(body.status)
    : null;
  if (requestedStatus === "pending") {
    throw httpError(400, "反馈回复后不能恢复为未处理");
  }
  const status =
    requestedStatus ||
    (feedback.status === "pending" ? "processing" : feedback.status);
  const repliedAt = nowIso();
  db.exec("BEGIN IMMEDIATE");
  try {
    insertFeedbackMessageStmt.run({
      id: crypto.randomUUID(),
      feedbackId: feedback.id,
      author: user.username,
      authorRole: user.role,
      content,
      createdAt: repliedAt,
    });
    updateFeedbackReplyStmt.run({
      id,
      status,
      reply: content,
      repliedBy: user.username,
      repliedAt,
      updatedAt: repliedAt,
    });
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    throw error;
  }
  return feedbackDto(selectFeedbackByIdStmt.get(id));
}

function updateFeedbackStatus(id, statusValue, user) {
  const feedback = selectFeedbackByIdStmt.get(id);
  assertFeedbackAccess(feedback, user);
  const status = parseFeedbackStatus(statusValue);
  if (status === "pending") throw httpError(400, "反馈状态不能恢复为未处理");
  if (
    status === "resolved" &&
    feedback.status !== "resolved" &&
    !selectFeedbackMessageExistsStmt.get(feedback.id)
  ) {
    throw httpError(400, "至少回复一次后才能标记为已解决");
  }
  const updatedAt = nowIso();
  db.prepare("UPDATE feedbacks SET status = ?, updatedAt = ? WHERE id = ?").run(
    status,
    updatedAt,
    id,
  );
  return feedbackDto(selectFeedbackByIdStmt.get(id));
}

function legacyReplyFeedback(id, body, admin) {
  const feedback = selectFeedbackByIdStmt.get(id);
  if (!feedback) throw httpError(404, "问题反馈不存在");
  const status = parseFeedbackStatus(body?.status);
  const reply = parseFeedbackText(body?.reply, "答复内容", 5000);
  const repliedAt = nowIso();
  updateFeedbackReplyStmt.run({
    id,
    status,
    reply,
    repliedBy: admin.username,
    repliedAt,
    updatedAt: repliedAt,
  });
  return feedbackDto(selectFeedbackByIdStmt.get(id));
}

function escapeLike(value) {
  return String(value).replace(/[\\%_]/g, "\\$&");
}

function parseScorerName(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  if (text.length > 100) throw httpError(400, "打分人不能超过 100 字");
  return text;
}

function normalizeScorePayload(body) {
  const payload = {};
  const criterionStates =
    body.criterionStates && typeof body.criterionStates === "object"
      ? body.criterionStates
      : {};

  for (const key of scoreNumericFields) {
    const isSkippable = skippableScoreFields.includes(key);
    const stateKey = scoreStateColumn(key);
    const requestedState = isSkippable
      ? parseScoreState(criterionStates[key] ?? body[stateKey], key)
      : null;

    if (requestedState === "not_applicable") {
      payload[key] = null;
      payload[stateKey] = "not_applicable";
      continue;
    }

    payload[key] = parseScoreValue(body[key], key);
    if (isSkippable) {
      payload[stateKey] = payload[key] === null ? "unrated" : "rated";
    }
  }
  payload.discomfort = parseNullableBoolean(body.discomfort);
  payload.comment = parseComment(body.comment);
  payload.scorer = parseScorerName(body.scorer);
  payload.ratedAt = nowIso();
  return payload;
}

function scoreFromRow(row) {
  if (!row) return null;
  const criterionStates = Object.fromEntries(
    skippableScoreFields.map((key) => {
      const state = row[scoreStateColumn(key)];
      return [
        key,
        ["unrated", "rated", "not_applicable"].includes(state)
          ? state
          : row[key] == null
            ? "unrated"
            : "rated",
      ];
    }),
  );

  return {
    overall: row.overall,
    creativity: row.creativity,
    mood: row.mood,
    composition: row.composition,
    color: row.color,
    lighting: row.lighting,
    realism: row.realism,
    detail: row.detail,
    discomfort:
      row.discomfort === null || row.discomfort === undefined
        ? null
        : Boolean(row.discomfort),
    promptAlignment: row.promptAlignment,
    textCorrectness: row.textCorrectness,
    anatomyNormality: row.anatomyNormality,
    informationClarity: row.informationClarity,
    designQuality: row.designQuality,
    typography: row.typography,
    criterionStates,
    scorer: row.scorer ?? null,
    comment: row.comment ?? "",
    ratedAt: row.ratedAt ?? null,
  };
}

function imageAssetUrl(storagePath) {
  return storagePath ? `/files/${storagePath}` : null;
}

function imageDto(row) {
  return {
    _id: row._id,
    subjectId: row.subjectId,
    filename: row.filename,
    originalPath: row.originalPath,
    category: row.category,
    directory: row.directory || "",
    isInfographic: Boolean(row.isInfographic),
    prompt: row.prompt ?? null,
    catalog: parseCatalogData(row.catalogData),
    imageUrl: imageAssetUrl(row.storagePath),
    thumbnailUrl: imageAssetUrl(row.thumbnailPath),
    score: scoreFromRow(row),
  };
}

function taskImageDto(row) {
  return {
    _id: row._id,
    subjectId: row.subjectId,
    filename: row.filename,
    originalPath: row.originalPath,
    category: row.category,
    directory: row.directory || "",
    isInfographic: Boolean(row.isInfographic),
    prompt: row.prompt ?? null,
    imageUrl: imageAssetUrl(row.storagePath),
    thumbnailUrl: imageAssetUrl(row.thumbnailPath),
  };
}

function taskListImageDto(row) {
  return {
    _id: row._id,
    filename: row.filename,
    imageUrl: imageAssetUrl(row.storagePath),
    thumbnailUrl: imageAssetUrl(row.thumbnailPath),
  };
}

function subjectDto(row) {
  return row
    ? {
        _id: row._id,
        name: row.name,
        originalFilename: row.originalFilename,
        importBatch: row.importBatch,
        imageCount: row.imageCount,
        categoryCount: row.categoryCount,
        taskTemplateCount: Number(row.taskTemplateCount || 0),
        status: row.status,
        taskStatus: row.taskStatus || "task_pending",
        deletionRequestedAt: row.deletionRequestedAt ?? null,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      }
    : null;
}

function teamDto(row) {
  return row
    ? {
        id: row.id,
        name: row.name,
        status: row.status || "enabled",
        userCount: Number(row.userCount || 0),
        projectCount: Number(row.projectCount || 0),
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      }
    : null;
}

function getProjectTaskStats(projectId, version = taskVersion) {
  const row = selectProjectTaskStatsStmt.get(projectId, version);
  return {
    total: Number(row?.total || 0),
    pending: Number(row?.pending || 0),
    assigned: Number(row?.assigned || 0),
    completed: Number(row?.completed || 0),
  };
}

function invalidateTaskSummaryCaches(projectId) {
  subjectTaskReportCache.delete(projectId);
}

const queuedProjectTaskSummaries = new Set();

function queueProjectTaskSummary(projectId) {
  if (queuedProjectTaskSummaries.has(projectId)) return;
  queuedProjectTaskSummaries.add(projectId);
  setImmediate(() => {
    try {
      const taskStats = getProjectTaskStats(projectId);
      if (taskStats.pending + taskStats.assigned !== 0) return;
      updateSubjectTaskStatusStmt.run({
        id: projectId,
        taskStatus: "task_completed",
        updatedAt: nowIso(),
      });
    } catch (error) {
      // ponytail: eventual-consistency summary update; use a durable job if
      // recovery after process loss becomes a requirement.
      console.error("failed to update project task summary", error);
    } finally {
      queuedProjectTaskSummaries.delete(projectId);
    }
  });
}

function projectStatsByIds(projectIds, version = taskVersion) {
  const ids = [...new Set(projectIds.filter(Boolean))];
  if (!ids.length) return new Map();
  const rows = db
    .prepare(
      `SELECT projectId, total, pending, assigned, completed
       FROM project_task_stats
       WHERE taskVersion = ?
         AND projectId IN (${placeholders(ids.length)})`,
    )
    .all(version, ...ids);
  return new Map(
    rows.map((row) => [
      row.projectId,
      {
        total: Number(row.total || 0),
        pending: Number(row.pending || 0),
        assigned: Number(row.assigned || 0),
        completed: Number(row.completed || 0),
      },
    ]),
  );
}

function projectRelatedRowsByIds(projectIds) {
  const ids = [...new Set(projectIds.filter(Boolean))];
  if (!ids.length) return new Map();

  const packageRows = db
    .prepare(
      `SELECT project_packages.projectId AS _projectId,
              subjects.id AS _id,
              subjects.name,
              subjects.originalFilename,
              subjects.imageCount,
              subjects.categoryCount,
              subjects.status,
              subjects.createdAt,
              subjects.updatedAt,
              COUNT(subject_task_templates.id) AS taskTemplateCount
       FROM project_packages
       JOIN subjects ON subjects.id = project_packages.packageId
       LEFT JOIN subject_task_templates
         ON subject_task_templates.subjectId = subjects.id
       WHERE project_packages.projectId IN (${placeholders(ids.length)})
         AND subjects.deletionRequestedAt IS NULL
       GROUP BY project_packages.projectId,
                project_packages.packageId,
                project_packages.createdAt,
                subjects.id,
                subjects.name,
                subjects.originalFilename,
                subjects.imageCount,
                subjects.categoryCount,
                subjects.status,
                subjects.createdAt,
                subjects.updatedAt
       ORDER BY project_packages.projectId ASC,
                project_packages.createdAt ASC,
                subjects.createdAt ASC,
                subjects.id ASC`,
    )
    .all(...ids);
  const teamRows = db
    .prepare(
      `SELECT project_teams.projectId AS _projectId,
              teams.id,
              teams.name,
              teams.status
       FROM project_teams
       JOIN teams ON teams.id = project_teams.teamId
       WHERE project_teams.projectId IN (${placeholders(ids.length)})
       ORDER BY project_teams.projectId ASC, teams.name COLLATE NOCASE ASC`,
    )
    .all(...ids);
  const relatedByProjectId = new Map();
  ids.forEach((id) => {
    relatedByProjectId.set(id, { packageRows: [], teamRows: [] });
  });
  packageRows.forEach((row) => {
    relatedByProjectId.get(row._projectId)?.packageRows.push(row);
  });
  teamRows.forEach((row) => {
    relatedByProjectId.get(row._projectId)?.teamRows.push(row);
  });
  return relatedByProjectId;
}

function mapProjectRows(rows) {
  const statsByProjectId = projectStatsByIds(rows.map((row) => row._id));
  const relatedByProjectId = projectRelatedRowsByIds(rows.map((row) => row._id));
  return rows.map((row) =>
    projectDto(
      row,
      statsByProjectId.get(row._id),
      relatedByProjectId.get(row._id),
    ),
  );
}

function projectDto(row, taskStats = null, related = null) {
  if (!row) return null;
  const packageRows = related?.packageRows?.length
    ? related.packageRows
    : selectProjectPackagesStmt.all(row._id);
  const fallbackPackage = row.packageId
    ? [{
        _id: row.packageId,
        name: row.packageName,
        originalFilename: row.packageFilename,
        imageCount: Number(row.imageCount || 0),
        categoryCount: Number(row.categoryCount || 0),
        status: row.packageStatus,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        taskTemplateCount: Number(row.taskTemplateCount || 0),
      }]
    : [];
  const packages = packageRows.length ? packageRows : fallbackPackage;
  const primaryPackage =
    packages.find((item) => item._id === row.packageId) || packages[0] || null;
  const taskTemplateCount = packages.reduce(
    (total, item) => total + Number(item.taskTemplateCount || 0),
    0,
  );
  const stats = taskStats || getProjectTaskStats(row._id);
  const generatedTaskCount = stats.total;
  const pendingTaskCount = stats.pending;
  const remainingTemplateCount = Math.max(taskTemplateCount - generatedTaskCount, 0);
  return {
    _id: row._id,
    name: row.name,
    packageId: primaryPackage?._id || row.packageId,
    packageIds: packages.map((item) => item._id),
    packages,
    packageName: primaryPackage?.name || row.packageName,
    packageNames: packages.map((item) => item.name),
    packageFilename: primaryPackage?.originalFilename || row.packageFilename,
    packageStatus: packages.every((item) => item.status === "imported")
      ? "imported"
      : packages.some((item) => item.status === "failed")
        ? "failed"
        : "importing",
    imageCount: packages.reduce(
      (total, item) => total + Number(item.imageCount || 0),
      0,
    ),
    categoryCount: packages.reduce(
      (total, item) => total + Number(item.categoryCount || 0),
      0,
    ),
    taskTemplateCount,
    generatedTaskCount,
    pendingTaskCount,
    remainingTemplateCount,
    availableTaskCount: pendingTaskCount + remainingTemplateCount,
    taskStatus: row.taskStatus || "task_pending",
    deletionRequestedAt: row.deletionRequestedAt ?? null,
    teams: (related?.teamRows || selectProjectTeamsStmt.all(row._id)).map(teamDto),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function projectSubjectDto(project, projectView = null) {
  const view = projectView || projectDto(project);
  if (!view) return null;
  return {
    _id: view._id,
    name: view.name,
    originalFilename: view.packageNames.join("、"),
    importBatch: view.packageIds.join(","),
    imageCount: view.imageCount,
    categoryCount: view.categoryCount,
    taskTemplateCount: view.taskTemplateCount,
    status: view.packageStatus,
    taskStatus: view.taskStatus,
    deletionRequestedAt: view.deletionRequestedAt,
    createdAt: view.createdAt,
    updatedAt: view.updatedAt,
  };
}

function listProjects() {
  return mapProjectRows(selectProjectsStmt.all());
}

function listProjectsPage(query = {}) {
  const { page, pageSize } = parseTaskPagination(query);
  const total = db
    .prepare(
      `SELECT COUNT(*) AS total
       FROM projects
       JOIN subjects ON subjects.id = projects.packageId
       WHERE projects.deletionRequestedAt IS NULL`,
    )
    .get().total;
  const projectRows = db
    .prepare(
      `SELECT ${projectSelectColumns}
       FROM projects
       JOIN subjects ON subjects.id = projects.packageId
       WHERE projects.deletionRequestedAt IS NULL
       ORDER BY projects.createdAt DESC, projects.id ASC
       LIMIT ? OFFSET ?`,
    )
    .all(pageSize, (page - 1) * pageSize);
  const projects = mapProjectRows(projectRows);
  return { total, page, pageSize, projects };
}

function normalizeTeamNames(value) {
  if (!Array.isArray(value)) return [];
  const names = [];
  const seen = new Set();
  for (const item of value) {
    const name = String(item ?? "").trim();
    if (!name) continue;
    if (name.length > 60) throw httpError(400, "团队名称不能超过 60 字");
    const key = name.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  if (names.length > 20) throw httpError(400, "每个账号最多关联 20 个团队");
  return names;
}

function normalizeTeamIds(value, { required = false, enabledOnly = false } = {}) {
  if (!Array.isArray(value)) {
    if (required) throw httpError(400, "请选择标注团队");
    return [];
  }
  const ids = [...new Set(value.map((item) => String(item ?? "").trim()).filter(Boolean))];
  if (required && !ids.length) throw httpError(400, "请选择标注团队");
  if (ids.length > 20) throw httpError(400, "最多选择 20 个团队");
  const teams = ids.map((id) => selectTeamByIdStmt.get(id));
  const missing = ids.filter((_, index) => !teams[index]);
  if (missing.length) throw httpError(400, "存在已删除的团队，请刷新后重试");
  const disabled = teams.filter((team) => team.status === "disabled");
  if (enabledOnly && disabled.length) {
    throw httpError(
      400,
      `以下团队已禁用：${disabled.map((team) => team.name).join("、")}`,
    );
  }
  return ids;
}

function ensureTeams(teamNames, now) {
  return teamNames.map((name) => {
    let team = selectTeamByNameStmt.get(name);
    if (!team) {
      const id = crypto.randomUUID();
      insertTeamStmt.run({ id, name, createdAt: now, updatedAt: now });
      team = selectTeamByIdStmt.get(id);
    }
    return team.id;
  });
}

function parseEnabledStatus(value, label, { optional = false } = {}) {
  if ((value === undefined || value === null || value === "") && optional) {
    return null;
  }
  const status = String(value ?? "").trim();
  if (status !== "enabled" && status !== "disabled") {
    throw httpError(400, `${label}状态不正确`);
  }
  return status;
}

function parseTeamName(value) {
  const name = String(value ?? "").trim();
  if (!name) throw httpError(400, "请输入团队名称");
  if (name.length > 60) throw httpError(400, "团队名称不能超过 60 字");
  return name;
}

function listTeams(query = {}) {
  const status = parseEnabledStatus(query.status, "团队", { optional: true });
  if (!status) return selectTeamsStmt.all().map(teamDto);

  return db
    .prepare(
      `SELECT teams.id, teams.name, teams.status, teams.createdAt, teams.updatedAt,
              COUNT(DISTINCT user_teams.userId) AS userCount,
              COUNT(DISTINCT project_teams.projectId) AS projectCount
       FROM teams
       LEFT JOIN user_teams ON user_teams.teamId = teams.id
       LEFT JOIN project_teams ON project_teams.teamId = teams.id
       WHERE teams.status = ?
       GROUP BY teams.id
       ORDER BY teams.name COLLATE NOCASE ASC`,
    )
    .all(status)
    .map(teamDto);
}

function createTeam(body = {}) {
  const name = parseTeamName(body.name);
  const now = nowIso();
  const id = crypto.randomUUID();
  try {
    insertTeamStmt.run({ id, name, createdAt: now, updatedAt: now });
  } catch (error) {
    if (
      String(error?.message || "").includes(
        "UNIQUE constraint failed: teams.name",
      )
    ) {
      throw httpError(409, "团队已存在");
    }
    throw error;
  }
  return teamDto(selectTeamByIdStmt.get(id));
}

function updateTeam(id, body = {}) {
  const team = selectTeamByIdStmt.get(String(id));
  if (!team) throw httpError(404, "团队不存在");
  const name = Object.hasOwn(body, "name") ? parseTeamName(body.name) : null;
  const status = parseEnabledStatus(body.status, "团队", { optional: true });
  if (!name && !status) return teamDto(selectTeamByIdStmt.get(team.id));

  try {
    updateTeamStmt.run({
      id: team.id,
      name,
      status,
      updatedAt: nowIso(),
    });
  } catch (error) {
    if (
      String(error?.message || "").includes(
        "UNIQUE constraint failed: teams.name",
      )
    ) {
      throw httpError(409, "团队已存在");
    }
    throw error;
  }
  return teamDto(selectTeamByIdStmt.get(team.id));
}

function syncUserTeams(userId, teamNames, now) {
  const teamIds = ensureTeams(teamNames, now);
  deleteUserTeamsStmt.run(userId);
  teamIds.forEach((teamId) => {
    insertUserTeamStmt.run({ userId, teamId, createdAt: now });
  });
}

function syncProjectTeams(projectId, teamIds, now) {
  deleteProjectTeamsStmt.run(projectId);
  teamIds.forEach((teamId) => {
    insertProjectTeamStmt.run({ projectId, teamId, createdAt: now });
  });
}

function deleteTeam(id) {
  const team = selectTeamByIdStmt.get(String(id));
  if (!team) throw httpError(404, "团队不存在");
  const usage = selectTeamUsageStmt.get(team.id, team.id);
  if (usage.userCount > 0 || usage.projectCount > 0) {
    throw httpError(409, "团队仍有关联账号或项目，不能删除");
  }
  deleteTeamStmt.run(team.id);
  return { deleted: true };
}

function parseProjectName(value) {
  const name = String(value ?? "").trim();
  if (!name) throw httpError(400, "请输入项目名称");
  if (name.length > 120) throw httpError(400, "项目名称不能超过 120 字");
  return name;
}

function assertProjectNameAvailable(name, excludeId = null) {
  const existing = selectProjectByNameStmt.get(name);
  if (existing && existing.id !== excludeId) {
    throw httpError(409, "项目名称已存在");
  }
}

function projectPackageIds(project) {
  const packageRows = selectProjectPackagesStmt.all(project._id);
  if (packageRows.length) return packageRows.map((row) => row._id);
  return project.packageId ? [project.packageId] : [];
}

function normalizeProjectPackageIds(body = {}, fallback = []) {
  const raw = Array.isArray(body.packageIds)
    ? body.packageIds
    : body.packageId != null
      ? [body.packageId]
      : fallback;
  const packageIds = [
    ...new Set(
      raw
        .map((item) => String(item ?? "").trim())
        .filter(Boolean),
    ),
  ];
  if (!packageIds.length) throw httpError(400, "请选择至少一个图包");
  if (packageIds.length > 100) throw httpError(400, "一个项目最多关联 100 个图包");

  const packageRows = packageIds.map((id) => selectSubjectByIdStmt.get(id));
  const missing = packageIds.filter((_, index) => !packageRows[index]);
  if (missing.length) throw httpError(400, "存在不存在的图包，请刷新后重试");
  const unavailable = packageRows.filter((row) => row.status !== "imported");
  if (unavailable.length) {
    throw httpError(
      400,
      `以下图包尚未处理完成：${unavailable.map((row) => row.name).join("、")}`,
    );
  }
  return packageIds;
}

function getProjectOrThrow(projectId) {
  const project = selectProjectByIdStmt.get(String(projectId));
  if (!project) throw httpError(404, "项目不存在");
  if (projectPackageIds(project).some((packageId) => {
    const packageRow = selectSubjectByIdStmt.get(packageId);
    return !packageRow || packageRow.status !== "imported";
  })) {
    throw httpError(409, "关联图包尚未处理完成");
  }
  return project;
}

function createProject(body = {}) {
  const name = parseProjectName(body.name);
  const icon = "archive";
  const packageIds = normalizeProjectPackageIds(body);
  const packageId = packageIds[0];
  const now = nowIso();
  const id = crypto.randomUUID();
  db.exec("BEGIN IMMEDIATE");
  try {
    assertProjectNameAvailable(name);
    insertProjectStmt.run({ id, name, icon, packageId, createdAt: now, updatedAt: now });
    packageIds.forEach((linkedPackageId) => {
      insertProjectPackageStmt.run({
        projectId: id,
        packageId: linkedPackageId,
        createdAt: now,
      });
    });
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    if (String(error?.message || "").includes("UNIQUE constraint failed")) {
      throw httpError(409, "项目名称已存在");
    }
    throw error;
  }
  return projectDto(selectProjectByIdStmt.get(id));
}

function updateProject(id, body = {}) {
  const current = getProjectOrThrow(id);
  const name = parseProjectName(body.name ?? current.name);
  const icon = "archive";
  const packageIds = normalizeProjectPackageIds(body, projectPackageIds(current));
  const packageId = packageIds[0];
  const currentPackageIds = projectPackageIds(current);
  const packageChanged =
    packageIds.length !== currentPackageIds.length ||
    packageIds.some((item) => !currentPackageIds.includes(item));
  if (packageChanged && selectProjectTaskCountStmt.get(id).total) {
    throw httpError(409, "项目已生成任务，不能更换关联图包");
  }
  const now = nowIso();
  db.exec("BEGIN IMMEDIATE");
  try {
    assertProjectNameAvailable(name, id);
    updateProjectStmt.run({ id, name, icon, packageId, updatedAt: now });
    deleteProjectPackagesStmt.run(id);
    packageIds.forEach((linkedPackageId) => {
      insertProjectPackageStmt.run({
        projectId: id,
        packageId: linkedPackageId,
        createdAt: now,
      });
    });
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    if (String(error?.message || "").includes("UNIQUE constraint failed")) {
      throw httpError(409, "项目名称已存在");
    }
    throw error;
  }
  return projectDto(selectProjectByIdStmt.get(id));
}

function listVisibleProjects(user, query = {}) {
  if (user?.role === "admin") {
    return hasPaginationQuery(query) ? listProjectsPage(query) : listProjects();
  }
  const rows = db
    .prepare(`
      SELECT DISTINCT ${projectSelectColumns}
      FROM projects
      JOIN subjects ON subjects.id = projects.packageId
      JOIN rating_tasks ON rating_tasks.projectId = projects.id
      WHERE projects.deletionRequestedAt IS NULL
        AND rating_tasks.taskVersion = ?
        AND rating_tasks.scorer = ?
        AND rating_tasks.status IN ('assigned', 'completed')
      ORDER BY projects.createdAt DESC, projects.id ASC
    `)
    .all(taskVersion, user?.username || "");
  return mapProjectRows(rows);
}

function deleteProject(id) {
  const project = getProjectOrThrow(id);
  const activeJobId = activeTaskGenerationBySubject.get(project._id);
  const activeJob = activeJobId ? taskGenerationJobs.get(activeJobId) : null;
  if (activeJob && ["queued", "running"].includes(activeJob.status)) {
    throw httpError(409, "任务正在生成，请等待生成完成后再删除项目");
  }

  db.exec("BEGIN IMMEDIATE");
  try {
    const deletedTaskCount = deleteUncompletedProjectTasksStmt.run(project._id).changes;
    deleteProjectUserLinksStmt.run(project._id);
    if (!deleteProjectStmt.run(project._id).changes) {
      throw httpError(404, "项目不存在");
    }
    db.exec("COMMIT");
    invalidateTaskSummaryCaches(project._id);
    return { deleted: true, deletedTaskCount };
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    throw error;
  }
}

const queuedSubjectDeletionIds = new Set();

function queueSubjectDeletion(subjectId) {
  if (queuedSubjectDeletionIds.has(subjectId)) return;

  queuedSubjectDeletionIds.add(subjectId);
  setImmediate(() => {
    void deleteQueuedSubject(subjectId);
  });
}

async function deleteQueuedSubject(subjectId) {
  try {
    const subject = selectSubjectPendingDeletionStmt.get(subjectId);
    if (!subject) return;

    const images = selectSubjectStoragePathsStmt.all(subjectId);
    if (subject.storageRoot) {
      await fs
        .rm(path.join(uploadDir, subject.storageRoot), {
          recursive: true,
          force: true,
        })
        .catch(() => {});
    } else {
      await Promise.all(
        images.map((row) =>
          fs.unlink(path.join(uploadDir, row.storagePath)).catch(() => {}),
        ),
      );
    }

    db.exec("BEGIN IMMEDIATE");
    try {
      deleteQueuedSubjectStmt.run(subjectId);
      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {}
      throw error;
    }
  } catch (error) {
    console.error(`Failed to delete queued subject ${subjectId}`, error);
  } finally {
    queuedSubjectDeletionIds.delete(subjectId);
  }
}

function assertPackageCanBeDeleted(packageId) {
  const projectCount = selectPackageProjectCountStmt.get(packageId).total;
  if (projectCount) {
    throw httpError(409, "该图包已关联项目，无法删除；请先删除未开始的项目");
  }
}

function userDto(row) {
  return row
    ? {
        id: row.id,
        username: row.username,
        role: row.role,
        teams: row.role === "scorer" ? selectUserTeamsStmt.all(row.id).map(teamDto) : [],
        status: row.status || "enabled",
        disabledByTeam: row.role === "scorer"
          ? Boolean(selectDisabledTeamForUserStmt.get(row.id))
          : false,
        lastLoginAt: row.lastLoginAt ?? null,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      }
    : null;
}

function normalizeUsername(value) {
  const text = String(value ?? "").trim();
  if (!text) throw httpError(400, "请输入用户名");
  if (text.length > 100) throw httpError(400, "用户名不能超过 100 字");
  return text;
}

function parseUserPassword(value) {
  const text = String(value ?? "").trim();
  if (!text) return "123456";
  if (text.length > 100) throw httpError(400, "密码不能超过 100 字");
  return text;
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

function verifyPassword(password, storedPassword) {
  const value = String(storedPassword || "");
  const parts = value.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;

  const expected = Buffer.from(parts[2], "hex");
  if (!expected.length) return false;
  const actual = crypto.scryptSync(password, parts[1], expected.length);
  return (
    actual.length === expected.length &&
    crypto.timingSafeEqual(actual, expected)
  );
}

function scorerAvailabilityError(user) {
  if (!user || user.role !== "scorer") return null;
  if ((user.status || "enabled") !== "enabled") {
    return httpError(403, "账号已禁用，请联系管理员");
  }
  const disabledTeam = selectDisabledTeamForUserStmt.get(user.id);
  if (disabledTeam) {
    return httpError(403, `所属团队“${disabledTeam.name}”已禁用，无法登录`);
  }
  return null;
}

function assertScorerAssignable(user, scorerName = user?.username) {
  const error = scorerAvailabilityError(user);
  if (!error) return;
  const message = String(error.message || "账号不可用").replace("，无法登录", "");
  throw httpError(400, `打分人 ${scorerName || ""}${message ? `：${message}` : "不可用"}`);
}

function cookieValue(header, name) {
  const prefix = `${name}=`;
  const entry = String(header || "")
    .split(";")
    .map((item) => item.trim())
    .find((item) => item.startsWith(prefix));
  if (!entry) return null;
  try {
    return decodeURIComponent(entry.slice(prefix.length));
  } catch {
    return null;
  }
}

function sessionTokenHash(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function createSession(user) {
  const token = crypto.randomBytes(32).toString("base64url");
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + sessionDurationMs).toISOString();
  deleteExpiredSessionsStmt.run(createdAt);
  insertSessionStmt.run({
    tokenHash: sessionTokenHash(token),
    userId: user.id,
    createdAt,
    expiresAt,
    lastSeenAt: createdAt,
  });
  return { token, expiresAt };
}

function setSessionCookie(res, token, expiresAt) {
  res.cookie("image_rating_session", token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.COOKIE_SECURE === "true",
    maxAge: sessionDurationMs,
    expires: new Date(expiresAt),
    path: "/",
  });
}

function clearSessionCookie(res) {
  res.clearCookie("image_rating_session", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.COOKIE_SECURE === "true",
    path: "/",
  });
}

function touchSessionSeenAt(tokenHash) {
  const now = Date.now();
  const lastWriteAt = sessionSeenWriteAt.get(tokenHash) || 0;
  if (now - lastWriteAt < sessionSeenWriteIntervalMs) return;

  updateSessionSeenStmt.run(new Date(now).toISOString(), tokenHash);
  sessionSeenWriteAt.set(tokenHash, now);

  if (sessionSeenWriteAt.size > 10000) {
    for (const [hash, seenAt] of sessionSeenWriteAt) {
      if (now - seenAt >= sessionSeenWriteIntervalMs) {
        sessionSeenWriteAt.delete(hash);
      }
    }
  }
}

function requireAuth(req, _res, next) {
  if (req.method === "OPTIONS") return next();
  const token = cookieValue(req.headers.cookie, "image_rating_session");
  if (!token) return next(httpError(401, "请先登录"));

  const tokenHash = sessionTokenHash(token);
  const user = selectSessionUserStmt.get(tokenHash, nowIso());
  if (!user) {
    deleteSessionStmt.run(tokenHash);
    sessionSeenWriteAt.delete(tokenHash);
    return next(httpError(401, "登录已过期，请重新登录"));
  }
  const availabilityError = scorerAvailabilityError(user);
  if (availabilityError) {
    deleteSessionStmt.run(tokenHash);
    sessionSeenWriteAt.delete(tokenHash);
    return next(availabilityError);
  }

  touchSessionSeenAt(tokenHash);
  req.auth = userDto(user);
  return next();
}

function requireAdmin(req, _res, next) {
  if (req.method === "OPTIONS") return next();
  if (req.auth?.role !== "admin") return next(httpError(403, "需要管理员权限"));
  return next();
}

function requireScorer(req, _res, next) {
  if (req.method === "OPTIONS") return next();
  if (req.auth?.role !== "scorer")
    return next(httpError(403, "需要打分账号权限"));
  return next();
}

function assertSubjectAccess(subjectId, user) {
  const project = selectProjectByIdStmt.get(subjectId);
  if (!project) {
    const subject = selectSubjectByIdStmt.get(subjectId);
    if (!subject) throw httpError(404, "项目不存在");
    if (user?.role === "admin") return subject;
    const assignedToPackage = db
      .prepare(
        `SELECT 1 FROM rating_tasks
         WHERE subjectId = ? AND scorer = ? AND status IN ('assigned', 'completed')
         LIMIT 1`,
      )
      .get(subjectId, user?.username || "");
    if (!assignedToPackage) throw httpError(403, "无权访问该项目");
    return subject;
  }
  if (user?.role === "admin") return project;

  const assigned = db
    .prepare(
      `SELECT 1 FROM rating_tasks
       WHERE projectId = ? AND scorer = ? AND status IN ('assigned', 'completed')
       LIMIT 1`,
    )
    .get(subjectId, user?.username || "");
  if (!assigned) throw httpError(403, "无权访问该项目");
  return project;
}

function listVisibleSubjects(user) {
  if (user?.role === "admin") return selectSubjectsStmt.all();
  return db
    .prepare(
      `SELECT DISTINCT
         subjects.id AS _id,
         subjects.name,
         subjects.originalFilename,
         subjects.importBatch,
         subjects.storageRoot,
         subjects.imageCount,
         subjects.categoryCount,
         subjects.status,
         subjects.taskStatus,
         subjects.deletionRequestedAt,
         subjects.createdAt,
         subjects.updatedAt
       FROM subjects
       JOIN rating_tasks ON rating_tasks.subjectId = subjects.id
       WHERE subjects.deletionRequestedAt IS NULL
         AND rating_tasks.taskVersion = ?
         AND rating_tasks.scorer = ?
         AND rating_tasks.status IN ('assigned', 'completed')
       ORDER BY subjects.createdAt DESC`,
    )
    .all(taskVersion, user?.username || "");
}

function ensureFileAccess(req, _res, next) {
  let storagePath;
  try {
    storagePath = cleanRelative(decodeURIComponent(req.path));
  } catch {
    return next(httpError(400, "图片路径不正确"));
  }
  if (!storagePath || storagePath.startsWith("_")) {
    return next(httpError(404, "文件不存在"));
  }
  if (req.auth?.role === "admin") return next();
  if (storagePath.startsWith("feedback/")) {
    return next();
  }
  const allowed = selectAssignedTaskForImageStmt.get(
    req.auth?.username || "",
    storagePath,
    storagePath,
  );
  if (!allowed) return next(httpError(403, "无权访问该图片"));
  return next();
}

function parseProjectId(value) {
  const text = String(value ?? "").trim();
  if (!text) throw httpError(400, "请选择项目");
  return getProjectOrThrow(text)._id;
}

function loginUser(body = {}) {
  const username = normalizeUsername(body.username);
  const password = String(body.password ?? "");
  if (!password) throw httpError(401, "用户名或密码不正确");

  const now = nowIso();
  if (username === "admin") {
    const admin = selectUserAuthByUsernameStmt.get(username);
    if (
      !admin ||
      admin.role !== "admin" ||
      !verifyPassword(password, admin.password)
    )
      throw httpError(401, "用户名或密码不正确");
    updateUserLoginStmt.run({ id: admin.id, lastLoginAt: now, updatedAt: now });
    return userDto(selectUserByUsernameStmt.get(username));
  }

  const scorer = selectScorerByUsernameStmt.get(username);
  if (
    !scorer ||
    scorer.role !== "scorer" ||
    !verifyPassword(password, scorer.password)
  )
    throw httpError(401, "用户名或密码不正确");
  const availabilityError = scorerAvailabilityError(scorer);
  if (availabilityError) throw availabilityError;
  updateUserLoginStmt.run({ id: scorer.id, lastLoginAt: now, updatedAt: now });
  return userDto(selectUserByIdStmt.get(scorer.id));
}

function listScorerUsers(query = {}) {
  const { page, pageSize } = parseTaskPagination(query);
  const username = String(query.username ?? "").trim();
  const teamIds = normalizeTeamIds(
    parseQueryList(query.teamIds ?? query.teamId),
  );
  const lastLoginStart = parseOptionalDateFilter(
    query.lastLoginStart ?? query.loginStart,
    "登录开始日期",
  );
  const lastLoginEnd = parseOptionalDateFilter(
    query.lastLoginEnd ?? query.loginEnd,
    "登录结束日期",
  );
  if (lastLoginStart && lastLoginEnd && lastLoginStart > lastLoginEnd) {
    throw httpError(400, "登录开始日期不能晚于结束日期");
  }

  const clauses = ["users.role = 'scorer'"];
  const params = [];
  if (username) {
    clauses.push("users.username LIKE ? ESCAPE '\\'");
    params.push(`%${escapeSqlLike(username)}%`);
  }
  if (teamIds.length) {
    clauses.push(
      `EXISTS (
        SELECT 1
        FROM user_teams
        WHERE user_teams.userId = users.id
          AND user_teams.teamId IN (${placeholders(teamIds.length)})
      )`,
    );
    params.push(...teamIds);
  }
  if (lastLoginStart) {
    clauses.push("users.lastLoginAt >= ?");
    params.push(lastLoginStart);
  }
  if (lastLoginEnd) {
    clauses.push("users.lastLoginAt <= ?");
    params.push(lastLoginEnd);
  }

  const where = `WHERE ${clauses.join(" AND ")}`;
  const total = db
    .prepare(`SELECT COUNT(*) AS total FROM users ${where}`)
    .get(...params).total;
  const rows = db
    .prepare(
      `SELECT ${userSelectColumns}
       FROM users
       ${where}
       ORDER BY createdAt DESC, username COLLATE NOCASE ASC
       LIMIT ? OFFSET ?`,
    )
    .all(...params, pageSize, (page - 1) * pageSize);
  return {
    total,
    page,
    pageSize,
    users: rows.map((user) => userDto(user)),
  };
}

function createScorerUser(body = {}) {
  const username = normalizeUsername(body.username);
  const password = parseUserPassword(body.password);
  const teamNames = normalizeTeamNames(body.teamNames);
  if (username === "admin") throw httpError(409, "admin 是管理员账号");
  const now = nowIso();
  db.exec("BEGIN IMMEDIATE");
  try {
    if (selectUserByUsernameStmt.get(username)) {
      throw httpError(409, "账号已存在");
    }
    const id = crypto.randomUUID();
    insertScorerUserStmt.run({
      id,
      username,
      password: hashPassword(password),
      lastLoginAt: null,
      createdAt: now,
      updatedAt: now,
    });
    syncUserTeams(id, teamNames, now);
    const user = selectScorerByUsernameStmt.get(username);
    db.exec("COMMIT");
    return userDto(selectUserByIdStmt.get(user.id));
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    if (
      String(error?.message || "").includes(
        "UNIQUE constraint failed: users.username",
      )
    ) {
      throw httpError(409, "账号已存在");
    }
    throw error;
  }
}

function normalizeBatchUsernames(value) {
  if (!Array.isArray(value)) throw httpError(400, "请输入打分人名单");
  const usernames = [];
  const seen = new Set();
  for (const item of value) {
    const raw = String(item ?? "").trim();
    if (!raw) continue;
    const username = normalizeUsername(raw);
    if (username === "admin") continue;
    if (seen.has(username)) continue;
    seen.add(username);
    usernames.push(username);
  }
  if (!usernames.length) throw httpError(400, "请输入至少一个有效的打分人");
  if (usernames.length > 1000) throw httpError(400, "一次最多添加 1000 个账号");
  return usernames;
}

function createScorerUsers(body = {}) {
  const usernames = normalizeBatchUsernames(body.usernames);
  const password = parseUserPassword(body.password);
  const teamNames = normalizeTeamNames(body.teamNames);
  const skipped = [];
  const created = [];
  const now = nowIso();

  db.exec("BEGIN IMMEDIATE");
  try {
    for (const username of usernames) {
      if (selectUserByUsernameStmt.get(username)) {
        skipped.push({ username, reason: "账号已存在" });
        continue;
      }

      const id = crypto.randomUUID();
      insertScorerUserStmt.run({
        id,
        username,
        password: hashPassword(password),
        lastLoginAt: null,
        createdAt: now,
        updatedAt: now,
      });
      syncUserTeams(id, teamNames, now);
      created.push(userDto(selectUserByIdStmt.get(id)));
    }
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    if (
      String(error?.message || "").includes(
        "UNIQUE constraint failed: users.username",
      )
    ) {
      throw httpError(409, "账号已存在，请刷新后重试");
    }
    throw error;
  }

  return {
    users: created,
    createdCount: created.length,
    skipped,
    skippedCount: skipped.length,
  };
}

function updateScorerUser(id, body = {}) {
  const user = selectUserByIdStmt.get(String(id));
  if (!user || user.role !== "scorer") throw httpError(404, "打分账号不存在");
  const passwordValue = String(body.password ?? "").trim();
  if (passwordValue.length > 100) throw httpError(400, "密码不能超过 100 字");
  const status = parseEnabledStatus(body.status, "账号", { optional: true });
  const shouldSyncTeams = Object.hasOwn(body, "teamNames");
  const teamNames = shouldSyncTeams ? normalizeTeamNames(body.teamNames) : [];
  const now = nowIso();
  db.exec("BEGIN IMMEDIATE");
  try {
    updateScorerUserStmt.run({
      id: user.id,
      password: passwordValue ? hashPassword(passwordValue) : null,
      status,
      updatedAt: now,
    });
    if (shouldSyncTeams) syncUserTeams(user.id, teamNames, now);
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
  return userDto(selectUserByIdStmt.get(user.id));
}

function normalizeTeamMatchMode(value) {
  const mode = String(value ?? "all").trim().toLowerCase();
  if (mode !== "all" && mode !== "any") {
    throw httpError(400, "团队匹配方式无效");
  }
  return mode;
}

function listScorersByTeamIds(teamIds, matchMode = "all") {
  if (!teamIds.length) return [];
  const normalizedMatchMode = normalizeTeamMatchMode(matchMode);
  const matchClause = normalizedMatchMode === "all"
    ? `HAVING COUNT(DISTINCT user_teams.teamId) = ?`
    : "";
  const params = normalizedMatchMode === "all"
    ? [...teamIds, teamIds.length]
    : teamIds;
  return db
    .prepare(
      `SELECT users.id, users.username
       FROM users
       JOIN user_teams ON user_teams.userId = users.id
       WHERE users.role = 'scorer'
         AND users.status = 'enabled'
         AND user_teams.teamId IN (${placeholders(teamIds.length)})
         AND NOT EXISTS (
           SELECT 1
           FROM user_teams AS disabled_user_teams
           JOIN teams ON teams.id = disabled_user_teams.teamId
           WHERE disabled_user_teams.userId = users.id
             AND teams.status = 'disabled'
         )
       GROUP BY users.id, users.username
       ${matchClause}
       ORDER BY users.username COLLATE NOCASE ASC`,
    )
    .all(...params)
    .map((user) => ({ id: user.id, username: user.username }));
}

function deleteScorerUser(id) {
  const user = selectUserByIdStmt.get(String(id));
  if (!user || user.role !== "scorer") throw httpError(404, "打分账号不存在");
  const assignedTaskCount = selectAssignedTaskCountByScorerStmt.get(
    user.username,
  ).total;
  if (assignedTaskCount > 0) {
    throw httpError(
      409,
      `该账号仍有 ${assignedTaskCount} 个未完成任务，请先重新分配任务`,
    );
  }
  const result = deleteScorerUserStmt.run(String(id));
  if (result.changes === 0) throw httpError(404, "打分账号不存在");
  return { deleted: true };
}

function deterministicTaskId(projectId, taskType, imageIds) {
  const imageKey = [...imageIds].sort().join("|");
  return crypto
    .createHash("sha256")
    .update(`${projectId}|${taskVersion}|${taskType}|${imageKey}`)
    .digest("hex");
}

function seededShuffle(items, seedText) {
  const output = [...items];
  const seedBytes = crypto.createHash("sha256").update(seedText).digest();
  let state = seedBytes.readUInt32BE(0) || 1;

  const nextRandom = () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state / 0x100000000;
  };

  for (let index = output.length - 1; index > 0; index--) {
    const swapIndex = Math.floor(nextRandom() * (index + 1));
    [output[index], output[swapIndex]] = [output[swapIndex], output[index]];
  }
  return output;
}

function dimensionTaskType(projectId, packageId, criterion) {
  const baseType = `dimension:${criterion}`;
  // Legacy projects use the original key. New projects can safely share a
  // package because the legacy unique index also sees the project suffix.
  return projectId === packageId ? baseType : `${baseType}:project:${projectId}`;
}

async function hydrateSubjectTaskTemplates(templates) {
  if (!templates.length) return [];

  const templateIds = templates.map((template) => template.id);
  // SQLite limits the number of bound variables in one statement. Large
  // imports can contain over 100k templates, so load their items in batches.
  const itemRows = [];
  const itemRowsStmtCache = new Map();
  for (let start = 0; start < templateIds.length; start += 500) {
    const batch = templateIds.slice(start, start + 500);
    let stmt = itemRowsStmtCache.get(batch.length);
    if (!stmt) {
      stmt = db.prepare(
        `SELECT templateId, imageId, position, role
         FROM subject_task_template_items
         WHERE templateId IN (${placeholders(batch.length)})
         ORDER BY templateId ASC, position ASC, imageId ASC`,
      );
      itemRowsStmtCache.set(batch.length, stmt);
    }
    itemRows.push(...stmt.all(...batch));
    if (start + batch.length < templateIds.length) {
      await yieldToEventLoop();
    }
  }
  const itemsByTemplateId = new Map();
  itemRows.forEach((item) => {
    const items = itemsByTemplateId.get(item.templateId) || [];
    items.push(item);
    itemsByTemplateId.set(item.templateId, items);
  });

  return templates.map((template) => ({
    ...template,
    items: itemsByTemplateId.get(template.id) || [],
  }));
}

async function loadSubjectTaskTemplates(subjectId, limit = null) {
  const templates = limit == null
    ? selectSubjectTaskTemplatesStmt.all(subjectId)
    : db.prepare(`
        SELECT id, subjectId, sourceTaskId, round, criterion, imageKey, selectionKey
        FROM subject_task_templates
        WHERE subjectId = ?
        ORDER BY selectionKey ASC, id ASC
        LIMIT ?
      `).all(subjectId, limit);
  return hydrateSubjectTaskTemplates(templates);
}

async function loadProjectTaskTemplates(projectId) {
  const project = selectProjectByIdStmt.get(projectId);
  if (!project) throw httpError(404, "项目不存在");
  const packageIds = projectPackageIds(project);
  if (!packageIds.length) return [];

  const templates = [];
  for (const packageId of packageIds) {
    const packageTemplates = await loadSubjectTaskTemplates(packageId);
    templates.push(...packageTemplates.map((template) => ({
      ...template,
      packageId,
    })));
    await yieldToEventLoop();
  }
  return templates;
}

async function loadUnmaterializedProjectTaskTemplates(projectId, limit) {
  const requestedLimit = Math.max(0, Math.floor(Number(limit) || 0));
  if (!requestedLimit) return [];

  const project = selectProjectByIdStmt.get(projectId);
  if (!project) throw httpError(404, "项目不存在");
  const packageIds = projectPackageIds(project);
  if (!packageIds.length) return [];

  const templates = db.prepare(`
    SELECT
      subject_task_templates.id,
      subject_task_templates.subjectId,
      subject_task_templates.sourceTaskId,
      subject_task_templates.round,
      subject_task_templates.criterion,
      subject_task_templates.imageKey
    FROM subject_task_templates
    LEFT JOIN rating_tasks
      ON rating_tasks.projectId = ?
     AND rating_tasks.taskVersion = ?
     AND rating_tasks.subjectId = subject_task_templates.subjectId
     AND rating_tasks.round = subject_task_templates.round
     AND rating_tasks.taskType = CASE
       WHEN subject_task_templates.subjectId = ?
         THEN 'dimension:' || subject_task_templates.criterion
       ELSE 'dimension:' || subject_task_templates.criterion || ':project:' || ?
     END
     AND rating_tasks.imageKey = subject_task_templates.imageKey
    WHERE subject_task_templates.subjectId IN (${placeholders(packageIds.length)})
      AND rating_tasks.id IS NULL
    ORDER BY subject_task_templates.selectionKey ASC,
             subject_task_templates.id ASC
    LIMIT ?
  `).all(projectId, taskVersion, projectId, projectId, ...packageIds, requestedLimit);

  return (await hydrateSubjectTaskTemplates(templates)).map((template) => ({
    ...template,
    packageId: template.subjectId,
  }));
}

function insertTemplateTask(projectId, packageId, template) {
  const imageIds = template.items.map((item) => item.imageId);
  const taskType = dimensionTaskType(projectId, packageId, template.criterion);
  const id = deterministicTaskId(projectId, taskType, imageIds);
  const now = nowIso();
  const result = insertRatingTaskStmt.run({
    id,
    subjectId: packageId,
    projectId,
    taskVersion,
    round: Number(template.round || 1),
    taskType,
    assignmentKey: crypto.randomInt(1, 2147483647),
    imageKey: template.imageKey,
    createdAt: now,
    updatedAt: now,
  });
  if (result.changes === 0) return null;

  template.items.forEach((item) => {
    insertRatingTaskItemStmt.run({
      taskId: id,
      imageId: item.imageId,
      position: item.position,
      role: item.role,
    });
  });
  return id;
}

function parseTaskPagination(query = {}) {
  const page = Math.max(Math.floor(Number(query.page) || 1), 1);
  const pageSize = Math.min(
    Math.max(Math.floor(Number(query.pageSize) || 10), 1),
    100,
  );
  return { page, pageSize };
}

function hasPaginationQuery(query = {}) {
  return Object.hasOwn(query, "page") || Object.hasOwn(query, "pageSize");
}

function parseTaskCursor(value) {
  if (!value) return null;
  let parsed;
  try {
    parsed = typeof value === "string" ? JSON.parse(value) : value;
  } catch {
    throw httpError(400, "浠诲姟鍒嗛〉游标格式不正确");
  }
  const taskType = String(parsed?.taskType ?? "");
  const createdAt = String(parsed?.createdAt ?? "");
  const id = String(parsed?.id ?? "");
  const criterionOrder = Number(parsed?.criterionOrder);
  if (!taskType || !createdAt || !id) {
    throw httpError(400, "浠诲姟鍒嗛〉游标格式不正确");
  }
  return {
    taskType,
    createdAt,
    id,
    criterionOrder: Number.isFinite(criterionOrder) ? criterionOrder : null,
  };
}

function serializeTaskCursor(row, criterionOrder = null) {
  return JSON.stringify({
    taskType: row.taskType,
    createdAt: row.createdAt,
    id: row.id,
    ...(criterionOrder == null ? {} : { criterionOrder }),
  });
}

function includeTaskTotal(query = {}) {
  return ["1", "true", "yes"].includes(
    String(query.includeTotal ?? "").toLowerCase(),
  );
}

function escapeSqlLike(value) {
  return String(value).replace(/[\\%_]/g, (char) => `\\${char}`);
}

function parseOptionalDateFilter(value, label) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) throw httpError(400, `${label}不正确`);
  return date.toISOString();
}

function parseQueryList(value) {
  const values = Array.isArray(value) ? value : [value];
  return values
    .flatMap((item) => String(item ?? "").split(","))
    .map((item) => item.trim())
    .filter(Boolean);
}

function placeholders(length) {
  return Array.from({ length }, () => "?").join(", ");
}

function parseStoredTaskImageIds(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return [
      ...new Set(
        parsed.map((item) => String(item ?? "").trim()).filter(Boolean),
      ),
    ];
  } catch {
    return [];
  }
}

function parseStoredTaskRankingRelations(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    if (
      !Array.isArray(parsed) ||
      parsed.some((item) => ![">", "="].includes(item))
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function hydrateTaskRows(rows) {
  const taskIds = rows.map((row) => row.id);
  const itemsByTaskId = new Map();

  if (taskIds.length) {
    const taskIdPlaceholders = placeholders(taskIds.length);
    const itemRows = db
      .prepare(
        `
      SELECT taskId, imageId, position, role
      FROM rating_task_items
      WHERE taskId IN (${taskIdPlaceholders})
      ORDER BY taskId ASC, position ASC
    `,
      )
      .all(...taskIds);
    const imageIds = [...new Set(itemRows.map((item) => item.imageId))];
    const imageById = new Map();

    if (imageIds.length) {
      const imageRows = db
        .prepare(
          `
        SELECT ${taskImageSelectColumns}
        FROM images
        WHERE id IN (${placeholders(imageIds.length)})
      `,
      )
      .all(...imageIds);
      imageRows.forEach((image) =>
        imageById.set(image._id, taskImageDto(image)),
      );
    }

    itemRows.forEach((item) => {
      const image = imageById.get(item.imageId);
      if (!image) return;
      const currentItems = itemsByTaskId.get(item.taskId) || [];
      currentItems.push({
        imageId: item.imageId,
        position: item.position,
        role: item.role,
        image,
      });
      itemsByTaskId.set(item.taskId, currentItems);
    });
  }

  return rows.map((row) => ({
    id: row.id,
    subjectId: row.subjectId,
    projectId: row.projectId || row.subjectId,
    subjectName: row.subjectName ?? null,
    taskVersion: row.taskVersion,
    taskType: row.taskType,
    criterion: row.taskType.split(":")[1] || null,
    status: row.status,
    scorer: row.scorer,
    ranking: row.ranking ? JSON.parse(row.ranking) : null,
    excludedImageIds: parseStoredTaskImageIds(row.excludedImageIds),
    correctImageIds: parseStoredTaskImageIds(row.correctImageIds),
    rankingRelations: parseStoredTaskRankingRelations(row.rankingRelations),
    submissionMode: row.submissionMode || null,
    rankingActionCount: Number(row.rankingActionCount || 0),
    startedAt: row.startedAt ?? null,
    completedAt: row.completedAt ?? null,
    durationMs: row.durationMs ?? null,
    editedAt: row.editedAt ?? null,
    editCount: Number(row.editCount || 0),
    rollbackCount: Number(row.rollbackCount || 0),
    lastRolledBackAt: row.lastRolledBackAt ?? null,
    lastRolledBackBy: row.lastRolledBackBy ?? null,
    imageKey: row.imageKey,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    items: itemsByTaskId.get(row.id) || [],
  }));
}

const adminDashboardService = createAdminDashboardService({
  db,
  taskVersion,
  httpError,
  nowIso,
  normalizeTeamIds,
  parseProjectId,
  parseTaskPagination,
  hydrateTaskRows,
  selectUserByIdStmt,
  selectScorerByUsernameStmt,
  selectTeamByIdStmt,
});
const {
  listAdminDashboard,
  getDashboardStats,
  getDashboardProjectSection,
  getDashboardCharts,
  getDashboardAverageDuration,
  getDashboardWorkloadSection,
  exportCompletedTasks,
  exportScorerTaskSummary,
  exportTeamTaskSummary,
} = adminDashboardService;

const adminScoringService = createAdminScoringService({
  db,
  taskVersion,
  httpError,
  nowIso,
  parseProjectId,
  parseTaskPagination,
});
const {
  listScoringSummary,
  listScoringTaskRecords,
  previewRollback,
  startRollbackJob,
  getRollbackJob,
  rollbackJobDto,
} = adminScoringService;

function hydrateTaskListRows(rows) {
  const taskIds = rows.map((row) => row.id);
  const itemsByTaskId = new Map();

  if (taskIds.length) {
    const taskIdPlaceholders = placeholders(taskIds.length);
    const itemRows = db
      .prepare(
        `
      SELECT taskId, imageId, position
      FROM rating_task_items
      WHERE taskId IN (${taskIdPlaceholders})
      ORDER BY taskId ASC, position ASC
    `,
      )
      .all(...taskIds);
    const imageIds = [...new Set(itemRows.map((item) => item.imageId))];
    const imageById = new Map();

    if (imageIds.length) {
      const imageRows = db
        .prepare(
          `
        SELECT ${taskListImageSelectColumns}
        FROM images
        WHERE id IN (${placeholders(imageIds.length)})
      `,
        )
        .all(...imageIds);
      imageRows.forEach((image) =>
        imageById.set(image._id, taskListImageDto(image)),
      );
    }

    itemRows.forEach((item) => {
      const image = imageById.get(item.imageId);
      if (!image) return;
      const currentItems = itemsByTaskId.get(item.taskId) || [];
      currentItems.push({
        position: item.position,
        image,
      });
      itemsByTaskId.set(item.taskId, currentItems);
    });
  }

  return rows.map((row) => ({
    ...row,
    items: itemsByTaskId.get(row.id) || [],
  }));
}

function buildSubjectTaskFilter(projectId, query = {}) {
  const clauses = ["projectId = ?", "taskVersion = ?"];
  const params = [projectId, taskVersion];
  const status = String(query.status || "");
  const scorer = parseScorerName(query.scorer);
  const criterion = String(query.criterion || "");

  if (["pending", "assigned", "completed"].includes(status)) {
    clauses.push("status = ?");
    params.push(status);
  }
  if (scorer) {
    clauses.push("scorer = ?");
    params.push(scorer);
  }
  if (taskCriteria.includes(criterion)) {
    const taskType = `dimension:${criterion}`;
    clauses.push("(taskType = ? OR taskType LIKE ?)");
    params.push(taskType, `${taskType}:%`);
  }

  return {
    where: `WHERE ${clauses.join(" AND ")}`,
    params,
  };
}

function listSubjectTaskOptions(projectId) {
  const scorers = db
    .prepare(
      `SELECT DISTINCT scorer
       FROM rating_tasks
       WHERE projectId = ? AND taskVersion = ? AND scorer IS NOT NULL AND scorer <> ''
       ORDER BY scorer COLLATE NOCASE ASC`,
    )
    .all(projectId, taskVersion)
    .map((row) => row.scorer);

  return { scorers };
}

function listSubjectTasks(projectId, query = {}) {
  const { page, pageSize } = parseTaskPagination(query);
  const filter = buildSubjectTaskFilter(projectId, query);
  const cursor = parseTaskCursor(query.cursor);
  const cursorWhere = cursor
    ? ` AND (
         taskType > ?
         OR (
           taskType = ?
           AND (
             createdAt > ?
             OR (createdAt = ? AND id > ?)
           )
         )
       )`
    : "";
  const statusKey = ["pending", "assigned", "completed"].includes(query.status)
    ? query.status
    : "total";
  const statsTotal =
    !query.scorer && !query.criterion
      ? getProjectTaskStats(projectId)[statusKey]
      : null;
  const total = statsTotal != null
    ? statsTotal
    : includeTaskTotal(query)
      ? db
        .prepare(`SELECT COUNT(*) AS total FROM rating_tasks ${filter.where}`)
        .get(...filter.params).total
      : null;
  const rows = db
    .prepare(
      `SELECT id, taskType, status, scorer, createdAt
       FROM rating_tasks
       ${filter.where}
       ${cursorWhere}
       ORDER BY taskType ASC, createdAt ASC, id ASC
       LIMIT ?${cursor ? "" : " OFFSET ?"}`,
    )
    .all(
      ...filter.params,
      ...(cursor
        ? [cursor.taskType, cursor.taskType, cursor.createdAt, cursor.createdAt, cursor.id]
        : []),
      pageSize + 1,
      ...(cursor ? [] : [(page - 1) * pageSize]),
    );
  const hasMore = rows.length > pageSize;
  const pageRows = rows.slice(0, pageSize);
  const lastRow = pageRows[pageRows.length - 1];

  return {
    total,
    page,
    pageSize,
    hasMore,
    nextCursor: hasMore && lastRow ? serializeTaskCursor(lastRow) : null,
    tasks: hydrateTaskListRows(pageRows).map((row) => ({
      id: row.id,
      criterion: row.taskType.split(":")[1] || null,
      status: row.status,
      scorer: row.scorer,
      createdAt: row.createdAt,
      items: row.items,
    })),
  };
}

function taskCriterionLabel(taskType) {
  const criterion = String(taskType || "").split(":")[1] || "";
  return taskCriterionLabels[criterion] || criterion || "未指定维度";
}

function orderedTaskItems(task) {
  const itemByImageId = new Map(task.items.map((item) => [item.imageId, item]));
  const excludedImageIds = new Set(task.excludedImageIds || []);
  const ordered = [];
  const used = new Set();

  if (Array.isArray(task.ranking)) {
    task.ranking.forEach((imageId) => {
      if (excludedImageIds.has(imageId)) return;
      const item = itemByImageId.get(imageId);
      if (!item || used.has(imageId)) return;
      ordered.push(item);
      used.add(imageId);
    });
  }

  task.items
    .slice()
    .sort((left, right) => left.position - right.position)
    .forEach((item) => {
      if (excludedImageIds.has(item.imageId)) return;
      if (used.has(item.imageId)) return;
      ordered.push(item);
      used.add(item.imageId);
    });
  return ordered;
}

function reportCompletionRate(completed, total) {
  return total ? completed / total : 0;
}

function addReportSheet(workbook, name, headers, rows, widths) {
  const worksheet = workbook.addWorksheet(name, {
    views: [{ state: "frozen", ySplit: 1 }],
  });
  worksheet.columns = headers.map((header, index) => ({
    header,
    width: widths?.[index] || 16,
  }));
  const headerRow = worksheet.getRow(1);
  headerRow.height = 24;
  headerRow.font = { bold: true, color: { argb: "FFFFFFFF" } };
  headerRow.alignment = { vertical: "middle", horizontal: "center" };
  headerRow.eachCell((cell) => {
    cell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FF1E293B" },
    };
  });

  rows.forEach((values) => {
    const row = worksheet.addRow(values.map((value) => value ?? ""));
    row.alignment = { vertical: "middle", wrapText: true };
  });
  worksheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: headers.length },
  };
  return worksheet;
}

function getSubjectTaskReportSummary(subjectId) {
  const cached = subjectTaskReportCache.get(subjectId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const project = getProjectOrThrow(subjectId);
  const packageIds = projectPackageIds(project);

  const imageStats = db
    .prepare(
      `SELECT COUNT(*) AS imageCount,
               COUNT(DISTINCT category) AS categoryCount
       FROM images
       WHERE subjectId IN (${placeholders(packageIds.length)})`,
    )
    .get(...packageIds);
  const taskStats = getProjectTaskStats(subjectId);
  const statusCounts = {
    pending: taskStats.pending,
    assigned: taskStats.assigned,
    completed: taskStats.completed,
  };

  const dimensionRows = db
    .prepare(
      `SELECT taskType, status, COUNT(*) AS count
       FROM rating_tasks
       WHERE projectId = ? AND taskVersion = ?
       GROUP BY taskType, status
       ORDER BY taskType ASC`,
    )
    .all(subjectId, taskVersion);
  const dimensionMap = new Map();
  dimensionRows.forEach((row) => {
    const key = row.taskType;
    const item = dimensionMap.get(key) || {
      key: row.taskType,
      criterion: String(row.taskType || "").split(":")[1] || "",
      label: taskCriterionLabel(row.taskType),
      total: 0,
      pending: 0,
      assigned: 0,
      completed: 0,
    };
    item[row.status] = (item[row.status] || 0) + row.count;
    item.total += row.count;
    dimensionMap.set(key, item);
  });

  const scorerRows = db
    .prepare(
      `SELECT COALESCE(NULLIF(TRIM(scorer), ''), '未分配') AS scorer,
              status, COUNT(*) AS count,
              AVG(CASE WHEN durationMs >= 0 THEN durationMs END) AS averageDurationMs
       FROM rating_tasks
       WHERE projectId = ? AND taskVersion = ?
       GROUP BY COALESCE(NULLIF(TRIM(scorer), ''), '未分配'), status`,
    )
    .all(subjectId, taskVersion);
  const scorerCriteriaRows = db
    .prepare(
      `SELECT DISTINCT COALESCE(NULLIF(TRIM(scorer), ''), '未分配') AS scorer,
              taskType
       FROM rating_tasks
       WHERE projectId = ? AND taskVersion = ?
       ORDER BY scorer COLLATE NOCASE, taskType ASC`,
    )
    .all(subjectId, taskVersion);
  const scorerMap = new Map();
  scorerRows.forEach((row) => {
    const item = scorerMap.get(row.scorer) || {
      scorer: row.scorer,
      total: 0,
      pending: 0,
      assigned: 0,
      completed: 0,
      averageDurationMs: null,
      criteria: new Set(),
    };
    item[row.status] = (item[row.status] || 0) + row.count;
    item.total += row.count;
    if (row.averageDurationMs != null)
      item.averageDurationMs = row.averageDurationMs;
    scorerMap.set(row.scorer, item);
  });
  scorerCriteriaRows.forEach((row) => {
    const item = scorerMap.get(row.scorer);
    if (item) item.criteria.add(String(row.taskType || "").split(":")[1] || "");
  });

  const totalTasks = taskStats.total;
  const completedTasks = statusCounts.completed;
  const dimensions = [...dimensionMap.values()].map((item) => ({
    ...item,
    completionRate: reportCompletionRate(item.completed, item.total),
  }));
  const scorers = [...scorerMap.values()]
    .sort((left, right) => left.scorer.localeCompare(right.scorer))
    .map((item) => ({
      scorer: item.scorer,
      total: item.total,
      pending: item.pending,
      assigned: item.assigned,
      uncompleted: item.pending + item.assigned,
      completed: item.completed,
      completionRate: reportCompletionRate(item.completed, item.total),
      dimensions: [...item.criteria].filter(Boolean).map((criterion) => ({
        key: criterion,
        label: taskCriterionLabel(`dimension:${criterion}`),
      })),
      averageDurationSeconds:
        item.averageDurationMs == null ? null : item.averageDurationMs / 1000,
    }));

  const report = {
    subject: { _id: project._id, name: project.name },
    imageCount: imageStats.imageCount,
    categoryCount: imageStats.categoryCount,
    criterionCount: new Set(
      dimensions.map((item) => item.criterion).filter(Boolean),
    ).size,
    totalTasks,
    statusCounts,
    completedTasks,
    completionRate: reportCompletionRate(completedTasks, totalTasks),
    scorerCount: scorers.filter((item) => item.scorer !== "未分配").length,
    dimensions,
    scorers,
  };
  subjectTaskReportCache.set(subjectId, {
    value: report,
    expiresAt: Date.now() + subjectTaskReportCacheTtlMs,
  });
  return report;
}

async function exportSubjectTaskReport(subjectId, res) {
  const report = getSubjectTaskReportSummary(subjectId);
  const subject = report.subject;
  const imageStats = {
    imageCount: report.imageCount,
    categoryCount: report.categoryCount,
  };
  const statusCounts = report.statusCounts;
  const totalTasks = report.totalTasks;
  const completedTasks = report.completedTasks;
  const dimensionStats = report.dimensions;
  const scorerStats = report.scorers;
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "评分平台";
  workbook.created = new Date();

  addReportSheet(
    workbook,
    "项目总览",
    ["统计项", "数值"],
    [
      ["项目名称", subject.name],
      ["项目 ID", subject._id],
      ["图片总数", imageStats.imageCount],
      ["目录分类数", imageStats.categoryCount],
      ["评分维度数", report.criterionCount],
      ["任务总数", totalTasks],
      ["待分配任务", statusCounts.pending],
      ["未完成任务", statusCounts.assigned],
      ["已完成任务", completedTasks],
      ["任务完成率", reportCompletionRate(completedTasks, totalTasks)],
      ["打分人数量", report.scorerCount],
      ["导出时间", new Date().toLocaleString()],
    ],
    [24, 46],
  ).getCell(11, 2).numFmt = "0.00%";

  addReportSheet(
    workbook,
    "状态汇总",
    ["任务状态", "任务数量", "占比"],
    [
      [
        "待分配",
        statusCounts.pending,
        reportCompletionRate(statusCounts.pending, totalTasks),
      ],
      [
        "未完成",
        statusCounts.assigned,
        reportCompletionRate(statusCounts.assigned, totalTasks),
      ],
      [
        "已完成",
        completedTasks,
        reportCompletionRate(completedTasks, totalTasks),
      ],
    ],
    [18, 16, 16],
  ).getColumn(3).numFmt = "0.00%";

  const dimensionRows = dimensionStats.map((item) => [
    item.label,
    item.criterion,
    item.total,
    item.pending,
    item.assigned,
    item.completed,
    reportCompletionRate(item.completed, item.total),
  ]);
  addReportSheet(
    workbook,
    "维度统计",
    [
      "评分维度",
      "维度键",
      "任务总数",
      "待分配",
      "未完成",
      "已完成",
      "完成率",
    ],
    dimensionRows,
    [28, 24, 10, 14, 14, 14, 14],
  ).getColumn(7).numFmt = "0.00%";

  const scorerRows = scorerStats.map((item) => [
    item.scorer,
    item.total,
    item.pending,
    item.assigned,
    item.pending + item.assigned,
    item.completed,
    reportCompletionRate(item.completed, item.total),
    item.dimensions.map((dimension) => dimension.label).join("、"),
    item.averageDurationSeconds,
  ]);
  addReportSheet(
    workbook,
    "打分人统计",
    [
      "打分人",
      "任务总数",
      "待分配",
      "已分配未完成",
      "未完成合计",
      "已完成",
      "完成率",
      "涉及维度",
      "平均打分时长(秒)",
    ],
    scorerRows,
    [18, 14, 14, 18, 16, 14, 14, 52, 22],
  ).getColumn(7).numFmt = "0.00%";

  const filename = `task-report-${new Date()
    .toISOString()
    .replace(/[:.]/g, "-")}.xlsx`;
  const file = Buffer.from(await workbook.xlsx.writeBuffer());
  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  );
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(file);
}

function scorerTaskScope(query = {}) {
  const scorer = parseScorerName(query.scorer);
  if (!scorer) throw httpError(400, "缺少打分人");
  const projectId = query.projectId ? parseProjectId(query.projectId) : null;
  if (!selectScorerByUsernameStmt.get(scorer))
    throw httpError(404, "打分账号不存在");
  return { scorer, projectId };
}

function buildScorerTaskFilter(query = {}) {
  const { scorer, projectId } = scorerTaskScope(query);
  const clauses = ["rating_tasks.taskVersion = ?", "rating_tasks.scorer = ?"];
  const params = [taskVersion, scorer];
  const status = String(query.status || "");
  const criterion = String(query.criterion || "");

  if (["assigned", "completed"].includes(status)) {
    clauses.push("rating_tasks.status = ?");
    params.push(status);
  } else {
    clauses.push("rating_tasks.status IN ('assigned', 'completed')");
  }
  if (projectId) {
    clauses.push("rating_tasks.projectId = ?");
    params.push(projectId);
  }
  if (taskCriteria.includes(criterion)) {
    const taskType = `dimension:${criterion}`;
    clauses.push("(rating_tasks.taskType = ? OR rating_tasks.taskType LIKE ?)");
    params.push(taskType, `${taskType}:%`);
  }
  return { where: `WHERE ${clauses.join(" AND ")}`, params };
}

function getScorerTaskOptions(query = {}) {
  scorerTaskScope(query);
  return {};
}

function taskCriterionOrderSql(column) {
  const cases = taskCriteria
    .map((criterion, index) => {
      const taskType = `dimension:${criterion}`;
      return `WHEN ${column} = '${taskType}' OR ${column} LIKE '${taskType}:%' THEN ${index}`;
    })
    .join(" ");
  return `CASE ${cases} ELSE ${taskCriteria.length} END`;
}

function listAssignedTasks(query = {}) {
  const filter = buildScorerTaskFilter(query);
  const { page, pageSize } = parseTaskPagination(query);
  const criterionOrder = taskCriterionOrderSql("rating_tasks.taskType");
  const cursor = parseTaskCursor(query.cursor);
  const cursorOrder = cursor?.criterionOrder;
  const useCursor = Boolean(cursor && cursorOrder != null);
  const cursorWhere = useCursor
    ? ` AND (
         (${criterionOrder}) > ?
         OR (
           (${criterionOrder}) = ?
           AND (
             rating_tasks.createdAt > ?
             OR (rating_tasks.createdAt = ? AND rating_tasks.id > ?)
           )
         )
       )`
    : "";
  const total = includeTaskTotal(query)
    ? db
      .prepare(`SELECT COUNT(*) AS total FROM rating_tasks ${filter.where}`)
      .get(...filter.params).total
    : null;
  const rows = db
    .prepare(
      `SELECT rating_tasks.id, rating_tasks.subjectId, rating_tasks.projectId,
              rating_tasks.taskType, rating_tasks.status,
              rating_tasks.createdAt,
              ${criterionOrder} AS criterionOrder,
              projects.name AS subjectName
       FROM rating_tasks
       JOIN projects ON projects.id = rating_tasks.projectId
       ${filter.where}
       ${cursorWhere}
       ORDER BY ${criterionOrder} ASC,
                rating_tasks.createdAt ASC,
                rating_tasks.id ASC
       LIMIT ?${useCursor ? "" : " OFFSET ?"}`,
    )
    .all(
      ...filter.params,
      ...(!useCursor
        ? []
        : [cursorOrder, cursorOrder, cursor.createdAt, cursor.createdAt, cursor.id]),
      pageSize + 1,
      ...(useCursor ? [] : [(page - 1) * pageSize]),
    );
  const hasMore = rows.length > pageSize;
  const pageRows = rows.slice(0, pageSize);
  const lastRow = pageRows[pageRows.length - 1];

  return {
    total,
    page,
    pageSize,
    hasMore,
    nextCursor: hasMore && lastRow
      ? serializeTaskCursor(lastRow, Number(lastRow.criterionOrder))
      : null,
    tasks: hydrateTaskListRows(pageRows).map((row) => ({
      id: row.id,
      subjectId: row.projectId || row.subjectId,
      projectId: row.projectId || row.subjectId,
      subjectName: row.subjectName ?? null,
      criterion: row.taskType.split(":")[1] || null,
      status: row.status,
      items: row.items,
    })),
  };
}

function getTaskDetail(taskId, { projectId = null, scorer = null } = {}) {
  const task = selectTaskByIdStmt.get(taskId);
  if (!task || task.taskVersion !== taskVersion) {
    throw httpError(404, "任务不存在");
  }
  if (projectId && (task.projectId || task.subjectId) !== projectId) {
    throw httpError(404, "任务不存在");
  }
  if (scorer && task.scorer !== scorer) {
    throw httpError(403, "无权查看该任务");
  }
  if (scorer && !["assigned", "completed"].includes(task.status)) {
    throw httpError(403, "当前任务不可查看");
  }
  return hydrateTaskRows([task])[0];
}

const scorerDashboardCache = new Map();
const scorerDashboardCacheTtlMs = 2 * 1000;

function getScorerDashboard(query = {}) {
  const scorer = parseScorerName(query.scorer);
  if (!scorer) throw httpError(400, "缺少打分人");
  const projectId = query.projectId ? parseProjectId(query.projectId) : null;
  if (!selectScorerByUsernameStmt.get(scorer))
    throw httpError(404, "打分账号不存在");

  const cacheKey = `${scorer}:${projectId || "all"}`;
  const cached = scorerDashboardCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const stats = selectScorerTaskStatsStmt.get(
    taskVersion,
    scorer,
    projectId,
    projectId,
  );
  const pendingTasks = Number(stats.pendingTasks || 0);
  const completedTasks = Number(stats.completedTasks || 0);
  const totalTasks = pendingTasks + completedTasks;

  const value = {
    pendingTasks,
    completedTasks,
    totalTasks,
    projectCount: selectScorerProjectCountStmt.get(taskVersion, scorer).total,
    progress: totalTasks ? Math.round((completedTasks / totalTasks) * 100) : 0,
  };
  scorerDashboardCache.set(cacheKey, {
    value,
    expiresAt: Date.now() + scorerDashboardCacheTtlMs,
  });
  return value;
}

function parseTaskExcludedImageIds(value, taskImageIds, taskType) {
  if (!Array.isArray(value)) {
    if (value === undefined || value === null) return [];
    throw httpError(400, "Invalid excluded image list");
  }

  const excludedImageIds = value
    .map((imageId) => String(imageId ?? "").trim())
    .filter(Boolean);
  const expectedIds = new Set(taskImageIds);
  const criterion = String(taskType || "").split(":")[1] || "";
  if (excludedImageIds.length && !taskExclusionCriteria.has(criterion)) {
    throw httpError(400, "This criterion does not support image exclusion");
  }
  if (new Set(excludedImageIds).size !== excludedImageIds.length) {
    throw httpError(400, "Excluded image list contains duplicates");
  }
  if (excludedImageIds.some((imageId) => !expectedIds.has(imageId))) {
    throw httpError(
      400,
      "Excluded image list contains an image outside this task",
    );
  }
  return excludedImageIds;
}

function parseTaskCorrectImageIds(
  value,
  taskImageIds,
  taskType,
  excludedImageIds = [],
) {
  const criterion = String(taskType || "").split(":")[1] || "";
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw httpError(400, "确认正确的图片列表格式不正确");
  }

  const correctImageIds = value
    .map((imageId) => String(imageId ?? "").trim())
    .filter(Boolean);
  if (correctImageIds.length && !taskCorrectnessCriteria.has(criterion)) {
    throw httpError(400, "当前评分维度不支持确认正确");
  }
  if (new Set(correctImageIds).size !== correctImageIds.length) {
    throw httpError(400, "确认正确的图片列表包含重复图片");
  }
  const expectedIds = new Set(taskImageIds);
  if (correctImageIds.some((imageId) => !expectedIds.has(imageId))) {
    throw httpError(400, "确认正确的图片列表包含不属于该任务的图片");
  }
  const excluded = new Set(excludedImageIds);
  if (correctImageIds.some((imageId) => excluded.has(imageId))) {
    throw httpError(400, "同一图片不能同时确认正确和无需评价");
  }
  return correctImageIds;
}

function parseTaskRanking(
  value,
  taskImageIds,
  excludedImageIds = [],
  taskType = "",
) {
  if (!Array.isArray(value)) throw httpError(400, "请完成图片排序");
  const ranking = value
    .map((imageId) => String(imageId ?? "").trim())
    .filter(Boolean);
  const excluded = new Set(excludedImageIds);
  const expectedIds = new Set(
    taskImageIds.filter((imageId) => !excluded.has(imageId)),
  );
  if (
    ranking.length !== expectedIds.size ||
    new Set(ranking).size !== ranking.length
  )
    throw httpError(400, "排序结果不完整，请按任务图片完成排序");
  if (ranking.some((imageId) => !expectedIds.has(imageId)))
    throw httpError(400, "排序结果包含不属于该任务的图片");
  return ranking;
}

function parseTaskRankingRelations(value, ranking) {
  const expectedLength = Math.max(ranking.length - 1, 0);
  if (value === undefined || value === null) {
    return Array.from({ length: expectedLength }, () => ">");
  }
  if (
    !Array.isArray(value) ||
    value.length !== expectedLength ||
    value.some((relation) => relation !== ">" && relation !== "=")
  ) {
    throw httpError(400, "排序关系不完整，只支持 > 或 =");
  }
  return value;
}

function parseTaskDuration(value) {
  const durationMs = Math.round(Number(value));
  if (!Number.isFinite(durationMs) || durationMs < 0)
    throw httpError(400, "打分时长不正确");
  return Math.min(durationMs, 24 * 60 * 60 * 1000);
}

function parseRankingActionCount(value) {
  if (value === null || value === undefined || value === "") return 0;
  const count = Math.floor(Number(value));
  if (!Number.isFinite(count) || count < 0)
    throw httpError(400, "排序操作次数不正确");
  return Math.min(count, 100000);
}

function parseTaskSubmissionMode(value, rankingActionCount, trackingProvided = false) {
  const requested = String(value || "").trim();
  if (requested && !["direct", "ranked"].includes(requested)) {
    throw httpError(400, "提交方式不正确");
  }
  if (rankingActionCount > 0) return "ranked";
  if (requested) return requested;
  return trackingProvided ? "direct" : null;
}

function completeAssignedTask(taskId, body = {}) {
  const scorer = parseScorerName(body.scorer);
  if (!scorer) throw httpError(400, "缺少打分人");
  const task = selectTaskByIdStmt.get(taskId);
  if (!task) throw httpError(404, "任务不存在");
  if (task.status === "completed") throw httpError(409, "该任务已完成");
  if (task.status !== "assigned" || task.scorer !== scorer)
    throw httpError(403, "该任务未分配给当前打分人");
  if (body.projectId && String(body.projectId) !== (task.projectId || task.subjectId))
    throw httpError(400, "任务项目不匹配");

  const taskImageIds = selectTaskImageIdsStmt
    .all(task.id)
    .map((item) => item.imageId);
  const excludedImageIds = parseTaskExcludedImageIds(
    body.excludedImageIds,
    taskImageIds,
    task.taskType,
  );
  const correctImageIds = parseTaskCorrectImageIds(
    body.correctImageIds,
    taskImageIds,
    task.taskType,
    excludedImageIds,
  );
  const ranking = parseTaskRanking(
    body.ranking,
    taskImageIds,
    excludedImageIds,
    task.taskType,
  );
  const rankingRelations = parseTaskRankingRelations(
    body.rankingRelations,
    ranking,
  );
  const durationMs = parseTaskDuration(body.durationMs);
  const rankingActionCount = parseRankingActionCount(body.rankingActionCount);
  const submissionMode = parseTaskSubmissionMode(
    body.submissionMode,
    rankingActionCount,
    Object.hasOwn(body, "submissionMode") ||
      Object.hasOwn(body, "rankingActionCount"),
  );
  const completedAt = nowIso();
  const startedAt = new Date(Date.now() - durationMs).toISOString();
  const projectId = task.projectId || task.subjectId;

  db.exec("BEGIN IMMEDIATE");
  try {
    const result = completeAssignedTaskStmt.run({
      id: task.id,
      scorer,
      ranking: JSON.stringify(ranking),
      excludedImageIds: JSON.stringify(excludedImageIds),
      correctImageIds: JSON.stringify(correctImageIds),
      rankingRelations: JSON.stringify(rankingRelations),
      submissionMode,
      rankingActionCount,
      startedAt,
      completedAt,
      durationMs,
      updatedAt: completedAt,
    });
    if (result.changes === 0)
      throw httpError(409, "任务状态已变更，请刷新后重试");
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    throw error;
  }

  invalidateTaskSummaryCaches(projectId);
  queueProjectTaskSummary(projectId);
  const updated = selectTaskByIdStmt.get(task.id);
  return hydrateTaskRows([updated])[0];
}

function updateCompletedTask(taskId, body = {}) {
  const scorer = parseScorerName(body.scorer);
  if (!scorer) throw httpError(400, "缺少打分人");
  const task = selectTaskByIdStmt.get(taskId);
  if (!task) throw httpError(404, "任务不存在");
  if (task.status !== "completed" || task.scorer !== scorer)
    throw httpError(403, "只能修改已分配给当前打分人的已完成任务");
  if (body.projectId && String(body.projectId) !== (task.projectId || task.subjectId))
    throw httpError(400, "任务项目不匹配");

  const taskImageIds = selectTaskImageIdsStmt
    .all(task.id)
    .map((item) => item.imageId);
  const excludedImageIds = parseTaskExcludedImageIds(
    body.excludedImageIds,
    taskImageIds,
    task.taskType,
  );
  const correctImageIds = parseTaskCorrectImageIds(
    body.correctImageIds,
    taskImageIds,
    task.taskType,
    excludedImageIds,
  );
  const ranking = parseTaskRanking(
    body.ranking,
    taskImageIds,
    excludedImageIds,
    task.taskType,
  );
  const rankingRelations = parseTaskRankingRelations(
    body.rankingRelations,
    ranking,
  );
  parseTaskDuration(body.durationMs);
  const rankingActionCount = parseRankingActionCount(body.rankingActionCount);
  const submissionMode = parseTaskSubmissionMode(
    body.submissionMode,
    rankingActionCount,
    Object.hasOwn(body, "submissionMode") ||
      Object.hasOwn(body, "rankingActionCount"),
  );
  const editedAt = nowIso();

  db.exec("BEGIN IMMEDIATE");
  try {
    const result = updateCompletedTaskStmt.run({
      id: task.id,
      scorer,
      ranking: JSON.stringify(ranking),
      excludedImageIds: JSON.stringify(excludedImageIds),
      correctImageIds: JSON.stringify(correctImageIds),
      rankingRelations: JSON.stringify(rankingRelations),
      submissionMode,
      rankingActionCount,
      editedAt,
      updatedAt: editedAt,
    });
    if (result.changes === 0)
      throw httpError(409, "任务状态已变更，请刷新后重试");

    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    throw error;
  }

  invalidateTaskSummaryCaches(task.projectId || task.subjectId);
  const updated = selectTaskByIdStmt.get(task.id);
  return hydrateTaskRows([updated])[0];
}

function normalizeTaskAssigneeNames(value) {
  const rawNames = Array.isArray(value)
    ? value
    : String(value ?? "").split(",");
  return [
    ...new Set(
      rawNames
        .map((item) => String(item ?? "").trim())
        .filter(Boolean)
        .map(normalizeUsername),
    ),
  ];
}

function parseTaskAssignees(value) {
  const names = normalizeTaskAssigneeNames(value);
  if (!names.length) throw httpError(400, "请选择打分人");

  const users = names.map((name) => selectScorerByUsernameStmt.get(name));
  const missing = names.filter((_, index) => !users[index]);
  if (missing.length)
    throw httpError(400, `打分人不存在：${missing.join("、")}`);
  users.forEach((user, index) => {
    assertScorerAssignable(user, names[index]);
  });
  return { names };
}

function parseTaskGenerationAssignees(body = {}) {
  const teamIds = normalizeTeamIds(body.teamIds, {
    required: true,
    enabledOnly: true,
  });
  const teamMatchMode = normalizeTeamMatchMode(body.teamMatchMode);
  const availableUsers = listScorersByTeamIds(teamIds, teamMatchMode);
  if (!availableUsers.length) throw httpError(400, "所选团队没有可用的打分账号");

  if (!Array.isArray(body.allocations)) {
    throw httpError(400, "请设置打分人任务数量");
  }

  const availableNames = new Set(availableUsers.map((user) => user.username));
  const allocations = [];
  const seen = new Set();
  for (const item of body.allocations) {
    const scorer = normalizeUsername(item?.scorer);
    const taskCount = Number(item?.taskCount);
    if (seen.has(scorer)) throw httpError(400, `打分人 ${scorer} 重复设置`);
    seen.add(scorer);
    if (!availableNames.has(scorer)) {
      throw httpError(400, `打分人 ${scorer} 不属于所选团队`);
    }
    if (!Number.isInteger(taskCount) || taskCount < 0) {
      throw httpError(400, `打分人 ${scorer} 的任务数量必须是非负整数`);
    }
    if (taskCount > 0) allocations.push({ scorer, taskCount });
  }

  return { teamIds, teamMatchMode, allocations };
}

function normalizedAllocationHeader(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s_\-:：]/g, "");
}

function taskAllocationCellText(cell) {
  if (!cell) return "";
  const text = String(cell.text ?? "").trim();
  if (text) return text;
  const value = cell.value;
  if (value == null) return "";
  if (typeof value === "object") {
    if ("result" in value) return String(value.result ?? "").trim();
    if ("text" in value) return String(value.text ?? "").trim();
    if ("richText" in value && Array.isArray(value.richText)) {
      return value.richText.map((item) => item.text || "").join("").trim();
    }
  }
  return String(value).trim();
}

function parseAllocationTaskCount(value) {
  const text = String(value ?? "").replace(/,/g, "").trim();
  if (!text) return null;
  const count = Number(text);
  if (!Number.isFinite(count) || !Number.isInteger(count) || count < 0) {
    return null;
  }
  return count;
}

async function parseTaskAllocationWorkbook(file) {
  if (!file) throw httpError(400, "请选择分配表");
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(file.buffer);
  } catch (error) {
    throw httpError(422, "分配表无法读取，请确认文件为 XLSX 格式", error);
  }
  const worksheet = workbook.worksheets[0];
  if (!worksheet) throw httpError(422, "分配表没有可读取的工作表");

  const scorerHeaders = new Set([
    "打分人",
    "打分人名字",
    "打分账号",
    "账号",
    "用户名",
    "姓名",
    "名字",
    "name",
    "username",
    "user",
    "scorer",
  ].map(normalizedAllocationHeader));
  const countHeaders = new Set([
    "数量",
    "任务数量",
    "任务数",
    "分配数量",
    "分配任务数",
    "count",
    "taskcount",
    "tasks",
    "number",
  ].map(normalizedAllocationHeader));

  let scorerColumn = 1;
  let countColumn = 2;
  let firstDataRow = 1;
  let hasHeader = false;

  const rows = [];
  worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    rows.push({ row, rowNumber });
  });

  for (const { row, rowNumber } of rows.slice(0, 10)) {
    const cells = [];
    for (let index = 1; index <= Math.max(row.cellCount, 8); index += 1) {
      cells.push({
        index,
        header: normalizedAllocationHeader(taskAllocationCellText(row.getCell(index))),
      });
    }
    const scorer = cells.find((cell) => scorerHeaders.has(cell.header));
    const count = cells.find((cell) => countHeaders.has(cell.header));
    if (scorer && count && scorer.index !== count.index) {
      scorerColumn = scorer.index;
      countColumn = count.index;
      firstDataRow = rowNumber + 1;
      hasHeader = true;
      break;
    }
  }

  const parsedRows = [];
  const errors = [];
  for (const { row, rowNumber } of rows) {
    if (rowNumber < firstDataRow) continue;
    const scorer = taskAllocationCellText(row.getCell(scorerColumn));
    const rawCount = taskAllocationCellText(row.getCell(countColumn));
    if (!scorer && !rawCount) continue;
    if (!scorer) {
      errors.push(`第 ${rowNumber} 行缺少打分人`);
      continue;
    }
    const taskCount = parseAllocationTaskCount(rawCount);
    if (taskCount == null) {
      errors.push(`第 ${rowNumber} 行任务数量无效`);
      continue;
    }
    parsedRows.push({ rowNumber, scorer, taskCount });
    if (parsedRows.length > 1000) {
      throw httpError(413, "分配表最多读取 1000 行");
    }
  }

  return {
    filename: file.originalname,
    hasHeader,
    scorerColumn,
    countColumn,
    rows: parsedRows,
    errors,
  };
}

function getTaskReassignmentOptions(subjectId) {
  getProjectOrThrow(subjectId);
  const stats = getProjectTaskStats(subjectId);

  return {
    users: selectAvailableSubjectScorersStmt.all(subjectId).map(userDto),
    availableTaskCount: stats.pending,
    sourceScorers: selectSubjectAssignedScorerCountsStmt
      .all(subjectId, taskVersion)
      .map((row) => ({ username: row.scorer, taskCount: row.taskCount })),
  };
}

function reassignSubjectTasks(subjectId, body = {}) {
  getProjectOrThrow(subjectId);

  const source = String(body.source || "");
  if (source !== "assigned_uncompleted" && source !== "selected_scorers") {
    throw httpError(400, "任务来源不正确");
  }

  const assignees = parseTaskAssignees(body.scorers);
  const existingScorers = new Set(
    selectSubjectScorerNamesStmt.all(subjectId).map((row) => row.scorer),
  );
  const existingAssignees = assignees.names.filter((name) =>
    existingScorers.has(name),
  );
  if (existingAssignees.length) {
    throw httpError(
      400,
      `以下账号已属于当前项目：${existingAssignees.join("、")}`,
    );
  }

  let taskCount = Number(body.taskCount);
  if (!Number.isInteger(taskCount) || taskCount < 1) {
    throw httpError(400, "任务数量必须为正整数");
  }
  if (source === "assigned_uncompleted" && taskCount < assignees.names.length) {
    throw httpError(400, "任务数量不能少于所选打分人数");
  }

  const availableTaskCount = source === "assigned_uncompleted"
    ? getProjectTaskStats(subjectId).pending
    : getProjectTaskStats(subjectId).assigned;
  let assignmentPlan = null;
  if (source === "assigned_uncompleted") {
    if (!Array.isArray(body.allocations)) {
      throw httpError(400, "请按打分人分别设置任务数量");
    }
    const allocationMap = new Map();
    body.allocations.forEach((item) => {
      const scorer = normalizeUsername(item?.scorer);
      const count = Number(item?.taskCount);
      if (!assignees.names.includes(scorer)) {
        throw httpError(400, `打分人 ${scorer} 不在本次新增账号列表中`);
      }
      if (allocationMap.has(scorer)) {
        throw httpError(400, `打分人 ${scorer} 重复设置`);
      }
      if (!Number.isInteger(count) || count < 0) {
        throw httpError(400, `打分人 ${scorer} 的任务数量必须是非负整数`);
      }
      allocationMap.set(scorer, count);
    });
    const allocations = assignees.names.map((scorer) => ({
      scorer,
      taskCount: allocationMap.get(scorer) ?? 0,
    }));
    taskCount = allocations.reduce(
      (total, allocation) => total + allocation.taskCount,
      0,
    );
    if (!taskCount) {
      throw httpError(400, "请至少为一名打分人设置任务数量");
    }
    assignmentPlan = allocations.flatMap(({ scorer, taskCount: count }) =>
      Array.from({ length: count }, () => scorer),
    );
  }
  let selectedTasks;
  if (source === "assigned_uncompleted") {
    const candidates = selectReassignableTaskIdsStmt.all(
      subjectId,
      taskVersion,
      taskCount,
    );
    if (taskCount > candidates.length) {
      throw httpError(400, `任务数量不能超过 ${candidates.length}`);
    }

    selectedTasks = candidates;
  } else {
    const sourceScorers = [
      ...new Set(
        (Array.isArray(body.sourceScorers)
          ? body.sourceScorers
          : String(body.sourceScorers || "").split(",")
        )
          .filter(Boolean)
          .map(normalizeUsername),
      ),
    ];
    if (!sourceScorers.length) {
      throw httpError(400, "请选择已分配打分人");
    }

    const sourceCounts = new Map(
      selectSubjectAssignedScorerCountsStmt
        .all(subjectId, taskVersion)
        .map((row) => [row.scorer, row.taskCount]),
    );
    const invalidScorers = sourceScorers.filter(
      (scorer) => !sourceCounts.has(scorer),
    );
    if (invalidScorers.length) {
      throw httpError(
        400,
        `以下打分人没有可领取的未完成任务：${invalidScorers.join("、")}`,
      );
    }

    selectedTasks = sourceScorers.flatMap((scorer) => {
      const candidates = selectReassignableTaskIdsByScorerStmt.all(
        subjectId,
        taskVersion,
        scorer,
        taskCount,
      );
      if (taskCount > candidates.length) {
        throw httpError(
          400,
          `打分人 ${scorer} 的未完成任务不足 ${taskCount} 个`,
        );
      }
      return candidates;
    });
  }

  if (selectedTasks.length < assignees.names.length) {
    throw httpError(400, "任务数量不能少于所选打分人数");
  }
  const updatedAt = nowIso();
  const distribution = Object.fromEntries(
    assignees.names.map((name) => [name, 0]),
  );

  db.exec("BEGIN IMMEDIATE");
  try {
    selectedTasks.forEach((task, index) => {
      const scorer = assignmentPlan?.[index]
        || assignees.names[index % assignees.names.length];
      const result = source === "assigned_uncompleted"
        ? assignUnassignedTaskStmt.run({
          id: task.id,
          projectId: subjectId,
          taskVersion,
          scorer,
          updatedAt,
        })
        : reassignTaskStmt.run({
          id: task.id,
          projectId: subjectId,
          taskVersion,
          scorer,
          updatedAt,
        });
      if (result.changes !== 1) {
        throw httpError(409, "任务状态已变更，请刷新后重试");
      }
      distribution[scorer]++;
    });
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    throw error;
  }

  invalidateTaskSummaryCaches(subjectId);
  return {
    reassignedCount: selectedTasks.length,
    remainingTaskCount: availableTaskCount - selectedTasks.length,
    distribution,
  };
}

async function assignGeneratedTasks(projectId, allocations, onProgress) {
  const requestedTaskCount = allocations.reduce(
    (total, allocation) => total + allocation.taskCount,
    0,
  );
  if (!requestedTaskCount) return 0;

  const pendingTasks = selectPendingProjectTaskIdsStmt.all(
    projectId,
    taskVersion,
    requestedTaskCount,
  );
  if (requestedTaskCount > pendingTasks.length) {
    throw httpError(400, `分配数量不能超过 ${pendingTasks.length} 个可用任务`);
  }

  const selectedTasks = pendingTasks;
  const assigneePlan = allocations.flatMap(({ scorer, taskCount }) =>
    Array.from({ length: taskCount }, () => scorer),
  );
  const updatedAt = nowIso();

  for (let start = 0; start < selectedTasks.length; start += TASK_ASSIGN_BATCH_SIZE) {
    const batch = selectedTasks.slice(start, start + TASK_ASSIGN_BATCH_SIZE);
    db.exec("BEGIN IMMEDIATE");
    try {
      const whenClauses = batch.map(() => "WHEN ? THEN ?");
      const taskIds = batch.map((task) => task.id);
      const assignmentParams = [];
      batch.forEach((task, index) => {
        assignmentParams.push(task.id, assigneePlan[start + index]);
      });
      assignmentParams.push(updatedAt, ...taskIds);
      const result = db
        .prepare(
          `UPDATE rating_tasks
           SET scorer = CASE id ${whenClauses.join(" ")} ELSE scorer END,
               status = 'assigned',
               updatedAt = ?
           WHERE status = 'pending'
             AND id IN (${placeholders(batch.length)})`,
        )
        .run(...assignmentParams);
      if (result.changes !== batch.length) {
        throw httpError(409, "任务状态已变更，请刷新后重试");
      }
      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {}
      throw error;
    }
    const processed = start + batch.length;
    onProgress?.(processed, selectedTasks.length);
    if (processed < selectedTasks.length) await yieldToEventLoop();
  }

  invalidateTaskSummaryCaches(projectId);
  return selectedTasks.length;
}

function rollbackGeneratedTasks(projectId, taskIds, previousTaskStatus) {
  try {
    for (let start = 0; start < taskIds.length; start += 500) {
      const batch = taskIds.slice(start, start + 500);
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare(
          `DELETE FROM rating_tasks
           WHERE projectId = ?
             AND id IN (${placeholders(batch.length)})`,
        ).run(projectId, ...batch);
        db.exec("COMMIT");
      } catch (error) {
        try {
          db.exec("ROLLBACK");
        } catch {}
        throw error;
      }
    }
    updateProjectTaskStatusStmt.run({
      id: projectId,
      taskStatus: previousTaskStatus,
      updatedAt: nowIso(),
    });
  } catch (cleanupError) {
    console.error(`Failed to roll back generated tasks for ${projectId}`, cleanupError);
  }
}

async function generateSubjectTasks(projectId, assignment, onProgress) {
  const project = getProjectOrThrow(projectId);
  const requestedTaskCount = assignment.allocations.reduce(
    (total, allocation) => total + allocation.taskCount,
    0,
  );
  if (!requestedTaskCount) {
    throw httpError(400, "请至少为一名打分人分配任务");
  }
  const previousTaskStatus = project.taskStatus;
  const generatedTaskIds = [];

  try {
    let createdCount = 0;
    let assignedCount = 0;
    const pendingBefore = getProjectTaskStats(projectId).pending;
    const templatesNeeded = Math.max(0, requestedTaskCount - pendingBefore);
    const templates = templatesNeeded
      ? await loadUnmaterializedProjectTaskTemplates(projectId, templatesNeeded)
      : [];

    if (templates.length < templatesNeeded) {
      const availableTaskCount = pendingBefore + templates.length;
      throw httpError(400, `本次最多还能下发 ${availableTaskCount} 个任务`);
    }

    onProgress?.({
      stage: templatesNeeded ? "正在生成本次任务" : "正在分配已生成任务",
      progress: templatesNeeded ? 5 : 70,
    });

    for (let start = 0; start < templates.length; start += TASK_WRITE_BATCH_SIZE) {
      const batch = templates.slice(start, start + TASK_WRITE_BATCH_SIZE);
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const template of batch) {
          const taskId = insertTemplateTask(projectId, template.packageId, template);
          if (taskId) {
            createdCount++;
            generatedTaskIds.push(taskId);
          }
        }
        db.exec("COMMIT");
      } catch (error) {
        try {
          db.exec("ROLLBACK");
        } catch {}
        throw error;
      }
      onProgress?.({
        stage: "正在生成本次任务",
        progress: 5 + Math.round((Math.min(start + batch.length, templates.length) / templates.length) * 70),
      });
      if (start + batch.length < templates.length) await yieldToEventLoop();
    }

    onProgress?.({ stage: "正在按配额分配任务", progress: 75 });
    assignedCount = await assignGeneratedTasks(
      projectId,
      assignment.allocations,
      (current, total) => onProgress?.({
        stage: "正在按配额分配任务",
        progress: 75 + (total ? Math.round((current / total) * 23) : 0),
      }),
    );

    syncProjectTeams(projectId, assignment.teamIds, nowIso());
    updateSubjectTaskStatusStmt.run({
      id: projectId,
      taskStatus: "scoring",
      updatedAt: nowIso(),
    });
    const updatedProject = selectProjectByIdStmt.get(projectId);
    const taskStats = getProjectTaskStats(projectId);
    const taskCount = taskStats.total;
    const unassignedCount = taskStats.pending;
    onProgress?.({ stage: "任务生成完成", progress: 100 });

    return {
      project: projectDto(updatedProject, taskStats),
      taskCount,
      createdCount,
      assignedCount,
      unassignedCount,
      taskVersion,
    };
  } catch (error) {
    rollbackGeneratedTasks(projectId, generatedTaskIds, previousTaskStatus);
    throw error;
  }
}

function startSubjectTaskGeneration(subjectId, assigneesInput = {}) {
  const project = getProjectOrThrow(subjectId);
  if (!["task_pending", "scoring"].includes(project.taskStatus)) {
    throw httpError(409, "当前项目已完成任务，不能继续下发");
  }
  const assignment = parseTaskGenerationAssignees(assigneesInput);

  const activeJobId = activeTaskGenerationBySubject.get(subjectId);
  if (activeJobId) {
    const activeJob = taskGenerationJobs.get(activeJobId);
    if (activeJob && ["queued", "running"].includes(activeJob.status)) {
      return activeJob;
    }
  }

  const job = {
    jobId: crypto.randomUUID(),
    subjectId,
    status: "queued",
    stage: "等待导入任务模板",
    progress: 0,
    message: null,
    result: null,
  };
  taskGenerationJobs.set(job.jobId, job);
  activeTaskGenerationBySubject.set(subjectId, job.jobId);

  const worker = fork(
    fileURLToPath(new URL("./task-generation-worker.js", import.meta.url)),
    [],
    {
      env: process.env,
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    },
  );
  job.worker = worker;
  worker.on("message", (message) => {
    if (message?.type === "progress") {
      job.status = "running";
      job.stage = message.stage || job.stage;
      job.progress = Math.max(0, Math.min(100, Number(message.progress) || 0));
      return;
    }
    if (message?.type === "completed") {
      job.result = message.result;
      job.status = "completed";
      job.stage = "任务导入完成";
      job.progress = 100;
      worker.disconnect();
      return;
    }
    if (message?.type === "failed") {
      job.status = "failed";
      job.stage = "任务导入失败";
      job.message = message.message || "任务导入失败，请重试";
      worker.disconnect();
    }
  });
  worker.on("error", (error) => {
    if (["queued", "running"].includes(job.status)) {
      job.status = "failed";
      job.stage = "任务导入失败";
      job.message = error.message || "任务生成进程启动失败";
    }
    console.error(`Task generation worker failed (${job.jobId})`, error);
  });
  worker.on("exit", (code) => {
    if (["queued", "running"].includes(job.status)) {
      job.status = "failed";
      job.stage = "任务导入失败";
      job.message = `任务生成进程异常退出（code ${code}）`;
    }
    activeTaskGenerationBySubject.delete(subjectId);
    delete job.worker;
    setTimeout(() => taskGenerationJobs.delete(job.jobId), 24 * 60 * 60 * 1000).unref();
  });
  worker.send({ type: "start", subjectId, assignment });

  return job;
}

function buildImageFilter(query) {
  const clauses = [];
  const params = [];

  if (query.subjectId) {
    clauses.push("subjectId = ?");
    params.push(String(query.subjectId));
  }

  if (query.category) {
    clauses.push("category = ?");
    params.push(String(query.category));
  }

  if (query.filename) {
    clauses.push("filename LIKE ? ESCAPE '\\'");
    params.push(`%${escapeLike(query.filename)}%`);
  }

  if (query.scorer) {
    clauses.push("scorer = ?");
    params.push(String(query.scorer));
  }

  if (query.status === "rated") {
    clauses.push("overall IS NOT NULL");
  } else if (query.status === "unrated") {
    clauses.push("overall IS NULL");
  }

  const keys = String(query.scoreCriteria || "")
    .split(",")
    .map((key) => key.trim())
    .filter((key) => scoreFilterKeys.has(key));

  let scoreRanges = {};
  try {
    scoreRanges = JSON.parse(String(query.scoreRanges || "{}"));
  } catch {
    scoreRanges = {};
  }

  for (const key of keys) {
    const [min, max] = parseScoreRange(scoreRanges[key]);
    if (skippableScoreFields.includes(key)) {
      clauses.push(`${scoreStateColumn(key)} = 'rated'`);
    }
    clauses.push(`${key} BETWEEN ? AND ?`);
    params.push(min, max);
  }

  return {
    where: clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "",
    params,
  };
}

function listImages(query) {
  const page = Math.max(Number(query.page) || 1, 1);
  const pageSize = Math.min(Math.max(Number(query.pageSize) || 20, 1), 100);
  const { where, params } = buildImageFilter(query);
  const total = db
    .prepare(`SELECT COUNT(*) AS total FROM images${where}`)
    .get(...params).total;
  const items = db
    .prepare(
      `SELECT ${imageSelectColumns} FROM images${where} ORDER BY createdAt DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, pageSize, (page - 1) * pageSize)
    .map(imageDto);

  return { total, page, pageSize, items };
}

function getCategories(subjectId) {
  const rows = subjectId
    ? db
        .prepare(
          "SELECT DISTINCT category FROM images WHERE subjectId = ? ORDER BY category COLLATE NOCASE",
        )
        .all(String(subjectId))
    : db
        .prepare(
          "SELECT DISTINCT category FROM images ORDER BY category COLLATE NOCASE",
        )
        .all();
  return rows.map((row) => row.category);
}

function getScorers(subjectId) {
  const where = subjectId
    ? "subjectId = ? AND scorer IS NOT NULL AND scorer <> '' AND overall IS NOT NULL"
    : "scorer IS NOT NULL AND scorer <> '' AND overall IS NOT NULL";
  const rows = subjectId
    ? db
        .prepare(
          `SELECT DISTINCT scorer FROM images WHERE ${where} ORDER BY scorer COLLATE NOCASE`,
        )
        .all(String(subjectId))
    : db
        .prepare(
          `SELECT DISTINCT scorer FROM images WHERE ${where} ORDER BY scorer COLLATE NOCASE`,
        )
        .all();
  return rows.map((row) => row.scorer);
}

app.use("/files", requireAuth, ensureFileAccess, express.static(uploadDir));

app.post("/api/auth/login", async (req, res, next) => {
  try {
    const user = loginUser(req.body);
    const session = createSession(user);
    setSessionCookie(res, session.token, session.expiresAt);
    res.json({ user });
  } catch (error) {
    next(error);
  }
});

app.use("/api", requireAuth);

app.get("/api/auth/session", (req, res) => {
  res.json({ user: req.auth });
});

app.post("/api/auth/logout", (req, res) => {
  const token = cookieValue(req.headers.cookie, "image_rating_session");
  if (token) {
    const tokenHash = sessionTokenHash(token);
    deleteSessionStmt.run(tokenHash);
    sessionSeenWriteAt.delete(tokenHash);
  }
  clearSessionCookie(res);
  res.status(204).end();
});

app.use("/api/admin", requireAdmin);
app.use("/api/users", requireAdmin);
app.use("/api/import", requireAdmin);
app.use("/api/scorer", requireScorer);
app.use("/api/tasks/assigned", requireScorer);

app.get("/api/admin/dashboard", async (req, res, next) => {
  try {
    res.json(listAdminDashboard(req.query));
  } catch (error) {
    next(error);
  }
});

app.get("/api/admin/dashboard/stats", async (req, res, next) => {
  try {
    res.json(getDashboardStats());
  } catch (error) {
    next(error);
  }
});

app.get("/api/admin/dashboard/project-summary", async (req, res, next) => {
  try {
    res.json(getDashboardProjectSection(req.query));
  } catch (error) {
    next(error);
  }
});

app.get("/api/admin/dashboard/charts", async (req, res, next) => {
  try {
    res.json(getDashboardCharts());
  } catch (error) {
    next(error);
  }
});

app.get("/api/admin/dashboard/average-duration", async (req, res, next) => {
  try {
    res.json(getDashboardAverageDuration());
  } catch (error) {
    next(error);
  }
});

app.get("/api/admin/dashboard/workload", async (req, res, next) => {
  try {
    res.json(getDashboardWorkloadSection(req.query));
  } catch (error) {
    next(error);
  }
});

app.get("/api/admin/tasks/completed/export", async (req, res, next) => {
  try {
    await exportCompletedTasks(req, res);
  } catch (error) {
    next(error);
  }
});

app.get("/api/admin/scorers/task-summary/export", async (req, res, next) => {
  try {
    await exportScorerTaskSummary(req, res);
  } catch (error) {
    next(error);
  }
});

app.get("/api/admin/scorers/completed/export", async (req, res, next) => {
  try {
    await exportScorerTaskSummary(req, res);
  } catch (error) {
    next(error);
  }
});

app.get("/api/admin/teams/task-summary/export", async (req, res, next) => {
  try {
    exportTeamTaskSummary(req, res);
  } catch (error) {
    next(error);
  }
});

app.get("/api/admin/scoring/summary", async (req, res, next) => {
  try {
    res.json(listScoringSummary(req.query));
  } catch (error) {
    next(error);
  }
});

app.get("/api/admin/scoring/tasks", async (req, res, next) => {
  try {
    res.json(listScoringTaskRecords(req.query));
  } catch (error) {
    next(error);
  }
});

app.post("/api/admin/scoring/rollback/preview", async (req, res, next) => {
  try {
    res.json(previewRollback(req.body));
  } catch (error) {
    next(error);
  }
});

app.post("/api/admin/scoring/rollback", async (req, res, next) => {
  try {
    res.status(202).json(rollbackJobDto(startRollbackJob(req.body, req.auth)));
  } catch (error) {
    next(error);
  }
});

app.get("/api/admin/scoring/rollback/:jobId", async (req, res, next) => {
  try {
    const job = getRollbackJob(req.params.jobId);
    if (!job) throw httpError(404, "任务回退作业不存在或已过期");
    res.json(rollbackJobDto(job));
  } catch (error) {
    next(error);
  }
});

app.get("/api/users/scorers", async (req, res, next) => {
  try {
    res.json(listScorerUsers(req.query));
  } catch (error) {
    next(error);
  }
});

app.post("/api/users/scorers", async (req, res, next) => {
  try {
    res.status(201).json({ user: createScorerUser(req.body) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/users/scorers/batch", async (req, res, next) => {
  try {
    res.status(201).json(createScorerUsers(req.body));
  } catch (error) {
    next(error);
  }
});

app.patch("/api/users/scorers/:id", async (req, res, next) => {
  try {
    res.json({ user: updateScorerUser(req.params.id, req.body) });
  } catch (error) {
    next(error);
  }
});

app.get("/api/teams", requireAdmin, async (req, res, next) => {
  try {
    res.json(listTeams(req.query));
  } catch (error) {
    next(error);
  }
});

app.post("/api/teams", requireAdmin, async (req, res, next) => {
  try {
    res.status(201).json({ team: createTeam(req.body) });
  } catch (error) {
    next(error);
  }
});

app.get("/api/teams/scorers", requireAdmin, async (req, res, next) => {
  try {
    const rawTeamIds = String(req.query.teamIds || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    const teamIds = normalizeTeamIds(rawTeamIds, {
      required: true,
      enabledOnly: true,
    });
    const teamMatchMode = normalizeTeamMatchMode(req.query.teamMatchMode);
    res.json({ users: listScorersByTeamIds(teamIds, teamMatchMode) });
  } catch (error) {
    next(error);
  }
});

app.patch("/api/teams/:id", requireAdmin, async (req, res, next) => {
  try {
    res.json({ team: updateTeam(req.params.id, req.body) });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/teams/:id", requireAdmin, async (req, res, next) => {
  try {
    res.json(deleteTeam(req.params.id));
  } catch (error) {
    next(error);
  }
});

app.delete("/api/users/scorers/:id", async (req, res, next) => {
  try {
    res.json(deleteScorerUser(req.params.id));
  } catch (error) {
    next(error);
  }
});

app.get("/api/tasks/assigned/options", async (req, res, next) => {
  try {
    res.json(getScorerTaskOptions({ ...req.query, scorer: req.auth.username }));
  } catch (error) {
    next(error);
  }
});

app.get("/api/tasks/assigned", async (req, res, next) => {
  try {
    res.json(listAssignedTasks({ ...req.query, scorer: req.auth.username }));
  } catch (error) {
    next(error);
  }
});

app.get("/api/scorer/dashboard", async (req, res, next) => {
  try {
    res.json(getScorerDashboard({ ...req.query, scorer: req.auth.username }));
  } catch (error) {
    next(error);
  }
});

app.get("/api/feedbacks", async (req, res, next) => {
  try {
    res.json(listFeedbacks(req.query));
  } catch (error) {
    next(error);
  }
});

app.post(
  "/api/feedbacks",
  requireScorer,
  feedbackUpload.array("images", 5),
  async (req, res, next) => {
    try {
      res.status(201).json({
        feedback: await createFeedback(req.auth, req.body, req.files || []),
      });
    } catch (error) {
      next(error);
    }
  },
);

app.put("/api/feedbacks/:id/reply", requireAdmin, async (req, res, next) => {
  try {
    res.json({
      feedback: addFeedbackMessage(req.params.id, req.body, req.auth),
    });
  } catch (error) {
    next(error);
  }
});

app.post(
  "/api/feedbacks/:id/messages",
  requireScorer,
  async (req, res, next) => {
    try {
      res.json({
        feedback: addFeedbackMessage(req.params.id, req.body, req.auth),
      });
    } catch (error) {
      next(error);
    }
  },
);

app.put("/api/feedbacks/:id/status", async (req, res, next) => {
  try {
    res.json({
      feedback: updateFeedbackStatus(req.params.id, req.body?.status, req.auth),
    });
  } catch (error) {
    next(error);
  }
});

app.post(
  "/api/tasks/:id/complete",
  requireScorer,
  async (req, res, next) => {
    try {
      res.json({
        task: completeAssignedTask(req.params.id, {
          ...req.body,
          scorer: req.auth.username,
        }),
      });
    } catch (error) {
      next(error);
    }
  },
);

app.put(
  "/api/tasks/:id/complete",
  requireScorer,
  async (req, res, next) => {
    try {
      res.json({
        task: updateCompletedTask(req.params.id, {
          ...req.body,
          scorer: req.auth.username,
        }),
      });
    } catch (error) {
      next(error);
    }
  },
);

app.get("/api/tasks/:id", requireScorer, async (req, res, next) => {
  try {
    res.json({
      task: getTaskDetail(req.params.id, { scorer: req.auth.username }),
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/subjects", async (req, res, next) => {
  try {
    res.json(listVisibleSubjects(req.auth).map(subjectDto));
  } catch (error) {
    next(error);
  }
});

app.get("/api/projects", async (req, res, next) => {
  try {
    res.json(listVisibleProjects(req.auth, req.query));
  } catch (error) {
    next(error);
  }
});

app.get("/api/projects/:id", async (req, res, next) => {
  try {
    const project = getProjectOrThrow(req.params.id);
    if (req.auth.role !== "admin") {
      const allowed = db.prepare(
        `SELECT 1 FROM rating_tasks
         WHERE projectId = ? AND scorer = ?
           AND status IN ('assigned', 'completed')
         LIMIT 1`,
      ).get(project._id, req.auth.username);
      if (!allowed) throw httpError(403, "无权访问该项目");
    }
    res.json({ project: projectDto(project) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/projects", requireAdmin, async (req, res, next) => {
  try {
    res.status(201).json({ project: createProject(req.body) });
  } catch (error) {
    next(error);
  }
});

app.patch("/api/projects/:id", requireAdmin, async (req, res, next) => {
  try {
    res.json({ project: updateProject(req.params.id, req.body) });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/projects/:id", requireAdmin, async (req, res, next) => {
  try {
    res.json(deleteProject(req.params.id));
  } catch (error) {
    next(error);
  }
});

app.get("/api/categories", async (req, res, next) => {
  try {
    if (req.auth.role !== "admin" && !req.query.subjectId)
      throw httpError(400, "请选择项目");
    if (req.query.subjectId)
      assertSubjectAccess(String(req.query.subjectId), req.auth);
    res.json(getCategories(req.query.subjectId));
  } catch (error) {
    next(error);
  }
});

app.get("/api/scorers", async (req, res, next) => {
  try {
    if (req.auth.role !== "admin" && !req.query.subjectId)
      throw httpError(400, "请选择项目");
    if (req.query.subjectId)
      assertSubjectAccess(String(req.query.subjectId), req.auth);
    res.json(getScorers(req.query.subjectId));
  } catch (error) {
    next(error);
  }
});

app.get("/api/images", async (req, res, next) => {
  try {
    if (req.auth.role !== "admin" && !req.query.subjectId)
      throw httpError(400, "请选择项目");
    if (req.query.subjectId)
      assertSubjectAccess(String(req.query.subjectId), req.auth);
    res.json(listImages(req.query));
  } catch (error) {
    next(error);
  }
});

app.get(
  "/api/subjects/:id/tasks/reassignment-options",
  requireAdmin,
  async (req, res, next) => {
    try {
      res.json(getTaskReassignmentOptions(req.params.id));
    } catch (error) {
      next(error);
    }
  },
);

app.post(
  "/api/subjects/:id/tasks/reassign",
  requireAdmin,
  async (req, res, next) => {
    try {
      res.json(reassignSubjectTasks(req.params.id, req.body));
    } catch (error) {
      next(error);
    }
  },
);

app.get(
  "/api/subjects/:id/tasks/report",
  requireAdmin,
  async (req, res, next) => {
    try {
      res.json(getSubjectTaskReportSummary(req.params.id));
    } catch (error) {
      next(error);
    }
  },
);

app.get(
  "/api/subjects/:id/tasks/report/export",
  requireAdmin,
  async (req, res, next) => {
    try {
      await exportSubjectTaskReport(req.params.id, res);
    } catch (error) {
      next(error);
    }
  },
);

app.get(
  "/api/subjects/:id/tasks/options",
  requireAdmin,
  async (req, res, next) => {
    try {
      getProjectOrThrow(req.params.id);
      res.json(listSubjectTaskOptions(req.params.id));
    } catch (error) {
      next(error);
    }
  },
);

app.get("/api/projects/:id/tasks", requireAdmin, async (req, res, next) => {
  try {
    const project = getProjectOrThrow(req.params.id);
    const projectView = projectDto(project);
    res.json({
      subject: projectSubjectDto(project, projectView),
      project: projectView,
      ...listSubjectTasks(req.params.id, req.query),
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/projects/:id/tasks/options", requireAdmin, async (req, res, next) => {
  try {
    getProjectOrThrow(req.params.id);
    res.json(listSubjectTaskOptions(req.params.id));
  } catch (error) {
    next(error);
  }
});

app.get("/api/projects/:id/tasks/reassignment-options", requireAdmin, async (req, res, next) => {
  try {
    res.json(getTaskReassignmentOptions(req.params.id));
  } catch (error) {
    next(error);
  }
});

app.post(
  "/api/projects/:id/tasks/allocations/import",
  requireAdmin,
  taskAllocationUpload.single("file"),
  async (req, res, next) => {
    try {
      getProjectOrThrow(req.params.id);
      res.json(await parseTaskAllocationWorkbook(req.file));
    } catch (error) {
      next(error);
    }
  },
);

app.post("/api/projects/:id/tasks/reassign", requireAdmin, async (req, res, next) => {
  try {
    res.json(reassignSubjectTasks(req.params.id, req.body));
  } catch (error) {
    next(error);
  }
});

app.get("/api/projects/:id/tasks/report", requireAdmin, async (req, res, next) => {
  try {
    res.json(getSubjectTaskReportSummary(req.params.id));
  } catch (error) {
    next(error);
  }
});

app.get("/api/projects/:id/tasks/report/export", requireAdmin, async (req, res, next) => {
  try {
    await exportSubjectTaskReport(req.params.id, res);
  } catch (error) {
    next(error);
  }
});

app.post("/api/projects/:id/tasks/generate", requireAdmin, async (req, res, next) => {
  try {
    res.status(202).json(taskGenerationJobDto(
      startSubjectTaskGeneration(req.params.id, req.body),
    ));
  } catch (error) {
    next(error);
  }
});

app.get("/api/projects/:id/tasks/generate/:jobId", requireAdmin, async (req, res, next) => {
  try {
    const job = taskGenerationJobs.get(req.params.jobId);
    if (!job || job.subjectId !== req.params.id) throw httpError(404, "任务生成作业不存在或已过期");
    res.json(taskGenerationJobDto(job));
  } catch (error) {
    next(error);
  }
});

app.get("/api/projects/:id/tasks/:taskId", requireAdmin, async (req, res, next) => {
  try {
    res.json({ task: getTaskDetail(req.params.taskId, { projectId: req.params.id }) });
  } catch (error) {
    next(error);
  }
});

app.get(
  "/api/subjects/:id/tasks/:taskId",
  requireAdmin,
  async (req, res, next) => {
    try {
      res.json({
        task: getTaskDetail(req.params.taskId, { projectId: req.params.id }),
      });
    } catch (error) {
      next(error);
    }
  },
);

app.get("/api/subjects/:id/tasks", requireAdmin, async (req, res, next) => {
  try {
    const project = getProjectOrThrow(req.params.id);
    const projectView = projectDto(project);
    res.json({
      subject: projectSubjectDto(project, projectView),
      project: projectView,
      ...listSubjectTasks(req.params.id, req.query),
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/import", upload.single("file"), async (req, res, next) => {
  if (!req.file) return res.status(400).json({ message: "请选择 ZIP 文件" });
  if (path.extname(req.file.originalname).toLowerCase() !== ".zip") {
    await fs.unlink(req.file.path).catch(() => {});
    return res.status(400).json({ message: "仅支持 ZIP 文件" });
  }

  try {
    res
      .status(201)
      .json(await importZipArchive(req.file.path, req.file.originalname));
  } catch (error) {
    next(error);
  }
});

app.options("/api/import/uploads", (_req, res) => {
  res
    .set({
      "Tus-Resumable": tusVersion,
      "Tus-Version": tusVersion,
      "Tus-Extension": "creation,termination",
      "Tus-Max-Size": String(maxZipBytes),
    })
    .status(204)
    .end();
});

app.options("/api/import/uploads/:uploadId", (_req, res) => {
  res
    .set({
      "Tus-Resumable": tusVersion,
      "Tus-Version": tusVersion,
      "Tus-Extension": "creation,termination",
      "Tus-Max-Size": String(maxZipBytes),
    })
    .status(204)
    .end();
});

app.post("/api/import/uploads", async (req, res, next) => {
  try {
    requireTusResumableHeader(req);
    const uploadLength = Number(req.headers["upload-length"]);
    if (!Number.isInteger(uploadLength) || uploadLength <= 0) {
      throw httpError(400, "上传文件大小不正确");
    }
    if (uploadLength > maxZipBytes) {
      throw httpError(413, "ZIP 文件超过服务器允许的大小限制");
    }

    const metadata = parseTusMetadataHeader(req.headers["upload-metadata"]);
    const originalFilename = normalizeTusFilename(metadata.filename);
    if (
      !originalFilename ||
      path.extname(originalFilename).toLowerCase() !== ".zip"
    ) {
      throw httpError(400, "仅支持 ZIP 文件");
    }

    const session = await createResumableUploadSession(
      originalFilename,
      uploadLength,
    );
    res
      .set(resumableUploadResponseHeaders(session, 0))
      .status(201)
      .json(resumableUploadDto(session, 0));
  } catch (error) {
    next(error);
  }
});

app.head("/api/import/uploads/:uploadId", async (req, res, next) => {
  try {
    requireTusResumableHeader(req);
    const uploadId = req.params.uploadId;
    const session = await loadResumableUploadSession(uploadId);
    if (!session) throw httpError(404, "上传任务不存在或已过期");
    if (session.status !== "uploading") {
      throw httpError(409, "上传任务已开始处理");
    }
    res
      .set(resumableUploadResponseHeaders(session, session.offset))
      .status(204)
      .end();
  } catch (error) {
    next(error);
  }
});

app.patch(
  "/api/import/uploads/:uploadId",
  express.raw({
    type: "application/offset+octet-stream",
    limit: resumableUploadMaxChunkBytes,
  }),
  async (req, res, next) => {
    const uploadId = req.params.uploadId;
    try {
      await withResumableUploadLock(uploadId, async () => {
        requireTusResumableHeader(req);

        const session = await loadResumableUploadSession(uploadId);
        if (!session) throw httpError(404, "上传任务不存在或已过期");
        if (session.status !== "uploading") {
          throw httpError(409, "上传任务状态不允许继续写入");
        }

        const requestedOffset = Number(req.headers["upload-offset"]);
        if (!Number.isInteger(requestedOffset) || requestedOffset < 0) {
          throw httpError(400, "上传偏移量不正确");
        }
        if (requestedOffset !== session.offset) {
          return res
            .set(resumableUploadResponseHeaders(session, session.offset))
            .status(409)
            .json({ message: "上传偏移量不匹配，请按服务器返回位置续传" });
        }

        const chunkBuffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
        if (!chunkBuffer.length) throw httpError(400, "上传数据为空");
        const nextOffset = session.offset + chunkBuffer.length;
        if (nextOffset > session.uploadLength) {
          throw httpError(413, "上传数据超过声明的文件大小");
        }

        await fs.appendFile(session.filePath, chunkBuffer);

        const updatedSession = {
          ...session,
          offset: nextOffset,
          updatedAt: nowIso(),
          expiresAt: resumableUploadExpiresAt(),
        };

        if (nextOffset === session.uploadLength) {
          updatedSession.status = "queued";
          await saveResumableUploadSession(updatedSession);
          const job = {
            uploadId,
            dir: session.dir,
            zipPath: session.filePath,
            originalFilename: session.originalFilename,
            totalChunks: 1,
            protocol: "tus",
            uploadLength: session.uploadLength,
            uploadOffset: nextOffset,
            status: "queued",
            stage: "等待处理",
            progress: 0,
            message: null,
            result: null,
            createdAt: nowIso(),
            expiresAt: importJobExpiry(),
          };
          insertImportJobStmt.run({
            uploadId: job.uploadId,
            originalFilename: job.originalFilename,
            totalChunks: job.totalChunks,
            protocol: job.protocol,
            uploadLength: job.uploadLength,
            uploadOffset: job.uploadOffset,
            metadata: JSON.stringify({
              filename: job.originalFilename,
              uploadLength: job.uploadLength,
            }),
            status: job.status,
            stage: job.stage,
            progress: job.progress,
            message: null,
            resultJson: null,
            createdAt: job.createdAt,
            updatedAt: job.createdAt,
            expiresAt: job.expiresAt,
          });
          importJobs.set(uploadId, job);
          setImmediate(() => void runResumableImportJob(job));
        } else {
          await saveResumableUploadSession(updatedSession);
        }

        res
          .set(resumableUploadResponseHeaders(updatedSession, nextOffset))
          .status(204)
          .end();
      });
    } catch (error) {
      next(error);
    }
  },
);

app.get("/api/import/uploads/:uploadId/status", async (req, res, next) => {
  try {
    const uploadId = req.params.uploadId;
    validateUploadId(uploadId);
    const job =
      importJobs.get(uploadId) || importJobFromRow(selectImportJobStmt.get(uploadId));
    if (job) return res.json(importJobDto(job));

    const session = await loadResumableUploadSession(uploadId);
    if (!session) throw httpError(404, "上传任务不存在或已过期");
    res.json({
      uploadId,
      status: "uploading",
      stage: "上传中",
      progress: Math.min(
        99,
        Math.round((session.offset / session.uploadLength) * 100),
      ),
      message: null,
    });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/import/uploads/:uploadId", async (req, res, next) => {
  try {
    requireTusResumableHeader(req);
    const uploadId = req.params.uploadId;
    const job =
      importJobs.get(uploadId) || importJobFromRow(selectImportJobStmt.get(uploadId));
    if (job && !["failed", "completed"].includes(job.status)) {
      throw httpError(409, "导入任务已开始，无法取消");
    }

    await cleanupResumableUploadSession(uploadId);
    deleteImportJobStmt.run(uploadId);
    importJobs.delete(uploadId);
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.post(
  "/api/import/chunks/:uploadId/parts/:index",
  chunkUpload.single("chunk"),
  async (req, res, next) => {
    try {
      if (!req.file) return res.status(400).json({ message: "缺少上传分片" });
      const index = Number(req.params.index);
      if (!Number.isInteger(index) || index < 0 || index >= maxChunkCount)
        throw httpError(400, "分片序号不正确");
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  },
);

app.post("/api/import/chunks/:uploadId/complete", async (req, res, next) => {
  try {
    const uploadId = req.params.uploadId;
    const dir = chunkDir(uploadId);
    const existingJob = importJobs.get(uploadId);
    if (existingJob) {
      return res.status(202).json(importJobDto(existingJob));
    }
    const persistedJob = importJobFromRow(selectImportJobStmt.get(uploadId));
    if (persistedJob) {
      return res.status(202).json(importJobDto(persistedJob));
    }

    const originalFilename = String(req.body?.filename || "").trim();
    const totalChunks = Number(req.body?.totalChunks);
    if (
      !originalFilename ||
      path.extname(originalFilename).toLowerCase() !== ".zip"
    ) {
      throw httpError(400, "仅支持 ZIP 文件");
    }
    if (
      !Number.isInteger(totalChunks) ||
      totalChunks <= 0 ||
      totalChunks > maxChunkCount
    ) {
      throw httpError(400, "分片总数不正确");
    }

    const job = {
      uploadId,
      dir,
      zipPath: path.join(zipUploadDir, `${uploadId}.zip`),
      originalFilename,
      totalChunks,
      status: "queued",
      stage: "等待处理",
      progress: 0,
      message: null,
      result: null,
      createdAt: nowIso(),
      expiresAt: importJobExpiry(),
    };
    insertImportJobStmt.run({
      uploadId: job.uploadId,
      originalFilename: job.originalFilename,
      totalChunks: job.totalChunks,
      protocol: "chunked",
      uploadLength: null,
      uploadOffset: 0,
      metadata: null,
      status: job.status,
      stage: job.stage,
      progress: job.progress,
      message: null,
      resultJson: null,
      createdAt: job.createdAt,
      updatedAt: job.createdAt,
      expiresAt: job.expiresAt,
    });
    importJobs.set(uploadId, job);
    setImmediate(() => void runChunkedImportJob(job));
    res.status(202).json(importJobDto(job));
  } catch (error) {
    next(error);
  }
});

app.get("/api/import/chunks/:uploadId/status", (req, res, next) => {
  try {
    validateUploadId(req.params.uploadId);
    const job =
      importJobs.get(req.params.uploadId) ||
      importJobFromRow(selectImportJobStmt.get(req.params.uploadId));
    if (!job) throw httpError(404, "上传任务不存在或已过期");
    res.json(importJobDto(job));
  } catch (error) {
    next(error);
  }
});

app.delete("/api/import/chunks/:uploadId", async (req, res, next) => {
  try {
    await fs.rm(chunkDir(req.params.uploadId), {
      recursive: true,
      force: true,
    });
    deleteImportJobStmt.run(req.params.uploadId);
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.delete("/api/subjects/:id", requireAdmin, async (req, res, next) => {
  try {
    const subject = selectSubjectByIdStmt.get(req.params.id);
    if (!subject) return res.status(404).json({ message: "项目不存在" });
    assertPackageCanBeDeleted(subject._id);

    const requestedAt = new Date().toISOString();
    const result = markSubjectForDeletionStmt.run({
      id: subject._id,
      deletionRequestedAt: requestedAt,
      updatedAt: requestedAt,
    });
    if (!result.changes) {
      return res.status(404).json({ message: "Subject no longer exists" });
    }

    res.status(202).json({
      subject: subjectDto({ ...subject, deletionRequestedAt: requestedAt }),
      deletedImages: subject.imageCount,
      queued: true,
    });
    queueSubjectDeletion(subject._id);
  } catch (error) {
    next(error);
  }
});

app.put("/api/images/:id/score", async (req, res, next) => {
  try {
    const current = selectImageByIdStmt.get(req.params.id);
    if (!current) return res.status(404).json({ message: "图片不存在" });
    if (
      req.auth.role !== "admin" &&
      !selectAssignedTaskForImageStmt.get(
        req.auth.username,
        current.storagePath,
        current.storagePath,
      )
    ) {
      throw httpError(403, "无权为该图片评分");
    }

    const score = normalizeScorePayload({
      ...(req.body || {}),
      scorer: req.auth.role === "scorer" ? req.auth.username : current.scorer,
    });
    updateImageScoreStmt.run({
      id: req.params.id,
      ...score,
      scorer: score.scorer ?? current.scorer ?? null,
      updatedAt: score.ratedAt,
    });

    const updated = selectImageByIdStmt.get(req.params.id);
    res.json(imageDto(updated));
  } catch (error) {
    next(error);
  }
});

app.use((error, req, res, _next) => {
  let status = error.status || 500;
  if (status >= 500) console.error(error);
  let message = error.message || "服务异常";

  if (error instanceof multer.MulterError) {
    status = 400;
    message =
      error.code === "LIMIT_FILE_SIZE"
        ? req.path.includes("/chunks/")
          ? "上传分片超过大小限制，请重新上传该文件"
          : "ZIP 文件超过服务器允许的大小限制"
        : "上传文件数据不完整，请重新上传";
  }

  res.status(status).json({ message, code: error.code || "REQUEST_FAILED" });
});

const queuedSubjects = db
  .prepare("SELECT id FROM subjects WHERE deletionRequestedAt IS NOT NULL")
  .all();
for (const subject of queuedSubjects) queueSubjectDeletion(subject.id);

const startupNow = nowIso();
deleteExpiredSessionsStmt.run(startupNow);
deleteExpiredImportJobsStmt.run(startupNow);
await sweepResumableUploadSessions();
db.prepare(
  `UPDATE import_jobs
   SET status = 'failed',
       stage = '导入失败',
       message = '服务端在导入过程中重启，请重新上传',
       updatedAt = @updatedAt
   WHERE status IN ('queued', 'merging', 'importing')`,
).run({ updatedAt: startupNow });

export { generateSubjectTasks, importZipArchive };
export default app;
