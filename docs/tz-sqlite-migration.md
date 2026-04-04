# TZ: Миграция Снежанны Personal на SQLite

> Спецификация для Claude Code. Формат: поведенческий, без имён функций и скелетов кода.

---

## Цель

Перевести хранение задач и проектов Снежанны Personal с JSON-файлов на Яндекс.Диске на локальную SQLite базу. Убрать разрозненные `tasks.json`, проектные markdown-файлы и `memory/*.md` — заменить единой БД с быстрым поиском, связями между сущностями и надёжной целостностью.

**Что НЕ входит:** memory/health.md и другие memory-файлы на первом этапе оставить как есть — их миграция опциональна (см. раздел 9).

---

## 1. Что мигрирует

| Сейчас (JSON/MD на Яндекс.Диске) | Станет (SQLite) |
|-----------------------------------|-----------------|
| `/mnt/yadisk-agent/tasks/tasks.json` | таблица `tasks` |
| `/mnt/yadisk-agent/projects/{name}/tasks.json` | таблица `tasks` с `project_id` |
| `/mnt/yadisk-agent/projects/{name}/README.md` | таблица `projects` |
| `/mnt/yadisk-agent/projects/{name}/log.md` | таблица `project_log` |
| `/mnt/yadisk-agent/projects/{name}/notes.md` | таблица `project_notes` |
| `/mnt/yadisk-agent/projects/{name}/docs/*` | таблица `project_docs` |
| GitHub Issues (live fetch) | Без изменений — по-прежнему live fetch, объединение в list_tasks |

---

## 2. Где лежит БД

```
/opt/snezhanna/data/snezhanna.db
```

Директория `data/` создаётся при старте бота если не существует. Путь настраивается через `config/nanobot.json → database.path`.

**Backup:** ежедневный автоматический backup в `/mnt/yadisk-agent/backups/snezhanna_YYYYMMDD.db` через cron (03:30, после индексера). Хранить 7 последних.

---

## 3. Схема базы данных

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

### task_deps (зависимости между задачами)

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
    name        TEXT NOT NULL UNIQUE,           -- имя папки (slug)
    display_name TEXT,                          -- человекочитаемое название
    client      TEXT,                           -- клиент/компания
    type        TEXT,                           -- Внедрение, Миграция, Аудит...
    platform    TEXT,                           -- 1С:ERP, 1С:УТ...
    status      TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('active', 'paused', 'completed', 'archived')),
    contacts    TEXT DEFAULT '{}',              -- JSON
    description TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### project_log (журнал работ)

```sql
CREATE TABLE project_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    content     TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_project_log ON project_log(project_id, created_at DESC);
```

### project_notes (заметки)

