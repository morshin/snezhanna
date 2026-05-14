# TZ-2: Migration Yadisk → SQLite

## Goal

Replace all Yadisk-based JSON/Markdown storage for tasks, memory, and workload history with a single SQLite database. Add a proper project entity with contacts, history, params, and file index. Yadisk remains as a read-only file storage for documents; the agent no longer writes tasks/memory/scores there.

---

## 1. New File: `lib/db.js`

Central database module. Uses `better-sqlite3` (already in dependencies).

```
DB_PATH = /opt/snezhanna/data/snezhanna.db
```

On require: open the database, call `initSchema()`, export the `db` instance and helper functions.

### `initSchema()`

Creates all tables with `CREATE TABLE IF NOT EXISTS`. Run on every startup — idempotent.

### Schema

```sql
-- Projects
CREATE TABLE IF NOT EXISTS projects (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE,
  description TEXT,
  status      TEXT NOT NULL DEFAULT 'active',  -- active | archived
  storage_path TEXT,   -- path on Yadisk e.g. /Snezhanna/projects/ProjectName
  github_repo TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Flexible project parameters (key-value)
CREATE TABLE IF NOT EXISTS project_params (
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  key         TEXT NOT NULL,
  value       TEXT,
  PRIMARY KEY (project_id, key)
);

-- Project event history (unified log)
CREATE TABLE IF NOT EXISTS project_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  INTEGER REFERENCES projects(id) ON DELETE CASCADE,  -- null = global
  date        TEXT NOT NULL,   -- YYYY-MM-DD
  type        TEXT NOT NULL,   -- meeting | decision | milestone | note | task_done | email
  content     TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Global contacts
CREATE TABLE IF NOT EXISTS contacts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  role        TEXT,
  company     TEXT,
  telegram    TEXT,
  email       TEXT,
  phone       TEXT,
  notes       TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Contact ↔ Project linking
CREATE TABLE IF NOT EXISTS project_contacts (
  project_id      INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  contact_id      INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  role_in_project TEXT,
  PRIMARY KEY (project_id, contact_id)
);

-- Tasks (migrated from Yadisk JSON)
CREATE TABLE IF NOT EXISTS tasks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'todo',  -- todo | in_progress | done | cancelled
  urgent      INTEGER NOT NULL DEFAULT 0,    -- 0 | 1
  important   INTEGER NOT NULL DEFAULT 0,    -- 0 | 1
  project_id  INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  due_date    TEXT,   -- YYYY-MM-DD or NULL
  tags        TEXT,   -- JSON array string e.g. '["calls","admin"]'
  notes       TEXT,
  source      TEXT NOT NULL DEFAULT 'local', -- local | github
  github_url  TEXT,
  github_repo TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tasks_status    ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_due_date  ON tasks(due_date);
CREATE INDEX IF NOT EXISTS idx_tasks_project   ON tasks(project_id);

-- Workload history (migrated from workload-history.json)
CREATE TABLE IF NOT EXISTS workload_history (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  date             TEXT NOT NULL UNIQUE,  -- YYYY-MM-DD
  overall_score    INTEGER,
  work_score       INTEGER,
  family_score     INTEGER,
  health_score     INTEGER,
  personal_score   INTEGER,
  trend            TEXT,
  checkin_provided INTEGER DEFAULT 0,
  key_risks        TEXT,   -- JSON array string
  suggestions      TEXT,   -- JSON array string
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Memory (migrated from memory/*.md files)
CREATE TABLE IF NOT EXISTS memory (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  INTEGER REFERENCES projects(id) ON DELETE SET NULL,  -- null = global
  category    TEXT NOT NULL,  -- health | kids | finance | bureaucracy | decisions | project
  key         TEXT,           -- optional short key/title for the entry
  content     TEXT NOT NULL,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_memory_category   ON memory(category);
CREATE INDEX IF NOT EXISTS idx_memory_project    ON memory(project_id);

-- File index (migrated from file_index.json)
CREATE TABLE IF NOT EXISTS file_index (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  INTEGER REFERENCES projects(id) ON DELETE SET NULL,  -- null = global
  path        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  extension   TEXT,
  size_kb     INTEGER,
  summary     TEXT,
  keywords    TEXT,   -- JSON array string
  indexed_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_file_index_path    ON file_index(path);
CREATE INDEX IF NOT EXISTS idx_file_index_project ON file_index(project_id);
```

