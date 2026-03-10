'use strict';

const TelegramBot = require('node-telegram-bot-api');

const bot = new TelegramBot(process.env.TUTOR_BOT_TOKEN, { polling: true });
const ALLOWED = (process.env.TUTOR_ALLOWED_USER_ID || '').replace('@', '');

// C-3: без этого обработчика сетевые ошибки крашат процесс
bot.on('polling_error', (err) => {
  console.error('[Max] Polling error:', err.code || err.message);
});

function isAllowed(msg) {
  const { id, username } = msg.from || {};
  return String(id) === ALLOWED || username === ALLOWED;
}

// Разбивает одиночный параграф длиннее maxLen на части по строкам или посимвольно
function splitParagraph(para, maxLen) {
  if (para.length <= maxLen) return [para];
  const chunks = [];
  const lines = para.split('\n');
  let chunk = '';
  for (const line of lines) {
    if (chunk.length + line.length + 1 > maxLen) {
      if (chunk) chunks.push(chunk.trim());
      if (line.length > maxLen) {
        // Одна строка длиннее лимита — режем посимвольно
        for (let i = 0; i < line.length; i += maxLen) {
          chunks.push(line.slice(i, i + maxLen));
        }
        chunk = '';
      } else {
        chunk = line;
      }
    } else {
      chunk += (chunk ? '\n' : '') + line;
    }
  }
  if (chunk.trim()) chunks.push(chunk.trim());
  return chunks;
}

// M-3: корректно обрабатывает параграфы длиннее 4096 символов
async function sendLongMessage(chatId, text) {
  const MAX = 4096;
  if (text.length <= MAX) {
    await bot.sendMessage(chatId, text);
    return;
  }
  const paragraphs = text.split(/\n\n/);
  let chunk = '';
  for (const para of paragraphs) {
    if (para.length > MAX) {
      // Параграф сам по себе слишком длинный — сначала отправим накопленный chunk
      if (chunk.trim()) {
        await bot.sendMessage(chatId, chunk.trim());
        chunk = '';
      }
      // Затем отправим части параграфа по отдельности
      for (const part of splitParagraph(para, MAX)) {
        await bot.sendMessage(chatId, part);
      }
    } else if (chunk.length + para.length + 2 > MAX) {
      if (chunk.trim()) await bot.sendMessage(chatId, chunk.trim());
      chunk = para;
    } else {
      chunk += (chunk ? '\n\n' : '') + para;
    }
  }
  if (chunk.trim()) await bot.sendMessage(chatId, chunk.trim());
}

module.exports = { bot, ALLOWED, isAllowed, sendLongMessage };
