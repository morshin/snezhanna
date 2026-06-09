'use strict';

const diskLog = require('./disk-log');
const gdrive = require('./gdrive');

const config = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, '../config/nanobot.json'), 'utf8'));

const VALID_CATEGORIES = ['health', 'kids', 'finance', 'bureaucracy', 'decisions'];

async function readMemory(category) {
  if (!VALID_CATEGORIES.includes(category)) {
    return { error: `Invalid category: ${category}. Valid: ${VALID_CATEGORIES.join(', ')}` };
  }

  const content = await gdrive.readFile(`memory/${category}.md`);
  if (content === null) {
    return { category, content: '', note: 'File does not exist yet' };
  }
  return { category, content };
}

async function writeMemory(category, content, mode = 'append') {
  if (!VALID_CATEGORIES.includes(category)) {
    return { error: `Invalid category: ${category}. Valid: ${VALID_CATEGORIES.join(', ')}` };
  }

  if (mode === 'overwrite') {
    await gdrive.writeFile(`memory/${category}.md`, content);
  } else {
    const dateHeader = `\n\n---\n_${new Date().toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', timeZone: config.timezone })}_\n\n`;
    await gdrive.appendFile(`memory/${category}.md`, dateHeader + content);
  }

  diskLog.log('Запись в память', `${category} (${mode})`);
  return { saved: true, category, mode };
}

module.exports = { readMemory, writeMemory, VALID_CATEGORIES };