### Helper exports from `lib/db.js`

```js
db           // raw better-sqlite3 instance (for direct use in other modules)
getProject(name)                    // → project row or null
getProjectById(id)                  // → project row or null
listProjects(status)                // → array, status = 'active'|'archived'|null (all)
upsertProjectParam(projectId, key, value)
getProjectParam(projectId, key)     // → value string or null
```

---

## 2. Rewrite `lib/tasks.js`

Replace all file I/O with `better-sqlite3` calls against the `tasks` table.

Keep the **exact same public API** so no callers need to change:
- `addTask({ title, urgent, important, project, due_date, tags, notes })`
- `listTasks({ project, status, urgent, important, tag })`
- `updateTask(raw)`
- `completeTask(raw)`
- `deleteTask(raw)`
- `getTodayTasks(daysAhead = 2)`
- `eisenhowerSort(tasks)`

**Mapping changes:**
- `project` field (string name) → resolve to `project_id` via `db.getProject(name)`. If project name given but not found in DB → create project automatically with that name.
- `tags` stored as JSON string in DB, parsed back to array on read.
- `urgent`/`important` stored as `0`/`1` integers, converted to booleans on read.
- Remove all `diskLog.log()` calls — no longer writing to Yadisk.
- Remove all `_readTasks()`, `_writeTasks()`, `_readAllTasks()`, `_getAllProjectNames()`, `_resolveTaskStore()` private helpers — replace with SQL queries.

`listTasks` with no `project` filter: `SELECT * FROM tasks` (no join needed for listing; include `project_id`). Return a virtual `project` string field by joining with projects table for backwards compatibility with Mini App and briefing code.

---

## 3. Rewrite `lib/workload.js` — history persistence

Replace `loadHistory()` and `saveHistory()` with SQLite reads/writes against `workload_history` table.

`loadHistory()` → `SELECT * FROM workload_history ORDER BY date DESC LIMIT 12`

`saveHistory(history, entry)` → `INSERT OR REPLACE INTO workload_history (date, overall_score, ...)` using entry fields. Remove Yadisk read/write of `workload-history.json`.

No other changes to workload scoring logic.

---

## 4. Rewrite `lib/memory.js`

Replace file read/write with SQLite against `memory` table.

Keep same public API:
- `readMemory(category)` → `SELECT content FROM memory WHERE category = ? ORDER BY updated_at DESC`  
  Returns concatenated content of all entries in that category, newest first.
- `writeMemory(category, content, mode)`:
  - `mode = 'append'` → `INSERT INTO memory (category, content, updated_at) VALUES (?, ?, datetime('now'))`
  - `mode = 'overwrite'` → delete all rows for category, then insert new row
- `VALID_CATEGORIES` — keep existing list, add `'project'` as valid category

Remove all `fs` operations and `diskLog.log()` calls.

---

## 5. Rewrite `lib/yadisk-dirs.js` — project management

Replace file-based project creation/listing with SQLite.

Keep same public API (called from `lib/tools.js`):
- `createProject(projectName)` → `INSERT INTO projects (name, storage_path) VALUES (?, ?)` where `storage_path = /Snezhanna/projects/{name}`. Also create the physical Yadisk folder as before (Yadisk still used for document storage).
- `listProjects()` → `SELECT * FROM projects WHERE status = 'active'`
- `readProjectFile()` / `writeProjectFile()` / `listProjectDocs()` / `readProjectDoc()` / `writeProjectDoc()` — keep reading/writing actual files on Yadisk (documents stay on Yadisk). No change to these functions.

---

## 6. Rewrite `lib/indexer.js` — file index

Replace `file_index.json` read/write with SQLite `file_index` table.

On full reindex: truncate table, then bulk insert all indexed files.
On incremental reindex: upsert changed files by `path`.

`lib/yadisk.js` `searchFiles()` function: replace JSON file read with:
```sql
SELECT * FROM file_index WHERE (name LIKE ? OR path LIKE ? OR keywords LIKE ?)
```
for each search term, scored by match count. Keep same return format.

---

