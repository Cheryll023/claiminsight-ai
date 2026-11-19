import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
export const TMP_DIR = path.join(DATA_DIR, 'tmp');

for (const dir of [DATA_DIR, UPLOAD_DIR, TMP_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

export const db = new DatabaseSync(path.join(DATA_DIR, 'app.db'));

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS batches (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'grouping',
    classify_status TEXT NOT NULL DEFAULT 'idle',
    classify_message TEXT,
    classify_at TEXT
  );

  CREATE TABLE IF NOT EXISTS cases (
    id TEXT PRIMARY KEY,
    batch_id TEXT,
    code TEXT NOT NULL,
    employee_id TEXT,
    employee_name TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    report_json TEXT,
    analysis_error TEXT,
    analysis_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS recordings (
    id TEXT PRIMARY KEY,
    batch_id TEXT NOT NULL,
    case_id TEXT,
    filename TEXT NOT NULL,
    stored_path TEXT NOT NULL,
    size INTEGER NOT NULL DEFAULT 0,
    format TEXT,
    duration REAL,
    rec_date TEXT,
    rec_type TEXT,
    employee_id TEXT,
    status TEXT NOT NULL DEFAULT 'uploaded',
    progress INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    transcript_json TEXT,
    speaker_map_json TEXT,
    needs_review INTEGER NOT NULL DEFAULT 0,
    sort_index INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    source_path TEXT,
    match_code TEXT,
    match_source TEXT,
    match_confidence TEXT,
    match_candidates TEXT,
    content_hints TEXT
  );

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    case_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    citations_json TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS kb_docs (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    ext TEXT,
    size INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'processing',
    error TEXT,
    text TEXT,
    chunks INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS kb_chunks (
    id TEXT PRIMARY KEY,
    doc_id TEXT NOT NULL,
    idx INTEGER NOT NULL,
    title TEXT,
    text TEXT NOT NULL,
    embedding TEXT
  );

  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    ref_id TEXT,
    label TEXT,
    status TEXT NOT NULL DEFAULT 'queued',
    progress INTEGER NOT NULL DEFAULT 0,
    message TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_recordings_batch ON recordings(batch_id);
  CREATE INDEX IF NOT EXISTS idx_recordings_case ON recordings(case_id);
  CREATE INDEX IF NOT EXISTS idx_cases_batch ON cases(batch_id);
  CREATE INDEX IF NOT EXISTS idx_messages_case ON messages(case_id);
  CREATE INDEX IF NOT EXISTS idx_chunks_doc ON kb_chunks(doc_id);
`);

const MIGRATIONS = {
  batches: {
    classify_status: "TEXT NOT NULL DEFAULT 'idle'",
    classify_message: 'TEXT',
    classify_at: 'TEXT',
  },
  recordings: {
    source_path: 'TEXT',
    match_code: 'TEXT',
    match_source: 'TEXT',
    match_confidence: 'TEXT',
    match_candidates: 'TEXT',
    content_hints: 'TEXT',
  },
};

/* 已有数据库的增量迁移（CREATE TABLE IF NOT EXISTS 不会补列） */
for (const [table, columns] of Object.entries(MIGRATIONS)) {
  const existing = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name));
  for (const [name, ddl] of Object.entries(columns)) {
    if (!existing.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${ddl}`);
  }
}

export const q = {
  all(sql, ...params) {
    return db.prepare(sql).all(...params);
  },
  get(sql, ...params) {
    return db.prepare(sql).get(...params);
  },
  run(sql, ...params) {
    return db.prepare(sql).run(...params);
  },
};

export function nowIso() {
  return new Date().toISOString();
}

export function uid() {
  return crypto.randomUUID();
}

export function jsonParse(value, fallback = null) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function getSetting(key, fallback = '') {
  const row = q.get('SELECT value FROM settings WHERE key = ?', key);
  return row ? row.value : fallback;
}

export function setSetting(key, value) {
  q.run(
    `INSERT INTO settings(key, value) VALUES(?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    key,
    String(value ?? ''),
  );
}

export function deleteRecordingFile(rec) {
  if (!rec?.stored_path) return;
  try {
    fs.rmSync(rec.stored_path, { force: true });
  } catch {
    /* ignore */
  }
}

export { ROOT };
