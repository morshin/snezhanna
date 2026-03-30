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
const { getAvailableTools, executeTool } = require('./lib/tools');
const yadiskDirs = require('./lib/yadisk-dirs');
const vision = require('./lib/vision');
const diskLog = require('./lib/disk-log');
const tasks = require('./lib/tasks');
const chatMonitor = require('./lib/chat-monitor');
const strava = require('./lib/strava');
const workload = require('./lib/workload');
const github = require('./lib/github');
const { logTokens } = require('./lib/token-log');
const api = require('./lib/api');

// ── Config & Identity ─────────────────────────────────────────────────────────

const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config/nanobot.json'), 'utf8'));
const identity = fs.readFileSync(path.join(__dirname, 'identity/IDENTITY.md'), 'utf8');

// ── Anthropic ─────────────────────────────────────────────────────────────────

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
let history = [];

// Мьютекс для сериализации вызовов askClaude: предотвращает race condition,
// когда два параллельных запроса видят историю с осиротевшим tool_use.
let messageLock = Promise.resolve();
function withMessageLock(fn) {
  const next = messageLock.then(fn);
  messageLock = next.catch(() => {});
  return next;
}

// Одноразовый вызов Claude без использования глобальной истории разговора.
// Используется для крон-задач: у них изолированный локальный контекст,
// они не загрязняют историю чата и не ломаются от "отравленной" истории.
async function askClaudeOneShot(userMessage, requestType = 'scheduled') {
  const tools = getAvailableTools();
  const MAX_TOOL_ROUNDS = 10;

  const nowStr = new Date().toLocaleString('ru-RU', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
    timeZone: config.timezone
  });
  const system = [
    { type: 'text', text: `Сейчас: ${nowStr} (${config.timezone}).` },
    { type: 'text', text: identity, cache_control: { type: 'ephemeral' } }
  ];

  let localHistory = [{ role: 'user', content: userMessage }];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await anthropic.messages.create({
      model: config.model,
      max_tokens: config.max_tokens,
      system,
      messages: localHistory,
      tools
    });

    if (response.usage?.cache_read_input_tokens) {
      console.log(`[Cache/OneShot] hit: ${response.usage.cache_read_input_tokens} tokens cached`);
    }

    logTokens({
      bot: 'snezhanna',
      type: requestType,
      tools_called: response.content.filter(b => b.type === 'tool_use').map(b => b.name),
      history_len: localHistory.length,
      usage: response.usage
    });

    if (response.stop_reason === 'tool_use') {
      localHistory.push({ role: 'assistant', content: response.content });

      const toolResults = [];
      for (const block of response.content) {
        if (block.type === 'tool_use') {
          console.log(`[Tools/OneShot] Calling ${block.name}:`, JSON.stringify(block.input));
          try {
            const result = await executeTool(block.name, block.input);
            toolResults.push({
              type: 'tool_result',
              tool_use_id: block.id,
              content: JSON.stringify(result)
            });
          } catch (err) {
            console.error(`[Tools/OneShot] Error in ${block.name}:`, err.message);
            toolResults.push({
              type: 'tool_result',
              tool_use_id: block.id,
              content: JSON.stringify({ error: err.message }),
              is_error: true
            });
          }
        }
      }
      localHistory.push({ role: 'user', content: toolResults });
      continue;
    }

    const textBlocks = response.content.filter(b => b.type === 'text');
    return textBlocks.map(b => b.text).join('\n') || '';
  }

  return 'Извини, Вовик, слишком долго думала над этим.';
}

async function askClaude(userMessage, requestType = 'text') {
  return withMessageLock(() => _askClaude(userMessage, requestType));
}

