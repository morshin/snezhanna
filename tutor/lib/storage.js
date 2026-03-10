'use strict';

const fs = require('fs');
const path = require('path');

const KIDS_DIR = process.env.KIDS_DATA_DIR || '/mnt/yadisk-agent/kids';
const SESSIONS_DIR = path.join(KIDS_DIR, 'sessions');
const WEEKLY_DIR = path.join(KIDS_DIR, 'weekly');
const SCHEDULE_FILE = path.join(KIDS_DIR, 'schedule.json');
const HOMEWORK_FILE = path.join(KIDS_DIR, 'homework.json');
const PROGRESS_FILE = path.join(KIDS_DIR, 'progress.md');

function ensureDirs() {
  for (const dir of [KIDS_DIR, SESSIONS_DIR, WEEKLY_DIR]) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      console.log('[Storage] Created dir:', dir);
    }
  }
}

// ── Schedule ──────────────────────────────────────────────────────────────────

function loadSchedule() {
  try {
    if (!fs.existsSync(SCHEDULE_FILE)) return null;
    return JSON.parse(fs.readFileSync(SCHEDULE_FILE, 'utf8'));
  } catch (e) {
    console.error('[Storage] Failed to load schedule:', e.message);
    return null;
  }
}

function saveSchedule(data) {
  try {
    // M-7: создаём копию чтобы не мутировать объект вызывающего кода
    const toSave = { ...data, updated: new Date().toISOString().slice(0, 10) };
    fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(toSave, null, 2), 'utf8');
    console.log('[Storage] Schedule saved');
  } catch (e) {
    console.error('[Storage] Failed to save schedule:', e.message);
    throw e;
  }
}

// ── Homework ──────────────────────────────────────────────────────────────────

function loadHomework() {
  try {
    if (!fs.existsSync(HOMEWORK_FILE)) return { tasks: [] };
    return JSON.parse(fs.readFileSync(HOMEWORK_FILE, 'utf8'));
  } catch (e) {
    console.error('[Storage] Failed to load homework:', e.message);
    return { tasks: [] };
  }
}

function saveHomework(data) {
  try {
    fs.writeFileSync(HOMEWORK_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.error('[Storage] Failed to save homework:', e.message);
    throw e;
  }
}

function addHomeworkTask(task) {
  const hw = loadHomework();
  const id = 'hw_' + Date.now();
  hw.tasks.push({
    id,
    subject: task.subject || '',
    description: task.description || '',
    due: task.due || '',
    done: false,
    doneAt: null,
    added: new Date().toISOString().slice(0, 10)
  });
  saveHomework(hw);
  return id;
}

function markHomeworkDone(taskId) {
  const hw = loadHomework();
  const task = hw.tasks.find(t => t.id === taskId);
  if (task) {
    task.done = true;
    task.doneAt = new Date().toISOString().slice(0, 10);
    saveHomework(hw);
    console.log('[Storage] Homework marked done:', taskId, task.subject);
  }
}

// ── Session reports ───────────────────────────────────────────────────────────

function appendSessionReport(dateStr, md) {
  try {
    const filePath = path.join(SESSIONS_DIR, `${dateStr}.md`);
    const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : `# ${dateStr}\n`;
    fs.writeFileSync(filePath, existing + '\n' + md + '\n', 'utf8');
    console.log('[Storage] Session report appended:', filePath);
  } catch (e) {
    console.error('[Storage] Failed to append session report:', e.message);
    throw e;
  }
}

// ── Progress ──────────────────────────────────────────────────────────────────

function readProgress() {
  try {
    if (!fs.existsSync(PROGRESS_FILE)) return '';
    return fs.readFileSync(PROGRESS_FILE, 'utf8');
  } catch (e) {
    return '';
  }
}

function writeProgress(md) {
  try {
    fs.writeFileSync(PROGRESS_FILE, md, 'utf8');
    console.log('[Storage] Progress updated');
  } catch (e) {
    console.error('[Storage] Failed to write progress:', e.message);
    throw e;
  }
}

// ── Weekly digest ─────────────────────────────────────────────────────────────

function writeWeeklyDigest(weekStr, md) {
  try {
    const filePath = path.join(WEEKLY_DIR, `${weekStr}.md`);
    fs.writeFileSync(filePath, md, 'utf8');
    console.log('[Storage] Weekly digest written:', filePath);
  } catch (e) {
    console.error('[Storage] Failed to write weekly digest:', e.message);
    throw e;
  }
}

// ── Read session files for a date ─────────────────────────────────────────────

function readSessionReport(dateStr) {
  const filePath = path.join(SESSIONS_DIR, `${dateStr}.md`);
  try {
    if (!fs.existsSync(filePath)) return '';
    return fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    return '';
  }
}

module.exports = {
  ensureDirs,
  loadSchedule, saveSchedule,
  loadHomework, saveHomework, addHomeworkTask, markHomeworkDone,
  appendSessionReport, readSessionReport,
  readProgress, writeProgress,
  writeWeeklyDigest
};
