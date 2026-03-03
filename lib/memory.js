'use strict';

const fs = require('fs');
const path = require('path');

const config = JSON.parse(fs.readFileSync(path.join(__dirname, '../config/nanobot.json'), 'utf8'));
const MEMORY_DIR = path.join(config.yadisk.agent_mount, 'memory');

const VALID_CATEGORIES = ['health', 'kids', 'finance', 'bureaucracy', 'decisions'];

function readMemory(category) {
  if (!VALID_CATEGORIES.includes(category)) {
    return { error: `Invalid category: ${category}. Valid: ${VALID_CATEGORIES.join(', ')}` };
  }

  const filePath = path.join(MEMORY_DIR, `${category}.md`);
  if (!fs.existsSync(filePath)) {
    return { category, content: '', note: 'File does not exist yet' };
  }

  const content = fs.readFileSync(filePath, 'utf8');
  return { category, content };
}

function writeMemory(category, content, mode = 'append') {
  if (!VALID_CATEGORIES.includes(category)) {
    return { error: `Invalid category: ${category}. Valid: ${VALID_CATEGORIES.join(', ')}` };
  }

  // Ensure directory exists
  if (!fs.existsSync(MEMORY_DIR)) {
    fs.mkdirSync(MEMORY_DIR, { recursive: true });
  }

  const filePath = path.join(MEMORY_DIR, `${category}.md`);

  if (mode === 'overwrite') {
    fs.writeFileSync(filePath, content, 'utf8');
  } else {
    const dateHeader = `\n\n---\n_${new Date().toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Madrid' })}_\n\n`;
    fs.appendFileSync(filePath, dateHeader + content, 'utf8');
  }

  return { saved: true, category, mode };
}

module.exports = { readMemory, writeMemory, VALID_CATEGORIES };
