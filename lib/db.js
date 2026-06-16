'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const config = require('./config');
const DB_PATH = path.resolve(path.join(__dirname, '..'), config.database.path);
const DB_DIR = path.dirname(DB_PATH);

if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true });
}

const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS projects (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT NOT NULL UNIQUE,
    display_name TEXT,
    client       TEXT,
    type         TEXT,
    platform     TEXT,
    status       TEXT NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active', 'paused', 'completed', 'archived')),
    contacts     TEXT DEFAULT '{}',
    description  TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    title        TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'in_progress', 'done', 'cancelled')),
    urgent       INTEGER NOT NULL DEFAULT 0,
    important    INTEGER NOT NULL DEFAULT 0,
    project_id   INTEGER REFERENCES projects(id) ON DELETE SET NULL,
    parent_id    INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
    due_date     TEXT,
    tags         TEXT DEFAULT '[]',
    notes        TEXT,
    source       TEXT DEFAULT 'manual',
    source_ref   TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_tasks_status  ON tasks(status);
  CREATE INDEX IF NOT EXISTS idx_tasks_parent  ON tasks(parent_id);
  CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
  CREATE INDEX IF NOT EXISTS idx_tasks_due     ON tasks(due_date);

  CREATE TABLE IF NOT EXISTS task_deps (
    task_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    depends_on INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    PRIMARY KEY (task_id, depends_on)
  );

  CREATE TABLE IF NOT EXISTS project_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    content    TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_project_log ON project_log(project_id, created_at);

  CREATE TABLE IF NOT EXISTS project_notes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    content    TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS project_docs (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    filename   TEXT NOT NULL,
    content    TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (project_id, filename)
  );

  CREATE TABLE IF NOT EXISTS project_params (
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    key        TEXT NOT NULL,
    value      TEXT,
    PRIMARY KEY (project_id, key)
  );

  CREATE TABLE IF NOT EXISTS project_history (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
    date       TEXT NOT NULL,
    type       TEXT NOT NULL,
    content    TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_project_history ON project_history(project_id, date);

  CREATE TABLE IF NOT EXISTS contacts (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    role       TEXT,
    company    TEXT,
    telegram   TEXT,
    email      TEXT,
    phone      TEXT,
    notes      TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS project_contacts (
    project_id      INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    contact_id      INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    role_in_project TEXT,
    PRIMARY KEY (project_id, contact_id)
  );

  CREATE TABLE IF NOT EXISTS workload_history (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    date             TEXT NOT NULL UNIQUE,
    overall_score    INTEGER,
    work_score       INTEGER,
    family_score     INTEGER,
    health_score     INTEGER,
    personal_score   INTEGER,
    trend            TEXT,
    checkin_provided INTEGER DEFAULT 0,
    key_risks        TEXT,
    suggestions      TEXT,
    created_at       TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS memory (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
    category   TEXT NOT NULL,
    key        TEXT,
    content    TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_memory_category ON memory(category);
  CREATE INDEX IF NOT EXISTS idx_memory_project  ON memory(project_id);

  CREATE TABLE IF NOT EXISTS user_settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS monitored_chats (
    chat_id  INTEGER PRIMARY KEY,
    name     TEXT NOT NULL,
    type     TEXT NOT NULL DEFAULT 'personal',
    category TEXT,
    project  TEXT
  );

  CREATE TABLE IF NOT EXISTS file_index (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
    path       TEXT NOT NULL UNIQUE,
    name       TEXT NOT NULL,
    extension  TEXT,
    size_kb    INTEGER,
    modified   TEXT,
    category   TEXT,
    summary    TEXT,
    keywords   TEXT,
    indexed_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_file_index_path    ON file_index(path);
  CREATE INDEX IF NOT EXISTS idx_file_index_project ON file_index(project_id);

  CREATE TABLE IF NOT EXISTS email_accounts (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    label         TEXT NOT NULL,
    email         TEXT NOT NULL UNIQUE,
    type          TEXT NOT NULL,
    account_type  TEXT NOT NULL DEFAULT 'personal',
    enabled       INTEGER NOT NULL DEFAULT 1,
    bootstrapped  INTEGER NOT NULL DEFAULT 0,
    credentials   TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS email_seen (
    account_id  INTEGER NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
    message_id  TEXT NOT NULL,
    seen_at     TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (account_id, message_id)
  );
  CREATE INDEX IF NOT EXISTS idx_email_seen_account ON email_seen(account_id);
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS _migrations (
    name       TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

// ── Migration runner ──────────────────────────────────────────────────────────

const MIGRATIONS_DIR = path.join(__dirname, '../migrations');

function runMigrations() {
  if (!fs.existsSync(MIGRATIONS_DIR)) return;

  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.js'))
    .sort();

  const applied = new Set(
    db.prepare('SELECT name FROM _migrations').all().map(r => r.name)
  );

  for (const file of files) {
    if (applied.has(file)) continue;
    console.log(`[db] Running migration: ${file}`);
    const migrate = require(path.join(MIGRATIONS_DIR, file));
    db.transaction(() => {
      migrate(db);
      db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(file);
    })();
    console.log(`[db] Migration applied: ${file}`);
  }
}

runMigrations();

console.log(`[db] SQLite ready: ${DB_PATH}`);

// ── Helper functions ──────────────────────────────────────────────────────────

function getProject(name) {
  return db.prepare('SELECT * FROM projects WHERE name = ?').get(name) || null;
}

function getProjectById(id) {
  return db.prepare('SELECT * FROM projects WHERE id = ?').get(id) || null;
}

function listProjects(status) {
  if (status) {
    return db.prepare('SELECT * FROM projects WHERE status = ? ORDER BY name').all(status);
  }
  return db.prepare('SELECT * FROM projects ORDER BY name').all();
}

function upsertProjectParam(projectId, key, value) {
  db.prepare('INSERT OR REPLACE INTO project_params (project_id, key, value) VALUES (?, ?, ?)')
    .run(projectId, key, value);
}

function getProjectParam(projectId, key) {
  const row = db.prepare('SELECT value FROM project_params WHERE project_id = ? AND key = ?').get(projectId, key);
  return row ? row.value : null;
}

async function backup(destPath) {
  return db.backup(destPath);
}

module.exports = { db, getProject, getProjectById, listProjects, upsertProjectParam, getProjectParam, backup };
