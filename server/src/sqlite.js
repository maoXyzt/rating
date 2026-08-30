import { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const scoreNumericFields = [
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

export const skippableScoreFields = [
  "promptAlignment",
  "textCorrectness",
  "anatomyNormality",
  "informationClarity",
  "designQuality",
  "typography",
];

export const scoreStateFields = skippableScoreFields.map(
  (field) => `${field}State`,
);
export const scoreFilterKeys = new Set(scoreNumericFields);
export const subjectSelectColumns =
  "id AS _id, name, originalFilename, importBatch, storageRoot, sourceZipPath, imageCount, categoryCount, status, taskStatus, deletionRequestedAt, createdAt, updatedAt, (SELECT COUNT(*) FROM subject_task_templates WHERE subject_task_templates.subjectId = subjects.id) AS taskTemplateCount";
export const projectSelectColumns = `
  projects.id AS _id,
  projects.name,
  projects.icon,
  projects.packageId,
  projects.taskStatus,
  projects.deletionRequestedAt,
  projects.createdAt,
  projects.updatedAt,
  subjects.name AS packageName,
  subjects.originalFilename AS packageFilename,
  subjects.imageCount,
  subjects.categoryCount,
  subjects.status AS packageStatus
`;
export const imageSelectColumns = `id AS _id, subjectId, filename, originalPath, storagePath, thumbnailPath, mimeType, category, directory, isInfographic, prompt, catalogData, importBatch, scorer, ${scoreNumericFields.join(", ")}, ${scoreStateFields.join(", ")}, discomfort, comment, ratedAt, createdAt, updatedAt`;
export const userSelectColumns =
  "id, username, role, status, lastLoginAt, createdAt, updatedAt";

const serverDir = path.dirname(fileURLToPath(import.meta.url));
const defaultDbPath = path.resolve(
  serverDir,
  "..",
  "data",
  "image-rating.sqlite",
);
const configuredDbPath = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : defaultDbPath;

await fs.mkdir(path.dirname(configuredDbPath), { recursive: true });

export const db = new DatabaseSync(configuredDbPath);

db.exec("PRAGMA busy_timeout = 30000;");

db.exec(`
  PRAGMA foreign_keys = ON;
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;

  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'scorer')),
    status TEXT NOT NULL DEFAULT 'enabled' CHECK (status IN ('enabled', 'disabled')),
    lastLoginAt TEXT,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS user_sessions (
    tokenHash TEXT PRIMARY KEY,
    userId TEXT NOT NULL,
    expiresAt TEXT NOT NULL,
    createdAt TEXT NOT NULL,
    lastSeenAt TEXT NOT NULL,
    FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS import_jobs (
    uploadId TEXT PRIMARY KEY,
    originalFilename TEXT NOT NULL,
    totalChunks INTEGER NOT NULL,
    protocol TEXT NOT NULL DEFAULT 'chunked',
    uploadLength INTEGER,
    uploadOffset INTEGER NOT NULL DEFAULT 0,
    metadata TEXT,
    status TEXT NOT NULL CHECK (status IN ('queued', 'merging', 'importing', 'completed', 'failed')),
    stage TEXT NOT NULL,
    progress INTEGER NOT NULL DEFAULT 0,
    message TEXT,
    resultJson TEXT,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL,
    expiresAt TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS schema_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS subjects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    originalFilename TEXT NOT NULL,
    importBatch TEXT NOT NULL UNIQUE,
    storageRoot TEXT,
    sourceZipPath TEXT,
    imageCount INTEGER NOT NULL DEFAULT 0,
    categoryCount INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'importing' CHECK (status IN ('importing', 'imported', 'failed')),
    taskStatus TEXT NOT NULL DEFAULT 'task_pending' CHECK (taskStatus IN ('task_pending', 'scoring', 'task_completed')),
    deletionRequestedAt TEXT,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  );

  -- Subjects are retained as imported image-package storage. Projects own
  -- task configuration and can reuse an imported package safely.
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    icon TEXT NOT NULL DEFAULT 'archive',
    packageId TEXT NOT NULL,
    taskStatus TEXT NOT NULL DEFAULT 'task_pending' CHECK (taskStatus IN ('task_pending', 'scoring', 'task_completed')),
    deletionRequestedAt TEXT,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL,
    FOREIGN KEY (packageId) REFERENCES subjects(id) ON DELETE RESTRICT
  );

  CREATE TABLE IF NOT EXISTS project_packages (
    projectId TEXT NOT NULL,
    packageId TEXT NOT NULL,
    createdAt TEXT NOT NULL,
    PRIMARY KEY (projectId, packageId),
    FOREIGN KEY (projectId) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY (packageId) REFERENCES subjects(id) ON DELETE RESTRICT
  );

  CREATE TABLE IF NOT EXISTS teams (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    status TEXT NOT NULL DEFAULT 'enabled' CHECK (status IN ('enabled', 'disabled')),
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS user_teams (
    userId TEXT NOT NULL,
    teamId TEXT NOT NULL,
    createdAt TEXT NOT NULL,
    PRIMARY KEY (userId, teamId),
    FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (teamId) REFERENCES teams(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS project_teams (
    projectId TEXT NOT NULL,
    teamId TEXT NOT NULL,
    createdAt TEXT NOT NULL,
    PRIMARY KEY (projectId, teamId),
    FOREIGN KEY (projectId) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY (teamId) REFERENCES teams(id) ON DELETE RESTRICT
  );

  CREATE TABLE IF NOT EXISTS user_projects (
    userId TEXT NOT NULL,
    projectId TEXT NOT NULL,
    createdAt TEXT NOT NULL,
    PRIMARY KEY (userId, projectId),
    FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (projectId) REFERENCES subjects(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS images (
    id TEXT PRIMARY KEY,
    subjectId TEXT NOT NULL,
    filename TEXT NOT NULL,
    originalPath TEXT NOT NULL,
    storagePath TEXT NOT NULL,
    thumbnailPath TEXT,
    mimeType TEXT,
    category TEXT NOT NULL,
    directory TEXT NOT NULL DEFAULT '',
    isInfographic INTEGER NOT NULL DEFAULT 0,
    prompt TEXT,
    catalogData TEXT,
    importBatch TEXT NOT NULL,
    scorer TEXT,
    overall INTEGER,
    creativity INTEGER,
    mood INTEGER,
    composition INTEGER,
    color INTEGER,
    lighting INTEGER,
    realism INTEGER,
    detail INTEGER,
    discomfort INTEGER,
    promptAlignment INTEGER,
    promptAlignmentState TEXT NOT NULL DEFAULT 'unrated',
    textCorrectness INTEGER,
    textCorrectnessState TEXT NOT NULL DEFAULT 'unrated',
    anatomyNormality INTEGER,
    anatomyNormalityState TEXT NOT NULL DEFAULT 'unrated',
    informationClarity INTEGER,
    informationClarityState TEXT NOT NULL DEFAULT 'unrated',
    designQuality INTEGER,
    designQualityState TEXT NOT NULL DEFAULT 'unrated',
    typography INTEGER,
    typographyState TEXT NOT NULL DEFAULT 'unrated',
    comment TEXT,
    ratedAt TEXT,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL,
    FOREIGN KEY (subjectId) REFERENCES subjects(id) ON DELETE CASCADE,
    UNIQUE (subjectId, originalPath)
  );

  CREATE INDEX IF NOT EXISTS idx_subjects_createdAt ON subjects(createdAt DESC);
  CREATE INDEX IF NOT EXISTS idx_projects_createdAt ON projects(createdAt DESC);
  CREATE INDEX IF NOT EXISTS idx_projects_deleted_created
    ON projects(deletionRequestedAt, createdAt DESC, id ASC);
  CREATE INDEX IF NOT EXISTS idx_projects_packageId ON projects(packageId);
  CREATE INDEX IF NOT EXISTS idx_project_packages_project_created
    ON project_packages(projectId, createdAt ASC, packageId ASC);
  CREATE INDEX IF NOT EXISTS idx_project_packages_package_project ON project_packages(packageId, projectId);
  CREATE INDEX IF NOT EXISTS idx_images_subject_category ON images(subjectId, category);
  CREATE INDEX IF NOT EXISTS idx_images_subject_createdAt ON images(subjectId, createdAt DESC);
  CREATE INDEX IF NOT EXISTS idx_images_importBatch ON images(importBatch);
  CREATE INDEX IF NOT EXISTS idx_images_ratedAt ON images(ratedAt);
  CREATE INDEX IF NOT EXISTS idx_users_role_username ON users(role, username);
  CREATE INDEX IF NOT EXISTS idx_users_role_lastLoginAt ON users(role, lastLoginAt);
  CREATE INDEX IF NOT EXISTS idx_user_sessions_expiresAt ON user_sessions(expiresAt);
  CREATE INDEX IF NOT EXISTS idx_import_jobs_expiresAt ON import_jobs(expiresAt);
  CREATE INDEX IF NOT EXISTS idx_user_projects_project_user ON user_projects(projectId, userId);
  CREATE INDEX IF NOT EXISTS idx_user_teams_team_user ON user_teams(teamId, userId);
  CREATE INDEX IF NOT EXISTS idx_project_teams_team_project ON project_teams(teamId, projectId);

  CREATE TRIGGER IF NOT EXISTS trg_projects_name_unique_insert
  BEFORE INSERT ON projects
  WHEN EXISTS (
    SELECT 1
    FROM projects AS existing
    WHERE existing.deletionRequestedAt IS NULL
      AND TRIM(existing.name) COLLATE NOCASE = TRIM(NEW.name) COLLATE NOCASE
  )
  BEGIN
    SELECT RAISE(ABORT, '项目名称已存在');
  END;

  CREATE TRIGGER IF NOT EXISTS trg_projects_name_unique_update
  BEFORE UPDATE OF name ON projects
  WHEN EXISTS (
    SELECT 1
    FROM projects AS existing
    WHERE existing.deletionRequestedAt IS NULL
      AND existing.id <> NEW.id
      AND TRIM(existing.name) COLLATE NOCASE = TRIM(NEW.name) COLLATE NOCASE
  )
  BEGIN
    SELECT RAISE(ABORT, '项目名称已存在');
  END;

  CREATE TABLE IF NOT EXISTS rating_tasks (
    id TEXT PRIMARY KEY,
    subjectId TEXT NOT NULL,
    projectId TEXT,
    taskVersion TEXT NOT NULL,
    round INTEGER NOT NULL,
    taskType TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'assigned', 'completed')),
    scorer TEXT,
    ranking TEXT,
    excludedImageIds TEXT,
    correctImageIds TEXT,
    rankingRelations TEXT,
    assignmentKey INTEGER NOT NULL DEFAULT 0,
    submissionMode TEXT CHECK (submissionMode IN ('direct', 'ranked')),
    rankingActionCount INTEGER NOT NULL DEFAULT 0,
    startedAt TEXT,
    completedAt TEXT,
    durationMs INTEGER,
    editedAt TEXT,
    editCount INTEGER NOT NULL DEFAULT 0,
    rollbackCount INTEGER NOT NULL DEFAULT 0,
    lastRolledBackAt TEXT,
    lastRolledBackBy TEXT,
    imageKey TEXT NOT NULL,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL,
    FOREIGN KEY (subjectId) REFERENCES subjects(id) ON DELETE CASCADE,
    UNIQUE (subjectId, taskVersion, round, taskType, imageKey)
  );

  CREATE TABLE IF NOT EXISTS rating_task_items (
    taskId TEXT NOT NULL,
    imageId TEXT NOT NULL,
    position INTEGER NOT NULL,
    role TEXT NOT NULL DEFAULT 'target' CHECK (role IN ('target', 'filler', 'anchor_low', 'anchor_high', 'boundary')),
    PRIMARY KEY (taskId, imageId),
    FOREIGN KEY (taskId) REFERENCES rating_tasks(id) ON DELETE CASCADE,
    FOREIGN KEY (imageId) REFERENCES images(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS project_task_stats (
    projectId TEXT NOT NULL,
    taskVersion TEXT NOT NULL,
    total INTEGER NOT NULL DEFAULT 0,
    pending INTEGER NOT NULL DEFAULT 0,
    assigned INTEGER NOT NULL DEFAULT 0,
    completed INTEGER NOT NULL DEFAULT 0,
    updatedAt TEXT NOT NULL,
    PRIMARY KEY (projectId, taskVersion),
    FOREIGN KEY (projectId) REFERENCES projects(id) ON DELETE CASCADE
  );

  -- A ZIP package owns immutable task definitions. Projects copy these
  -- definitions into rating_tasks when work starts, then assign them to users.
  CREATE TABLE IF NOT EXISTS subject_task_templates (
    id TEXT PRIMARY KEY,
    subjectId TEXT NOT NULL,
    sourceTaskId TEXT NOT NULL,
    round INTEGER NOT NULL,
    criterion TEXT NOT NULL,
    imageKey TEXT NOT NULL,
    selectionKey INTEGER NOT NULL DEFAULT 0,
    createdAt TEXT NOT NULL,
    FOREIGN KEY (subjectId) REFERENCES subjects(id) ON DELETE CASCADE,
    UNIQUE (subjectId, sourceTaskId),
    UNIQUE (subjectId, round, criterion, imageKey)
  );

  CREATE TABLE IF NOT EXISTS subject_task_template_items (
    templateId TEXT NOT NULL,
    imageId TEXT NOT NULL,
    position INTEGER NOT NULL,
    role TEXT NOT NULL DEFAULT 'target' CHECK (role IN ('target', 'filler', 'anchor_low', 'anchor_high', 'boundary')),
    PRIMARY KEY (templateId, imageId),
    FOREIGN KEY (templateId) REFERENCES subject_task_templates(id) ON DELETE CASCADE,
    FOREIGN KEY (imageId) REFERENCES images(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS image_pair_edges (
    subjectId TEXT NOT NULL,
    imageA TEXT NOT NULL,
    imageB TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    updatedAt TEXT NOT NULL,
    PRIMARY KEY (subjectId, imageA, imageB),
    FOREIGN KEY (subjectId) REFERENCES subjects(id) ON DELETE CASCADE,
    FOREIGN KEY (imageA) REFERENCES images(id) ON DELETE CASCADE,
    FOREIGN KEY (imageB) REFERENCES images(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS feedbacks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('platform_bug', 'scoring_rule', 'other')),
    description TEXT NOT NULL,
    imagePaths TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'resolved')),
    submitter TEXT NOT NULL,
    submittedAt TEXT NOT NULL,
    reply TEXT,
    repliedBy TEXT,
    repliedAt TEXT,
    updatedAt TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS feedback_messages (
    id TEXT PRIMARY KEY,
    feedbackId TEXT NOT NULL,
    author TEXT NOT NULL,
    authorRole TEXT NOT NULL CHECK (authorRole IN ('admin', 'scorer')),
    content TEXT NOT NULL,
    createdAt TEXT NOT NULL,
    FOREIGN KEY (feedbackId) REFERENCES feedbacks(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_rating_tasks_subject ON rating_tasks(subjectId, round, taskType);
  CREATE INDEX IF NOT EXISTS idx_rating_tasks_subject_version_order
    ON rating_tasks(subjectId, taskVersion, round, taskType, createdAt, id);
  CREATE INDEX IF NOT EXISTS idx_rating_tasks_subject_version_status_order
    ON rating_tasks(subjectId, taskVersion, status, round, taskType, createdAt, id);
  CREATE INDEX IF NOT EXISTS idx_rating_tasks_subject_version_scorer_order
    ON rating_tasks(subjectId, taskVersion, scorer, round, taskType, createdAt, id);
  CREATE INDEX IF NOT EXISTS idx_rating_tasks_subject_version_task_type_order
    ON rating_tasks(subjectId, taskVersion, taskType, round, createdAt, id);
  CREATE INDEX IF NOT EXISTS idx_rating_tasks_project_template
    ON rating_tasks(projectId, taskVersion, subjectId, round, taskType, imageKey);
  CREATE INDEX IF NOT EXISTS idx_rating_tasks_project_order
    ON rating_tasks(projectId, taskVersion, taskType, createdAt, id);
  CREATE INDEX IF NOT EXISTS idx_rating_tasks_project_status_order
    ON rating_tasks(projectId, taskVersion, status, taskType, createdAt, id);
  CREATE INDEX IF NOT EXISTS idx_rating_tasks_project_scorer_order
    ON rating_tasks(projectId, taskVersion, scorer, taskType, createdAt, id);
  CREATE INDEX IF NOT EXISTS idx_rating_tasks_scorer_status ON rating_tasks(scorer, status, subjectId);
  CREATE INDEX IF NOT EXISTS idx_rating_tasks_export ON rating_tasks(taskVersion, status, completedAt DESC, id);
  CREATE INDEX IF NOT EXISTS idx_rating_tasks_scorer_version_status ON rating_tasks(scorer, taskVersion, status, subjectId);
  CREATE INDEX IF NOT EXISTS idx_rating_tasks_scorer_version_status_updated
    ON rating_tasks(scorer, taskVersion, status, updatedAt DESC, id);
  CREATE INDEX IF NOT EXISTS idx_rating_tasks_version_scorer_status_order
    ON rating_tasks(taskVersion, scorer, status, taskType, createdAt, id);
  CREATE INDEX IF NOT EXISTS idx_rating_task_items_image ON rating_task_items(imageId);
  CREATE INDEX IF NOT EXISTS idx_subject_task_templates_subject_order
    ON subject_task_templates(subjectId, round, criterion, sourceTaskId);
  CREATE INDEX IF NOT EXISTS idx_subject_task_template_items_image
    ON subject_task_template_items(imageId);
  CREATE INDEX IF NOT EXISTS idx_image_pair_edges_subject ON image_pair_edges(subjectId);
  CREATE INDEX IF NOT EXISTS idx_feedbacks_submitter_status_created ON feedbacks(submitter, status, submittedAt DESC);
  CREATE INDEX IF NOT EXISTS idx_feedbacks_status_created ON feedbacks(status, submittedAt DESC);
  CREATE INDEX IF NOT EXISTS idx_feedback_messages_feedback_created ON feedback_messages(feedbackId, createdAt ASC, id ASC);

  CREATE TRIGGER IF NOT EXISTS trg_rating_tasks_stats_insert
  AFTER INSERT ON rating_tasks
  WHEN NEW.projectId IS NOT NULL
  BEGIN
    INSERT INTO project_task_stats (
      projectId, taskVersion, total, pending, assigned, completed, updatedAt
    ) VALUES (
      NEW.projectId,
      NEW.taskVersion,
      1,
      CASE WHEN NEW.status = 'pending' THEN 1 ELSE 0 END,
      CASE WHEN NEW.status = 'assigned' THEN 1 ELSE 0 END,
      CASE WHEN NEW.status = 'completed' THEN 1 ELSE 0 END,
      NEW.updatedAt
    )
    ON CONFLICT(projectId, taskVersion) DO UPDATE SET
      total = project_task_stats.total + 1,
      pending = project_task_stats.pending + excluded.pending,
      assigned = project_task_stats.assigned + excluded.assigned,
      completed = project_task_stats.completed + excluded.completed,
      updatedAt = excluded.updatedAt;
  END;

  CREATE TRIGGER IF NOT EXISTS trg_rating_tasks_stats_delete
  AFTER DELETE ON rating_tasks
  WHEN OLD.projectId IS NOT NULL
  BEGIN
    UPDATE project_task_stats
    SET total = MAX(0, total - 1),
        pending = MAX(0, pending - CASE WHEN OLD.status = 'pending' THEN 1 ELSE 0 END),
        assigned = MAX(0, assigned - CASE WHEN OLD.status = 'assigned' THEN 1 ELSE 0 END),
        completed = MAX(0, completed - CASE WHEN OLD.status = 'completed' THEN 1 ELSE 0 END),
        updatedAt = OLD.updatedAt
    WHERE projectId = OLD.projectId AND taskVersion = OLD.taskVersion;
  END;

  CREATE TRIGGER IF NOT EXISTS trg_rating_tasks_stats_update
  AFTER UPDATE OF projectId, taskVersion, status ON rating_tasks
  WHEN COALESCE(OLD.projectId, '') <> COALESCE(NEW.projectId, '')
    OR OLD.taskVersion <> NEW.taskVersion
    OR OLD.status <> NEW.status
  BEGIN
    UPDATE project_task_stats
    SET total = MAX(0, total - 1),
        pending = MAX(0, pending - CASE WHEN OLD.status = 'pending' THEN 1 ELSE 0 END),
        assigned = MAX(0, assigned - CASE WHEN OLD.status = 'assigned' THEN 1 ELSE 0 END),
        completed = MAX(0, completed - CASE WHEN OLD.status = 'completed' THEN 1 ELSE 0 END),
        updatedAt = NEW.updatedAt
    WHERE projectId = OLD.projectId AND taskVersion = OLD.taskVersion;

    INSERT INTO project_task_stats (
      projectId, taskVersion, total, pending, assigned, completed, updatedAt
    )
    SELECT
      NEW.projectId,
      NEW.taskVersion,
      1,
      CASE WHEN NEW.status = 'pending' THEN 1 ELSE 0 END,
      CASE WHEN NEW.status = 'assigned' THEN 1 ELSE 0 END,
      CASE WHEN NEW.status = 'completed' THEN 1 ELSE 0 END,
      NEW.updatedAt
    WHERE NEW.projectId IS NOT NULL
    ON CONFLICT(projectId, taskVersion) DO UPDATE SET
      total = project_task_stats.total + 1,
      pending = project_task_stats.pending + excluded.pending,
      assigned = project_task_stats.assigned + excluded.assigned,
      completed = project_task_stats.completed + excluded.completed,
      updatedAt = excluded.updatedAt;
  END;
`);

const userColumns = db.prepare("PRAGMA table_info(users)").all();
if (userColumns.some((column) => column.name === "projectId")) {
  db.exec(`
    INSERT OR IGNORE INTO user_projects (userId, projectId, createdAt)
    SELECT users.id, users.projectId, users.createdAt
    FROM users
    JOIN subjects ON subjects.id = users.projectId
    WHERE users.role = 'scorer'
      AND users.projectId IS NOT NULL
      AND users.projectId <> ''
  `);

  db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE users_rebuilt (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        password TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('admin', 'scorer')),
        status TEXT NOT NULL DEFAULT 'enabled' CHECK (status IN ('enabled', 'disabled')),
        lastLoginAt TEXT,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );
      INSERT INTO users_rebuilt (id, username, password, role, status, lastLoginAt, createdAt, updatedAt)
      SELECT id, username, password, role, 'enabled', lastLoginAt, createdAt, updatedAt
      FROM users;
      DROP TABLE users;
      ALTER TABLE users_rebuilt RENAME TO users;
      CREATE INDEX IF NOT EXISTS idx_users_role_username ON users(role, username);
      COMMIT;
    `);
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    throw error;
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

function addColumnIfMissing(table, columns, name, definition) {
  if (columns.some((column) => column.name === name)) return;
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
  } catch (error) {
    if (!String(error?.message || "").includes("duplicate column name")) {
      throw error;
    }
  }
}

addColumnIfMissing(
  "users",
  db.prepare("PRAGMA table_info(users)").all(),
  "status",
  "status TEXT NOT NULL DEFAULT 'enabled' CHECK (status IN ('enabled', 'disabled'))",
);
addColumnIfMissing(
  "teams",
  db.prepare("PRAGMA table_info(teams)").all(),
  "status",
  "status TEXT NOT NULL DEFAULT 'enabled' CHECK (status IN ('enabled', 'disabled'))",
);
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_users_role_username ON users(role, username);
  CREATE INDEX IF NOT EXISTS idx_users_role_lastLoginAt ON users(role, lastLoginAt);
  CREATE INDEX IF NOT EXISTS idx_users_role_status ON users(role, status, username);
  CREATE INDEX IF NOT EXISTS idx_teams_status_name ON teams(status, name);
`);

const feedbackForeignKeys = db.prepare("PRAGMA foreign_key_list(feedbacks)").all();
if (feedbackForeignKeys.length) {
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE feedbacks_rebuilt (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        type TEXT NOT NULL CHECK (type IN ('platform_bug', 'scoring_rule', 'other')),
        description TEXT NOT NULL,
        imagePaths TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'resolved')),
        submitter TEXT NOT NULL,
        submittedAt TEXT NOT NULL,
        reply TEXT,
        repliedBy TEXT,
        repliedAt TEXT,
        updatedAt TEXT NOT NULL
      );
      INSERT INTO feedbacks_rebuilt (
        id, title, type, description, imagePaths, status,
        submitter, submittedAt, reply, repliedBy, repliedAt, updatedAt
      )
      SELECT
        id, title, type, description, imagePaths, status,
        submitter, submittedAt, reply, repliedBy, repliedAt, updatedAt
      FROM feedbacks;
      DROP TABLE feedbacks;
      ALTER TABLE feedbacks_rebuilt RENAME TO feedbacks;
      CREATE INDEX IF NOT EXISTS idx_feedbacks_submitter_status_created ON feedbacks(submitter, status, submittedAt DESC);
      CREATE INDEX IF NOT EXISTS idx_feedbacks_status_created ON feedbacks(status, submittedAt DESC);
      COMMIT;
    `);
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    throw error;
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

db.exec(`
  INSERT OR IGNORE INTO feedback_messages (id, feedbackId, author, authorRole, content, createdAt)
  SELECT
    feedbacks.id || ':legacy-reply',
    feedbacks.id,
    COALESCE(NULLIF(feedbacks.repliedBy, ''), 'admin'),
    CASE
      WHEN EXISTS (
        SELECT 1 FROM users
        WHERE users.username = feedbacks.repliedBy AND users.role = 'scorer'
      ) THEN 'scorer'
      ELSE 'admin'
    END,
    feedbacks.reply,
    COALESCE(feedbacks.repliedAt, feedbacks.updatedAt)
  FROM feedbacks
  WHERE feedbacks.reply IS NOT NULL AND TRIM(feedbacks.reply) <> ''