async function _askClaude(userMessage, requestType = 'text') {
  // Сохраняем снимок истории до вызова — восстановим при ошибке,
  // чтобы не оставлять в истории осиротевшие tool_use / tool_result блоки
  const historyBeforeCall = [...history];

  history.push({ role: 'user', content: userMessage });

  // Trim history, but never orphan a tool_result or start on an assistant message
  if (history.length > config.history.max_messages) {
    let sliceAt = history.length - config.history.keep_last;
    // Сдвигаемся назад, пока не окажемся на обычном user-сообщении:
    // — нельзя начинать с tool_result (user, но со служебным контентом)
    // — нельзя начинать с assistant-сообщения (Claude требует, чтобы первым шёл user)
    while (sliceAt > 0 && (
      history[sliceAt].role !== 'user' ||
      (Array.isArray(history[sliceAt].content) &&
       history[sliceAt].content.some(b => b.type === 'tool_result'))
    )) {
      sliceAt--;
    }
    history = history.slice(sliceAt);
  }

  const tools = getAvailableTools();
  const MAX_TOOL_ROUNDS = 10;

  const nowStr = new Date().toLocaleString('ru-RU', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
    timeZone: config.timezone
  });
  const system = [
    { type: 'text', text: `Сейчас: ${nowStr} (${config.timezone}).` },
    { type: 'text', text: identity, cache_control: { type: 'ephemeral' } }
  ];

  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const response = await anthropic.messages.create({
        model: config.model,
        max_tokens: config.max_tokens,
        system,
        messages: history,
        tools
      });

      if (response.usage?.cache_read_input_tokens) {
        console.log(`[Cache] hit: ${response.usage.cache_read_input_tokens} tokens cached`);
      }

      logTokens({
        bot: 'snezhanna',
        type: requestType,
        tools_called: response.content.filter(b => b.type === 'tool_use').map(b => b.name),
        history_len: history.length,
        usage: response.usage
      });

      // Log web search usage (server-side tool, handled by Anthropic)
      for (const block of response.content) {
        if (block.type === 'server_tool_use' && block.name === 'web_search') {
          console.log('[WebSearch] Query:', JSON.stringify(block.input));
        }
      }

      // If Claude wants to use tools
      if (response.stop_reason === 'tool_use') {
        // Add assistant's full response (text + tool_use blocks) to history
        history.push({ role: 'assistant', content: response.content });

        // Execute each tool call and collect results
        const toolResults = [];
        for (const block of response.content) {
          if (block.type === 'tool_use') {
            console.log(`[Tools] Calling ${block.name}:`, JSON.stringify(block.input));
            try {
              const result = await executeTool(block.name, block.input);
              toolResults.push({
                type: 'tool_result',
                tool_use_id: block.id,
                content: JSON.stringify(result)
              });
            } catch (err) {
              console.error(`[Tools] Error in ${block.name}:`, err.message);
              toolResults.push({
                type: 'tool_result',
                tool_use_id: block.id,
                content: JSON.stringify({ error: err.message }),
                is_error: true
              });
            }
          }
        }

      // Add tool results as user message.
      // Большие tool_result-ы обрезаем перед сохранением в историю:
      // Claude уже обработал полный ответ в этом раунде, а история нужна
      // только для контекста — хранить сырой дамп на 10 000 символов нет смысла.
      const MAX_TOOL_RESULT_CHARS = 2000;
      const toolResultsForHistory = toolResults.map(r => {
        if (typeof r.content === 'string' && r.content.length > MAX_TOOL_RESULT_CHARS) {
          return {
            ...r,
            content: r.content.slice(0, MAX_TOOL_RESULT_CHARS) +
              `\n...[обрезано: исходный размер ${r.content.length} симв.]`
          };
        }
        return r;
      });
      history.push({ role: 'user', content: toolResultsForHistory });
        continue;
      }

      // End turn — extract text reply
      const textBlocks = response.content.filter(b => b.type === 'text');
      const reply = textBlocks.map(b => b.text).join('\n') || '';
      history.push({ role: 'assistant', content: reply });
      return reply;
    }

    // Safety: if we hit max rounds, return whatever we have
    return 'Извини, Вовик, я слишком долго думала. Попробуй переформулировать вопрос.';
  } catch (err) {
    // При любой ошибке откатываем историю в состояние до вызова.
    // Иначе в истории могут остаться осиротевшие tool_use без tool_result,
    // что ломает все последующие запросы к Claude.
    history = historyBeforeCall;
    throw err;
  }
}

// ── Error formatting ─────────────────────────────────────────────────────────

// Проверяет, является ли ошибка превышением лимита запросов (HTTP 429)
function isRateLimitError(err) {
  const raw = err.message || '';
  const statusMatch = raw.match(/^(\d{3})\s+(\{.*\})$/s);
  if (!statusMatch) return false;
  const status = parseInt(statusMatch[1], 10);
  let body = {};
  try { body = JSON.parse(statusMatch[2]); } catch (_) {}
  return status === 429 || body?.error?.type === 'rate_limit_error';
}

// Превращает технические ошибки в понятные сообщения для Вовы
function formatErrorForUser(err) {
  const raw = err.message || '';

  // Anthropic SDK бросает ошибки с числовым status и телом ответа в message
  // Например: "529 {"type":"error","error":{"type":"overloaded_error",...}}"
  const statusMatch = raw.match(/^(\d{3})\s+(\{.*\})$/s);
  if (statusMatch) {
    const status = parseInt(statusMatch[1], 10);
    let body = {};
    try { body = JSON.parse(statusMatch[2]); } catch (_) {}
    const errorType = body?.error?.type || '';

    if (status === 529 || errorType === 'overloaded_error') {
      return 'Снежанна временно перегружена — у Anthropic сейчас много запросов. Попробуй через минуту 🙏';
    }
    if (status === 429 || errorType === 'rate_limit_error') {
      return 'Превышен лимит запросов к Claude. Подожди немного и повтори 🕐';
    }
    if (status === 401 || errorType === 'authentication_error') {
      return 'Ошибка авторизации API — проверь ключ ANTHROPIC_API_KEY 🔑';
    }
    if (status === 400 || errorType === 'invalid_request_error') {
      return `Неверный запрос к Claude: ${body?.error?.message || 'неизвестная причина'}`;
    }
    if (status >= 500 || errorType === 'api_error') {
      return 'На стороне Anthropic что-то сломалось. Попробуй чуть позже 🛠';
    }
    // Другой HTTP-статус — показываем только код без JSON-мусора
    return `Ошибка API (HTTP ${status}): ${body?.error?.message || errorType || 'неизвестная ошибка'}`;
  }

  // Сетевые ошибки
  if (raw.includes('ECONNREFUSED') || raw.includes('ENOTFOUND') || raw.includes('ETIMEDOUT')) {
    return 'Не могу подключиться к серверу — проблема с сетью 📡';
  }

  // Всё остальное — показываем коротко, без JSON-мусора
  const clean = raw.replace(/\{.*\}/s, '').trim().slice(0, 120);
  return `Что-то пошло не так${clean ? ': ' + clean : ''}`;
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
  if (Object.keys(options).length > 0 || text.length <= 4096) {
    await bot.sendMessage(appState.chatId, text, options);
  } else {
    await sendLongMessage(appState.chatId, text);
  }
  return true;
}

