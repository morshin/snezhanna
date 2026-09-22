'use strict';

// Хранит лог операций с Google Drive за текущие сутки (в памяти).
// Сбрасывается после отправки вечернего чек-ина или при перезапуске.

const config = require('./config');

const entries = [];

function log(action, details) {
  entries.push({
    time: new Date().toLocaleTimeString('ru-RU', {
      hour: '2-digit', minute: '2-digit', timeZone: config.timezone
    }),
    action,
    details
  });
}

function getSummary() {
  if (entries.length === 0) return null;

  const lines = entries.map(e => `• ${e.time} — ${e.action}: ${e.details}`);
  return lines.join('\n');
}

function getCount() {
  return entries.length;
}

function clear() {
  entries.length = 0;
}

module.exports = { log, getSummary, getCount, clear };