`);

function passwordHash(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const derived = crypto.scryptSync(password, salt, 64).toString("hex");
  return `scrypt$${salt}$${derived}`;
}

function passwordMatches(password, storedPassword) {
  const parts = String(storedPassword || "").split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const expected = Buffer.from(parts[2], "hex");
  if (!expected.length) return false;
  const actual = crypto.scryptSync(password, parts[1], expected.length);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

const seededAt = new Date().toISOString();
db.prepare(
  `
  INSERT INTO users (id, username, password, role, createdAt, updatedAt)
  VALUES ('admin', 'admin', @password, 'admin', @seededAt, @seededAt)
  ON CONFLICT(username) DO NOTHING
`,
).run({ seededAt, password: passwordHash("666666") });

const legacyUsers = db
  .prepare("SELECT id, password FROM users WHERE password NOT LIKE 'scrypt$%'")
  .all();
const upgradeUserPasswordStmt = db.prepare(
  "UPDATE users SET password = @password, updatedAt = @updatedAt WHERE id = @id",
);
for (const user of legacyUsers) {
  upgradeUserPasswordStmt.run({
    id: user.id,
    password: passwordHash(user.password),
    updatedAt: seededAt,
  });
}

const adminUser = db
  .prepare("SELECT id, password FROM users WHERE username = 'admin' AND role = 'admin'")
  .get();
if (adminUser && !passwordMatches("666666", adminUser.password)) {
  db.prepare(
    "UPDATE users SET password = @password, updatedAt = @updatedAt WHERE id = @id",
  ).run({
    id: adminUser.id,
    password: passwordHash("666666"),
    updatedAt: seededAt,
  });
}

const subjectColumns = db.prepare("PRAGMA table_info(subjects)").all();
if (!subjectColumns.some((column) => column.name === "storageRoot")) {
  db.exec("ALTER TABLE subjects ADD COLUMN storageRoot TEXT");
}
if (!subjectColumns.some((column) => column.name === "sourceZipPath")) {
  db.exec("ALTER TABLE subjects ADD COLUMN sourceZipPath TEXT");
}
if (!subjectColumns.some((column) => column.name === "taskStatus")) {
  db.exec(
    "ALTER TABLE subjects ADD COLUMN taskStatus TEXT NOT NULL DEFAULT 'task_pending'",
  );
}
if (!subjectColumns.some((column) => column.name === "deletionRequestedAt")) {
  try {
    db.exec("ALTER TABLE subjects ADD COLUMN deletionRequestedAt TEXT");
  } catch (error) {
    if (!String(error?.message || "").includes("duplicate column name")) {
      throw error;
    }
  }
}
db.exec(
  "UPDATE subjects SET taskStatus = 'task_pending' WHERE status = 'imported' AND (taskStatus IS NULL OR taskStatus = '')",
);
db.exec(`
  UPDATE subjects
  SET taskStatus = 'task_pending'
  WHERE status = 'imported'
    AND taskStatus = 'scoring'
    AND NOT EXISTS (
      SELECT 1
      FROM rating_tasks
      WHERE rating_tasks.subjectId = subjects.id
        AND rating_tasks.taskVersion = 'v3'
  )
