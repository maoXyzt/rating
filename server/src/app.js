import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import AdmZip from 'adm-zip';
import iconv from 'iconv-lite';
import {
  db,
  imageSelectColumns,
  scoreFilterKeys,
  scoreNumericFields,
  skippableScoreFields,
  subjectSelectColumns
} from './sqlite.js';

const app = express();
const port = Number(process.env.PORT || 3000);
const uploadDir = path.resolve(process.env.UPLOAD_DIR || 'uploads');
const zipUploadDir = path.join(uploadDir, '_zips');
const chunkUploadDir = path.join(uploadDir, '_chunks');
const imageExts = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);

await fs.mkdir(uploadDir, { recursive: true });
await fs.mkdir(zipUploadDir, { recursive: true });
await fs.mkdir(chunkUploadDir, { recursive: true });

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use('/files', express.static(uploadDir));

const upload = multer({
  dest: zipUploadDir,
  limits: { fileSize: 1024 * 1024 * 1024 }
});

const chunkUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 16 * 1024 * 1024 }
});

const insertSubjectStmt = db.prepare(`
  INSERT INTO subjects (id, name, originalFilename, importBatch, storageRoot, imageCount, categoryCount, status, createdAt, updatedAt)
  VALUES (@id, @name, @originalFilename, @importBatch, @storageRoot, 0, 0, 'importing', @createdAt, @updatedAt)
`);

const updateSubjectCountsStmt = db.prepare(`
  UPDATE subjects
  SET imageCount = @imageCount,
      categoryCount = @categoryCount,
      status = @status,
      updatedAt = @updatedAt
  WHERE id = @id
`);

