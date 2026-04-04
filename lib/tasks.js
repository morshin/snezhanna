'use strict';

const fs = require('fs');
const path = require('path');
const db = require('./db');

const config = JSON.parse(fs.readFileSync(path.join(__dirname, '../config/nanobot.json'), 'utf8'));

// ── Prepared statements ───────────────────────────────────────────────────────

const stmts = {
  getProjectByName: db.prepare('SELECT * FROM projects WHERE name = ?'),
  insertProject:    db.prepare(
    'INSERT OR IGNORE INTO projects (name, display_name, status) VALUES (?, ?, ?)'
  ),
  insertTask: db.prepare(`
    INSERT INTO tasks (title, status, urgent, important, project_id, parent_id, due_date, tags, notes, source, source_ref, created_at, updated_at)
    VALUES (@title, @status, @urgent, @important, @project_id, @parent_id, @due_date, @tags, @notes, @source, @source_ref, @created_at, @updated_at)
  `),
  getTaskById: db.prepare('SELECT t.*, p.name AS project_name FROM tasks t LEFT JOIN projects p ON t.project_id = p.id WHERE t.id = ?'),
  updateTask: db.prepare(`
    UPDATE tasks SET title=@title, status=@status, urgent=@urgent, important=@important,
      due_date=@due_date, tags=@tags, notes=@notes, updated_at=@updated_at
    WHERE id=@id
  `),
  completeTask: db.prepare('UPDATE tasks SET status=?, updated_at=?, completed_at=? WHERE id=?'),
  deleteTask:   db.prepare('DELETE FROM tasks WHERE id=?'),
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function _now() {
  return new Date().toISOString();
}

function _rowToTask(row) {
  return {
    id:           row.id,
    title:        row.title,
    status:       row.status,
    urgent:       !!row.urgent,
    important:    !!row.important,
    project:      row.project_name || null,
    parent_id:    row.parent_id    || null,
    tags:         JSON.parse(row.tags || '[]'),
    due_date:     row.due_date     || null,
    created_at:   row.created_at,
    updated_at:   row.updated_at,
    completed_at: row.completed_at || null,
    notes:        row.notes        || null,
    source:       row.source       || 'manual',
    source_ref:   row.source_ref   || null,
  };
}

/** Resolve project name → id, auto-creating the project record if absent. */
function _resolveProjectId(name) {
  if (!name) return null;
  stmts.insertProject.run(name, name, 'active');
  const row = stmts.getProjectByName.get(name);
  return row ? row.id : null;
}

// Eisenhower sort: Q1 (urgent+important) → Q3 (urgent) → Q2 (important) → Q4
function _eisenhowerSort(tasks) {
  function quadrant(t) {
    if (t.urgent && t.important) return 1;
    if (t.urgent && !t.important) return 2;
    if (!t.urgent && t.important) return 3;
    return 4;
  }
  return [...tasks].sort((a, b) => quadrant(a) - quadrant(b));
}

// ── Public API ────────────────────────────────────────────────────────────────

function addTask({ title, urgent = false, important = false, project, due_date, tags = [], notes, parent_id, source, source_ref } = {}) {
  if (!title) return { error: 'Не указан заголовок задачи' };

  const project_id = _resolveProjectId(project || null);
  const now = _now();
  const info = stmts.insertTask.run({
    title,
    status:     'pending',
    urgent:     urgent  ? 1 : 0,
    important:  important ? 1 : 0,
    project_id: project_id,
    parent_id:  parent_id || null,
    due_date:   due_date || null,
    tags:       JSON.stringify(Array.isArray(tags) ? tags : []),
    notes:      notes || null,
    source:     source || 'manual',
    source_ref: source_ref || null,
    created_at: now,
    updated_at: now,
  });

  const task = _rowToTask(stmts.getTaskById.get(info.lastInsertRowid));
  console.log(`[tasks] Added: "${task.title}" (id=${task.id}, project=${project || 'global'})`);
  return { created: true, task };
}

function listTasks({ project, status, urgent, important, tag, include_subtasks = true } = {}) {
  let sql = `
    SELECT t.*, p.name AS project_name
    FROM tasks t
    LEFT JOIN projects p ON t.project_id = p.id
    WHERE 1=1
  `;
  const params = [];

  if (project !== undefined && project !== null) {
    const proj = stmts.getProjectByName.get(project);
    if (!proj) return { tasks: [], total: 0 };
    sql += ' AND t.project_id = ?';
    params.push(proj.id);
  }
  if (status !== undefined)    { sql += ' AND t.status = ?';    params.push(status); }
  if (urgent !== undefined)    { sql += ' AND t.urgent = ?';    params.push(urgent ? 1 : 0); }
  if (important !== undefined) { sql += ' AND t.important = ?'; params.push(important ? 1 : 0); }
  if (!include_subtasks)       { sql += ' AND t.parent_id IS NULL'; }

  sql += ' ORDER BY (t.urgent * t.important) DESC, t.urgent DESC, t.important DESC';

  let rows = db.prepare(sql).all(...params);

  if (tag) {
    rows = rows.filter(r => {
      try { return JSON.parse(r.tags || '[]').includes(tag); } catch { return false; }
    });
  }

  const tasks = rows.map(_rowToTask);
  return { tasks, total: tasks.length };
}

function updateTask(raw) {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: 'Некорректные данные задачи' };
  }
  const id = raw.id;
  if (!id) return { error: 'Не указан ID задачи' };

  const row = stmts.getTaskById.get(Number(id));
  if (!row) return { error: `Задача #${id} не найдена` };

  const allowed = ['title', 'status', 'urgent', 'important', 'due_date', 'tags', 'notes'];
  const updated = { ...row };
  for (const key of allowed) {
    if (raw[key] !== undefined) updated[key] = raw[key];
  }

  stmts.updateTask.run({
    id:         Number(id),
    title:      updated.title,
    status:     updated.status,
    urgent:     updated.urgent  ? 1 : 0,
    important:  updated.important ? 1 : 0,
    due_date:   updated.due_date || null,
    tags:       Array.isArray(updated.tags) ? JSON.stringify(updated.tags) : (updated.tags || '[]'),
    notes:      updated.notes || null,
    updated_at: _now(),
  });

  const task = _rowToTask(stmts.getTaskById.get(Number(id)));
  return { updated: true, task };
}