// ── Message handler ───────────────────────────────────────────────────────────

let pendingStartup = false;
let workloadCheckinTimeout = null;

bot.on('message', async (msg) => {
  if (!isAllowed(msg)) return;

  // Monitored chats — collect only, NEVER respond
  if (chatMonitor.isMonitored(msg.chat.id)) return;

  // Hard block: never respond outside Vova's personal chat
  if (appState.chatId && String(msg.chat.id) !== String(appState.chatId)) {
    console.warn(`[SECURITY] Blocked response to chat ${msg.chat.id} — not Vova's chat`);
    return;
  }

  // Persist chatId on first contact
  if (!appState.chatId) {
    appState.chatId = msg.chat.id;
    state.save(appState);
    console.log('[Snezhanna] Saved chatId:', appState.chatId);
  }

  // Send delayed startup message
  if (pendingStartup) {
    pendingStartup = false;
    await bot.sendMessage(msg.chat.id, 'Вов, я онлайн! 🦞');
    // Prompt Google auth if needed
    if (!google.isAuthorized()) {
      setTimeout(() => offerGoogleAuth(msg.chat.id), 1500);
    }
    return;
  }

  const chatId = msg.chat.id;
  let userText = '';
  let requestType = 'text';

  try {

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

      // ── Workload check-in intercept ──
      if (appState.awaitingWorkloadCheckin && appState.awaitingWorkloadCheckin.active) {
        const elapsed = Date.now() - appState.awaitingWorkloadCheckin.timestamp;
        if (elapsed < 30 * 60 * 1000) {
          // Clear flag
          appState.awaitingWorkloadCheckin = null;
          state.save(appState);
          if (workloadCheckinTimeout) {
            clearTimeout(workloadCheckinTimeout);
            workloadCheckinTimeout = null;
          }
          await bot.sendChatAction(chatId, 'typing');
          try {
            const data = await workload.collectData();
            const scoring = await workload.runScoring(data, userText);
            const history = workload.loadHistory();
            const entry = {
              date: new Date().toLocaleDateString('sv-SE', { timeZone: config.timezone }),
              overall_score: scoring.overall_score,
              domains: {
                work: scoring.domains.work.score,
                family: scoring.domains.family.score,
                health: scoring.domains.health.score,
                personal: scoring.domains.personal.score
              },
              trend: scoring.trend,
              checkin_provided: true,
              key_risks: scoring.key_risks,
              suggestions: scoring.suggestions
            };
            workload.saveHistory(history, entry);
            const report = workload.buildWeeklyReport(scoring, history);
            await sendLongMessage(chatId, report);
          } catch (e) {
            console.error('[Workload] Checkin scoring error:', e.message);
            await bot.sendMessage(chatId, 'Вов, что-то не смогла собрать отчёт. Попробую позже.');
          }
          return;
        }
      }

      // ── Workload on-demand intent detection ──
      const WORKLOAD_INTENTS = [
        'как я справляюсь', 'мой скор', 'обзор недели', 'что со мной не так',
        'как у меня со здоровьем', 'как дела на работе', 'как я в последнее время',
        'покажи мой скор', 'лучше или хуже стало'
      ];
      const lowerText = userText.toLowerCase();
      if (WORKLOAD_INTENTS.some(intent => lowerText.includes(intent))) {
        await bot.sendChatAction(chatId, 'typing');
        try {
          const data = await workload.collectData();
          const scoring = await workload.runScoring(data, userText);
          const history = workload.loadHistory();
          const entry = {
            date: new Date().toLocaleDateString('sv-SE', { timeZone: config.timezone }),
            overall_score: scoring.overall_score,
            domains: {
              work: scoring.domains.work.score,
              family: scoring.domains.family.score,
              health: scoring.domains.health.score,
              personal: scoring.domains.personal.score
            },
            trend: scoring.trend,
            checkin_provided: false,
            key_risks: scoring.key_risks,
            suggestions: scoring.suggestions
          };
          workload.saveHistory(history, entry);
          const report = workload.buildWeeklyReport(scoring, history);
          await sendLongMessage(chatId, report);
        } catch (e) {
          console.error('[Workload] On-demand scoring error:', e.message);
          await bot.sendMessage(chatId, `Вов, ${formatErrorForUser(e)}`);
        }
        return;
      }

    } else if (msg.voice) {
      await bot.sendChatAction(chatId, 'typing');
      const file = await bot.getFile(msg.voice.file_id);
      const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
      const audioRes = await axios.get(fileUrl, { responseType: 'arraybuffer' });
      userText = await whisper.transcribe(Buffer.from(audioRes.data));
      await bot.sendMessage(chatId, `🎤 _"${userText}"_`, { parse_mode: 'Markdown' });
    } else if (msg.document) {
      await bot.sendChatAction(chatId, 'typing');
      const doc = msg.document;
      const mimeType = doc.mime_type || 'application/octet-stream';
      const filename = doc.file_name || 'file';
      const sizeKb = doc.file_size ? (doc.file_size / 1024).toFixed(1) : '?';

      const file = await bot.getFile(doc.file_id);
      const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
      const fileRes = await axios.get(fileUrl, { responseType: 'arraybuffer' });
      const buffer = Buffer.from(fileRes.data);

      // Кладём буфер в кэш — Claude может сохранить файл на диск через инструмент save_file
      const fileCache = require('./lib/file-cache');
      const cacheKey = doc.file_id;
      fileCache.set(cacheKey, buffer, filename, mimeType);

      // Прямое сохранение: если подпись начинается с "сохрани" / "положи" и т.п. —
      // сохраняем файл как есть, без парсинга и без вызова Claude
      const rawCaption = msg.caption || '';
      if (DIRECT_SAVE_RE.test(rawCaption)) {
        const destPath = parseDirectSavePath(rawCaption, filename);
        const result = yadiskDirs.saveFile(cacheKey, destPath);
        if (result.error) {
          await bot.sendMessage(chatId, `❌ Не удалось сохранить: ${result.error}`);
        } else {
          await bot.sendMessage(chatId, `✅ Сохранено: ${result.path} (${sizeKb} КБ)`);
        }
        return;
      }

      const { parseAttachment } = require('./lib/attachments');
      const parsedText = await parseAttachment(buffer, mimeType, filename);
      const captionNote = rawCaption ? `\nКомментарий к файлу: ${rawCaption}` : '';

      const fileHeader = `Получен файл «${filename}» (${mimeType}, ${sizeKb} КБ).${captionNote}\n[file_cache_key: ${cacheKey}]\n`;

      if (parsedText.startsWith('[Ошибка') || parsedText.startsWith('[Неподдерживаемый')) {
        // Файл нельзя прочитать как текст, но Claude может его сохранить на диск
        userText = `${fileHeader}\nСодержимое файла недоступно: ${parsedText}\nЕсли нужно — можешь сохранить файл на Яндекс.Диск через инструмент save_file.`;
      } else {
        userText = `${fileHeader}\nСодержимое файла:\n\n${parsedText}`;
      }
    } else {
      return; // Ignore unsupported message types
    }

    await bot.sendChatAction(chatId, 'typing');

    requestType = msg.voice ? 'voice' : 'text';
    const reply = await askClaude(userText, requestType);

    // Send voice if: user sent voice and reply is short, OR user explicitly asked for voice
    const wantsVoice = msg.voice && reply.length < 500
      || /ответь голосовым|ответь голосом|скажи голосом/i.test(userText);
    if (wantsVoice) {
      try {
        await bot.sendChatAction(chatId, 'record_voice');
        const audio = await whisper.tts(reply);
        await bot.sendVoice(chatId, audio, {}, { filename: 'voice.mp3', contentType: 'audio/mpeg' });
        return;
      } catch (ttsErr) {
        console.error('[TTS] Error, falling back to text:', ttsErr.message);
      }
    }

    // Split long messages at Telegram's 4096 char limit
    await sendLongMessage(chatId, reply);

  } catch (err) {
    console.error('[Snezhanna] Error:', err.message);

    if (isRateLimitError(err) && userText) {
      // Сообщаем, что попробуем позже
      await bot.sendMessage(chatId,
        'Вов, сейчас небольшой перелимит запросов к Claude — подожди 2 минуты, попробую ещё раз и сразу вернусь к тебе 🕐'
      ).catch(() => {});

      // История уже откачена внутри askClaude — просто ждём и повторяем
      await new Promise(resolve => setTimeout(resolve, 2 * 60 * 1000));

      try {
        console.log('[Snezhanna] Retrying after rate limit...');
        const retryReply = await askClaude(userText, requestType);
        await sendLongMessage(chatId, retryReply);
      } catch (retryErr) {
        console.error('[Snezhanna] Retry failed:', retryErr.message);
        await bot.sendMessage(chatId, `Вов, ${formatErrorForUser(retryErr)}`).catch(() => {});
      }
    } else {
      await bot.sendMessage(chatId, `Вов, ${formatErrorForUser(err)}`).catch(() => {});
    }
  }
});

