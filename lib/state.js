'use strict';

const fs = require('fs');
const path = require('path');

const STATE_FILE = path.join(__dirname, '../.nanobot/state.json');

const DEFAULT_STATE = {
  chatId: null,
  businessConnectionId: null,
  awaitingWorkloadCheckin: null,
  // ID писем, по которым уже отработал дайджест (или bootstrap); переживает рестарт бота
  emailDigestSeenIds: [],
  // После первого тика email-cron без уведомления (только «хвост» инбокса на момент установки)
  emailDigestBootstrapped: false
};

function load() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      const merged = { ...DEFAULT_STATE, ...parsed };
      // Старые state.json без полей почты: не делаем повторный «первый запуск» после деплоя
      if (!Object.prototype.hasOwnProperty.call(parsed, 'emailDigestBootstrapped')) {
        merged.emailDigestBootstrapped = true;
      }
      return merged;
    }
  } catch (e) {
    console.error('[state] Failed to load:', e.message);
  }
  return { ...DEFAULT_STATE };
}

function save(state) {
  const dir = path.dirname(STATE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

module.exports = { load, save };
