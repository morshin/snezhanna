'use strict';

const fs = require('fs');
const path = require('path');
const diskLog = require('./disk-log');

const config = JSON.parse(fs.readFileSync(path.join(__dirname, '../config/nanobot.json'), 'utf8'));
const AGENT_MOUNT = config.yadisk.agent_mount;

// ── Helpers ──────────────────────────────────────────────────────────────────

function _getFilePath(project) {
  if (project) {
    return path.join(AGENT_MOUNT, 'projects', project, 'tasks.json');
  }
  return path.join(AGENT_MOUNT, 'tasks', 'tasks.json');
}

function _readTasks(project) {
  const filePath = _getFilePath(project);
  if (!fs.existsSync(filePath)) return [];
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    console.error('[tasks] Failed to read:', filePath, e.message);
    return [];
  }
}

function _writeTasks(tasks, project) {
  const filePath = _getFilePath(project);
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, JSON.stringify(tasks, null, 2), 'utf8');
}

function _nextId(tasks) {
  if (tasks.length === 0) return 1;
  return Math.max(...tasks.map(t => t.id)) + 1;
}

function _now() {
  return new Date().toISOString();
}

// Eisenhower sort: Q1 (urgent+important) → Q3 (urgent+!important) → Q2 (!urgent+important) → Q4
function _eisenhowerSort(tasks) {
  function quadrant(t) {
    if (t.urgent && t.important) return 1;
    if (t.urgent && !t.important) return 2;
    if (!t.urgent && t.important) return 3;
    return 4;
  }
  return [...tasks].sort((a, b) => quadrant(a) - quadrant(b));
}

function _getAllProjectNames() {
  const projectsDir = path.join(AGENT_MOUNT, 'projects');
  if (!fs.existsSync(projectsDir)) return [];
  try {
    return fs.readdirSync(projectsDir, { withFileTypes: true })
      .filter(e => e.isDirectory() && !e.name.startsWith('.'))
      .map(e => e.name);
  } catch (e) {
    console.error('[tasks] Failed to list projects:', e.message);
    return [];
  }
}

function _readAllTasks() {
  let all = _readTasks(null);
  for (const projName of _getAllProjectNames()) {
    all = all.concat(_readTasks(projName));
  }
  return all;
}

/** Где лежит задача: глобальный tasks.json или projects/<name>/tasks.json */
function _resolveTaskStore(id) {
  const idNum = Number(id);
  let tasks = _readTasks(null);
  let idx = tasks.findIndex(t => Number(t.id) === idNum);
  if (idx !== -1) return { project: null, tasks, idx };

  for (const projName of _getAllProjectNames()) {
    tasks = _readTasks(projName);
    idx = tasks.findIndex(t => Number(t.id) === idNum);
    if (idx !== -1) return { project: projName, tasks, idx };
  }
  return null;
}

// ── Public API ───────────────────────────────────────────────────────────────

function addTask({ title, urgent = false, important = false, project, due_date, tags = [], notes }) {
  if (!title) return { error: 'Не указан заголовок задачи' };

  const tasks = _readTasks(project);
  const task = {
    id: _nextId(tasks),
    title,
    status: 'pending',
    urgent: !!urgent,
    important: !!important,
    project: project || null,
    tags: Array.isArray(tags) ? tags : [],
    due_date: due_date || null,
    created_at: _now(),
    updated_at: _now(),
    notes: notes || null
  };

  tasks.push(task);
  _writeTasks(tasks, project);

  const location = project ? `projects/${project}/tasks.json` : 'tasks/tasks.json';
  diskLog.log('Добавлена задача', `${task.title} → ${location}`);
  console.log(`[tasks] Added: "${task.title}" (id=${task.id}, project=${project || 'global'})`);

  return { created: true, task };
}

function listTasks({ project, status, urgent, important, tag } = {}) {
  // If no project filter — aggregate global tasks + all project tasks
  const allTasks = project ? _readTasks(project) : _readAllTasks();

  let filtered = allTasks;
  if (status !== undefined) filtered = filtered.filter(t => t.status === status);
  if (urgent !== undefined) filtered = filtered.filter(t => t.urgent === urgent);
  if (important !== undefined) filtered = filtered.filter(t => t.important === important);
  if (tag) filtered = filtered.filter(t => t.tags && t.tags.includes(tag));

  const sorted = _eisenhowerSort(filtered);
  return { tasks: sorted, total: sorted.length };
}