function completeTask(raw) {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: 'Некорректные данные задачи' };
  }
  const id = raw.id;
  if (!id) return { error: 'Не указан ID задачи' };

  const row = stmts.getTaskById.get(Number(id));
  if (!row) return { error: `Задача #${id} не найдена` };

  const now = _now();
  stmts.completeTask.run('done', now, now, Number(id));

  const task = _rowToTask(stmts.getTaskById.get(Number(id)));
  console.log(`[tasks] Completed: #${id} "${task.title}"`);
  return { completed: true, task };
}

function deleteTask(raw) {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: 'Некорректные данные задачи' };
  }
  const id = raw.id;
  if (!id) return { error: 'Не указан ID задачи' };

  const row = stmts.getTaskById.get(Number(id));
  if (!row) return { error: `Задача #${id} не найдена` };

  stmts.deleteTask.run(Number(id));

  const task = _rowToTask(row);
  console.log(`[tasks] Deleted: #${id} "${task.title}"`);
  return { deleted: true, task };
}

function getTodayTasks(daysAhead = 2) {
  const tz = config.timezone;
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: tz });
  const cutoffDate = new Date(today);
  cutoffDate.setDate(cutoffDate.getDate() + daysAhead);
  const cutoff = cutoffDate.toISOString().slice(0, 10);

  const rows = db.prepare(`
    SELECT t.*, p.name AS project_name
    FROM tasks t
    LEFT JOIN projects p ON t.project_id = p.id
    WHERE t.status NOT IN ('done', 'cancelled')
      AND (t.due_date IS NULL OR t.due_date <= ?)
    ORDER BY (t.urgent * t.important) DESC, t.urgent DESC, t.important DESC
  `).all(cutoff);

  return rows.map(_rowToTask);
}

function addTaskDependency(taskId, dependsOnId) {
  const task = stmts.getTaskById.get(Number(taskId));
  if (!task) return { error: `Задача #${taskId} не найдена` };
  const dep = stmts.getTaskById.get(Number(dependsOnId));
  if (!dep) return { error: `Задача #${dependsOnId} не найдена` };
  if (Number(taskId) === Number(dependsOnId)) return { error: 'Задача не может зависеть от самой себя' };

  try {
    db.prepare('INSERT OR IGNORE INTO task_deps (task_id, depends_on) VALUES (?, ?)').run(Number(taskId), Number(dependsOnId));
  } catch (e) {
    return { error: e.message };
  }

  console.log(`[tasks] Dependency: #${taskId} depends on #${dependsOnId}`);
  return { added: true, task_id: Number(taskId), depends_on: Number(dependsOnId) };
}

function getTaskWithSubtasks(taskId) {
  const row = stmts.getTaskById.get(Number(taskId));
  if (!row) return { error: `Задача #${taskId} не найдена` };

  const task = _rowToTask(row);

  const subtaskRows = db.prepare(`
    SELECT t.*, p.name AS project_name FROM tasks t
    LEFT JOIN projects p ON t.project_id = p.id
    WHERE t.parent_id = ?
    ORDER BY (t.urgent * t.important) DESC, t.urgent DESC, t.important DESC
  `).all(Number(taskId));

  task.subtasks = subtaskRows.map(_rowToTask);

  const depRows = db.prepare(`
    SELECT t.*, p.name AS project_name FROM tasks t
    LEFT JOIN projects p ON t.project_id = p.id
    INNER JOIN task_deps d ON t.id = d.depends_on
    WHERE d.task_id = ?
  `).all(Number(taskId));

  task.depends_on = depRows.map(_rowToTask);

  return { task };
}

module.exports = {
  addTask,
  listTasks,
  updateTask,
  completeTask,
  deleteTask,
  getTodayTasks,
  addTaskDependency,
  getTaskWithSubtasks,
  eisenhowerSort: _eisenhowerSort,
};