// ── Photo handler ─────────────────────────────────────────────────────────────

bot.on('photo', async (msg) => {
  if (!isAllowed(msg)) return;
  if (chatMonitor.isMonitored(msg.chat.id)) return;
  if (appState.chatId && String(msg.chat.id) !== String(appState.chatId)) return;

  const chatId = msg.chat.id;

  try {
    await bot.sendChatAction(chatId, 'typing');

    // Get largest photo (last in array)
    const photo = msg.photo[msg.photo.length - 1];
    const { base64, mime_type } = await vision.downloadTelegramPhoto(
      bot, photo.file_id, process.env.TELEGRAM_BOT_TOKEN
    );

    const caption = msg.caption || '';
    const content = vision.buildPhotoMessage(base64, mime_type, caption || 'Что на этом фото?');

    const reply = await askClaude(content, 'photo');

    // Replace base64-heavy content in history with a lightweight placeholder
    const lastUserIdx = history.findLastIndex(h => h.role === 'user');
    if (lastUserIdx !== -1) {
      history[lastUserIdx] = { role: 'user', content: vision.photoPlaceholder(caption) };
    }

    await sendLongMessage(chatId, reply);
  } catch (err) {
    console.error('[Snezhanna] Photo error:', err.message);
    await bot.sendMessage(chatId, `Вов, ${formatErrorForUser(err)}`).catch(() => {});
  }
});