function updateTask(raw) {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: 'Некорректные данные задачи' };
  }
  const id = raw.id;
  if (!id) return { error: 'Не указан ID задачи' };

  const hasProjectKey = Object.prototype.hasOwnProperty.call(raw, 'project');
  const project = raw.project;
  const updates = { ...raw };
  delete updates.id;
  delete updates.project;

  let tasks;
  let idx;
  let projKey;

  if (hasProjectKey) {
    projKey = project == null || project === '' ? null : project;
    tasks = _readTasks(projKey);
    idx = tasks.findIndex(t => Number(t.id) === Number(id));
    if (idx === -1) return { error: `Задача #${id} не найдена` };
  } else {
    const found = _resolveTaskStore(id);
    if (!found) return { error: `Задача #${id} не найдена` };
    tasks = found.tasks;
    idx = found.idx;
    projKey = found.project;
  }

  const allowed = ['title', 'status', 'urgent', 'important', 'due_date', 'tags', 'notes'];
  for (const key of allowed) {
    if (updates[key] !== undefined) {
      tasks[idx][key] = updates[key];
    }
  }
  tasks[idx].updated_at = _now();
  _writeTasks(tasks, projKey);

  diskLog.log('Обновлена задача', `#${id}: ${tasks[idx].title}`);
  return { updated: true, task: tasks[idx] };
}

function completeTask(raw) {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: 'Некорректные данные задачи' };
  }
  const id = raw.id;
  if (!id) return { error: 'Не указан ID задачи' };

  const hasProjectKey = Object.prototype.hasOwnProperty.call(raw, 'project');
  const project = raw.project;

  let tasks;
  let idx;
  let projKey;

  if (hasProjectKey) {
    projKey = project == null || project === '' ? null : project;
    tasks = _readTasks(projKey);
    idx = tasks.findIndex(t => Number(t.id) === Number(id));
    if (idx === -1) return { error: `Задача #${id} не найдена` };
  } else {
    const found = _resolveTaskStore(id);
    if (!found) return { error: `Задача #${id} не найдена` };
    tasks = found.tasks;
    idx = found.idx;
    projKey = found.project;
  }

  tasks[idx].status = 'done';
  tasks[idx].updated_at = _now();
  _writeTasks(tasks, projKey);

  diskLog.log('Завершена задача', `#${id}: ${tasks[idx].title}`);
  console.log(`[tasks] Completed: #${id} "${tasks[idx].title}"`);
  return { completed: true, task: tasks[idx] };
}

function deleteTask(raw) {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: 'Некорректные данные задачи' };
  }
  const id = raw.id;
  if (!id) return { error: 'Не указан ID задачи' };

  const hasProjectKey = Object.prototype.hasOwnProperty.call(raw, 'project');
  const project = raw.project;

  let tasks;
  let idx;
  let projKey;

  if (hasProjectKey) {
    projKey = project == null || project === '' ? null : project;
    tasks = _readTasks(projKey);
    idx = tasks.findIndex(t => Number(t.id) === Number(id));
    if (idx === -1) return { error: `Задача #${id} не найдена` };
  } else {
    const found = _resolveTaskStore(id);
    if (!found) return { error: `Задача #${id} не найдена` };
    tasks = found.tasks;
    idx = found.idx;
    projKey = found.project;
  }

  const removed = tasks.splice(idx, 1)[0];
  _writeTasks(tasks, projKey);

  diskLog.log('Удалена задача', `#${id}: ${removed.title}`);
  console.log(`[tasks] Deleted: #${id} "${removed.title}"`);
  return { deleted: true, task: removed };
}

function getTodayTasks(daysAhead = 2) {
  const tz = config.timezone;
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: tz }); // YYYY-MM-DD
  const cutoffDate = new Date(today);
  cutoffDate.setDate(cutoffDate.getDate() + daysAhead);
  const cutoff = cutoffDate.toISOString().slice(0, 10);

  const allTasks = _readAllTasks();

  const active = allTasks.filter(t => {
    if (t.status === 'done' || t.status === 'cancelled') return false;
    // Tasks without due_date are always included (backlog/ongoing)
    if (!t.due_date) return true;
    // Include overdue + today + upcoming within daysAhead
    return t.due_date <= cutoff;
  });

  return _eisenhowerSort(active);
}

module.exports = {
  addTask,
  listTasks,
  updateTask,
  completeTask,
  deleteTask,
  getTodayTasks,
  eisenhowerSort: _eisenhowerSort
};
