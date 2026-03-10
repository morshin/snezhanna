'use strict';

require('dotenv').config({ path: '/opt/snezhanna/.env' });

const fs = require('fs');
const path = require('path');
const axios = require('axios');

const { bot, ALLOWED, isAllowed, sendLongMessage } = require('./lib/telegram');
const { askMax, askMaxOneShot } = require('./lib/claude');
const session = require('./lib/session');
const storage = require('./lib/storage');
const report = require('./lib/report');
const { setupSchedules } = require('./schedules/crons');
const vision = require('../lib/vision');
const whisper = require('../lib/whisper');

// ── State ─────────────────────────────────────────────────────────────────────

const STATE_FILE = path.join(__dirname, '.tutor-state.json');
let appState = { chatId: null };

// Флаг: бот ждёт ответа на вопрос "Что задали?" (15:00 чекин)
let awaitingHomework = false;

function setAwaitingHomework(value) {
  awaitingHomework = value;
  console.log('[Max] awaitingHomework =', value);
}

// C-4: мьютекс на обработку входящих сообщений — предотвращает гонку при быстрой отправке
// Для каждого chatId держим цепочку промисов: новое сообщение ждёт пока предыдущее не обработается
const processingLocks = new Map();

async function withLock(chatId, fn) {
  const prev = processingLocks.get(chatId) || Promise.resolve();
  let release;
  const current = new Promise(resolve => { release = resolve; });
  processingLocks.set(chatId, current);
  try {
    await prev;
    return await fn();
  } finally {
    release();
  }
}

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      appState = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('[Max] Failed to load state:', e.message);
  }
}

function saveState() {
  fs.writeFileSync(STATE_FILE, JSON.stringify(appState, null, 2), 'utf8');
}

function getChatId() {
  return appState.chatId;
}

// ── Onboarding ────────────────────────────────────────────────────────────────

const WEEKDAYS = ['lunes', 'martes', 'miércoles', 'jueves', 'viernes'];
const WEEKDAY_LABELS = {
  lunes: 'LUNES', martes: 'MARTES', miércoles: 'MIÉRCOLES',
  jueves: 'JUEVES', viernes: 'VIERNES'
};

let onboarding = null; // { step: 0..4, schedule: {} }

function startOnboarding() {
  onboarding = { step: 0, schedule: {} };
  return `¡Hola! Soy Max 👋 Voy a ser tu ayudante de estudios.\nPrimero necesito saber tu horario escolar.\n¿Qué clases tienes los ${WEEKDAY_LABELS[WEEKDAYS[0]]}? Dímelas todas en orden 📋`;
}

async function handleOnboarding(text) {
  const day = WEEKDAYS[onboarding.step];

  // Parse subjects from user text using Claude
  const parsed = await askMaxOneShot(
    'Eres un parser. El alumno te dice sus asignaturas del día. Devuelve SOLO un JSON array de strings con los nombres de las asignaturas en español correcto (con mayúscula). Ejemplo: ["Matemáticas", "Lengua", "Inglés"]. Sin explicaciones, solo el JSON array.',
    `Asignaturas para ${day}: "${text}"`
  );

  let subjects;
  try {
    // Extract JSON array from response
    const match = parsed.match(/\[[\s\S]*?\]/);
    subjects = match ? JSON.parse(match[0]) : [text];
  } catch (e) {
    subjects = text.split(/[,;]+/).map(s => s.trim()).filter(Boolean);
  }

  onboarding.schedule[day] = subjects;
  onboarding.step++;

  if (onboarding.step < WEEKDAYS.length) {
    const nextDay = WEEKDAYS[onboarding.step];
    return `Perfecto ✅ ¿Y los ${WEEKDAY_LABELS[nextDay]}?`;
  }

  // All days collected — save
  storage.saveSchedule(onboarding.schedule);
  onboarding = null;

  return '¡Listo! Ya tengo tu horario guardado 🎉\nA partir de hoy, a las 15:00 te preguntaré cómo fue el día y qué deberes tienes. ¿Alguna pregunta?';
}

// ── Error formatting ──────────────────────────────────────────────────────────

function formatErrorForUser(err) {
  const raw = err.message || '';
  const statusMatch = raw.match(/^(\d{3})\s+(\{.*\})$/s);
  if (statusMatch) {
    const status = parseInt(statusMatch[1], 10);
    if (status === 529) return '¡Uy! Los servidores están un poco ocupados. Intenta en un minuto 🙏';
    if (status === 429) return '¡Demasiadas preguntas! Espera un poco y vuelve a intentar 🕐';
    if (status >= 500) return 'Algo se rompió por allí. Intenta de nuevo en un momento 🛠';
  }
  if (raw.includes('ECONNREFUSED') || raw.includes('ENOTFOUND') || raw.includes('ETIMEDOUT')) {
    return 'Problemas de conexión 📡 Intenta de nuevo.';
  }
  return 'Algo salió mal. Intenta de nuevo.';
}