`);

// This one-off migration maps old mixed subject/project rows to both models.
// New uploads must remain packages only, so the marker prevents re-running it.
const splitMigrationKey = "packages-projects-split-v1";
const splitMigrationDone = db
  .prepare("SELECT value FROM schema_meta WHERE key = ?")
  .get(splitMigrationKey);
if (!splitMigrationDone) {
  const migratedAt = new Date().toISOString();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      INSERT OR IGNORE INTO projects (
        id, name, icon, packageId, taskStatus, createdAt, updatedAt
      )
      SELECT id, name, 'archive', id, taskStatus, createdAt, updatedAt
      FROM subjects
      WHERE deletionRequestedAt IS NULL
    `);
    db.prepare(
      "INSERT INTO schema_meta (key, value, updatedAt) VALUES (?, ?, ?)",
    ).run(splitMigrationKey, "completed", migratedAt);
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
}

db.exec(`
  INSERT OR IGNORE INTO project_packages (projectId, packageId, createdAt)
  SELECT id, packageId, createdAt
  FROM projects
  WHERE packageId IS NOT NULL
    AND TRIM(packageId) <> ''
`);
db.exec(
  "CREATE INDEX IF NOT EXISTS idx_project_packages_project_package ON project_packages(projectId, packageId)",
);