```sql
CREATE TABLE project_notes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    content     TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### project_docs (документация проектов)

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

## 4. Пользовательское поведение — что меняется

### Задачи

**Ничего не меняется для пользователя.** Все команды и tools работают как раньше:
- «Добавь задачу: позвонить Алексею» → `add_task`
- «Покажи задачи» → `list_tasks`
- «Завершить задачу 5» → `complete_task`
- Утренний брифинг → задачи из SQLite вместо JSON
- Вечерний чеклист → то же самое
- Mini App → те же API-эндпоинты, те же данные

**Новое поведение:**
- `parent_id` — подзадачи. «Разбей задачу 5 на подзадачи» → Claude создаёт задачи с `parent_id = 5`. В list_tasks подзадачи отображаются вложенными.
- `task_deps` — зависимости. «Задача 7 блокирует задачу 8» → запись в task_deps. В брифинге заблокированные задачи помечаются.
- `source` + `source_ref` — откуда пришла задача. Захват голосом → `source: 'voice'`. Из чата → `source: 'chat'`. Из почты → `source: 'email'`.

### Проекты

**Ничего не меняется для пользователя:**
- «Создай проект Миграция-ERP» → `create_project`
- «Покажи проекты» → `list_projects`
- «Запиши в журнал проекта» → `write_project_file`
- «Покажи документацию проекта» → `list_project_docs`, `read_project_doc`

**Внутри:** вместо файлов на Яндекс.Диске — записи в SQLite. Шаблоны файлов (README, tasks.md, log.md, notes.md) больше не создаются — данные хранятся в таблицах.

---

## 5. Что происходит с Mini App API

Эндпоинты не меняются. `lib/api.js` по-прежнему вызывает `lib/tasks.js` — просто внутри tasks.js теперь SQLite вместо JSON.

```
GET  /api/tasks              — без изменений
POST /api/tasks/:id/complete — без изменений
PATCH /api/tasks/:id         — без изменений
DELETE /api/tasks/:id        — без изменений
GET  /api/calendar/day       — без изменений
GET  /api/calendar/week      — без изменений
```

**Новый эндпоинт (опционально):**
```
GET /api/tasks/:id/subtasks  — подзадачи задачи
```

---

## 6. Где и когда: расписание

Бэкап БД — ежедневно в 03:30 (после индексера в 03:00). Cron в `schedules/heartbeats.json`:

```json
{
  "name": "database_backup",
  "cron": "30 3 * * *",
  "description": "Backup SQLite DB to Yandex.Disk"
}
```

---

## 7. Бизнес-правила

1. **ID задач.** Текущие задачи имеют `id = Date.now()` (13-значные числа). После миграции новые задачи получают `AUTOINCREMENT` (1, 2, 3...). **Мигрированные задачи сохраняют свои старые ID** — AUTOINCREMENT начинается с max(id) + 1. Это нужно чтобы не сломать активные ссылки в памяти Claude и в истории чата.

2. **Проектные задачи.** Сейчас проектные задачи хранятся отдельно (`projects/{name}/tasks.json`), различаясь от глобальных по полю `project`. После миграции — единая таблица `tasks` с `project_id`. Проектные задачи фильтруются по FK.

3. **GitHub Issues.** Без изменений — по-прежнему fetched live через `lib/github.js`. В `list_tasks` объединяются с локальными задачами. Не хранятся в SQLite.

4. **Eisenhower sort.** Порядок Q1 → Q3 → Q2 → Q4 сохраняется. Реализуется в SQL: `ORDER BY (urgent AND important) DESC, urgent DESC, important DESC`.

5. **Disk log.** При записи в SQLite `disk-log.js` НЕ вызывается — это не операция с Яндекс.Диском. Но бэкап на Диск — логируется.

6. **Обратная совместимость tools.** Все существующие tool schemas в `lib/tools.js` остаются без изменений. Добавляются новые опциональные параметры:
   - `add_task` → добавить `parent_id` (опционально)
   - `list_tasks` → добавить `include_subtasks` (опционально, default true)
   - Новый tool: `add_task_dependency(task_id, depends_on_id)`
   - Новый tool: `get_task_with_subtasks(task_id)`

---

## 8. Ограничения

- **better-sqlite3** — синхронный драйвер, без промисов. Все вызовы блокирующие, но для однопользовательского бота это ОК и даже предпочтительнее (нет race conditions).
- **WAL mode** — включить при инициализации (`PRAGMA journal_mode=WAL`) для лучшей производительности чтения при одновременном backup.
- **Foreign keys** — включить при инициализации (`PRAGMA foreign_keys=ON`).
- **Миграция данных** — одноразовый скрипт `scripts/migrate-to-sqlite.js`. Читает все JSON-файлы + проектные MD-файлы, записывает в SQLite. После успешной миграции старые файлы НЕ удаляются (на случай отката).
- **`.gitignore`** — добавить `data/` в `.gitignore`.

---

## 9. Опционально: миграция memory

Файлы `memory/*.md` (health.md, kids.md, finance.md, bureaucracy.md, decisions.md) — сейчас это простые markdown-файлы, которые Снежанна читает/пишет через `lib/memory.js`.

**Можно мигрировать позже** в таблицу:

```sql
CREATE TABLE memory (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    category    TEXT NOT NULL,      -- health, kids, finance, bureaucracy, decisions
    content     TEXT NOT NULL,
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
```

Это не блокирует основную миграцию — memory-файлы продолжают работать на Яндекс.Диске.

---

## 10. Порядок реализации

1. **lib/db.js** — инициализация better-sqlite3, создание таблиц (IF NOT EXISTS), PRAGMA, экспорт инстанса.
2. **scripts/migrate-to-sqlite.js** — одноразовый скрипт миграции данных из JSON/MD в SQLite. Запускать вручную.
3. **lib/tasks.js** — переписать: убрать `_readTasks`/`_writeTasks` (файловые), заменить на SQL-запросы через `lib/db.js`. Публичный API (`addTask`, `listTasks`, `updateTask`, `completeTask`, `deleteTask`, `getTodayTasks`) остаётся прежним.
4. **lib/yadisk-dirs.js** — убрать проектный CRUD (create_project, list_projects, read/write_project_file, read/write_project_doc). Заменить на SQL-обёртки. `ensureDirs()` — убрать `projects/` и `tasks/` из REQUIRED_DIRS (остальные папки оставить).
5. **lib/tools.js** — обновить case-ветки проектных tools на новые функции. Добавить новые tools (parent_id, dependencies).
6. **Cron backup** — добавить в index.js cron для ежедневного бэкапа SQLite → Яндекс.Диск.
7. **config/nanobot.json** — добавить `"database": { "path": "data/snezhanna.db" }`.
8. **Документация** — обновить CLAUDE.md, snezhanna-tz.md, tz-task-tracking.md, skills/yadisk.md.

---

## 11. Claude Code промпт

```
Прочитай /opt/snezhanna/docs/tz-sqlite-migration.md — это ТЗ на миграцию хранения данных с JSON-файлов на SQLite.

Правила:
- Исследуй кодовую базу перед началом: lib/tasks.js, lib/yadisk-dirs.js, lib/tools.js, lib/api.js, config/nanobot.json
- Публичный API задач (addTask, listTasks, updateTask, completeTask, deleteTask, getTodayTasks) не должен ломать вызывающий код в index.js, lib/api.js, lib/workload.js
- Tool schemas в lib/tools.js — не ломать существующие, можно добавлять новые опциональные параметры
- Mini App API эндпоинты — не менять
- better-sqlite3, синхронный — не заворачивать в промисы
- WAL mode + foreign_keys ON
- Миграционный скрипт scripts/migrate-to-sqlite.js — читает текущие JSON + MD, пишет в SQLite
- После реализации — обновить документацию: CLAUDE.md, docs/snezhanna-tz.md, docs/tz-task-tracking.md
- Добавить data/ в .gitignore
- Добавить cron бэкапа в index.js (03:30)
```