const selectSubjectByIdStmt = db.prepare(`SELECT ${subjectSelectColumns} FROM subjects WHERE id = ?`);
const selectSubjectsStmt = db.prepare(`SELECT ${subjectSelectColumns} FROM subjects ORDER BY createdAt DESC`);
const selectImageByIdStmt = db.prepare(`SELECT ${imageSelectColumns} FROM images WHERE id = ?`);
const insertImageStmt = db.prepare(`
  INSERT OR IGNORE INTO images (
    id, subjectId, filename, originalPath, storagePath, mimeType, category, importBatch,
    overall, creativity, mood, composition, color, lighting, realism, detail, discomfort,
    promptAlignment, textCorrectness, anatomyNormality, informationClarity, designQuality, typography,
    comment, ratedAt, createdAt, updatedAt
  ) VALUES (
    @id, @subjectId, @filename, @originalPath, @storagePath, @mimeType, @category, @importBatch,
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

function cleanRelative(value) {
  return value
    .replace(/\\/g, '/')
    .split('/')
    .filter(segment => segment && segment !== '.' && segment !== '..')
    .map(item => item.replace(/[^\p{L}\p{N}._-]/gu, '_'))
    .join('/');
}

function cleanFolderName(value, fallback = 'upload') {
  const cleaned = String(value)
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean)
    .join('_')
    .replace(/\s+/g, '_')
    .replace(/[^\p{L}\p{N}._-]/gu, '_')
    .replace(/^[._-]+|[._-]+$/g, '');
  return cleaned || fallback;
}

function detectArchiveRoot(entries) {
  const roots = new Set();
  let hasNestedImage = false;

  for (const entry of entries) {
    const relative = cleanRelative(entry.entryName);
    if (!relative) continue;
    const parts = relative.split('/');
    roots.add(parts[0]);
    if (parts.length > 1) hasNestedImage = true;
  }

  return roots.size === 1 && hasNestedImage ? [...roots][0] : null;
}

function stripArchiveRoot(relative, root) {
  if (!root) return relative;
  const parts = relative.split('/');
  return parts[0] === root ? parts.slice(1).join('/') : relative;
}

function isMacMetadataEntry(relative) {
  if (!relative) return true;
  if (relative === '.DS_Store' || relative.endsWith('/.DS_Store')) return true;
  return relative
    .split('/')
    .some(segment => segment === '__MACOSX' || segment.startsWith('._'));
}

async function allocateSubjectStorageRoot(subjectName, subjectId) {
  const baseName = cleanFolderName(subjectName, `subject-${subjectId.slice(0, 8)}`);
  let candidate = baseName;
  let attempt = 0;

  while (true) {
    try {
      await fs.access(path.join(uploadDir, candidate));
      attempt += 1;
      candidate = `${baseName}-${subjectId.slice(0, 8)}${attempt > 1 ? `-${attempt}` : ''}`;
    } catch {
      return candidate;
    }
  }
}

function validateUploadId(uploadId) {
  if (!/^[a-z0-9-]{8,128}$/i.test(uploadId)) {
    throw httpError(400, '上传标识不正确');
  }
}

function chunkDir(uploadId) {
  validateUploadId(uploadId);
  return path.join(chunkUploadDir, uploadId);
}

function chunkFilePath(uploadId, index) {
  return path.join(chunkDir(uploadId), `${String(index).padStart(6, '0')}.part`);
}

function decodeZipName(value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const utf8Text = buffer.toString('utf8');
  if (!utf8Text.includes('\uFFFD')) return utf8Text;
  try {
    return iconv.decode(buffer, 'gbk');
  } catch {
    return utf8Text;
  }
}

const zipDecoder = {
  efs: false,
  encode: value => Buffer.from(String(value), 'utf8'),
  decode: decodeZipName
};

async function importZipArchive(zipPath, originalFilename) {
  const batch = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const subjectId = crypto.randomUUID();
  const subjectName = path.basename(originalFilename, path.extname(originalFilename)) || originalFilename;
  const createdAt = nowIso();
  const zip = new AdmZip(zipPath, { decoder: zipDecoder });
  const imageEntries = zip.getEntries().filter(entry => {
    if (entry.isDirectory) return false;
    const relative = cleanRelative(entry.entryName);
    return Boolean(relative)
      && !isMacMetadataEntry(relative)
      && imageExts.has(path.extname(relative).toLowerCase());
  });
  const archiveRoot = detectArchiveRoot(imageEntries);
  const storageRoot = await allocateSubjectStorageRoot(subjectName, subjectId);
  const subjectDir = path.join(uploadDir, storageRoot);
  const categories = new Set();
  let imported = 0;
  let skipped = 0;

  try {
    db.exec('BEGIN IMMEDIATE');
    insertSubjectStmt.run({
      id: subjectId,
      name: subjectName,
      originalFilename,
      importBatch: batch,
      storageRoot,
      createdAt,
      updatedAt: createdAt
    });

    await fs.mkdir(subjectDir, { recursive: true });

    for (const entry of imageEntries) {
      if (entry.isDirectory) continue;
      const relative = stripArchiveRoot(cleanRelative(entry.entryName), archiveRoot);
      if (isMacMetadataEntry(relative)) continue;
      const ext = path.extname(relative).toLowerCase();
      if (!relative || !imageExts.has(ext)) continue;

      const category = relative.includes('/') ? relative.split('/').slice(0, -1).join('/') : '未分类';
      const imageId = crypto.randomUUID();
      const relativeDir = path.posix.dirname(relative);
      const storagePath = path.posix.join(
        storageRoot,
        relativeDir === '.' ? '' : relativeDir,
        `${imageId}${ext}`
      );
      const storedPath = path.join(uploadDir, ...storagePath.split('/'));

      await fs.mkdir(path.dirname(storedPath), { recursive: true });
      await fs.writeFile(storedPath, entry.getData());
      const result = insertImageStmt.run({
        id: imageId,
        subjectId,
        filename: path.basename(relative),
        originalPath: relative,
        storagePath,
        mimeType: ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : `image/${ext.slice(1)}`,
        category,
        importBatch: batch,
        createdAt,
        updatedAt: createdAt
      });

      if (result.changes === 0) {
        await fs.unlink(storedPath).catch(() => {});
        skipped++;
        continue;
      }

      categories.add(category);
      imported++;
    }

    const updatedAt = nowIso();
    updateSubjectCountsStmt.run({
      id: subjectId,
      imageCount: imported,
      categoryCount: categories.size,
      status: 'imported',
      updatedAt
    });

    db.exec('COMMIT');
    const subject = selectSubjectByIdStmt.get(subjectId);
    return { subject: subjectDto(subject), batch, imported, skipped };
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {}
    await fs.rm(subjectDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  } finally {
    await fs.unlink(zipPath).catch(() => {});
  }
}

function nowIso() {
  return new Date().toISOString();
}

function clampScore(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  const rounded = Math.round(number);
  return Math.max(1, Math.min(10, rounded));
}

function parseScoreValue(value, key) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number) || !Number.isInteger(number) || number < 1 || number > 10) {
    throw httpError(400, `${key} 必须是 1-10 的整数`);
  }
  return number;
}

function scoreStateColumn(key) {
  return `${key}State`;
}

function parseScoreState(value, key) {
  if (value === null || value === undefined || value === '') return null;
  const state = String(value);
  if (!['unrated', 'rated', 'not_applicable'].includes(state)) {
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
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value === 1 || value === '1' || value === 'true') return 1;
  if (value === 0 || value === '0' || value === 'false') return 0;
  throw httpError(400, '不舒适字段格式不正确');
}

function parseComment(value) {
  if (value === null || value === undefined) return '';
  const text = String(value).trim();
  if (text.length > 2000) throw httpError(400, '备注不能超过 2000 字');
  return text;
}

function parseScorerName(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  if (text.length > 100) throw httpError(400, '打分人不能超过 100 字');
  return text;
}

function normalizeScorePayload(body) {
  const payload = {};
  const criterionStates = body.criterionStates && typeof body.criterionStates === 'object' ? body.criterionStates : {};

  for (const key of scoreNumericFields) {
    const isSkippable = skippableScoreFields.includes(key);
    const stateKey = scoreStateColumn(key);
    const requestedState = isSkippable ? parseScoreState(criterionStates[key] ?? body[stateKey], key) : null;

    if (requestedState === 'not_applicable') {
      payload[key] = null;
      payload[stateKey] = 'not_applicable';
      continue;
    }

    payload[key] = parseScoreValue(body[key], key);
    if (isSkippable) {
      payload[stateKey] = payload[key] === null ? 'unrated' : 'rated';
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
    skippableScoreFields.map(key => {
      const state = row[scoreStateColumn(key)];
      return [key, ['unrated', 'rated', 'not_applicable'].includes(state) ? state : (row[key] == null ? 'unrated' : 'rated')];
    })
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
    discomfort: row.discomfort === null || row.discomfort === undefined ? null : Boolean(row.discomfort),
    promptAlignment: row.promptAlignment,
    textCorrectness: row.textCorrectness,
    anatomyNormality: row.anatomyNormality,
    informationClarity: row.informationClarity,
    designQuality: row.designQuality,
    typography: row.typography,
    criterionStates,
    scorer: row.scorer ?? null,
    comment: row.comment ?? '',
    ratedAt: row.ratedAt ?? null
  };
}

function imageDto(row) {
  return {
    _id: row._id,
    subjectId: row.subjectId,
    filename: row.filename,
    category: row.category,
    imageUrl: `/files/${row.storagePath}`,
    score: scoreFromRow(row)
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
        status: row.status,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt
      }
    : null;
}

function buildImageFilter(query) {
  const clauses = [];
  const params = [];

  if (query.subjectId) {
    clauses.push('subjectId = ?');
    params.push(String(query.subjectId));
  }

  if (query.category) {
    clauses.push('category = ?');
    params.push(String(query.category));
  }

  if (query.scorer) {
    clauses.push('scorer = ?');
    params.push(String(query.scorer));
  }

  if (query.status === 'rated') {
    clauses.push('overall IS NOT NULL');
  } else if (query.status === 'unrated') {
    clauses.push('overall IS NULL');
  }

  const keys = String(query.scoreCriteria || '')
    .split(',')
    .map(key => key.trim())
    .filter(key => scoreFilterKeys.has(key));

  let scoreRanges = {};
  try {
    scoreRanges = JSON.parse(String(query.scoreRanges || '{}'));
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
    where: clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '',
    params
  };
}

function listImages(query) {
  const page = Math.max(Number(query.page) || 1, 1);
  const pageSize = Math.min(Math.max(Number(query.pageSize) || 20, 1), 100);
  const { where, params } = buildImageFilter(query);
  const total = db.prepare(`SELECT COUNT(*) AS total FROM images${where}`).get(...params).total;
  const items = db
    .prepare(`SELECT ${imageSelectColumns} FROM images${where} ORDER BY createdAt DESC LIMIT ? OFFSET ?`)
    .all(...params, pageSize, (page - 1) * pageSize)
    .map(imageDto);

  return { total, page, pageSize, items };
}

function getCategories(subjectId) {
  const rows = subjectId
    ? db.prepare('SELECT DISTINCT category FROM images WHERE subjectId = ? ORDER BY category COLLATE NOCASE').all(String(subjectId))
    : db.prepare('SELECT DISTINCT category FROM images ORDER BY category COLLATE NOCASE').all();
  return rows.map(row => row.category);
}

function getScorers(subjectId) {
  const where = subjectId
    ? 'subjectId = ? AND scorer IS NOT NULL AND scorer <> \'\' AND overall IS NOT NULL'
    : 'scorer IS NOT NULL AND scorer <> \'\' AND overall IS NOT NULL';
  const rows = subjectId
    ? db.prepare(`SELECT DISTINCT scorer FROM images WHERE ${where} ORDER BY scorer COLLATE NOCASE`).all(String(subjectId))
    : db.prepare(`SELECT DISTINCT scorer FROM images WHERE ${where} ORDER BY scorer COLLATE NOCASE`).all();
  return rows.map(row => row.scorer);
}

app.get('/api/subjects', async (_req, res, next) => {
  try {
    res.json(selectSubjectsStmt.all().map(subjectDto));
  } catch (error) {
    next(error);
  }
});

app.get('/api/categories', async (req, res, next) => {
  try {
    res.json(getCategories(req.query.subjectId));
  } catch (error) {
    next(error);
  }
});

app.get('/api/scorers', async (req, res, next) => {
  try {
    res.json(getScorers(req.query.subjectId));
  } catch (error) {
    next(error);
  }
});

app.get('/api/images', async (req, res, next) => {
  try {
    res.json(listImages(req.query));
  } catch (error) {
    next(error);
  }
});

app.post('/api/import', upload.single('file'), async (req, res, next) => {
  if (!req.file) return res.status(400).json({ message: '请选择 ZIP 文件' });
  if (path.extname(req.file.originalname).toLowerCase() !== '.zip') {
    await fs.unlink(req.file.path).catch(() => {});
    return res.status(400).json({ message: '仅支持 ZIP 文件' });
  }

  try {
    res.status(201).json(await importZipArchive(req.file.path, req.file.originalname));
  } catch (error) {
    next(error);
  }
});

app.post('/api/import/chunks/:uploadId/parts/:index', chunkUpload.single('chunk'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ message: '缺少上传分片' });
    const index = Number(req.params.index);
    if (!Number.isInteger(index) || index < 0) throw httpError(400, '分片序号不正确');

    const dir = chunkDir(req.params.uploadId);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(chunkFilePath(req.params.uploadId, index), req.file.buffer);
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.post('/api/import/chunks/:uploadId/complete', async (req, res, next) => {
  let dir;
  let zipPath;
  try {
    dir = chunkDir(req.params.uploadId);
    zipPath = path.join(zipUploadDir, `${req.params.uploadId}.zip`);
    const originalFilename = String(req.body?.filename || '').trim();
    const totalChunks = Number(req.body?.totalChunks);
    if (!originalFilename || path.extname(originalFilename).toLowerCase() !== '.zip') {
      throw httpError(400, '仅支持 ZIP 文件');
    }
    if (!Number.isInteger(totalChunks) || totalChunks <= 0) {
      throw httpError(400, '分片总数不正确');
    }

    const output = await fs.open(zipPath, 'w');
    try {
      for (let index = 0; index < totalChunks; index++) {
        const partPath = chunkFilePath(req.params.uploadId, index);
        const buffer = await fs.readFile(partPath).catch(() => {
          throw httpError(400, `缺少第 ${index + 1} 个分片`);
        });
        await output.write(buffer);
      }
    } finally {
      await output.close();
    }

    res.status(201).json(await importZipArchive(zipPath, originalFilename));
  } catch (error) {
    if (zipPath) await fs.unlink(zipPath).catch(() => {});
    next(error);
  } finally {
    if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

app.delete('/api/import/chunks/:uploadId', async (req, res, next) => {
  try {
    await fs.rm(chunkDir(req.params.uploadId), { recursive: true, force: true });
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.delete('/api/subjects/:id', async (req, res, next) => {
  try {
    const subject = selectSubjectByIdStmt.get(req.params.id);
    if (!subject) return res.status(404).json({ message: '图包不存在' });

    const images = db.prepare('SELECT storagePath FROM images WHERE subjectId = ?').all(req.params.id);
    const storageRoot = subject.storageRoot;
    db.exec('BEGIN IMMEDIATE');
    db.prepare('DELETE FROM subjects WHERE id = ?').run(req.params.id);
    db.exec('COMMIT');

    if (storageRoot) {
      await fs.rm(path.join(uploadDir, storageRoot), { recursive: true, force: true }).catch(() => {});
    } else {
      await Promise.all(
        images.map(row => fs.unlink(path.join(uploadDir, row.storagePath)).catch(() => {}))
      );
    }

    res.json({ subject: subjectDto(subject), deletedImages: images.length });
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {}
    next(error);
  }
});

app.put('/api/images/:id/score', async (req, res, next) => {
  try {
    const current = selectImageByIdStmt.get(req.params.id);
    if (!current) return res.status(404).json({ message: '图片不存在' });

    const score = normalizeScorePayload(req.body || {});
    updateImageScoreStmt.run({
      id: req.params.id,
      ...score,
      scorer: score.scorer ?? current.scorer ?? null,
      updatedAt: score.ratedAt
    });

    const updated = selectImageByIdStmt.get(req.params.id);
    res.json(imageDto(updated));
  } catch (error) {
    next(error);
  }
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(error.status || 500).json({ message: error.message || '服务异常' });
});

app.listen(port, () => console.log(`API ready on ${port}`));

export default app;
