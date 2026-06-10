'use strict';

const fs = require('fs');
const path = require('path');

const STATE_FILE = process.env.STATE_FILE || path.join(__dirname, '../.nanobot/state.json');

const DEFAULT_STATE = {
  chatId: null,
  businessConnectionId: null,
  awaitingWorkloadCheckin: null,
  // Conversational briefing + silence adaptation
  lastUserMessageAt: null,       // ISO timestamp — обновляется на каждом входящем сообщении
  briefingPending: false,        // true = «Готов к брифингу?» отправлен, ждём ответа
  briefingPendingAt: null,       // ISO timestamp — когда был отправлен вопрос
  silenceLevel: 0,               // 0 | 1 | 2 — текущий уровень тишины
  silenceDaysCount: 0,           // кол-во дней подряд, когда брифинг-вопрос был проигнорирован
  quietUntil: null               // ISO timestamp — режим отпуска до этого момента, null = не активен
};

function load() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      const merged = { ...DEFAULT_STATE, ...parsed };
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
