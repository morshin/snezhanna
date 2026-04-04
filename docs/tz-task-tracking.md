# Task Tracking — Technical Spec

## Goal

Snezhanna manages tasks and projects using a local SQLite database. Tasks are created from free-form text, prioritised with the Eisenhower Matrix, and combined with live GitHub Issues in briefings, tool responses, and the Mini App.

---

## Eisenhower Matrix

Two independent boolean fields:

|                | Important           | Not important              |
|----------------|---------------------|----------------------------|
| **Urgent**     | Q1 — do now         | Q3 — delegate / quick fix  |
| **Not urgent** | Q2 — schedule       | Q4 — defer                 |

Display order: **Q1 → Q3 → Q2 → Q4**

---

## Storage

| Data | Location |
|------|----------|
| Tasks, projects, docs, logs | `data/snezhanna.db` (SQLite, WAL mode) |
| GitHub Issues | Live fetch via `lib/github.js` — not stored locally |
| Daily backup | `/mnt/yadisk-agent/backups/snezhanna_YYYYMMDD.db` (keep 7) |

DB path is configured in `config/nanobot.json → database.path`.

---

## Database Schema

### tasks

```sql
CREATE TABLE tasks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    title       TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'in_progress', 'done', 'cancelled')),
    urgent      INTEGER NOT NULL DEFAULT 0,
    important   INTEGER NOT NULL DEFAULT 0,
    project_id  INTEGER REFERENCES projects(id) ON DELETE SET NULL,
    parent_id   INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
    due_date    TEXT,
    tags        TEXT DEFAULT '[]',    -- JSON array
    notes       TEXT,
    source      TEXT DEFAULT 'manual', -- manual, voice, email, chat, github
    source_ref  TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT
);
```

### projects

```sql
CREATE TABLE projects (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL UNIQUE,
    display_name TEXT,
    client      TEXT,
    type        TEXT,
    platform    TEXT,
    status      TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('active', 'paused', 'completed', 'archived')),
    contacts    TEXT DEFAULT '{}',
    description TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
```

Additional tables: `task_deps`, `project_log`, `project_notes`, `project_docs`.
See `lib/db.js` for the full schema.

---

## Public API — `lib/tasks.js`

All functions are synchronous (better-sqlite3).

| Function | Returns |
|----------|---------|
| `addTask({title, urgent, important, project, due_date, tags, notes, parent_id, source})` | `{created, task}` |
| `listTasks({project, status, urgent, important, tag, include_subtasks})` | `{tasks, total}` |
| `updateTask({id, title, status, urgent, important, due_date, tags, notes})` | `{updated, task}` |
| `completeTask({id})` | `{completed, task}` |
| `deleteTask({id})` | `{deleted, task}` |
| `getTodayTasks(daysAhead=2)` | `task[]` sorted by Eisenhower |
| `addTaskDependency(taskId, dependsOnId)` | `{added, task_id, depends_on}` |
| `getTaskWithSubtasks(taskId)` | `{task}` with `.subtasks[]` and `.depends_on[]` |
| `eisenhowerSort(tasks)` | sorted `task[]` |

Task objects always include `project` as a string name (not `project_id`).

---

## Project API — `lib/yadisk-dirs.js`

Projects are stored in SQLite (not on Yandex.Disk). The same function signatures are preserved.

| Function | Storage |
|----------|---------|
| `createProject(name)` | INSERT into projects |
| `listProjects()` | SELECT projects + open task count |
| `readProjectFile(name, file)` | README.md → projects row; log.md → project_log; notes.md → project_notes; tasks.md → task query |
| `writeProjectFile(name, file, content, mode)` | README.md → update description; log.md / notes.md → INSERT entry |
| `listProjectDocs(name)` | SELECT project_docs |
| `readProjectDoc(name, filename)` | SELECT from project_docs |
| `writeProjectDoc(name, filename, content, mode)` | UPSERT / append project_docs |

---

## Claude Tools

### Existing (unchanged schemas, backward compatible)

- `add_task` — added optional `parent_id`, `source`
- `list_tasks` — added optional `include_subtasks` (default true)
- `update_task`, `complete_task`, `delete_task` — unchanged
- `create_project`, `list_projects`, `read_project_file`, `write_project_file`, `list_project_docs`, `read_project_doc`, `write_project_doc` — unchanged schemas, SQLite backend

### New tools

- `add_task_dependency(task_id, depends_on_id)` — mark task_id as blocked by depends_on_id
- `get_task_with_subtasks(task_id)` — return task + nested subtasks + dependency list

---

## Backup

Daily cron at 03:30 (Madrid time) in `index.js`:
- Uses `db.backup(path)` from better-sqlite3 (online, WAL-safe)
- Saves to `/mnt/yadisk-agent/backups/snezhanna_YYYYMMDD.db`
- Keeps 7 most recent backups, deletes older ones
- Logs backup to `disk-log.js` for evening check-in summary

---

## Migration

One-time script to import existing JSON data into SQLite:

```bash
node scripts/migrate-to-sqlite.js [--dry-run]
```

- Reads `tasks/tasks.json` (global tasks) and `projects/*/tasks.json` (project tasks)
- Reads `projects/*/README.md`, `log.md`, `notes.md`, `docs/*`
- Preserves original task IDs (Date.now()-style) — AUTOINCREMENT starts after max(id)+1
- Old JSON files are NOT deleted after migration (kept for rollback)

---

## Implementation Files

| File | Role |
|------|------|
| `lib/db.js` | better-sqlite3 init, schema creation (WAL + foreign_keys) |
| `lib/tasks.js` | Task CRUD — SQLite backend |
| `lib/yadisk-dirs.js` | Project CRUD — SQLite backend; `saveFile()` unchanged |
| `lib/tools.js` | Tool schemas + executor cases |
| `scripts/migrate-to-sqlite.js` | One-time migration from JSON/MD to SQLite |
| `data/snezhanna.db` | SQLite database (gitignored) |
| `config/nanobot.json` | `database.path` config key |