// ── Homework parsing ──────────────────────────────────────────────────────────

// Вызывается один раз после того как ученик ответил на вопрос "Что задали?"
// Парсит ответ через Claude и сохраняет задания в homework.json
async function parseAndSaveHomework(text) {
  const todayStr = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Madrid' });
  const tomorrowDate = new Date();
  tomorrowDate.setDate(tomorrowDate.getDate() + 1);
  const tomorrowStr = tomorrowDate.toLocaleDateString('sv-SE', { timeZone: 'Europe/Madrid' });

  const parsed = await askMaxOneShot(
    `Eres un parser de deberes escolares. El alumno acaba de decir qué deberes tiene hoy.
Extrae TODOS los deberes mencionados y devuelve SOLO un JSON array (sin texto extra).
Cada tarea debe tener: {"subject": "Nombre de la asignatura", "description": "Qué hay que hacer", "due": "YYYY-MM-DD o vacío si no se menciona"}.
Si no hay deberes ("nada", "no tengo", etc.), devuelve un array vacío: [].
Hoy es ${todayStr}. Cuando diga "mañana" = ${tomorrowStr}.`,
    `El alumno dice: "${text}"`
  );

  let tasks = [];
  try {
    const match = parsed.match(/\[[\s\S]*\]/);
    tasks = match ? JSON.parse(match[0]) : [];
  } catch (e) {
    console.error('[Max] Failed to parse homework JSON:', e.message, '| raw:', parsed);
    tasks = [];
  }

  for (const task of tasks) {
    if (task.subject && task.description) {
      storage.addHomeworkTask(task);
    }
  }

  console.log(`[Max] Homework parsed: ${tasks.length} task(s) saved`);
  return tasks;
}

// Вырезает маркеры [DONE:hw_xxx] из ответа Claude и возвращает чистый текст + список ID
function extractDoneMarkers(text) {
  const doneIds = [];
  const cleanText = text.replace(/\[DONE:([^\]]+)\]/g, (_, id) => {
    doneIds.push(id.trim());
    return '';
  }).trim();
  return { cleanText, doneIds };
}

// ── Commands ──────────────────────────────────────────────────────────────────

async function handleCommand(msg, text) {
  const chatId = msg.chat.id;

  // L-3: /start — Telegram отправляет его автоматически при первом открытии бота
  if (text === '/start') {
    const schedule = storage.loadSchedule();
    if (!schedule) {
      const reply = startOnboarding();
      await sendLongMessage(chatId, reply);
    } else {
      await bot.sendMessage(chatId, '¡Hola! 👋 Soy Max, tu ayudante de estudios. ¿En qué te ayudo hoy?');
    }
    return true;
  }

  // H-3: добавлен /стоп из ТЗ
  if (text === '/done' || text === '/fin' || text === '/стоп') {
    if (!session.isActive()) {
      await bot.sendMessage(chatId, 'No hay sesión activa 🤷');
      return true;
    }
    const data = session.endSession();
    try {
      await bot.sendChatAction(chatId, 'typing');
      const summary = await report.generateSessionSummary(data);
      await sendLongMessage(chatId, '¡Buen trabajo! 💪 Aquí tienes el resumen:\n\n' + summary);
    } catch (e) {
      console.error('[Max] Failed to generate session summary:', e.message);
      await bot.sendMessage(chatId, '¡Sesión terminada! 💪 Hasta la próxima.');
    }
    return true;
  }

  if (text === '/reset') {
    if (session.isActive()) session.endSession();
    await bot.sendMessage(chatId, 'Historial borrado ✅');
    return true;
  }

  if (text === '/schedule' || text === '/horario') {
    const schedule = storage.loadSchedule();
    if (!schedule) {
      await bot.sendMessage(chatId, startOnboarding());
      return true;
    }
    // M-5: переименовано в scheduleText чтобы не затенять параметр msg функции
    let scheduleText = '📋 Tu horario:\n';
    for (const day of WEEKDAYS) {
      const lessons = schedule[day] || [];
      scheduleText += `\n**${WEEKDAY_LABELS[day]}:** ${lessons.join(', ')}`;
    }
    await bot.sendMessage(chatId, scheduleText);
    return true;
  }

  if (text === '/schedule reset' || text === '/horario reset') {
    await bot.sendMessage(chatId, startOnboarding());
    return true;
  }

  if (text === '/homework' || text === '/deberes') {
    const hw = storage.loadHomework();
    const pending = hw.tasks.filter(t => !t.done);
    if (pending.length === 0) {
      await bot.sendMessage(chatId, '¡No tienes deberes pendientes! 🎉');
      return true;
    }
    // M-5: переименовано в hwText чтобы не затенять параметр msg функции
    let hwText = '📝 Deberes pendientes:\n';
    for (const t of pending) {
      hwText += `\n• ${t.subject}: ${t.description}${t.due ? ` (para ${t.due})` : ''}`;
    }
    await bot.sendMessage(chatId, hwText);
    return true;
  }

  if (text === '/status') {
    const active = session.isActive() ? '✅ activa' : '❌ no';
    const schedule = storage.loadSchedule() ? '✅' : '❌ no configurado';
    const hw = storage.loadHomework();
    const pending = hw.tasks.filter(t => !t.done).length;
    await bot.sendMessage(chatId,
      `📊 Estado:\n• Sesión: ${active}\n• Horario: ${schedule}\n• Deberes pendientes: ${pending}\n• Max está funcionando 🟢`
    );
    return true;
  }

  return false;
}

