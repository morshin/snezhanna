'use strict';

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');
const Anthropic = require('@anthropic-ai/sdk');
const cron = require('node-cron');
const axios = require('axios');

const state = require('./lib/state');
const google = require('./lib/google');
const whisper = require('./lib/whisper');

// ── Config & Identity ─────────────────────────────────────────────────────────

const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config/nanobot.json'), 'utf8'));
const identity = fs.readFileSync(path.join(__dirname, 'identity/IDENTITY.md'), 'utf8');

// ── Anthropic ─────────────────────────────────────────────────────────────────

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
let history = [];

async function askClaude(userMessage, extraContext = '') {
  history.push({ role: 'user', content: userMessage });
  if (history.length > config.history.max_messages) {
    history = history.slice(-config.history.keep_last);
  }

  const systemPrompt = extraContext
    ? `${identity}\n\n## Текущий контекст\n${extraContext}`
    : identity;

  const response = await anthropic.messages.create({
    model: config.model,
    max_tokens: config.max_tokens,
    system: systemPrompt,
    messages: history
  });

  const reply = response.content[0].text;
  history.push({ role: 'assistant', content: reply });
  return reply;
}

// ── Telegram ──────────────────────────────────────────────────────────────────

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
const ALLOWED = process.env.TELEGRAM_ALLOWED_USER_ID.replace('@', '');

let appState = state.load();

function isAllowed(msg) {
  const { id, username } = msg.from || {};
  return String(id) === ALLOWED || username === ALLOWED;
}

async function sendToVova(text, options = {}) {
  if (!appState.chatId) {
    console.log('[Snezhanna] chatId unknown, queuing startup message');
    return false;
  }
  await bot.sendMessage(appState.chatId, text, options);
  return true;
}

// ── Message handler ───────────────────────────────────────────────────────────

let pendingStartup = false;

bot.on('message', async (msg) => {
  if (!isAllowed(msg)) return;

  // Persist chatId on first contact
  if (!appState.chatId) {
    appState.chatId = msg.chat.id;
    state.save(appState);
    console.log('[Snezhanna] Saved chatId:', appState.chatId);
  }

  // Send delayed startup message
  if (pendingStartup) {
    pendingStartup = false;
    await bot.sendMessage(msg.chat.id, 'Вовочка, я онлайн! 🦞');
    // Prompt Google auth if needed
    if (!google.isAuthorized()) {
      setTimeout(() => offerGoogleAuth(msg.chat.id), 1500);
    }
    return;
  }

  const chatId = msg.chat.id;

  try {
    let userText = '';

    if (msg.text) {
      userText = msg.text;

      // /auth <code> — Google OAuth callback
      if (userText.startsWith('/auth ')) {
        const code = userText.slice(6).trim();
        await handleGoogleAuthCode(code, chatId);
        return;
      }

      // /reset — clear conversation history
      if (userText === '/reset') {
        history = [];
        await bot.sendMessage(chatId, 'История очищена ✅');
        return;
      }

      // /status — quick status
      if (userText === '/status') {
        const gcal = google.isAuthorized() ? '✅' : '❌ нет авторизации';
        await bot.sendMessage(chatId, `📊 Статус:\n• Google: ${gcal}\n• Claude: ✅\n• Я работаю 🟢`);
        return;
      }

    } else if (msg.voice) {
      await bot.sendChatAction(chatId, 'typing');
      const file = await bot.getFile(msg.voice.file_id);
      const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
      const audioRes = await axios.get(fileUrl, { responseType: 'arraybuffer' });
      userText = await whisper.transcribe(Buffer.from(audioRes.data));
      await bot.sendMessage(chatId, `🎤 _"${userText}"_`, { parse_mode: 'Markdown' });
    } else {
      return; // Ignore non-text/non-voice
    }

    await bot.sendChatAction(chatId, 'typing');

    // Build context from Google if authorized
    let context = '';
    if (google.isAuthorized()) {
      const lowerText = userText.toLowerCase();
      if (lowerText.includes('календар') || lowerText.includes('встреч') ||
          lowerText.includes('сегодня') || lowerText.includes('завтра')) {
        try {
          const events = await google.getCalendarEvents(2);
          if (events.length > 0) {
            context = 'События в календаре:\n' +
              events.map(e => `• ${e.summary} — ${formatEventTime(e)}`).join('\n');
          }
        } catch (e) {
          console.error('[Calendar] context fetch error:', e.message);
        }
      }
      if (lowerText.includes('почт') || lowerText.includes('письм') || lowerText.includes('email')) {
        try {
          const msgs = await google.getGmailMessages(10);
          if (msgs.length > 0) {
            context += '\nПоследние письма в почте:\n' +
              msgs.slice(0, 5).map(m => `• ${m.unread ? '📬' : '📭'} От: ${m.from} | Тема: ${m.subject}`).join('\n');
          }
        } catch (e) {
          console.error('[Gmail] context fetch error:', e.message);
        }
      }
    }

    const reply = await askClaude(userText, context);
    await bot.sendMessage(chatId, reply);

  } catch (err) {
    console.error('[Snezhanna] Error:', err.message);
    await bot.sendMessage(chatId, `Вовочка, что-то пошло не так: ${err.message}`).catch(() => {});
  }
});

// ── Google OAuth ──────────────────────────────────────────────────────────────

async function offerGoogleAuth(chatId) {
  const url = google.getAuthUrl();
  await bot.sendMessage(chatId,
    `🔐 Вова, нужна авторизация Google!\n\nПерейди по ссылке:\n${url}\n\nПотом отправь мне код командой:\n/auth КОД`
  );
}

