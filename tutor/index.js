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

// ── Commands ──────────────────────────────────────────────────────────────────

async function handleCommand(msg, text) {
  const chatId = msg.chat.id;

  if (text === '/done' || text === '/fin') {
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
    let msg = '📋 Tu horario:\n';
    for (const day of WEEKDAYS) {
      const lessons = schedule[day] || [];
      msg += `\n**${WEEKDAY_LABELS[day]}:** ${lessons.join(', ')}`;
    }
    await bot.sendMessage(chatId, msg);
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
    let msg = '📝 Deberes pendientes:\n';
    for (const t of pending) {
      msg += `\n• ${t.subject}: ${t.description}${t.due ? ` (para ${t.due})` : ''}`;
    }
    await bot.sendMessage(chatId, msg);
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

    // Add to session + send to Claude
    session.addMessage('user', text);
    await bot.sendChatAction(chatId, 'typing');

    const history = session.getHistory();
    const context = session.getContext();
    const reply = await askMax(history, context);

    session.addMessage('assistant', reply);
    await sendLongMessage(chatId, reply);

  } catch (err) {
    console.error('[Max] Error:', err.message);
    await bot.sendMessage(chatId, formatErrorForUser(err)).catch(() => {});
  }
});

// ── Photo handler ─────────────────────────────────────────────────────────────

bot.on('photo', async (msg) => {
  if (!isAllowed(msg)) return;

  const chatId = msg.chat.id;

  if (!appState.chatId) {
    appState.chatId = chatId;
    saveState();
  }

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
});

// ── Voice handler ─────────────────────────────────────────────────────────────

bot.on('voice', async (msg) => {
  if (!isAllowed(msg)) return;

  const chatId = msg.chat.id;

  if (!appState.chatId) {
    appState.chatId = chatId;
    saveState();
  }

  try {
    await bot.sendChatAction(chatId, 'typing');

    const file = await bot.getFile(msg.voice.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${process.env.TUTOR_BOT_TOKEN}/${file.file_path}`;
    const audioRes = await axios.get(fileUrl, { responseType: 'arraybuffer' });
    const text = await whisper.transcribe(Buffer.from(audioRes.data), 'voice.ogg', 'es');

    await bot.sendMessage(chatId, `🎤 _"${text}"_`, { parse_mode: 'Markdown' });

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

    session.addMessage('user', text);

    const history = session.getHistory();
    const context = session.getContext();
    const reply = await askMax(history, context);

    session.addMessage('assistant', reply);
    await sendLongMessage(chatId, reply);

  } catch (err) {
    console.error('[Max] Voice error:', err.message);
    await bot.sendMessage(chatId, formatErrorForUser(err)).catch(() => {});
  }
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
    sendLongMessage
  });

  if (appState.chatId) {
    try {
      await bot.sendMessage(appState.chatId, '¡Hola! 👋 Soy Max, tu ayudante de estudio. ¿Empezamos?');
      console.log('[Max] Startup message sent to chatId:', appState.chatId);
    } catch (e) {
      console.error('[Max] Failed to send startup message:', e.message);
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
