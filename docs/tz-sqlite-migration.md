# TZ: Migrating Snezhanna Personal to SQLite

> Specification for Claude Code. Format: behavioral, without function names or code skeletons.

---

## Goal

Migrate task and project storage from JSON files on Yandex.Disk to a local SQLite database. Remove the scattered `tasks.json` files, project markdown files, and `memory/*.md` — replace them with a single DB that provides fast search, entity relationships, and reliable integrity.

**What is NOT included:** memory/health.md and other memory files are left as-is in the first phase — their migration is optional (see section 9).

---

## 1. What Gets Migrated

| Currently (JSON/MD on Yandex.Disk) | Becomes (SQLite) |
|-----------------------------------|-----------------|
| `/mnt/yadisk-agent/tasks/tasks.json` | `tasks` table |
| `/mnt/yadisk-agent/projects/{name}/tasks.json` | `tasks` table with `project_id` |
| `/mnt/yadisk-agent/projects/{name}/README.md` | `projects` table |
| `/mnt/yadisk-agent/projects/{name}/log.md` | `project_log` table |
| `/mnt/yadisk-agent/projects/{name}/notes.md` | `project_notes` table |
| `/mnt/yadisk-agent/projects/{name}/docs/*` | `project_docs` table |
| GitHub Issues (live fetch) | No change — still live fetch, merged in list_tasks |

---

## 2. Database Location

```
/opt/snezhanna/data/snezhanna.db
```

The `data/` directory is created on bot startup if it doesn't exist. The path is configurable via `config/nanobot.json → database.path`.

**Backup:** daily automatic backup to `/mnt/yadisk-agent/backups/snezhanna_YYYYMMDD.db` via cron (03:30, after the indexer). Keep 7 most recent.

---

## 3. Database Schema

### tasks

```sql
CREATE TABLE tasks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    title       TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'in_progress', 'done', 'cancelled')),
    urgent      INTEGER NOT NULL DEFAULT 0,    -- boolean: 0/1
    important   INTEGER NOT NULL DEFAULT 0,    -- boolean: 0/1
    project_id  INTEGER REFERENCES projects(id) ON DELETE SET NULL,
    parent_id   INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
    due_date    TEXT,                          -- YYYY-MM-DD
    tags        TEXT DEFAULT '[]',             -- JSON array
    notes       TEXT,
    source      TEXT DEFAULT 'manual',         -- manual, voice, email, chat, github
    source_ref  TEXT,                          -- message_id, issue URL, etc.
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT
);

CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_tasks_project ON tasks(project_id) WHERE status IN ('pending', 'in_progress');
CREATE INDEX idx_tasks_due ON tasks(due_date) WHERE status IN ('pending', 'in_progress');
CREATE INDEX idx_tasks_parent ON tasks(parent_id);
```

### task_deps (task dependencies)

```sql
CREATE TABLE task_deps (
    task_id     INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    depends_on  INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    PRIMARY KEY (task_id, depends_on)
);
```

### projects

```sql
CREATE TABLE projects (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL UNIQUE,           -- folder name (slug)
    display_name TEXT,                          -- human-readable name
    client      TEXT,                           -- client/company
    type        TEXT,                           -- Implementation, Migration, Audit...
    platform    TEXT,                           -- 1C:ERP, 1C:UT...
    status      TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('active', 'paused', 'completed', 'archived')),
    contacts    TEXT DEFAULT '{}',              -- JSON
    description TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### project_log (work log)

```sql
CREATE TABLE project_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    content     TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_project_log ON project_log(project_id, created_at DESC);
```

### project_notes (notes)

```sql
CREATE TABLE project_notes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    content     TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### project_docs (project documentation)

```sql
CREATE TABLE project_docs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    filename    TEXT NOT NULL,                  -- requirements.md, architecture.md...
    content     TEXT NOT NULL,
    updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (project_id, filename)
);
```

---

## 4. User-Facing Behavior — What Changes

### Tasks

**Nothing changes for the user.** All commands and tools work as before:
- "Add task: call Alexei" → `add_task`
- "Show tasks" → `list_tasks`
- "Complete task 5" → `complete_task`
- Morning briefing → tasks from SQLite instead of JSON
- Evening checklist → same
- Mini App → same API endpoints, same data

**New behavior:**
- `parent_id` — subtasks. "Break task 5 into subtasks" → Claude creates tasks with `parent_id = 5`. In list_tasks, subtasks are displayed nested.
- `task_deps` — dependencies. "Task 7 blocks task 8" → entry in task_deps. Blocked tasks are flagged in the briefing.
- `source` + `source_ref` — where the task came from. Captured by voice → `source: 'voice'`. From chat → `source: 'chat'`. From email → `source: 'email'`.

### Projects

**Nothing changes for the user:**
- "Create project Migration-ERP" → `create_project`
- "Show projects" → `list_projects`
- "Write to project log" → `write_project_file`
- "Show project documentation" → `list_project_docs`, `read_project_doc`

**Internally:** instead of files on Yandex.Disk — records in SQLite. File templates (README, tasks.md, log.md, notes.md) are no longer created — data is stored in tables.

---

## 5. What Happens with the Mini App API

Endpoints are unchanged. `lib/api.js` still calls `lib/tasks.js` — only now tasks.js uses SQLite instead of JSON internally.

