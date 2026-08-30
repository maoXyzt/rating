import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync(workerData.databasePath, { readOnly: true });
db.exec("PRAGMA query_only = ON; PRAGMA busy_timeout = 500; PRAGMA foreign_keys = ON;");

const taskVersion = workerData.taskVersion;
const taskCriteria = workerData.taskCriteria;
const scoreNumericFields = workerData.scoreNumericFields;
const skippableScoreFields = workerData.skippableScoreFields;
const scoreFilterKeys = new Set(scoreNumericFields);
const scoreStateFields = skippableScoreFields.map((field) => `${field}State`);
const imageSelectColumns = workerData.imageSelectColumns;
const imageListSelectColumns =
  "id AS _id, subjectId, filename, storagePath, thumbnailPath, category, directory, isInfographic";
const taskListImageSelectColumns =
  "id AS _id, filename, storagePath, thumbnailPath";

function queryError(status, message, code = "QUERY_FAILED") {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function placeholders(length) {
  return Array.from({ length }, () => "?").join(", ");
}

function parsePage(query, defaultSize = 10) {
  return {
    page: Math.max(Math.floor(Number(query.page) || 1), 1),
    pageSize: Math.min(
      Math.max(Math.floor(Number(query.pageSize) || defaultSize), 1),
      100,
    ),
  };
}

function parseProjectId(value) {
  const projectId = String(value ?? '').trim();
  if (!projectId) throw queryError(400, '请选择项目');
  const project = db.prepare(`
    SELECT id, packageId
    FROM projects
    WHERE id = ? AND deletionRequestedAt IS NULL
    LIMIT 1
  `).get(projectId);
  if (!project) {
    throw queryError(404, '项目不存在');
  }
  const packageIds = db
    .prepare('SELECT packageId FROM project_packages WHERE projectId = ?')
    .all(projectId)
    .map((row) => row.packageId);
  if (!packageIds.length) packageIds.push(project.packageId);
  const importedPackageCount = db.prepare(`
    SELECT COUNT(*) AS count
    FROM subjects
    WHERE id IN (${placeholders(packageIds.length)})
      AND deletionRequestedAt IS NULL
      AND status = 'imported'
  `).get(...packageIds).count;
  if (importedPackageCount !== packageIds.length) {
    throw queryError(409, '关联图包尚未处理完成');
  }
  return projectId;
}

function enabled(value) {
  return ["1", "true", "yes"].includes(String(value ?? "").toLowerCase());
}

function assetUrl(storagePath) {
  return storagePath ? `/files/${storagePath}` : null;
}

function parseJsonObject(value) {
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

function parseJsonArray(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function feedbackDto(row, messages) {
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
    messages: messages.map((message) => ({
      id: message.id,
      author: message.author,
      authorRole: message.authorRole,
      content: message.content,
      createdAt: message.createdAt,
    })),
    images: parseJsonArray(row.imagePaths)
      .filter((item) => typeof item === "string" && item.startsWith("feedback/"))
      .map((imagePath) => ({ path: imagePath, url: `/files/${imagePath}` })),
  };
}

function listFeedbacks(query) {
  const { page, pageSize } = parsePage(query);
  const statuses = new Set(["pending", "processing", "resolved"]);
  const status = query.status ? String(query.status) : null;
  if (status && !statuses.has(status)) throw queryError(400, "处理状态不正确");
  const where = status ? " WHERE status = ?" : "";
  const params = status ? [status] : [];
  const total = db
    .prepare(`SELECT COUNT(*) AS total FROM feedbacks${where}`)
    .get(...params).total;
  const rows = db
    .prepare(
      `SELECT * FROM feedbacks${where} ORDER BY submittedAt DESC, id DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, pageSize, (page - 1) * pageSize);
  const messagesByFeedbackId = new Map();
  if (rows.length) {
    db.prepare(`
      SELECT id, feedbackId, author, authorRole, content, createdAt
      FROM feedback_messages
      WHERE feedbackId IN (${placeholders(rows.length)})
      ORDER BY feedbackId ASC, createdAt ASC, id ASC
    `).all(...rows.map((row) => row.id)).forEach((message) => {
      const messages = messagesByFeedbackId.get(message.feedbackId) || [];
      messages.push(message);
      messagesByFeedbackId.set(message.feedbackId, messages);
    });
  }
  return {
    total,
    page,
    pageSize,
    items: rows.map((row) => feedbackDto(row, messagesByFeedbackId.get(row.id) || [])),
  };
}

function clampScore(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(1, Math.min(10, Math.round(number)));
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
    params.push(`%${String(query.filename).replace(/[\\%_]/g, "\\$&")}%`);
  }
  if (query.scorer) {
    clauses.push("scorer = ?");
    params.push(String(query.scorer));
  }
  if (query.status === "rated") clauses.push("overall IS NOT NULL");
  if (query.status === "unrated") clauses.push("overall IS NULL");
  const criteria = String(query.scoreCriteria || "")
    .split(",")
    .map((key) => key.trim())
    .filter((key) => scoreFilterKeys.has(key));
  let ranges = {};
  try {
    ranges = JSON.parse(String(query.scoreRanges || "{}"));
  } catch {}
  for (const key of criteria) {
    const range = Array.isArray(ranges[key]) ? ranges[key] : [];
    const min = clampScore(range[0], 1);
    const max = clampScore(range[1], 10);
    if (skippableScoreFields.includes(key)) clauses.push(`${key}State = 'rated'`);
    clauses.push(`${key} BETWEEN ? AND ?`);
    params.push(Math.min(min, max), Math.max(min, max));
  }
  return {
    where: clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "",
    params,
  };
}

function scoreFromRow(row) {
  const score = {};
  scoreNumericFields.forEach((field) => {
    score[field] = row[field] ?? null;
  });
  score.criterionStates = Object.fromEntries(
    scoreStateFields.map((field) => [field.slice(0, -5), row[field] ?? null]),
  );
  score.discomfort = row.discomfort == null ? null : Boolean(row.discomfort);
  score.scorer = row.scorer ?? null;
  score.comment = row.comment ?? "";
  score.ratedAt = row.ratedAt ?? null;
  return score;
}

function listImages(query) {
  const { page, pageSize } = parsePage(query, 20);
  const { where, params } = buildImageFilter(query);
  const includeTotal = enabled(query.includeTotal);
  const includeDetails = enabled(query.includeDetails);
  const total = includeTotal
    ? db.prepare(`SELECT COUNT(*) AS total FROM images${where}`).get(...params).total
    : null;
  const columns = includeDetails ? imageSelectColumns : imageListSelectColumns;
  const rows = db
    .prepare(`SELECT ${columns} FROM images${where} ORDER BY createdAt DESC LIMIT ? OFFSET ?`)
    .all(...params, pageSize, (page - 1) * pageSize);
  return {
    total,
    page,
    pageSize,
    items: rows.map((row) => ({
      _id: row._id,
      subjectId: row.subjectId,
      filename: row.filename,
      ...(includeDetails
        ? {
            originalPath: row.originalPath,
            prompt: row.prompt ?? null,
            catalog: parseJsonObject(row.catalogData),
            score: scoreFromRow(row),
          }
        : {}),
      category: row.category,
      directory: row.directory || "",
      isInfographic: Boolean(row.isInfographic),
      imageUrl: assetUrl(row.storagePath),
      thumbnailUrl: assetUrl(row.thumbnailPath),
    })),
  };
}

function parseCursor(value) {
  if (!value) return null;
  let parsed;
  try {
    parsed = typeof value === "string" ? JSON.parse(value) : value;
  } catch {
    throw queryError(400, "任务分页游标格式不正确");
  }
  if (!parsed?.taskType || !parsed?.createdAt || !parsed?.id) {
    throw queryError(400, "任务分页游标格式不正确");
  }
  const criterionOrder = Number(parsed.criterionOrder);
  return {
    taskType: String(parsed.taskType),
    createdAt: String(parsed.createdAt),
    id: String(parsed.id),
    criterionOrder: Number.isFinite(criterionOrder) ? criterionOrder : null,
  };
}

function criterionOrderSql(column) {
  const cases = taskCriteria
    .map((criterion, index) => {
      const taskType = `dimension:${criterion}`;
      return `WHEN ${column} = '${taskType}' OR ${column} LIKE '${taskType}:%' THEN ${index}`;
    })
    .join(" ");
  return `CASE ${cases} ELSE ${taskCriteria.length} END`;
}

function hydrateTaskListRows(rows) {
  if (!rows.length) return rows.map((row) => ({ ...row, items: [] }));
  const taskIds = rows.map((row) => row.id);
  const itemRows = db.prepare(`
    SELECT taskId, imageId, position
    FROM rating_task_items
    WHERE taskId IN (${placeholders(taskIds.length)})
    ORDER BY taskId ASC, position ASC
  `).all(...taskIds);
  const imageIds = [...new Set(itemRows.map((item) => item.imageId))];
  const images = imageIds.length
    ? db.prepare(`SELECT ${taskListImageSelectColumns} FROM images WHERE id IN (${placeholders(imageIds.length)})`).all(...imageIds)
    : [];
  const imageById = new Map(images.map((row) => [row._id, {
    _id: row._id,
    filename: row.filename,
    imageUrl: assetUrl(row.storagePath),
    thumbnailUrl: assetUrl(row.thumbnailPath),
  }]));
  const itemsByTaskId = new Map();
  itemRows.forEach((item) => {
    const image = imageById.get(item.imageId);
    if (!image) return;
    const items = itemsByTaskId.get(item.taskId) || [];
    items.push({ position: item.position, image });
    itemsByTaskId.set(item.taskId, items);
  });
  return rows.map((row) => ({ ...row, items: itemsByTaskId.get(row.id) || [] }));
}

function listAssignedTasks(query) {
  const scorer = String(query.scorer || "").trim();
  if (!scorer) throw queryError(400, "缺少打分人");
  const user = db.prepare("SELECT 1 FROM users WHERE username = ? AND role = 'scorer' LIMIT 1").get(scorer);
  if (!user) throw queryError(404, "打分账号不存在");
  const { page, pageSize } = parsePage(query);
  const clauses = ["rating_tasks.taskVersion = ?", "rating_tasks.scorer = ?"];
  const params = [taskVersion, scorer];
  const status = String(query.status || "");
  if (["assigned", "completed"].includes(status)) {
    clauses.push("rating_tasks.status = ?");
    params.push(status);
  } else {
    clauses.push("rating_tasks.status IN ('assigned', 'completed')");
  }
  if (query.projectId) {
    clauses.push("rating_tasks.projectId = ?");
    params.push(parseProjectId(query.projectId));
  }
  const criterion = String(query.criterion || "");
  if (taskCriteria.includes(criterion)) {
    const taskType = `dimension:${criterion}`;
    clauses.push("(rating_tasks.taskType = ? OR rating_tasks.taskType LIKE ?)");
    params.push(taskType, `${taskType}:%`);
  }
  const where = `WHERE ${clauses.join(" AND ")}`;
  const orderSql = criterionOrderSql("rating_tasks.taskType");
  const cursor = parseCursor(query.cursor);
  const useCursor = Boolean(cursor && cursor.criterionOrder != null);
  const cursorWhere = useCursor
    ? ` AND ((${orderSql}) > ? OR ((${orderSql}) = ? AND (rating_tasks.createdAt > ? OR (rating_tasks.createdAt = ? AND rating_tasks.id > ?))))`
    : "";
  const total = enabled(query.includeTotal)
    ? db.prepare(`SELECT COUNT(*) AS total FROM rating_tasks ${where}`).get(...params).total
    : null;
  const rows = db.prepare(`
    SELECT rating_tasks.id, rating_tasks.subjectId, rating_tasks.projectId,
           rating_tasks.taskType, rating_tasks.status, rating_tasks.createdAt,
           ${orderSql} AS criterionOrder, projects.name AS subjectName
    FROM rating_tasks
    JOIN projects ON projects.id = rating_tasks.projectId
    ${where}${cursorWhere}
    ORDER BY ${orderSql} ASC, rating_tasks.createdAt ASC, rating_tasks.id ASC
    LIMIT ?${useCursor ? "" : " OFFSET ?"}
  `).all(
    ...params,
    ...(useCursor
      ? [cursor.criterionOrder, cursor.criterionOrder, cursor.createdAt, cursor.createdAt, cursor.id]
      : []),
    pageSize + 1,
    ...(useCursor ? [] : [(page - 1) * pageSize]),
  );
  const hasMore = rows.length > pageSize;
  const pageRows = rows.slice(0, pageSize);
  const hydrated = enabled(query.summaryOnly)
    ? pageRows.map((row) => ({ ...row, items: [] }))
    : hydrateTaskListRows(pageRows);
  const lastRow = pageRows.at(-1);
  return {
    total,
    page,
    pageSize,
    hasMore,
    nextCursor: hasMore && lastRow
      ? JSON.stringify({
          taskType: lastRow.taskType,
          createdAt: lastRow.createdAt,
          id: lastRow.id,
          criterionOrder: Number(lastRow.criterionOrder),
        })
      : null,
    tasks: hydrated.map((row) => ({
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

function scorerDashboard(query) {
  const scorer = String(query.scorer || "").trim();
  if (!scorer) throw queryError(400, "缺少打分人");
  const user = db.prepare("SELECT 1 FROM users WHERE username = ? AND role = 'scorer' LIMIT 1").get(scorer);
  if (!user) throw queryError(404, "打分账号不存在");
  const projectId = query.projectId ? parseProjectId(query.projectId) : null;
  const stats = db.prepare(`
    SELECT SUM(CASE WHEN status = 'assigned' THEN 1 ELSE 0 END) AS pendingTasks,
           SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completedTasks
    FROM rating_tasks
    WHERE taskVersion = ? AND scorer = ? AND (? IS NULL OR projectId = ?)
  `).get(taskVersion, scorer, projectId, projectId);
  const pendingTasks = Number(stats.pendingTasks || 0);
  const completedTasks = Number(stats.completedTasks || 0);
  const totalTasks = pendingTasks + completedTasks;
  const projectCount = Number(db.prepare(`
    SELECT COUNT(DISTINCT projectId) AS total
    FROM rating_tasks
    WHERE taskVersion = ? AND scorer = ? AND status IN ('assigned', 'completed')
  `).get(taskVersion, scorer).total || 0);
  return {
    pendingTasks,
    completedTasks,
    totalTasks,
    projectCount,
    progress: totalTasks ? Math.round((completedTasks / totalTasks) * 100) : 0,
  };
}

const operations = {
  feedbacks: listFeedbacks,
  images: listImages,
  assignedTasks: listAssignedTasks,
  scorerDashboard,
};

parentPort.on("message", ({ requestId, operation, query }) => {
  try {
    const handler = operations[operation];
    if (!handler) throw queryError(400, "不支持的查询操作");
    parentPort.postMessage({ requestId, ok: true, data: handler(query || {}) });
  } catch (error) {
    parentPort.postMessage({
      requestId,
      ok: false,
      status: error.status || 500,
      code: error.code || "QUERY_FAILED",
      message: error.message || "查询失败",
    });
  }
});