const ratingTaskColumns = db.prepare("PRAGMA table_info(rating_tasks)").all();
function addRatingTaskColumnIfMissing(name, definition) {
  if (ratingTaskColumns.some((column) => column.name === name)) return;
  try {
    db.exec(`ALTER TABLE rating_tasks ADD COLUMN ${definition}`);
  } catch (error) {
    if (!String(error?.message || "").includes("duplicate column name")) {
      throw error;
    }
  }
}

if (!ratingTaskColumns.some((column) => column.name === "startedAt")) {
  db.exec("ALTER TABLE rating_tasks ADD COLUMN startedAt TEXT");
}
if (!ratingTaskColumns.some((column) => column.name === "completedAt")) {
  db.exec("ALTER TABLE rating_tasks ADD COLUMN completedAt TEXT");
}
if (!ratingTaskColumns.some((column) => column.name === "durationMs")) {
  db.exec("ALTER TABLE rating_tasks ADD COLUMN durationMs INTEGER");
}
addRatingTaskColumnIfMissing("excludedImageIds", "excludedImageIds TEXT");
addRatingTaskColumnIfMissing("correctImageIds", "correctImageIds TEXT");
addRatingTaskColumnIfMissing("rankingRelations", "rankingRelations TEXT");
addRatingTaskColumnIfMissing("submissionMode", "submissionMode TEXT CHECK (submissionMode IN ('direct', 'ranked'))");
addRatingTaskColumnIfMissing("rankingActionCount", "rankingActionCount INTEGER NOT NULL DEFAULT 0");
addRatingTaskColumnIfMissing("editedAt", "editedAt TEXT");
addRatingTaskColumnIfMissing("editCount", "editCount INTEGER NOT NULL DEFAULT 0");
addRatingTaskColumnIfMissing("rollbackCount", "rollbackCount INTEGER NOT NULL DEFAULT 0");
addRatingTaskColumnIfMissing("lastRolledBackAt", "lastRolledBackAt TEXT");
addRatingTaskColumnIfMissing("lastRolledBackBy", "lastRolledBackBy TEXT");
addRatingTaskColumnIfMissing("projectId", "projectId TEXT");
addRatingTaskColumnIfMissing(
  "assignmentKey",
  "assignmentKey INTEGER NOT NULL DEFAULT 0",
);
db.exec(`
  UPDATE rating_tasks
  SET projectId = subjectId
  WHERE projectId IS NULL OR TRIM(projectId) = ''
`);
db.exec(`
  UPDATE rating_tasks
  SET assignmentKey = (random() & 2147483647)
  WHERE assignmentKey = 0
`);
db.exec(
  "CREATE INDEX IF NOT EXISTS idx_rating_tasks_project ON rating_tasks(projectId, taskVersion, round, taskType)",
);
db.exec(
  "CREATE INDEX IF NOT EXISTS idx_rating_tasks_project_template ON rating_tasks(projectId, taskVersion, subjectId, round, taskType, imageKey)",
);
db.exec(
  "CREATE INDEX IF NOT EXISTS idx_rating_tasks_project_order ON rating_tasks(projectId, taskVersion, taskType, createdAt, id)",
);
db.exec(
  "CREATE INDEX IF NOT EXISTS idx_rating_tasks_project_status_order ON rating_tasks(projectId, taskVersion, status, taskType, createdAt, id)",
);
db.exec(
  "CREATE INDEX IF NOT EXISTS idx_rating_tasks_project_scorer_order ON rating_tasks(projectId, taskVersion, scorer, taskType, createdAt, id)",
);
db.exec(
  "CREATE INDEX IF NOT EXISTS idx_rating_tasks_project_assignment ON rating_tasks(projectId, taskVersion, status, assignmentKey, id)",
);
db.exec(
  "CREATE INDEX IF NOT EXISTS idx_rating_tasks_project_scorer_assignment ON rating_tasks(projectId, taskVersion, status, scorer, assignmentKey, id)",
);
db.exec(
  "CREATE INDEX IF NOT EXISTS idx_rating_tasks_version_scorer_status_order ON rating_tasks(taskVersion, scorer, status, taskType, createdAt, id)",
);

