'use strict';

const TelegramBot = require('node-telegram-bot-api');

const bot = new TelegramBot(process.env.TUTOR_BOT_TOKEN, { polling: true });
const ALLOWED = (process.env.TUTOR_ALLOWED_USER_ID || '').replace('@', '');

function isAllowed(msg) {
  const { id, username } = msg.from || {};
  return String(id) === ALLOWED || username === ALLOWED;
}

async function sendLongMessage(chatId, text) {
  const MAX = 4096;
  if (text.length <= MAX) {
    await bot.sendMessage(chatId, text);
    return;
  }
  const paragraphs = text.split(/\n\n/);
  let chunk = '';
  for (const para of paragraphs) {
    if (chunk.length + para.length + 2 > MAX) {
      if (chunk) await bot.sendMessage(chatId, chunk.trim());
      chunk = para;
    } else {
      chunk += (chunk ? '\n\n' : '') + para;
    }
  }
  if (chunk.trim()) await bot.sendMessage(chatId, chunk.trim());
}

module.exports = { bot, ALLOWED, isAllowed, sendLongMessage };