// ── Message handler ───────────────────────────────────────────────────────────

bot.on('message', async (msg) => {
  if (!isAllowed(msg)) return;
  if (!msg.text) return; // voice/photo handled separately

  const chatId = msg.chat.id;

  // Persist chatId
  if (!appState.chatId) {
    appState.chatId = chatId;
    saveState();
    console.log('[Max] Saved chatId:', chatId);
  }

  const text = msg.text.trim();

  // C-4: мьютекс — обрабатываем сообщения строго последовательно
  await withLock(chatId, async () => {
  try {
    // Commands
    if (text.startsWith('/')) {
      const handled = await handleCommand(msg, text);
      if (handled) return;
    }

    // Onboarding flow
    if (onboarding) {
      await bot.sendChatAction(chatId, 'typing');
      const reply = await handleOnboarding(text);
      await sendLongMessage(chatId, reply);
      return;
    }

    // Check if schedule exists — if not, start onboarding
    if (!storage.loadSchedule()) {
      const reply = startOnboarding();
      await sendLongMessage(chatId, reply);
      return;
    }

    // Start session if not active
    if (!session.isActive()) {
      session.startSession('General');
    }

    // Если бот ждал ответа на "Что задали?" — парсим ДЗ из этого сообщения
    if (awaitingHomework) {
      awaitingHomework = false;
      try {
        const tasks = await parseAndSaveHomework(text);
        if (tasks.length > 0) {
          const taskList = tasks.map(t => `• ${t.subject}: ${t.description}${t.due ? ` (para el ${t.due})` : ''}`).join('\n');
          console.log('[Max] Homework saved, notifying Claude context');
          // Показываем подтверждение сохранения в лог, но не прерываем — Claude ответит сам
          session.addMessage('user', `[Sistema: se guardaron ${tasks.length} deber(es): ${taskList}]`);
        }
      } catch (e) {
        console.error('[Max] Homework parse error:', e.message);
      }
    }

    // Add to session + send to Claude
    session.addMessage('user', text);
    await bot.sendChatAction(chatId, 'typing');

    const history = session.getHistory();
    const context = session.getContext();
    const pending = storage.loadHomework().tasks.filter(t => !t.done);
    const reply = await askMax(history, context, pending);

    // Извлекаем маркеры выполненных ДЗ и отмечаем их в storage
    const { cleanText, doneIds } = extractDoneMarkers(reply);
    for (const id of doneIds) {
      storage.markHomeworkDone(id);
    }

    session.addMessage('assistant', cleanText);
    await sendLongMessage(chatId, cleanText);

  } catch (err) {
    console.error('[Max] Error:', err.message);
    await bot.sendMessage(chatId, formatErrorForUser(err)).catch(() => {});
  }
  }); // withLock
});

// ── Photo handler ─────────────────────────────────────────────────────────────

bot.on('photo', async (msg) => {
  if (!isAllowed(msg)) return;

  const chatId = msg.chat.id;

  if (!appState.chatId) {
    appState.chatId = chatId;
    saveState();
  }

  await withLock(chatId, async () => {
  try {
    await bot.sendChatAction(chatId, 'typing');

    const photo = msg.photo[msg.photo.length - 1];
    const { base64, mime_type } = await vision.downloadTelegramPhoto(
      bot, photo.file_id, process.env.TUTOR_BOT_TOKEN
    );

    const caption = msg.caption || '';

    // Start session if not active
    if (!session.isActive()) {
      session.startSession('General');
    }

    // Build message with photo for Claude
    const content = vision.buildPhotoMessage(base64, mime_type, caption || '¿Puedes ayudarme con esto?');
    const history = session.getHistory();
    const context = session.getContext();

    // Send to Claude with full photo
    const messagesForClaude = [
      ...history.map(m => ({ role: m.role, content: m.content })),
      { role: 'user', content }
    ];
    const reply = await askMax(messagesForClaude, context);

    // Store text placeholder in session, not base64
    session.addMessage('user', vision.photoPlaceholder(caption));
    session.addMessage('assistant', reply);

    await sendLongMessage(chatId, reply);
  } catch (err) {
    console.error('[Max] Photo error:', err.message);
    await bot.sendMessage(chatId, formatErrorForUser(err)).catch(() => {});
  }
  }); // withLock
});

