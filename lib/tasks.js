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

function updateTask({ id, project, ...updates }) {
  if (!id) return { error: 'Не указан ID задачи' };

  const tasks = _readTasks(project);
  const idx = tasks.findIndex(t => t.id === id);
  if (idx === -1) return { error: `Задача #${id} не найдена` };

  const allowed = ['title', 'status', 'urgent', 'important', 'due_date', 'tags', 'notes'];
  for (const key of allowed) {
    if (updates[key] !== undefined) {
      tasks[idx][key] = updates[key];
    }
  }
  tasks[idx].updated_at = _now();
  _writeTasks(tasks, project);

  diskLog.log('Обновлена задача', `#${id}: ${tasks[idx].title}`);
  return { updated: true, task: tasks[idx] };
}

function completeTask({ id, project }) {
  if (!id) return { error: 'Не указан ID задачи' };

  const tasks = _readTasks(project);
  const idx = tasks.findIndex(t => t.id === id);
  if (idx === -1) return { error: `Задача #${id} не найдена` };

  tasks[idx].status = 'done';
  tasks[idx].updated_at = _now();
  _writeTasks(tasks, project);

  diskLog.log('Завершена задача', `#${id}: ${tasks[idx].title}`);
  console.log(`[tasks] Completed: #${id} "${tasks[idx].title}"`);
  return { completed: true, task: tasks[idx] };
}

function deleteTask({ id, project }) {
  if (!id) return { error: 'Не указан ID задачи' };

  const tasks = _readTasks(project);
  const idx = tasks.findIndex(t => t.id === id);
  if (idx === -1) return { error: `Задача #${id} не найдена` };

  const removed = tasks.splice(idx, 1)[0];
  _writeTasks(tasks, project);

  diskLog.log('Удалена задача', `#${id}: ${removed.title}`);
  console.log(`[tasks] Deleted: #${id} "${removed.title}"`);
  return { deleted: true, task: removed };
}

function getTodayTasks() {
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: config.timezone }); // YYYY-MM-DD

  // Aggregate global + all project tasks
  const allTasks = _readAllTasks();

  const active = allTasks.filter(t => {
    if (t.status === 'done') return false;
    // Include if: no due_date (always relevant), or due_date is today or overdue
    if (!t.due_date) return true;
    return t.due_date <= today;
  });

  return _eisenhowerSort(active);
}

module.exports = { addTask, listTasks, updateTask, completeTask, deleteTask, getTodayTasks };