## 7. Migration Script: `scripts/migrate-from-yadisk.js`

One-time script. Run manually before switching to new code.

```
node scripts/migrate-from-yadisk.js
```

### Steps

**Step 1 — Init DB**
Call `db.initSchema()` to ensure all tables exist.

**Step 2 — Migrate projects**
Read all directories under `/mnt/yadisk-agent/projects/`.
For each directory: insert into `projects` (name = dir name, storage_path = `/Snezhanna/projects/{name}`).
Read `README.md` if exists — extract status line, insert as `project_params(project_id, 'readme_summary', ...)`.

**Step 3 — Migrate tasks**
Read `/mnt/yadisk-agent/tasks/tasks.json` → insert all into `tasks` (project_id = null).
For each project dir: read `projects/{name}/tasks.json` → insert all into `tasks` with resolved `project_id`.
Preserve original `id` values as-is (SQLite autoincrement will skip them if we insert with explicit id).

**Step 4 — Migrate workload history**
Read `/mnt/yadisk-agent/workload-history.json` → insert all entries into `workload_history`.

**Step 5 — Migrate memory**
For each file in `/mnt/yadisk-agent/memory/`:
- Category = filename without `.md` extension
- Insert as single row: `INSERT INTO memory (category, content, updated_at)`

**Step 6 — Report**
Print summary:
```
Migration complete:
  Projects:         N
  Tasks:            N  
  Workload entries: N
  Memory files:     N
```

---

## 8. Backup Cron

Add to `schedules/heartbeats.json`:
```json
{
  "id": "db_backup",
  "name": "SQLite Backup",
  "cron": "0 4 * * 0",
  "description": "Weekly backup of snezhanna.db to Yadisk",
  "enabled": true
}
```

Add to `index.js` `setupSchedules()`:
```js
cron.schedule('0 4 * * 0', async () => {
  const date = new Date().toLocaleDateString('sv-SE', { timeZone: config.timezone });
  const dest = `/mnt/yadisk-agent/backups/snezhanna-${date}.db`;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  db.backup(dest)
    .then(() => console.log(`[Schedule] db_backup done → ${dest}`))
    .catch(e => console.error('[Schedule] db_backup error:', e.message));
}, { timezone: config.timezone });
```

`better-sqlite3` has a built-in `.backup(dest)` method — no shell commands needed.

---

## 9. Remove Yadisk Write Dependencies

After migration is confirmed working:

- Remove write calls to `tasks/tasks.json` and `projects/*/tasks.json` (already gone after step 2)
- Remove write calls to `memory/*.md` (already gone after step 4)
- Remove write calls to `workload-history.json` (already gone after step 3)
- Remove `diskLog` entries for task/memory/workload operations
- Keep `diskLog` for project document writes (still on Yadisk)
- Keep `/mnt/yadisk-agent` mount — still used for: project docs, fitness data, drafts, backups, kids data

---

## 10. Mini App API — `lib/api.js`

Tasks API already works via `lib/tasks.js` public interface — no changes needed if `tasks.js` keeps same return format.

One addition: tasks returned to Mini App now include `project` as a string (project name, not id) for backwards compatibility. Ensure `listTasks()` joins with `projects` table to return `project` name field alongside `project_id`.

---

## 11. Files Modified

| File | Change |
|------|--------|
| `lib/db.js` | **New** — SQLite init, schema, helpers |
| `lib/tasks.js` | Rewrite internals, keep public API |
| `lib/workload.js` | Replace `loadHistory`/`saveHistory` |
| `lib/memory.js` | Rewrite read/write |
| `lib/yadisk-dirs.js` | Replace project create/list with SQLite |
| `lib/indexer.js` | Replace JSON index with SQLite |
| `lib/yadisk.js` | Replace `searchFiles` with SQLite query |
| `index.js` | Add db_backup cron |
| `schedules/heartbeats.json` | Add db_backup entry |
| `scripts/migrate-from-yadisk.js` | **New** — one-time migration script |

---

## Out of Scope (future TZs)

- Projects/contacts UI in Mini App (TZ-3)
- project_history write tools for Claude (TZ-3)
- Contacts management tools for Claude (TZ-3)
- file_index migration from indexer.js (can be done as incremental reindex after deploy)
