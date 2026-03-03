'use strict';

const fs = require('fs');
const path = require('path');

const STATE_FILE = path.join(__dirname, '../.nanobot/state.json');

function load() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('[state] Failed to load:', e.message);
  }
  return { chatId: null };
}

function save(state) {
  const dir = path.dirname(STATE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

module.exports = { load, save };