const templateColumns = db
  .prepare("PRAGMA table_info(subject_task_templates)")
  .all();
if (!templateColumns.some((column) => column.name === "selectionKey")) {
  db.exec(
    "ALTER TABLE subject_task_templates ADD COLUMN selectionKey INTEGER NOT NULL DEFAULT 0",
  );
}
db.exec(`
  UPDATE subject_task_templates
  SET selectionKey = (random() & 2147483647)
  WHERE selectionKey = 0
`);
db.exec(
  "CREATE INDEX IF NOT EXISTS idx_subject_task_templates_selection ON subject_task_templates(subjectId, selectionKey, id)",
);

const projectTaskStatsBackfillKey = "project_task_stats_v1";
if (
  !db
    .prepare("SELECT 1 FROM schema_meta WHERE key = ?")
    .get(projectTaskStatsBackfillKey)
) {
  const migratedAt = new Date().toISOString();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      INSERT INTO project_task_stats (
        projectId, taskVersion, total, pending, assigned, completed, updatedAt
      )
      SELECT
        projectId,
        taskVersion,
        COUNT(*),
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END),
        SUM(CASE WHEN status = 'assigned' THEN 1 ELSE 0 END),
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END),
        '${migratedAt}'
      FROM rating_tasks
      WHERE projectId IS NOT NULL
      GROUP BY projectId, taskVersion
      ON CONFLICT(projectId, taskVersion) DO UPDATE SET
        total = excluded.total,
        pending = excluded.pending,
        assigned = excluded.assigned,
        completed = excluded.completed,
        updatedAt = excluded.updatedAt
    `);
    db.prepare(
      "INSERT INTO schema_meta (key, value, updatedAt) VALUES (?, ?, ?)",
    ).run(projectTaskStatsBackfillKey, "completed", migratedAt);
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    throw error;
  }
}

const imageColumns = db.prepare("PRAGMA table_info(images)").all();
function addImageColumnIfMissing(name, definition) {
  if (imageColumns.some((column) => column.name === name)) return;
  try {
    db.exec(`ALTER TABLE images ADD COLUMN ${definition}`);
  } catch (error) {
    if (!String(error?.message || "").includes("duplicate column name")) {
      throw error;
    }
  }
}

addImageColumnIfMissing("scorer", "scorer TEXT");
addImageColumnIfMissing("directory", "directory TEXT NOT NULL DEFAULT ''");
addImageColumnIfMissing("isInfographic", "isInfographic INTEGER NOT NULL DEFAULT 0");
addImageColumnIfMissing("prompt", "prompt TEXT");
addImageColumnIfMissing("catalogData", "catalogData TEXT");
addImageColumnIfMissing("thumbnailPath", "thumbnailPath TEXT");
db.exec(
  "CREATE INDEX IF NOT EXISTS idx_images_thumbnail_path ON images(thumbnailPath)",
);
const infographicDirectory = "信息图";
db.prepare(
  `
  UPDATE images
  SET isInfographic = 1,
      directory = CASE WHEN directory IS NULL OR directory = '' THEN @directory ELSE directory END,
      category = CASE WHEN category IS NULL OR category = '' OR category = '未分类' THEN @directory ELSE category END
  WHERE isInfographic = 1
     OR directory = @directory
     OR originalPath LIKE @rootPath
     OR originalPath LIKE @nestedPath
  `,
).run({
  directory: infographicDirectory,
  rootPath: `${infographicDirectory}/%`,
  nestedPath: `%/${infographicDirectory}/%`,
});
db.exec(`
  UPDATE subjects
  SET categoryCount = (
    SELECT COUNT(DISTINCT directory)
    FROM images
    WHERE images.subjectId = subjects.id
      AND directory IS NOT NULL
      AND directory <> ''
  )
  WHERE deletionRequestedAt IS NULL