// ── Business connection & checklist ───────────────────────────────────────────

bot.on('business_connection', (connection) => {
  if (connection.user && String(connection.user.id) === ALLOWED) {
    appState.businessConnectionId = connection.id;
    state.save(appState);
    console.log('[Snezhanna] Saved businessConnectionId:', connection.id);
  }
});

bot.on('message', async (msg) => {
  if (!isAllowed(msg)) return;
  if (!msg.checklist_tasks_done) return;

  try {
    const todayTasks = tasks.getTodayTasks();
    const doneIds = msg.checklist_tasks_done;
    let completed = 0;
    for (const doneId of doneIds) {
      // Map checklist position back to task
      const idx = doneId - 1;
      if (idx >= 0 && idx < todayTasks.length) {
        tasks.completeTask({ id: todayTasks[idx].id, project: todayTasks[idx].project });
        completed++;
      }
    }
    if (completed > 0) {
      console.log(`[Snezhanna] Completed ${completed} tasks via checklist`);
    }
  } catch (e) {
    console.error('[Snezhanna] checklist_tasks_done error:', e.message);
  }
});

// ── Chat Monitor handlers ─────────────────────────────────────────────────────

bot.on('message', (msg) => {
  if (msg.chat.type !== 'group' && msg.chat.type !== 'supergroup') return;
  if (!chatMonitor.isMonitored(msg.chat.id)) return;
  if (!msg.text) return;

  const from = msg.from?.first_name || msg.from?.username || 'Unknown';
  chatMonitor.addMessage(msg.chat.id, from, msg.text, msg.date);
});

