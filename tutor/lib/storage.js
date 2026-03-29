'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const KIDS_DIR = process.env.KIDS_DATA_DIR || '/mnt/yadisk-agent/kids';
const SESSIONS_DIR = path.join(KIDS_DIR, 'sessions');
const WEEKLY_DIR = path.join(KIDS_DIR, 'weekly');
const SCHEDULE_FILE = path.join(KIDS_DIR, 'schedule.json');
const HOMEWORK_FILE = path.join(KIDS_DIR, 'homework.json');
const PROGRESS_FILE = path.join(KIDS_DIR, 'progress.md');
const QUESTS_FILE = path.join(KIDS_DIR, 'quests.json');
const BALANCE_FILE = path.join(KIDS_DIR, 'balance.json');

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
    added: new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Madrid' })
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

// Расписание считается заполненным если хотя бы один день содержит предметы
function isScheduleComplete() {
  const schedule = loadSchedule();
  if (!schedule) return false;
  const days = ['lunes', 'martes', 'miércoles', 'jueves', 'viernes'];
  return days.some(d => Array.isArray(schedule[d]) && schedule[d].length > 0);
}

// Возвращает список дат сессий, отсортированных от новых к старым
function listSessionDates() {
  try {
    if (!fs.existsSync(SESSIONS_DIR)) return [];
    return fs.readdirSync(SESSIONS_DIR)
      .filter(f => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
      .map(f => f.replace('.md', ''))
      .sort()
      .reverse();
  } catch (e) {
    return [];
  }
}

// ── Quests ────────────────────────────────────────────────────────────────────

function loadQuests() {
  try {
    if (!fs.existsSync(QUESTS_FILE)) return { quests: [] };
    return JSON.parse(fs.readFileSync(QUESTS_FILE, 'utf8'));
  } catch (e) {
    console.error('[Storage] Failed to load quests:', e.message);
    return { quests: [] };
  }
}

function saveQuests(data) {
  try {
    fs.writeFileSync(QUESTS_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.error('[Storage] Failed to save quests:', e.message);
    throw e;
  }
}

function addQuest({ subject, description, reward_minutes }) {
  const data = loadQuests();
  const id = 'quest_' + Date.now();
  data.quests.push({
    id,
    subject,
    description,
    reward_minutes: Number(reward_minutes),
    status: 'active',
    created: new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Madrid' }),
    done_at: null,
    done_session: null
  });
  saveQuests(data);
  console.log('[Storage] Quest added:', id, subject);
  return id;
}

function completeQuest(id) {
  const data = loadQuests();
  const quest = data.quests.find(q => q.id === id);
  if (!quest || quest.status !== 'active') return null;
  quest.status = 'done';
  quest.done_at = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Madrid' });
  quest.done_session = quest.done_at;
  saveQuests(data);
  console.log('[Storage] Quest completed:', id, quest.subject);
  return { quest, balance_minutes_added: quest.reward_minutes };
}

function cancelQuest(id) {
  const data = loadQuests();
  const quest = data.quests.find(q => q.id === id);
  if (!quest) return false;
  quest.status = 'cancelled';
  saveQuests(data);
  console.log('[Storage] Quest cancelled:', id);
  return true;
}

function getActiveQuests() {
  const data = loadQuests();
  return data.quests.filter(q => q.status === 'active');
}

// ── Prize Codes ───────────────────────────────────────────────────────────────

const CODES_FILE_RE = /^codes_(\d{8})\.md$/;

function findLatestCodesFile() {
  try {
    if (!fs.existsSync(KIDS_DIR)) return null;
    const files = fs.readdirSync(KIDS_DIR).filter(f => CODES_FILE_RE.test(f));
    if (files.length === 0) return null;
    // Sort descending by DDMMYYYY → convert to YYYYMMDD for comparison
    const toSortable = s => {
      const m = s.match(CODES_FILE_RE);
      return m ? m[1].slice(4) + m[1].slice(2, 4) + m[1].slice(0, 2) : '';
    };
    files.sort((a, b) => toSortable(b).localeCompare(toSortable(a)));
    return path.join(KIDS_DIR, files[0]);
  } catch (e) {
    console.error('[Storage] findLatestCodesFile error:', e.message);
    return null;
  }
}

function loadCodes(filePath) {
  try {
    if (!fs.existsSync(filePath)) return [];
    const lines = fs.readFileSync(filePath, 'utf8').split('\n');
    const codes = [];
    for (const line of lines) {
      if (!line.startsWith('|')) continue;
      const parts = line.split('|').map(p => p.trim()).filter(Boolean);
      if (parts.length < 2) continue;
      const [code, used, usedAt, quest] = parts;
      // Skip header rows
      if (!code || code === 'Code' || code.startsWith('---')) continue;
      codes.push({ code, used: used === 'true', usedAt: usedAt || '', quest: quest || '' });
    }
    return codes;
  } catch (e) {
    console.error('[Storage] loadCodes error:', e.message);
    return [];
  }
}

function saveCodes(filePath, codes) {
  try {
    const m = path.basename(filePath).match(CODES_FILE_RE);
    const dateStr = m ? `${m[1].slice(0, 2)}.${m[1].slice(2, 4)}.${m[1].slice(4)}` : '';
    let content = `# Prize Codes — ${dateStr}\n\n| Code | Used | Used At | Quest |\n|------|------|---------|-------|\n`;
    for (const c of codes) {
      content += `| ${c.code} | ${c.used} | ${c.usedAt || ''} | ${c.quest || ''} |\n`;
    }
    fs.writeFileSync(filePath, content, 'utf8');
  } catch (e) {
    console.error('[Storage] saveCodes error:', e.message);
    throw e;
  }
}

function getNextCode(filePath) {
  if (!filePath) return null;
  try {
    const codes = loadCodes(filePath);
    const next = codes.find(c => !c.used);
    return next ? { code: next.code, filePath } : null;
  } catch (e) {
    console.error('[Storage] getNextCode error:', e.message);
    return null;
  }
}

function markCodeUsed(filePath, code, questDescription) {
  try {
    const codes = loadCodes(filePath);
    const c = codes.find(entry => entry.code === code);
    if (!c) return;
    c.used = true;
    c.usedAt = new Date().toISOString().slice(0, 10);
    c.quest = questDescription || '';
    saveCodes(filePath, codes);
    console.log('[Storage] Code marked used:', code);
  } catch (e) {
    console.error('[Storage] markCodeUsed error:', e.message);
    throw e;
  }
}

function countRemainingCodes(filePath) {
  if (!filePath) return 0;
  try {
    return loadCodes(filePath).filter(c => !c.used).length;
  } catch (e) {
    console.error('[Storage] countRemainingCodes error:', e.message);
    return 0;
  }
}

function generateUniqueCodes(n) {
  const known = new Set();
  try {
    if (fs.existsSync(KIDS_DIR)) {
      const files = fs.readdirSync(KIDS_DIR).filter(f => CODES_FILE_RE.test(f));
      for (const file of files) {
        for (const c of loadCodes(path.join(KIDS_DIR, file))) known.add(c.code);
      }
    }
  } catch (e) {
    console.error('[Storage] generateUniqueCodes: error scanning existing codes:', e.message);
  }

  const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const generated = [];
  while (generated.length < n) {
    let code = '';
    for (let i = 0; i < 10; i++) code += CHARS[Math.floor(Math.random() * CHARS.length)];
    if (!known.has(code)) {
      known.add(code);
      generated.push(code);
    }
  }
  return generated;
}

// Writes codes_DDMMYYYY.md to KIDS_DIR; returns prize txt content as string (not written to disk)
function writePrizeFiles(codes, dateStr) {
  const mdFilePath = path.join(KIDS_DIR, `codes_${dateStr}.md`);
  const formattedDate = `${dateStr.slice(0, 2)}.${dateStr.slice(2, 4)}.${dateStr.slice(4)}`;
  let mdContent = `# Prize Codes — ${formattedDate}\n\n| Code | Used | Used At | Quest |\n|------|------|---------|-------|\n`;
  for (const code of codes) {
    mdContent += `| ${code} | false |  |  |\n`;
  }
  fs.writeFileSync(mdFilePath, mdContent, 'utf8');
  console.log('[Storage] Codes file written:', mdFilePath);
  return codes.map(code => `${code}*30*0*0*0*0`).join('\n');
}

// ── Balance ───────────────────────────────────────────────────────────────────

function computeHmac(balance_minutes, last_updated) {
  const secret = process.env.QUEST_HMAC_SECRET || '';
  return crypto.createHmac('sha256', secret)
    .update(`${balance_minutes}|${last_updated}`)
    .digest('hex');
}

function loadBalance() {
  try {
    if (!fs.existsSync(BALANCE_FILE)) return { balance_minutes: 0 };
    return JSON.parse(fs.readFileSync(BALANCE_FILE, 'utf8'));
  } catch (e) {
    console.error('[Storage] Failed to load balance:', e.message);
    return { balance_minutes: 0 };
  }
}

function saveBalance(balance_minutes) {
  try {
    const last_updated = new Date().toISOString();
    const hmac = computeHmac(balance_minutes, last_updated);
    const data = { balance_minutes, last_updated, hmac };
    fs.writeFileSync(BALANCE_FILE, JSON.stringify(data, null, 2), 'utf8');
    console.log('[Storage] Balance saved:', balance_minutes, 'min');
    return data;
  } catch (e) {
    console.error('[Storage] Failed to save balance:', e.message);
    throw e;
  }
}

function addBalance(minutes) {
  const current = loadBalance();
  const newBalance = (current.balance_minutes || 0) + minutes;
  return saveBalance(newBalance);
}

module.exports = {
  ensureDirs,
  loadSchedule, saveSchedule,
  loadHomework, saveHomework, addHomeworkTask, markHomeworkDone,
  isScheduleComplete,
  appendSessionReport, readSessionReport, listSessionDates,
  readProgress, writeProgress,
  writeWeeklyDigest,
  loadQuests, saveQuests, addQuest, completeQuest, cancelQuest, getActiveQuests,
  findLatestCodesFile, loadCodes, saveCodes, getNextCode, markCodeUsed, countRemainingCodes,
  generateUniqueCodes, writePrizeFiles,
  loadBalance, saveBalance, addBalance
};