`);

for (const field of skippableScoreFields) {
  const stateColumn = `${field}State`;
  if (!imageColumns.some((column) => column.name === stateColumn)) {
    db.exec(
      `ALTER TABLE images ADD COLUMN ${stateColumn} TEXT NOT NULL DEFAULT 'unrated'`,
    );
  }
  db.prepare(
    `
    UPDATE images
    SET ${stateColumn} = 'rated'
    WHERE ${field} IS NOT NULL
      AND (${stateColumn} IS NULL OR ${stateColumn} = 'unrated')
  `,
  ).run();
  db.prepare(
    `
    UPDATE images
    SET ${stateColumn} = 'unrated'
    WHERE ${stateColumn} IS NULL
      OR ${stateColumn} NOT IN ('unrated', 'rated', 'not_applicable')
  `,
  ).run();
}

const importJobColumns = db.prepare("PRAGMA table_info(import_jobs)").all();
function addImportJobColumnIfMissing(name, definition) {
  if (importJobColumns.some((column) => column.name === name)) return;
  try {
    db.exec(`ALTER TABLE import_jobs ADD COLUMN ${definition}`);
  } catch (error) {
    if (!String(error?.message || "").includes("duplicate column name")) {
      throw error;
    }
  }
}

addImportJobColumnIfMissing("protocol", "protocol TEXT NOT NULL DEFAULT 'chunked'");
addImportJobColumnIfMissing("uploadLength", "uploadLength INTEGER");
addImportJobColumnIfMissing("uploadOffset", "uploadOffset INTEGER NOT NULL DEFAULT 0");
addImportJobColumnIfMissing("metadata", "metadata TEXT");
