import crypto from "node:crypto";

function placeholders(length) {
  return Array.from({ length }, () => "?").join(", ");
}
function chunk(items, size = 400) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function criterionFromTaskType(taskType) {
  return String(taskType || "").split(":")[1] || null;
}

function reportRate(count, total) {
  return total ? count / total : 0;
}

function parseOptionalScorer(value, httpError) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  if (text.length > 100) throw httpError(400, "打分人不能超过 100 字");
  return text;
}

function parseOptionalSubmissionMode(value, httpError) {
  const mode = String(value ?? "").trim();
  if (!mode) return null;
  if (!["direct", "ranked", "untracked"].includes(mode)) {
    throw httpError(400, "提交方式筛选不正确");
  }
  return mode;
}

function parseTaskCursor(value, httpError) {
  if (!value) return null;
  let parsed;
  try {
    parsed = typeof value === "string" ? JSON.parse(value) : value;
  } catch {
    throw httpError(400, "任务分页游标格式不正确");
  }
  const completedAt = String(parsed?.completedAt ?? "");
  const id = String(parsed?.id ?? "");
  if (!completedAt || !id) throw httpError(400, "任务分页游标格式不正确");
  return { completedAt, id };
}

function includeTaskTotal(query = {}) {
  return ["1", "true", "yes"].includes(
    String(query.includeTotal ?? "").toLowerCase(),
  );
}

function parseDurationSeconds(value, label, httpError) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw httpError(400, `${label}不正确`);
  }
  return Math.round(seconds * 1000);
}

function taskIdFromPayloadItem(item) {
  if (typeof item === "string" || typeof item === "number") return item;
  if (!item || typeof item !== "object") return null;
  return item.id ?? item.taskId ?? item._id ?? null;
}

function extractTaskIds(payload, httpError) {
  const source = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.taskIds)
      ? payload.taskIds
      : Array.isArray(payload?.ids)
        ? payload.ids
        : Array.isArray(payload?.tasks)
          ? payload.tasks
          : Array.isArray(payload?.rows)
            ? payload.rows
            : [];

  const rawIds = source
    .map(taskIdFromPayloadItem)
    .map((item) => String(item ?? "").trim())
    .filter(Boolean);
  if (!rawIds.length) throw httpError(400, "JSON 中未找到可回退的任务 ID");
  if (rawIds.length > 10000) throw httpError(400, "一次最多回退 10000 个任务");

  const seen = new Set();
  const taskIds = [];
  rawIds.forEach((id) => {
    if (seen.has(id)) return;
    seen.add(id);
    taskIds.push(id);
  });
  return {
    rawTaskCount: rawIds.length,
    duplicateTaskCount: rawIds.length - taskIds.length,
    taskIds,
  };
}

function taskRecordDto(row) {
  const durationMs = row.durationMs == null ? null : Number(row.durationMs);
  return {
    taskId: row.id,
    projectId: row.projectId || row.subjectId,
    projectName: row.projectName || "未命名项目",
    criterion: criterionFromTaskType(row.taskType),
    status: row.status,
    scorer: row.scorer || "未分配",
    submissionMode: row.submissionMode || null,
    rankingActionCount: Number(row.rankingActionCount || 0),
    durationMs,
    durationSeconds: durationMs == null ? null : durationMs / 1000,
    completedAt: row.completedAt ?? null,
    editedAt: row.editedAt ?? null,
    editCount: Number(row.editCount || 0),
    rollbackCount: Number(row.rollbackCount || 0),
    updatedAt: row.updatedAt,
  };
}

function groupRollbackRows(rows, key, nameKey) {
  const map = new Map();
  rows.forEach((row) => {
    const id = row[key] || "unknown";
    const item = map.get(id) || {
      id,
      name: row[nameKey] || id,
      taskCount: 0,
    };
    item.taskCount += 1;
    map.set(id, item);
  });
  return [...map.values()].sort((left, right) =>
    left.name.localeCompare(right.name, "zh-CN"),
  );
}