// ── Voice handler ─────────────────────────────────────────────────────────────

bot.on('voice', async (msg) => {
  if (!isAllowed(msg)) return;

  const chatId = msg.chat.id;

  if (!appState.chatId) {
    appState.chatId = chatId;
    saveState();
  }

  await withLock(chatId, async () => {
  try {
    await bot.sendChatAction(chatId, 'typing');

    const file = await bot.getFile(msg.voice.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${process.env.TUTOR_BOT_TOKEN}/${file.file_path}`;
    const audioRes = await axios.get(fileUrl, { responseType: 'arraybuffer' });
    const text = await whisper.transcribe(Buffer.from(audioRes.data), 'voice.ogg', 'es');

    // M-4: без экранирования Markdown-символы в тексте транскрипции вызывают ошибку API
    const escapedText = text.replace(/[_*`\[]/g, '\\$&');
    await bot.sendMessage(chatId, `🎤 _"${escapedText}"_`, { parse_mode: 'Markdown' });

    // Check if schedule exists — if not, start onboarding
    if (onboarding) {
      const reply = await handleOnboarding(text);
      await sendLongMessage(chatId, reply);
      return;
    }

    if (!storage.loadSchedule()) {
      const reply = startOnboarding();
      await sendLongMessage(chatId, reply);
      return;
    }

    // Start session if not active
    if (!session.isActive()) {
      session.startSession('General');
    }

    // Если бот ждал ответа на "Что задали?" — парсим ДЗ из голосового
    if (awaitingHomework) {
      awaitingHomework = false;
      try {
        const tasks = await parseAndSaveHomework(text);
        if (tasks.length > 0) {
          const taskList = tasks.map(t => `• ${t.subject}: ${t.description}${t.due ? ` (para el ${t.due})` : ''}`).join('\n');
          session.addMessage('user', `[Sistema: se guardaron ${tasks.length} deber(es): ${taskList}]`);
        }
      } catch (e) {
        console.error('[Max] Homework parse error (voice):', e.message);
      }
    }

    session.addMessage('user', text);

    const history = session.getHistory();
    const context = session.getContext();
    const pending = storage.loadHomework().tasks.filter(t => !t.done);
    const reply = await askMax(history, context, pending);

    const { cleanText, doneIds } = extractDoneMarkers(reply);
    for (const id of doneIds) {
      storage.markHomeworkDone(id);
    }

    session.addMessage('assistant', cleanText);
    await sendLongMessage(chatId, cleanText);

  } catch (err) {
    console.error('[Max] Voice error:', err.message);
    await bot.sendMessage(chatId, formatErrorForUser(err)).catch(() => {});
  }
  }); // withLock
});

// ── Startup ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('[Max] Starting...');

  storage.ensureDirs();
  loadState();

  setupSchedules({
    bot,
    chatId: getChatId,
    storage,
    session,
    claude: { askMax, askMaxOneShot },
    report,
    sendLongMessage,
    setAwaitingHomework
  });

  if (appState.chatId) {
    // M-6: Жора может перезапускать сервис несколько раз — отправляем приветствие не чаще раза в 4 часа
    const STARTUP_COOLDOWN_MS = 4 * 60 * 60 * 1000;
    const lastSent = appState.lastStartupAt || 0;
    if (Date.now() - lastSent > STARTUP_COOLDOWN_MS) {
      try {
        await bot.sendMessage(appState.chatId, '¡Hola! 👋 Soy Max, tu ayudante de estudio. ¿Empezamos?');
        appState.lastStartupAt = Date.now();
        saveState();
        console.log('[Max] Startup message sent to chatId:', appState.chatId);
      } catch (e) {
        console.error('[Max] Failed to send startup message:', e.message);
      }
    } else {
      console.log('[Max] Startup message skipped (cooldown, last sent', Math.round((Date.now() - lastSent) / 60000), 'min ago)');
    }
  } else {
    console.log('[Max] No chatId saved — will save on first message');
  }

  console.log('[Max] Ready and listening.');
}

main().catch((e) => {
  console.error('[Max] Fatal error:', e);
  process.exit(1);
});