```
GET  /api/tasks              — no change
POST /api/tasks/:id/complete — no change
PATCH /api/tasks/:id         — no change
DELETE /api/tasks/:id        — no change
GET  /api/calendar/day       — no change
GET  /api/calendar/week      — no change
```

**New endpoint (optional):**
```
GET /api/tasks/:id/subtasks  — subtasks of a task
```

---

## 6. When: Schedule

DB backup — daily at 03:30 (after the indexer at 03:00). Cron in `schedules/heartbeats.json`:

```json
{
  "name": "database_backup",
  "cron": "30 3 * * *",
  "description": "Backup SQLite DB to Yandex.Disk"
}
```

---

## 7. Business Rules

1. **Task IDs.** Current tasks have `id = Date.now()` (13-digit numbers). After migration, new tasks get `AUTOINCREMENT` (1, 2, 3...). **Migrated tasks keep their original IDs** — AUTOINCREMENT starts at max(id) + 1. This prevents breaking active references in Claude's memory and chat history.

2. **Project tasks.** Currently project tasks are stored separately (`projects/{name}/tasks.json`), distinguished from global tasks by the `project` field. After migration — a single `tasks` table with `project_id`. Project tasks are filtered by FK.

3. **GitHub Issues.** Unchanged — still fetched live via `lib/github.js`. Merged with local tasks in `list_tasks`. Not stored in SQLite.

4. **Eisenhower sort.** The Q1 → Q3 → Q2 → Q4 order is preserved. Implemented in SQL: `ORDER BY (urgent AND important) DESC, urgent DESC, important DESC`.

5. **Disk log.** When writing to SQLite, `disk-log.js` is NOT called — this is not a Yandex.Disk operation. But the backup to Disk is logged.

6. **Tool backward compatibility.** All existing tool schemas in `lib/tools.js` remain unchanged. New optional parameters are added:
   - `add_task` → add `parent_id` (optional)
   - `list_tasks` → add `include_subtasks` (optional, default true)
   - New tool: `add_task_dependency(task_id, depends_on_id)`
   - New tool: `get_task_with_subtasks(task_id)`

---

## 8. Constraints

- **better-sqlite3** — synchronous driver, no promises. All calls are blocking, but for a single-user bot this is fine and even preferable (no race conditions).
- **WAL mode** — enable on initialization (`PRAGMA journal_mode=WAL`) for better read performance during concurrent backup.
- **Foreign keys** — enable on initialization (`PRAGMA foreign_keys=ON`).
- **Data migration** — one-time script `scripts/migrate-to-sqlite.js`. Reads all JSON files + project MD files, writes to SQLite. After a successful migration, old files are NOT deleted (kept for rollback).
- **`.gitignore`** — add `data/` to `.gitignore`.

---

## 9. Optional: Memory Migration

Files `memory/*.md` (health.md, kids.md, finance.md, bureaucracy.md, decisions.md) — currently simple markdown files that Snezhanna reads/writes via `lib/memory.js`.

**Can be migrated later** into a table:

```sql
CREATE TABLE memory (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    category    TEXT NOT NULL,      -- health, kids, finance, bureaucracy, decisions
    content     TEXT NOT NULL,
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
```

This does not block the main migration — memory files continue to work on Yandex.Disk.

---

## 10. Implementation Order

1. **lib/db.js** — initialize better-sqlite3, create tables (IF NOT EXISTS), PRAGMA, export instance.
2. **scripts/migrate-to-sqlite.js** — one-time data migration script from JSON/MD to SQLite. Run manually.
3. **lib/tasks.js** — rewrite: remove file-based `_readTasks`/`_writeTasks`, replace with SQL queries via `lib/db.js`. Public API (`addTask`, `listTasks`, `updateTask`, `completeTask`, `deleteTask`, `getTodayTasks`) stays the same.
4. **lib/yadisk-dirs.js** — remove project CRUD (create_project, list_projects, read/write_project_file, read/write_project_doc). Replace with SQL wrappers. `ensureDirs()` — remove `projects/` and `tasks/` from REQUIRED_DIRS (keep the rest).
5. **lib/tools.js** — update case branches for project tools to new functions. Add new tools (parent_id, dependencies).
6. **Cron backup** — add to index.js cron for daily SQLite → Yandex.Disk backup.
7. **config/nanobot.json** — add `"database": { "path": "data/snezhanna.db" }`.
8. **Documentation** — update CLAUDE.md, snezhanna-tz.md, tz-task-tracking.md, skills/yadisk.md.

---

## 11. Claude Code Prompt

```
Read /opt/snezhanna/docs/tz-sqlite-migration.md — this is the spec for migrating data storage from JSON files to SQLite.

Rules:
- Explore the codebase before starting: lib/tasks.js, lib/yadisk-dirs.js, lib/tools.js, lib/api.js, config/nanobot.json
- The public task API (addTask, listTasks, updateTask, completeTask, deleteTask, getTodayTasks) must not break calling code in index.js, lib/api.js, lib/workload.js
- Tool schemas in lib/tools.js — do not break existing ones, you can add new optional parameters
- Mini App API endpoints — do not change
- better-sqlite3, synchronous — do not wrap in promises
- WAL mode + foreign_keys ON
- Migration script scripts/migrate-to-sqlite.js — reads current JSON + MD, writes to SQLite
- After implementation — update documentation: CLAUDE.md, docs/snezhanna-tz.md, docs/tz-task-tracking.md
- Add data/ to .gitignore
- Add backup cron to index.js (03:30)
```
