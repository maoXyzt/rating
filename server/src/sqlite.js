import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const scoreNumericFields = [
  'overall',
  'creativity',
  'mood',
  'composition',
  'color',
  'lighting',
  'realism',
  'detail',
  'promptAlignment',
  'textCorrectness',
  'anatomyNormality',
  'informationClarity',
  'designQuality',
  'typography'
];

export const skippableScoreFields = [
  'promptAlignment',
  'textCorrectness',
  'anatomyNormality',
  'informationClarity',
  'designQuality',
  'typography'
];

export const scoreStateFields = skippableScoreFields.map(field => `${field}State`);
export const scoreFilterKeys = new Set(scoreNumericFields);
export const subjectSelectColumns = 'id AS _id, name, originalFilename, importBatch, storageRoot, imageCount, categoryCount, status, createdAt, updatedAt';
export const imageSelectColumns = `id AS _id, subjectId, filename, originalPath, storagePath, mimeType, category, importBatch, scorer, ${scoreNumericFields.join(', ')}, ${scoreStateFields.join(', ')}, discomfort, comment, ratedAt, createdAt, updatedAt`;

const serverDir = path.dirname(fileURLToPath(import.meta.url));
const defaultDbPath = path.resolve(serverDir, '..', 'data', 'image-rating.sqlite');
const configuredDbPath = process.env.DB_PATH ? path.resolve(process.env.DB_PATH) : defaultDbPath;

await fs.mkdir(path.dirname(configuredDbPath), { recursive: true });

export const db = new DatabaseSync(configuredDbPath);

db.exec(`
  PRAGMA foreign_keys = ON;
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;

  CREATE TABLE IF NOT EXISTS subjects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    originalFilename TEXT NOT NULL,
    importBatch TEXT NOT NULL UNIQUE,
    storageRoot TEXT,
    imageCount INTEGER NOT NULL DEFAULT 0,
    categoryCount INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'importing' CHECK (status IN ('importing', 'imported', 'failed')),
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS images (
    id TEXT PRIMARY KEY,
    subjectId TEXT NOT NULL,
    filename TEXT NOT NULL,
    originalPath TEXT NOT NULL,
    storagePath TEXT NOT NULL,
    mimeType TEXT,
    category TEXT NOT NULL,
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
  CREATE INDEX IF NOT EXISTS idx_images_subject_category ON images(subjectId, category);
  CREATE INDEX IF NOT EXISTS idx_images_subject_createdAt ON images(subjectId, createdAt DESC);
  CREATE INDEX IF NOT EXISTS idx_images_importBatch ON images(importBatch);
  CREATE INDEX IF NOT EXISTS idx_images_ratedAt ON images(ratedAt);
`);

const subjectColumns = db.prepare('PRAGMA table_info(subjects)').all();
if (!subjectColumns.some(column => column.name === 'storageRoot')) {
  db.exec('ALTER TABLE subjects ADD COLUMN storageRoot TEXT');
}

const imageColumns = db.prepare('PRAGMA table_info(images)').all();
if (!imageColumns.some(column => column.name === 'scorer')) {
  db.exec('ALTER TABLE images ADD COLUMN scorer TEXT');
}

for (const field of skippableScoreFields) {
  const stateColumn = `${field}State`;
  if (!imageColumns.some(column => column.name === stateColumn)) {
    db.exec(`ALTER TABLE images ADD COLUMN ${stateColumn} TEXT NOT NULL DEFAULT 'unrated'`);
  }
  db.prepare(`
    UPDATE images
    SET ${stateColumn} = 'rated'
    WHERE ${field} IS NOT NULL
      AND (${stateColumn} IS NULL OR ${stateColumn} = 'unrated')
  `).run();
  db.prepare(`
    UPDATE images
    SET ${stateColumn} = 'unrated'
    WHERE ${stateColumn} IS NULL
      OR ${stateColumn} NOT IN ('unrated', 'rated', 'not_applicable')
  `).run();
}