export function createAdminScoringService({
  db,
  taskVersion,
  httpError,
  nowIso,
  parseProjectId,
  parseTaskPagination,
  onTasksChanged,
}) {
  const rollbackJobs = new Map();
  const activeRollbackJobsByKey = new Map();
  const summaryCache = new Map();
  const summaryCacheTtlMs = 15 * 1000;

  function buildSummaryFilter(query = {}) {
    const clauses = [
      "rating_tasks.taskVersion = ?",
      "rating_tasks.status = 'completed'",
      "rating_tasks.scorer IS NOT NULL",
      "TRIM(rating_tasks.scorer) <> ''",
    ];
    const params = [taskVersion];
    const scorer = parseOptionalScorer(query.scorer, httpError);
    const projectId = query.projectId ? parseProjectId(query.projectId) : null;
    if (scorer) {
      clauses.push("rating_tasks.scorer = ?");
      params.push(scorer);
    }
    if (projectId) {
      clauses.push("rating_tasks.projectId = ?");
      params.push(projectId);
    }
    return { where: `WHERE ${clauses.join(" AND ")}`, params };
  }

  function buildTaskFilter(query = {}) {
    const filter = buildSummaryFilter(query);
    const clauses = [filter.where.replace(/^WHERE\s+/i, "")];
    const params = [...filter.params];
    const submissionMode = parseOptionalSubmissionMode(query.submissionMode, httpError);
    const minDurationMs = parseDurationSeconds(query.minDurationSeconds, "最短打分时长", httpError);
    const maxDurationMs = parseDurationSeconds(query.maxDurationSeconds, "最长打分时长", httpError);

    if (submissionMode === "untracked") {
      clauses.push("rating_tasks.submissionMode IS NULL");
    } else if (submissionMode) {
      clauses.push("rating_tasks.submissionMode = ?");
      params.push(submissionMode);
    }
    if (minDurationMs != null) {
      clauses.push("rating_tasks.durationMs >= ?");
      params.push(minDurationMs);
    }
    if (maxDurationMs != null) {
      clauses.push("rating_tasks.durationMs <= ?");
      params.push(maxDurationMs);
    }
    return { where: `WHERE ${clauses.join(" AND ")}`, params };
  }

  async function calculateScoringSummary(query = {}) {
    const { page, pageSize } = parseTaskPagination(query);
    const filter = buildTaskFilter(query);
    const totalScorerCount = Number(
      (await db
        .prepare(
          `SELECT COUNT(*) AS total
           FROM (
             SELECT rating_tasks.scorer
             FROM rating_tasks
             ${filter.where}
             GROUP BY rating_tasks.scorer
           ) AS scorer_groups`,
        )
        .get(...filter.params)).total || 0,
    );
    const totalsRow = await db
      .prepare(
        `SELECT COUNT(*) AS totalTaskCount,
                SUM(CASE WHEN rating_tasks.submissionMode = 'direct' THEN 1 ELSE 0 END) AS directSubmitCount,
                SUM(CASE WHEN rating_tasks.submissionMode = 'ranked' THEN 1 ELSE 0 END) AS rankedSubmitCount,
                SUM(CASE WHEN rating_tasks.submissionMode IS NULL THEN 1 ELSE 0 END) AS untrackedSubmitCount
         FROM rating_tasks
         ${filter.where}`,
      )
      .get(...filter.params);
    const rows = await db
      .prepare(
        `SELECT rating_tasks.scorer,
                COUNT(*) AS totalTaskCount,
                COUNT(DISTINCT rating_tasks.projectId) AS projectCount,
                SUM(CASE WHEN rating_tasks.submissionMode = 'direct' THEN 1 ELSE 0 END) AS directSubmitCount,
                SUM(CASE WHEN rating_tasks.submissionMode = 'ranked' THEN 1 ELSE 0 END) AS rankedSubmitCount,
                SUM(CASE WHEN rating_tasks.submissionMode IS NULL THEN 1 ELSE 0 END) AS untrackedSubmitCount,
                AVG(CASE WHEN rating_tasks.durationMs >= 0 THEN rating_tasks.durationMs END) AS averageDurationMs,
                MIN(CASE WHEN rating_tasks.durationMs >= 0 THEN rating_tasks.durationMs END) AS minDurationMs,
                MAX(CASE WHEN rating_tasks.durationMs >= 0 THEN rating_tasks.durationMs END) AS maxDurationMs,
                SUM(COALESCE(rating_tasks.rollbackCount, 0)) AS rollbackCount
         FROM rating_tasks
         ${filter.where}
         GROUP BY rating_tasks.scorer
         ORDER BY directSubmitCount DESC,
                  averageDurationMs ASC,
                  rating_tasks.scorer COLLATE NOCASE ASC
         LIMIT ? OFFSET ?`,
      )
      .all(...filter.params, pageSize, (page - 1) * pageSize);

    const totals = {
      scorerCount: totalScorerCount,
      totalTaskCount: Number(totalsRow.totalTaskCount || 0),
      directSubmitCount: Number(totalsRow.directSubmitCount || 0),
      rankedSubmitCount: Number(totalsRow.rankedSubmitCount || 0),
      untrackedSubmitCount: Number(totalsRow.untrackedSubmitCount || 0),
    };

    return {
      ...totals,
      page,
      pageSize,
      directSubmitRate: reportRate(totals.directSubmitCount, totals.totalTaskCount),
      scorers: rows.map((row) => {
        const totalTaskCount = Number(row.totalTaskCount || 0);
        const directSubmitCount = Number(row.directSubmitCount || 0);
        const rankedSubmitCount = Number(row.rankedSubmitCount || 0);
        const untrackedSubmitCount = Number(row.untrackedSubmitCount || 0);
        const averageDurationMs = row.averageDurationMs == null ? null : Number(row.averageDurationMs);
        const minDurationMs = row.minDurationMs == null ? null : Number(row.minDurationMs);
        const maxDurationMs = row.maxDurationMs == null ? null : Number(row.maxDurationMs);
        return {
          scorer: row.scorer,
          projectCount: Number(row.projectCount || 0),
          totalTaskCount,
          directSubmitCount,
          rankedSubmitCount,
          untrackedSubmitCount,
          directSubmitRate: reportRate(directSubmitCount, totalTaskCount),
          averageDurationMs,
          averageDurationSeconds: averageDurationMs == null ? null : averageDurationMs / 1000,
          minDurationMs,
          minDurationSeconds: minDurationMs == null ? null : minDurationMs / 1000,
          maxDurationMs,
          maxDurationSeconds: maxDurationMs == null ? null : maxDurationMs / 1000,
          rollbackCount: Number(row.rollbackCount || 0),
        };
      }),
    };
  }

  async function listScoringSummary(query = {}) {
    const key = JSON.stringify({
      page: query.page || 1,
      pageSize: query.pageSize || 10,
      scorer: query.scorer || null,
      projectId: query.projectId || null,
      submissionMode: query.submissionMode || null,
      minDurationSeconds: query.minDurationSeconds || null,
      maxDurationSeconds: query.maxDurationSeconds || null,
    });
    const cached = summaryCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const value = await calculateScoringSummary(query);
    summaryCache.set(key, {
      value,
      expiresAt: Date.now() + summaryCacheTtlMs,
    });
    return value;
  }

  async function listScoringTaskRecords(query = {}) {
    const { page, pageSize } = parseTaskPagination(query);
    const filter = buildTaskFilter(query);
    const cursor = parseTaskCursor(query.cursor, httpError);
    const total = includeTaskTotal(query)
      ? Number(
        (await db
          .prepare(`SELECT COUNT(*) AS total FROM rating_tasks ${filter.where}`)
          .get(...filter.params)).total || 0,
      )
      : null;
    const rows = await db
      .prepare(
        `SELECT rating_tasks.id, rating_tasks.subjectId, rating_tasks.projectId,
                rating_tasks.taskType, rating_tasks.status, rating_tasks.scorer,
                rating_tasks.submissionMode, rating_tasks.rankingActionCount,
                rating_tasks.durationMs, rating_tasks.completedAt, rating_tasks.editedAt,
                rating_tasks.editCount, rating_tasks.rollbackCount, rating_tasks.updatedAt,
                projects.name AS projectName
         FROM rating_tasks
         JOIN projects ON projects.id = rating_tasks.projectId
         ${filter.where}
         ${cursor ? "AND (rating_tasks.completedAt < ? OR (rating_tasks.completedAt = ? AND rating_tasks.id > ?))" : ""}
         ORDER BY rating_tasks.completedAt DESC NULLS LAST, rating_tasks.id ASC
         LIMIT ?${cursor ? "" : " OFFSET ?"}`,
      )
      .all(
      ...filter.params,
      ...(cursor ? [cursor.completedAt, cursor.completedAt, cursor.id] : []),
      pageSize + 1,
      ...(cursor ? [] : [(page - 1) * pageSize])
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
        ? JSON.stringify({ completedAt: lastRow.completedAt, id: lastRow.id })
        : null,
      tasks: pageRows.map(taskRecordDto),
    };
  }

  async function selectTasksByIds(taskIds) {
    const rows = [];
    for (const ids of chunk(taskIds)) {
      rows.push(
        ...(await db
          .prepare(
            `SELECT rating_tasks.id, rating_tasks.subjectId, rating_tasks.projectId,
                    rating_tasks.taskVersion, rating_tasks.taskType, rating_tasks.status,
                    rating_tasks.scorer, rating_tasks.submissionMode,
                    rating_tasks.rankingActionCount, rating_tasks.durationMs,
                    rating_tasks.completedAt, rating_tasks.editedAt, rating_tasks.editCount,
                    rating_tasks.rollbackCount, rating_tasks.updatedAt,
                    projects.name AS projectName
             FROM rating_tasks
             LEFT JOIN projects ON projects.id = rating_tasks.projectId
             WHERE rating_tasks.id IN (${placeholders(ids.length)})`,
          )
          .all(...ids)),
      );
    }
    const order = new Map(taskIds.map((id, index) => [id, index]));
    return rows.sort((left, right) => order.get(left.id) - order.get(right.id));
  }

  async function analyzeRollbackPayload(payload) {
    const extracted = extractTaskIds(payload, httpError);
    const rows = await selectTasksByIds(extracted.taskIds);
    const rowById = new Map(rows.map((row) => [row.id, row]));
    const missingTaskIds = extracted.taskIds.filter((id) => !rowById.has(id));
    const matchedRows = extracted.taskIds
      .map((id) => rowById.get(id))
      .filter(Boolean);
    const rollbackRows = matchedRows.filter(
      (row) => row.taskVersion === taskVersion && row.status === "completed",
    );
    const ignoredRows = matchedRows.filter(
      (row) => row.taskVersion !== taskVersion || row.status !== "completed",
    );
    return {
      ...extracted,
      matchedRows,
      rollbackRows,
      ignoredRows,
      missingTaskIds,
    };
  }

  function rollbackPreviewDto(analysis) {
    const taskPreviewLimit = 300;
    const ignoredPreviewLimit = 100;
    const projectRows = analysis.rollbackRows.map((row) => ({
      ...row,
      projectGroupId: row.projectId || row.subjectId,
      projectGroupName: row.projectName || row.projectId || row.subjectId,
    }));
    return {
      requestedTaskCount: analysis.rawTaskCount,
      uniqueTaskCount: analysis.taskIds.length,
      duplicateTaskCount: analysis.duplicateTaskCount,
      matchedTaskCount: analysis.matchedRows.length,
      rollbackTaskCount: analysis.rollbackRows.length,
      ignoredTaskCount: analysis.ignoredRows.length + analysis.missingTaskIds.length,
      missingTaskCount: analysis.missingTaskIds.length,
      taskIds: analysis.rollbackRows.map((row) => row.id),
      scorers: groupRollbackRows(analysis.rollbackRows, "scorer", "scorer"),
      projects: groupRollbackRows(projectRows, "projectGroupId", "projectGroupName"),
      tasks: analysis.rollbackRows.slice(0, taskPreviewLimit).map(taskRecordDto),
      ignoredTasks: analysis.ignoredRows.slice(0, ignoredPreviewLimit).map(taskRecordDto),
      missingTaskIds: analysis.missingTaskIds.slice(0, ignoredPreviewLimit),
      taskPreviewLimit,
      ignoredPreviewLimit,
      hasMoreTasks: analysis.rollbackRows.length > taskPreviewLimit,
      hasMoreIgnored: analysis.ignoredRows.length + analysis.missingTaskIds.length > ignoredPreviewLimit,
    };
  }

  async function previewRollback(payload = {}) {
    return rollbackPreviewDto(await analyzeRollbackPayload(payload));
  }

  async function rollbackScoringTasks(payload = {}, admin = {}, onProgress) {
    onProgress?.({ stage: "正在校验回退任务", progress: 8 });
    const analysis = await analyzeRollbackPayload(payload);
    if (!analysis.rollbackRows.length) throw httpError(400, "没有可回退的已完成任务");

    const now = nowIso();
    const adminName = String(admin?.username || "admin");
    const taskIds = analysis.rollbackRows.map((row) => row.id);
    const projectIds = [
      ...new Set(
        analysis.rollbackRows
          .map((row) => row.projectId || row.subjectId)
          .filter(Boolean),
      ),
    ];
    let changed = 0;

    onProgress?.({ stage: "正在回退任务", progress: 20 });
    await db.exec("BEGIN IMMEDIATE");
    try {
      for (const ids of chunk(taskIds)) {
        changed += (await db
          .prepare(
            `UPDATE rating_tasks
             SET status = 'assigned',
                 ranking = NULL,
                 excludedImageIds = NULL,
                 correctImageIds = NULL,
                 rankingRelations = NULL,
                 submissionMode = NULL,
                 rankingActionCount = 0,
                 startedAt = NULL,
                 completedAt = NULL,
                 durationMs = NULL,
                 editedAt = NULL,
                 editCount = 0,
                 rollbackCount = COALESCE(rollbackCount, 0) + 1,
                 lastRolledBackAt = ?,
                 lastRolledBackBy = ?,
                 updatedAt = ?
             WHERE taskVersion = ?
               AND status = 'completed'
               AND id IN (${placeholders(ids.length)})`,
          )
          .run(now, adminName, now, taskVersion, ...ids)).changes;
      }

      onProgress?.({ stage: "正在更新项目状态", progress: 88 });
      if (changed !== taskIds.length) {
        throw httpError(409, "部分任务状态已变化，请重新预览后再回退");
      }

      for (const ids of chunk(projectIds)) {
        await db.prepare(
          `UPDATE projects
           SET taskStatus = 'scoring', updatedAt = ?
           WHERE id IN (${placeholders(ids.length)})`,
        ).run(now, ...ids);
      }

      await db.exec("COMMIT");
    } catch (error) {
      try {
        await db.exec("ROLLBACK");
      } catch {}
      throw error;
    }

    if (!changed) throw httpError(409, "任务状态已变化，请重新预览后再回退");
    onTasksChanged?.();
    return {
      ...rollbackPreviewDto(analysis),
      rolledBackTaskCount: changed,
      rolledBackAt: now,
      rolledBackBy: adminName,
    };
  }

  function rollbackJobDto(job) {
    const dto = {
      jobId: job.jobId,
      status: job.status,
      stage: job.stage,
      progress: job.progress,
      message: job.message || null,
      requestedTaskCount: job.requestedTaskCount,
      uniqueTaskCount: job.uniqueTaskCount,
    };
    if (job.result) dto.result = job.result;
    return dto;
  }

  function rollbackJobKey(taskIds) {
    return [...taskIds].sort().join("\u0000");
  }

  function startRollbackJob(payload = {}, admin = {}) {
    const extracted = extractTaskIds(payload, httpError);
    const key = rollbackJobKey(extracted.taskIds);
    const activeJobId = activeRollbackJobsByKey.get(key);
    if (activeJobId) {
      const activeJob = rollbackJobs.get(activeJobId);
      if (activeJob && ["queued", "running"].includes(activeJob.status)) {
        return activeJob;
      }
      activeRollbackJobsByKey.delete(key);
    }

    const job = {
      jobId: crypto.randomUUID(),
      status: "queued",
      stage: "等待回退任务",
      progress: 0,
      message: null,
      result: null,
      requestedTaskCount: extracted.rawTaskCount,
      uniqueTaskCount: extracted.taskIds.length,
    };
    rollbackJobs.set(job.jobId, job);
    activeRollbackJobsByKey.set(key, job.jobId);

    setImmediate(async () => {
      job.status = "running";
      job.stage = "正在准备回退任务";
      job.progress = 3;
      try {
        job.result = await rollbackScoringTasks({ taskIds: extracted.taskIds }, admin, ({ stage, progress }) => {
          job.stage = stage;
          job.progress = Math.max(0, Math.min(99, progress));
        });
        job.status = "completed";
        job.stage = "任务回退完成";
        job.progress = 100;
      } catch (error) {
        job.status = "failed";
        job.stage = "任务回退失败";
        job.message = error?.message || "任务回退失败，请重试";
        console.error(`Scoring rollback failed (${job.jobId})`, error);
      } finally {
        activeRollbackJobsByKey.delete(key);
        setTimeout(() => rollbackJobs.delete(job.jobId), 24 * 60 * 60 * 1000).unref();
      }
    });

    return job;
  }

  function getRollbackJob(jobId) {
    return rollbackJobs.get(jobId) || null;
  }

  return {
    listScoringSummary,
    listScoringTaskRecords,
    previewRollback,
    rollbackScoringTasks,
    startRollbackJob,
    getRollbackJob,
    rollbackJobDto,
  };
}