async function handleGoogleAuthCode(code, chatId) {
  try {
    await google.saveToken(code);
    await bot.sendMessage(chatId, '✅ Google авторизован! Теперь работаю с Calendar и Gmail.');
  } catch (err) {
    await bot.sendMessage(chatId, `❌ Ошибка авторизации: ${err.message}`);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatEventTime(event) {
  if (event.start.dateTime) {
    return new Date(event.start.dateTime).toLocaleString('ru-RU', {
      weekday: 'short', day: 'numeric', month: 'short',
      hour: '2-digit', minute: '2-digit',
      timeZone: config.timezone
    });
  }
  return new Date(event.start.date).toLocaleDateString('ru-RU', {
    weekday: 'short', day: 'numeric', month: 'short',
    timeZone: config.timezone
  });
}

function todayStr() {
  return new Date().toLocaleDateString('ru-RU', {
    weekday: 'long', day: 'numeric', month: 'long',
    timeZone: config.timezone
  });
}

// ── Scheduled tasks ───────────────────────────────────────────────────────────

function setupSchedules() {
  // Morning briefing — 08:00 Madrid
  cron.schedule('0 8 * * *', async () => {
    if (!appState.chatId) return;
    try {
      let eventsText = '• Событий нет';
      if (google.isAuthorized()) {
        const events = await google.getCalendarEvents(1);
        if (events.length > 0) {
          eventsText = events.map(e => `• ${e.summary} (${formatEventTime(e)})`).join('\n');
        }
      }
      const prompt = `Составь утренний брифинг для Вовочки. Сегодня ${todayStr()}.
События в Calendar:
${eventsText}
Напомни о топ-3 вещах, которые стоит сделать сегодня. Будь живым и тёплым.`;
      const reply = await askClaude(prompt);
      await sendToVova(reply);
    } catch (e) {
      console.error('[Schedule] morning_briefing error:', e.message);
    }
  }, { timezone: config.timezone });

  // Evening check-in — 19:00 Madrid
  cron.schedule('0 19 * * *', async () => {
    if (!appState.chatId) return;
    try {
      let eventsText = '• Событий нет';
      if (google.isAuthorized()) {
        const events = await google.getCalendarEvents(2);
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        const tomorrowEvents = events.filter(e => {
          const d = new Date(e.start.dateTime || e.start.date);
          return d.toDateString() === tomorrow.toDateString();
        });
        if (tomorrowEvents.length > 0) {
          eventsText = tomorrowEvents.map(e => `• ${e.summary} (${formatEventTime(e)})`).join('\n');
        }
      }
      const prompt = `Сделай вечерний чек-ин для Вовочки. Спроси как прошёл день.
Завтра в Calendar:
${eventsText}`;
      const reply = await askClaude(prompt);
      await sendToVova(reply);
    } catch (e) {
      console.error('[Schedule] evening_checkin error:', e.message);
    }
  }, { timezone: config.timezone });

  // Weekly digest — Sunday 10:00 Madrid
  cron.schedule('0 10 * * 0', async () => {
    if (!appState.chatId) return;
    try {
      const prompt = `Составь воскресный еженедельный дайджест для Вовочки.
Включи: краткий обзор прошедшей недели, что важного на следующей неделе, напоминание проверить фитнес-лог и бюрократические дедлайны.`;
      const reply = await askClaude(prompt);
      await sendToVova(reply);
    } catch (e) {
      console.error('[Schedule] weekly_digest error:', e.message);
    }
  }, { timezone: config.timezone });

  // Calendar reminders — check every 10 min
  const notifiedEvents = new Set();
  cron.schedule('*/10 * * * *', async () => {
    if (!appState.chatId || !google.isAuthorized()) return;
    try {
      const events = await google.getUpcomingEvents(40);
      const now = Date.now();
      for (const event of events) {
        if (!event.start.dateTime) continue;
        const eventTime = new Date(event.start.dateTime).getTime();
        const minutesUntil = (eventTime - now) / 60000;
        if (minutesUntil >= 28 && minutesUntil <= 32 && !notifiedEvents.has(event.id)) {
          notifiedEvents.add(event.id);
          const timeStr = new Date(event.start.dateTime).toLocaleTimeString('ru-RU', {
            hour: '2-digit', minute: '2-digit', timeZone: config.timezone
          });
          await sendToVova(`📅 Вовик, через 30 минут: *${event.summary}* в ${timeStr}`, { parse_mode: 'Markdown' });
        }
      }
    } catch (e) {
      // Silently skip calendar errors in reminder loop
    }
  });

  console.log('[Snezhanna] Schedules initialized (timezone: Europe/Madrid)');
}

// ── Startup ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('[Snezhanna] Starting...');

  setupSchedules();

  if (appState.chatId) {
    try {
      await sendToVova('Вовочка, я онлайн! 🦞');
      console.log('[Snezhanna] Startup message sent to chatId:', appState.chatId);
    } catch (e) {
      console.error('[Snezhanna] Failed to send startup message:', e.message);
    }

    if (!google.isAuthorized()) {
      setTimeout(() => offerGoogleAuth(appState.chatId), 2000);
    }
  } else {
    console.log('[Snezhanna] No chatId saved — will send startup message on first message from Vova');
    pendingStartup = true;
  }

  console.log('[Snezhanna] Ready and listening.');
}

main().catch((e) => {
  console.error('[Snezhanna] Fatal error:', e);
  process.exit(1);
});