bot.on('business_message', (msg) => {
  if (!chatMonitor.isMonitored(msg.chat.id)) return;
  if (!msg.text) return;

  const from = msg.from?.first_name || msg.from?.username || 'Unknown';
  chatMonitor.addMessage(msg.chat.id, from, msg.text, msg.date);
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

// ── File helpers ──────────────────────────────────────────────────────────

// Ключевые слова, которые означают "сохрани файл как есть, без парсинга"
const DIRECT_SAVE_RE = /^(сохрани|положи|скинь|save)\b/i;

// Вытаскивает путь назначения из подписи к файлу.
// "сохрани в drafts/план.pdf" → "drafts/план.pdf"
// "положи в projects/X/docs" → "projects/X/docs/<filename>"
// "сохрани" → "inbox/<filename>"
function parseDirectSavePath(caption, filename) {
  const withoutKeyword = caption.replace(DIRECT_SAVE_RE, '').trim();
  // Убираем предлог "в" / "в папку" / "to"
  const pathPart = withoutKeyword.replace(/^(в папку|в|to)\s+/i, '').trim();
  if (!pathPart) {
    return `inbox/${filename}`;
  }
  // Если путь заканчивается на имя файла с расширением — используем как есть
  if (/\.\w{1,10}$/.test(pathPart)) {
    return pathPart;
  }
  // Иначе — это папка, добавляем имя файла
  return `${pathPart}/${filename}`;
}

// ── Helpers ───────────────────────────────────────────────────────────────

async function sendLongMessage(chatId, text) {
  // Hard block: never write to any chat except Vova's
  if (appState.chatId && String(chatId) !== String(appState.chatId)) {
    console.error(`[SECURITY] sendLongMessage blocked for chat ${chatId}`);
    return;
  }
  const MAX = 4096;
  if (text.length <= MAX) {
    await bot.sendMessage(chatId, text);
    return;
  }
  // Split at paragraph boundaries
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

// ── Task formatting ──────────────────────────────────────────────────────────

function formatTasksForBriefing(taskList) {
  if (!taskList || taskList.length === 0) return '• Задач нет';

  const today = new Date().toLocaleDateString('sv-SE', { timeZone: config.timezone });

  const quadrants = [
    { emoji: '🔴', label: 'Срочные + важные', items: [] },
    { emoji: '🟡', label: 'Срочные',           items: [] },
    { emoji: '🔵', label: 'Важные',             items: [] },
    { emoji: '⚪', label: 'Бэклог',             items: [] },
  ];

  for (const t of taskList) {
    const proj = t.project ? ` [${t.project}]` : '';
    let dateStr = '';
    if (t.due_date) {
      if (t.due_date < today)       dateStr = ' ⚠️ просрочено';
      else if (t.due_date === today) dateStr = ' — сегодня';
      else {
        const [, mm, dd] = t.due_date.split('-');
        dateStr = ` — ${dd}.${mm}`;
      }
    }
    const line = `• ${t.title}${proj}${dateStr}`;
    if      (t.urgent && t.important)  quadrants[0].items.push(line);
    else if (t.urgent)                 quadrants[1].items.push(line);
    else if (t.important)              quadrants[2].items.push(line);
    else                               quadrants[3].items.push(line);
  }

  return quadrants
    .filter(q => q.items.length > 0)
    .map(q => `${q.emoji} ${q.label}:\n${q.items.join('\n')}`)
    .join('\n\n');
}

// ── Scheduled tasks ───────────────────────────────────────────────────────────

function setupSchedules() {
  // Morning briefing — 08:00 Madrid
  cron.schedule('0 8 * * *', async () => {
    if (!appState.chatId) return;
    console.log('[Schedule] morning_briefing fired');
    try {
      let eventsText = '• Событий нет';
      if (google.isAuthorized()) {
        const events = await google.getCalendarEvents(1);
        if (events.length > 0) {
          eventsText = events.map(e => `• ${e.summary} (${formatEventTime(e)})`).join('\n');
        }
      }
      let tasksText = '• Задач нет';
      try {
        const todayTasks = tasks.getTodayTasks();
        tasksText = formatTasksForBriefing(todayTasks);
      } catch (e) {
        console.error('[Schedule] Failed to load tasks for briefing:', e.message);
      }

      let githubText = '';
      if (github.isConfigured()) {
        try {
          const issues = await github.getAllOpenIssues();
          if (issues.length > 0) {
            githubText = '\n\nОткрытые GitHub Issues:\n' +
              issues.map(i => {
                const proj = i.project ? ` [${i.project}]` : ` [${i.repo}]`;
                return `• #${i.id} ${i.title}${proj}`;
              }).join('\n');
          }
        } catch (e) {
          console.error('[Schedule] Failed to load github issues for briefing:', e.message);
        }
      }

      const prompt = `Составь утренний брифинг для Вовочки. Сегодня ${todayStr()}.
События в Calendar:
${eventsText}

Задачи на ближайшие дни (уже отсортированы по приоритету — вставь их точно в таком виде, без таблиц и переформатирования):
${tasksText}${githubText}

Кратко прокомментируй день и выдели 1-2 самые важные вещи. Будь живым и тёплым.`;
      let briefingText = await askClaudeOneShot(prompt);

      // Overload coach block (only when last score ≤ 5)
      try {
        const lastScore = workload.getLastScore();
        if (lastScore !== null && lastScore <= 5) {
          let todayEvents = [];
          let tomorrowEvents = [];
          if (google.isAuthorized()) {
            const allEvents = await google.getCalendarEvents(2);
            const todayDate = new Date().toLocaleDateString('sv-SE', { timeZone: config.timezone });
            const tmrw = new Date();
            tmrw.setDate(tmrw.getDate() + 1);
            const tmrwDate = tmrw.toLocaleDateString('sv-SE', { timeZone: config.timezone });
            todayEvents = allEvents.filter(e => {
              const d = new Date(e.start.dateTime || e.start.date);
              return d.toLocaleDateString('sv-SE', { timeZone: config.timezone }) === todayDate;
            });
            tomorrowEvents = allEvents.filter(e => {
              const d = new Date(e.start.dateTime || e.start.date);
              return d.toLocaleDateString('sv-SE', { timeZone: config.timezone }) === tmrwDate;
            });
          }
          let openTasks = [];
          try { openTasks = tasks.getTodayTasks(); } catch (_) {}
          const overloadBlock = await workload.buildOverloadBlock(lastScore, todayEvents, tomorrowEvents, openTasks);
          if (overloadBlock) {
            briefingText += '\n\n---\n\n' + overloadBlock;
          }
        }
      } catch (e) {
        console.error('[Schedule] overload_block error:', e.message);
      }

      await sendToVova(briefingText);
      console.log('[Schedule] morning_briefing done');
    } catch (e) {
      console.error('[Schedule] morning_briefing error:', e.message);
    }
  }, { timezone: config.timezone });

  // Evening check-in — 19:00 Madrid
  cron.schedule('0 19 * * *', async () => {
    if (!appState.chatId) return;
    console.log('[Schedule] evening_checkin fired');
    try {
      let eventsText = '• Событий нет';
      if (google.isAuthorized()) {
        const events = await google.getCalendarEvents(2);
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        // Сравниваем даты в Madrid-timezone, иначе события около полуночи попадают не в тот день
        const tomorrowStr = tomorrow.toLocaleDateString('sv-SE', { timeZone: config.timezone });
        const tomorrowEvents = events.filter(e => {
          const d = new Date(e.start.dateTime || e.start.date);
          return d.toLocaleDateString('sv-SE', { timeZone: config.timezone }) === tomorrowStr;
        });
        if (tomorrowEvents.length > 0) {
          eventsText = tomorrowEvents.map(e => `• ${e.summary} (${formatEventTime(e)})`).join('\n');
        }
      }

      const diskSummary = diskLog.getSummary();
      const diskSection = diskSummary
        ? `\nДействия с Яндекс.Диском за сегодня (${diskLog.getCount()} операций):\n${diskSummary}`
        : '\nДействий с Яндекс.Диском сегодня не было.';

      const chatDigest = chatMonitor.getDigest();
      const chatSection = chatDigest
        ? `\nСообщения из чатов за сегодня:\n${chatDigest}\n\nПроанализируй дайджест чатов: для рабочих — выдели задачи, решения, вопросы требующие внимания; для личных — важные моменты и планы.`
        : '\nНовых сообщений в отслеживаемых чатах не было.';

      const prompt = `Сделай вечерний чек-ин для Вовочки. Спроси как прошёл день.
Завтра в Calendar:
${eventsText}
${diskSection}
${chatSection}`;
      const reply = await askClaudeOneShot(prompt);
      await sendToVova(reply);
      diskLog.clear();
      chatMonitor.clear();

      // Send native Telegram checklist if business connection is active
      try {
        const todayTasks = tasks.getTodayTasks();
        if (todayTasks.length > 0 && appState.businessConnectionId) {
          await bot.sendChecklist(appState.businessConnectionId, appState.chatId, {
            title: 'Задачи на сегодня',
            tasks: todayTasks.map((t, i) => ({ id: i + 1, text: t.title }))
          });
        }
      } catch (checklistErr) {
        console.error('[Schedule] checklist send error:', checklistErr.message);
      }
      console.log('[Schedule] evening_checkin done');
    } catch (e) {
      console.error('[Schedule] evening_checkin error:', e.message);
    }
  }, { timezone: config.timezone });

  // Workload weekly check-in — Monday 09:00 Madrid
  cron.schedule('0 9 * * 1', async () => {
    if (!appState.chatId) return;
    console.log('[Schedule] workload_checkin fired');
    try {
      const checkinMsg = `Вов, понедельничный чек-ин 📋\n\nОтветь коротко (можно одним сообщением):\n\n1. Как ощущается эта неделя в целом — потянул или нет?\n2. Было ли время с семьёй / детьми?\n3. Как со сном и энергией?\n4. Было ли что-то личное — хобби, отдых, своё время?`;
      await sendToVova(checkinMsg);

      appState.awaitingWorkloadCheckin = { active: true, timestamp: Date.now() };
      state.save(appState);

      // 30-minute timeout: run scoring without checkin if no response
      workloadCheckinTimeout = setTimeout(async () => {
        if (!appState.awaitingWorkloadCheckin || !appState.awaitingWorkloadCheckin.active) return;
        console.log('[Workload] Checkin timeout — running scoring without response');
        appState.awaitingWorkloadCheckin = null;
        state.save(appState);
        workloadCheckinTimeout = null;
        try {
          const data = await workload.collectData();
          const scoring = await workload.runScoring(data, null);
          const history = workload.loadHistory();
          const entry = {
            date: new Date().toLocaleDateString('sv-SE', { timeZone: config.timezone }),
            overall_score: scoring.overall_score,
            domains: {
              work: scoring.domains.work.score,
              family: scoring.domains.family.score,
              health: scoring.domains.health.score,
              personal: scoring.domains.personal.score
            },
            trend: scoring.trend,
            checkin_provided: false,
            key_risks: scoring.key_risks,
            suggestions: scoring.suggestions
          };
          workload.saveHistory(history, entry);
          const report = workload.buildWeeklyReport(scoring, history);
          await sendToVova(report);
        } catch (e) {
          console.error('[Workload] Timeout scoring error:', e.message);
        }
      }, 30 * 60 * 1000);
    } catch (e) {
      console.error('[Schedule] workload_checkin error:', e.message);
    }
  }, { timezone: config.timezone });

  // Strava sync — Sunday 09:30 Madrid (before weekly digest)
  cron.schedule('30 9 * * 0', async () => {
    if (!strava.isConfigured()) return;
    console.log('[Schedule] strava_sync fired');
    try {
      const result = await strava.syncCurrentWeek();
      if (result) {
        console.log(`[Schedule] Strava sync done: ${result.weekStr}, ${result.activities.length} activities`);
      }
    } catch (e) {
      console.error('[Schedule] strava_sync error:', e.message);
    }
  }, { timezone: config.timezone });

  // Weekly digest — Sunday 10:00 Madrid
  cron.schedule('0 10 * * 0', async () => {
    if (!appState.chatId) return;
    console.log('[Schedule] weekly_digest fired');
    try {
      let fitnessBlock = '';
      try {
        const block = strava.buildDigestFitnessBlock();
        if (block) {
          fitnessBlock = `\n\n--- ФИТНЕС-БЛОК (Strava) ---\n${block}\n--- КОНЕЦ ФИТНЕС-БЛОКА ---`;
        }
      } catch (e) {
        console.error('[Schedule] Strava fitness block error:', e.message);
      }

      const prompt = `Составь воскресный еженедельный дайджест для Вовочки.
Включи: краткий обзор прошедшей недели, что важного на следующей неделе, бюрократические дедлайны.${fitnessBlock}`;
      const reply = await askClaudeOneShot(prompt);
      await sendToVova(reply);
      console.log('[Schedule] weekly_digest done');
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
      console.error('[Schedule] calendar_reminder error:', e.message);
    }
  });

  // Email check — every 30 minutes
  const MAX_EMAIL_DIGEST_SEEN = 2000;
  function trimEmailDigestSeenIds(ids) {
    if (ids.length <= MAX_EMAIL_DIGEST_SEEN) return ids;
    return ids.slice(ids.length - MAX_EMAIL_DIGEST_SEEN);
  }
  function persistEmailDigestSeen(seenSet) {
    appState.emailDigestSeenIds = trimEmailDigestSeenIds([...seenSet]);
    state.save(appState);
  }

  cron.schedule('*/30 * * * *', async () => {
    if (!appState.chatId || !google.isAuthorized()) return;
    try {
      const messages = await google.getGmailMessages(20, true);
      const seenEmailIds = new Set(appState.emailDigestSeenIds || []);

      // Только при самой первой установке (пустой state): запоминаем хвост непрочитанного без спама в чат
      if (!appState.emailDigestBootstrapped) {
        messages.forEach((m) => seenEmailIds.add(m.id));
        appState.emailDigestBootstrapped = true;
        persistEmailDigestSeen(seenEmailIds);
        console.log(`[Schedule] email_check bootstrap: seeded ${messages.length} existing unread email(s), no digest`);
        return;
      }

      const newMessages = messages.filter((m) => !seenEmailIds.has(m.id));
      if (newMessages.length === 0) return;

      console.log(`[Schedule] email_check: ${newMessages.length} new unread email(s)`);

      // Полный текст (getMessageById помечает как прочитанное). ID в seen — только после успешной загрузки,
      // иначе следующий тик повторит попытку.
      const fullMessages = [];
      for (const m of newMessages.slice(0, 10)) {
        try {
          const full = await google.getMessageById(m.id);
          fullMessages.push(full);
          seenEmailIds.add(m.id);
        } catch (e) {
          console.error('[Schedule] email_check: failed to get message', m.id, e.message);
        }
      }

      if (fullMessages.length === 0) return;

      const emailsText = fullMessages.map((m, i) =>
        `--- Письмо ${i + 1} ---\nОт: ${m.from}\nКому: ${m.to}\nТема: ${m.subject}\nДата: ${m.date}\n\n${m.body.slice(0, 2000)}`
      ).join('\n\n');

      const prompt = `Пришли новые письма на почту (${fullMessages.length} шт.). \
Проанализируй каждое и составь краткий дайджест для Вовы. \
Для каждого письма укажи:
- Тип: 📋 Задача / 📅 Событие / 📁 Проектный апдейт / ℹ️ Инфо / 🗑 Спам
- Суть в 1–2 предложениях
- Что нужно сделать (если нужно)

Письма, требующие действий, — вынеси первыми. Не добавляй лишней воды.

${emailsText}`;

      const reply = await askClaudeOneShot(prompt);
      await sendToVova(reply);
      persistEmailDigestSeen(seenEmailIds);
    } catch (e) {
      console.error('[Schedule] email_check error:', e.message);
    }
  }, { timezone: config.timezone });

  console.log('[Snezhanna] Schedules initialized (timezone: Europe/Madrid)');
}

// ── Startup ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('[Snezhanna] Starting...');

  yadiskDirs.ensureDirs();
  api.start();
  setupSchedules();

  if (appState.chatId) {
    try {
      await sendToVova('Вов, я онлайн! 🦞');
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
