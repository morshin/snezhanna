'use strict';

require('dotenv').config({ path: '/opt/snezhanna/.env' });

const fs = require('fs');
const path = require('path');
const axios = require('axios');

const { bot, ALLOWED, isAllowed, sendLongMessage } = require('./lib/telegram');
const { askMax, askMaxOneShot, askMaxOneShotWithImage, askParent } = require('./lib/claude');
const session = require('./lib/session');
const storage = require('./lib/storage');
const report = require('./lib/report');
const { setupSchedules } = require('./schedules/crons');
const langWeek = require('./lib/lang-week');
const vision = require('../lib/vision');
const whisper = require('../lib/whisper');
const { buildReplyContext } = require('../lib/reply-chain');

// ── State ─────────────────────────────────────────────────────────────────────

const STATE_FILE = path.join(__dirname, '.tutor-state.json');
let appState = { chatId: null };

// Флаг: бот ждёт ответа на вопрос "Что задали?" (15:00 чекин)
let awaitingHomework = false;

// Timestamp последнего напоминания о ДЗ (антиспам для hourly reminder)
let lastHomeworkReminder = null;

function setAwaitingHomework(value) {
  awaitingHomework = value;
  console.log('[Max] awaitingHomework =', value);
}

// Черновик нового квеста — многошаговый диалог с родителем
// step: 'subject' | 'description' | 'confirmation' | 'reward'
let parentQuestDraft = null;

// Черновик свободного /assign — ожидание подтверждения от родителя
// { tasks: [...], rawText: '...' }
let parentAssignDraft = null;

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
      // Восстанавливаем прогресс онбординга если был прерван перезапуском
      if (appState.onboardingInProgress) {
        onboarding = appState.onboardingInProgress;
        console.log('[Max] Restored onboarding from disk (step', onboarding.step, 'of', WEEKDAYS.length, ')');
      }
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
const WEEKDAY_LABELS_RU = {
  lunes: 'понедельник', martes: 'вторник', miércoles: 'среда',
  jueves: 'четверг', viernes: 'пятница'
};

function getDayLabel(day) {
  return langWeek.getCurrentLang() === 'ru' ? WEEKDAY_LABELS_RU[day] : WEEKDAY_LABELS[day];
}

// Двуязычные тексты онбординга
const OB = {
  intro: {
    es: (day) =>
      `¡Hola! Soy Max 👋 Voy a ser tu ayudante de estudios.\n` +
      `Primero necesito saber tu horario escolar.\n\n` +
      `¿Qué clases tienes los ${WEEKDAY_LABELS[day]}?\n` +
      `Escríbelas en orden, separadas por comas.\n` +
      `Ej: Matemáticas, Lengua, Inglés`,
    ru: (day) =>
      `Привет! Я Макс 👋 Буду твоим помощником по учёбе.\n` +
      `Сначала мне нужно твоё расписание.\n\n` +
      `Какие уроки у тебя в ${WEEKDAY_LABELS_RU[day]}?\n` +
      `Напиши по порядку через запятую.\n` +
      `Пример: Математика, Русский, Английский`
  },
  confirmed: {
    es: (dayLabel, list, nextLabel) =>
      `✅ ${dayLabel}:\n${list}\n\n` +
      `¿Y los ${nextLabel}?\n` +
      `Escríbelas en orden, separadas por comas.`,
    ru: (dayLabel, list, nextLabel) =>
      `✅ ${dayLabel}:\n${list}\n\n` +
      `Теперь ${nextLabel}:\n` +
      `Напиши по порядку через запятую.`
  },
  freeAndNext: {
    es: (dayLabel, nextLabel) =>
      `✅ ${dayLabel}: día libre\n\n` +
      `¿Y los ${nextLabel}?\n` +
      `Escríbelas en orden, separadas por comas.`,
    ru: (dayLabel, nextLabel) =>
      `✅ ${dayLabel}: выходной\n\n` +
      `Теперь ${nextLabel}:\n` +
      `Напиши по порядку через запятую.`
  },
  done: {
    es: (schedule) => {
      let text = '¡Listo! Ya tengo tu horario guardado 🎉\n\n📋 Tu horario:\n';
      for (const day of WEEKDAYS) {
        const lessons = schedule[day] || [];
        text += `\n${WEEKDAY_LABELS[day]}:`;
        if (lessons.length === 0) {
          text += ' libre';
        } else {
          lessons.forEach((l, i) => { text += `\n  ${i + 1}. ${l}`; });
        }
      }
      text += '\n\nA partir de hoy, a las 15:00 te preguntaré cómo fue el día y qué deberes tienes. ¿Alguna pregunta?';
      return text;
    },
    ru: (schedule) => {
      let text = 'Готово! Расписание сохранено 🎉\n\n📋 Твоё расписание:\n';
      for (const day of WEEKDAYS) {
        const lessons = schedule[day] || [];
        text += `\n${WEEKDAY_LABELS_RU[day].charAt(0).toUpperCase() + WEEKDAY_LABELS_RU[day].slice(1)}:`;
        if (lessons.length === 0) {
          text += ' выходной';
        } else {
          lessons.forEach((l, i) => { text += `\n  ${i + 1}. ${l}`; });
        }
      }
      text += '\n\nС сегодняшнего дня буду спрашивать в 15:00 как прошёл день и что задали. Вопросы есть?';
      return text;
    }
  }
};

// Паттерн для распознавания "выходной / нет уроков"
const FREE_DAY_RE = /^(libre|nada|no hay|no tengo clases?|выходной|нет уроков|нет|свободно|-)$/i;

let onboarding = null; // { step: 0..4, schedule: {} }

// Сохраняем/очищаем прогресс онбординга в appState на диске
function persistOnboarding() {
  appState.onboardingInProgress = onboarding;
  saveState();
}

function startOnboarding() {
  onboarding = { step: 0, schedule: {} };
  persistOnboarding();
  const lang = langWeek.getCurrentLang();
  return OB.intro[lang](WEEKDAYS[0]);
}

async function handleOnboarding(text) {
  const day = WEEKDAYS[onboarding.step];
  const lang = langWeek.getCurrentLang();
  const dayLabel = getDayLabel(day);

  let subjects;
  if (FREE_DAY_RE.test(text.trim())) {
    subjects = [];
  } else {
    const parsed = await askMaxOneShot(
      'Eres un parser. El alumno te dice sus asignaturas del día. Devuelve SOLO un JSON array de strings con los nombres de las asignaturas en español correcto (con mayúscula). Ejemplo: ["Matemáticas", "Lengua", "Inglés"]. Sin explicaciones, solo el JSON array.',
      `Asignaturas para ${day}: "${text}"`
    );
    try {
      const match = parsed.match(/\[[\s\S]*?\]/);
      subjects = match ? JSON.parse(match[0]) : [text];
    } catch (e) {
      subjects = text.split(/[,;]+/).map(s => s.trim()).filter(Boolean);
    }
  }

  onboarding.schedule[day] = subjects;
  onboarding.step++;
  persistOnboarding();

  if (onboarding.step < WEEKDAYS.length) {
    const nextDay = WEEKDAYS[onboarding.step];
    const nextLabel = getDayLabel(nextDay);
    if (subjects.length === 0) {
      return OB.freeAndNext[lang](dayLabel, nextLabel);
    }
    const numberedList = subjects.map((s, i) => `  ${i + 1}. ${s}`).join('\n');
    return OB.confirmed[lang](dayLabel, numberedList, nextLabel);
  }

  // Все дни собраны — сохраняем
  const savedSchedule = { ...onboarding.schedule };
  storage.saveSchedule(savedSchedule);
  onboarding = null;
  persistOnboarding();

  return OB.done[lang](savedSchedule);
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

// Вырезает маркеры [QUEST_DONE:quest_xxx] из ответа Claude
function extractQuestDoneMarkers(text) {
  const pattern = /\[QUEST_DONE:([^\]]+)\]/g;
  const questIds = [];
  let match;
  while ((match = pattern.exec(text)) !== null) questIds.push(match[1].trim());
  const cleanText = text.replace(/\[QUEST_DONE:[^\]]+\]/g, '').trim();
  return { cleanText, questIds };
}

// ── Quest dialog helpers ───────────────────────────────────────────────────────

async function refineQuestDescription(subject, rawDescription, previousRefined, clarification) {
  const subjectCtx = subject ? `Предмет: ${subject}.` : 'Без привязки к предмету.';
  let userPrompt;
  if (previousRefined && clarification) {
    userPrompt = `${subjectCtx}\nПредыдущий вариант задания: "${previousRefined}"\nУточнение от папы: "${clarification}"\nСформулируй новый улучшенный вариант.`;
  } else {
    userPrompt = `${subjectCtx}\nОписание от папы: "${rawDescription}"`;
  }
  return askMaxOneShot(
    'Ты помогаешь папе сформулировать учебный квест для сына (13 лет, испанская школа в Мадриде). ' +
    'Получив описание задания, напиши чёткое, конкретное, педагогически грамотное описание квеста на русском языке. ' +
    '1–3 предложения — только суть задания, без упоминания наград и без названия предмета. ' +
    'Не добавляй ничего лишнего — только текст задания.',
    userPrompt,
    'parent_quest_refine'
  );
}

const CONFIRM_RE = /^(да|ок|ладно|принять|принимаю|подтверждаю|yes|ok|хорошо|супер|отлично|годится|сойдёт|пойдёт)\.?$/i;
const REWARD_RE = /^\+?(\d+)\s*мин?\.?$/i;

// ── Day name mapping (Russian / Spanish shorthand → schedule.json key) ────────

const DAY_NAME_MAP = {
  'пн': 'lunes', 'понедельник': 'lunes', 'lunes': 'lunes', 'lun': 'lunes',
  'вт': 'martes', 'вторник': 'martes', 'martes': 'martes', 'mar': 'martes',
  'ср': 'miércoles', 'среда': 'miércoles', 'miércoles': 'miércoles', 'miercoles': 'miércoles', 'mié': 'miércoles', 'mie': 'miércoles',
  'чт': 'jueves', 'четверг': 'jueves', 'jueves': 'jueves', 'jue': 'jueves',
  'пт': 'viernes', 'пятница': 'viernes', 'viernes': 'viernes', 'vie': 'viernes'
};
const DAY_LABELS_RU_SHORT = { lunes: 'Пн', martes: 'Вт', miércoles: 'Ср', jueves: 'Чт', viernes: 'Пт' };

function resolveDayName(input) {
  return DAY_NAME_MAP[input.toLowerCase().trim()] || null;
}

// Черновик пошагового редактирования расписания родителем
// step: 0..4 (по числу дней), schedule: {}
let parentScheduleDraft = null;

// ── Parent helpers ─────────────────────────────────────────────────────────────

function isParent(msg) {
  const parentId = process.env.PARENT_CHAT_ID;
  if (!parentId) return false;
  return String(msg.from && msg.from.id) === String(parentId);
}

async function notifyParent(text) {
  const parentId = process.env.PARENT_CHAT_ID;
  if (!parentId) return;
  try {
    await bot.sendMessage(parentId, text);
  } catch (e) {
    console.error('[Max] Failed to notify parent:', e.message);
  }
}

function formatBalance(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h}ч ${m}мин (${minutes} мин)` : `${minutes} мин`;
}

function getISOWeekStr() {
  const now = new Date();
  const madridDateStr = now.toLocaleDateString('sv-SE', { timeZone: 'Europe/Madrid' });
  const d = new Date(madridDateStr + 'T12:00:00Z');
  const dayNum = (d.getUTCDay() || 7);
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

async function handleParentCommand(msg, text) {
  const parentId = process.env.PARENT_CHAT_ID;

  // ── Multi-step quest draft dialog ──────────────────────────────────────────
  if (parentQuestDraft) {
    const draft = parentQuestDraft;

    // Allow /cancelquest (or any slash command) to abort the draft
    if (text.startsWith('/') && text !== '/quest') {
      parentQuestDraft = null;
      console.log('[Max] Quest draft cancelled by command');
      // Fall through to normal command handling below
    } else if (draft.step === 'subject') {
      const raw = text.trim();
      draft.subject = /^(без предмета|нет|—|-|нет предмета|без)$/i.test(raw) ? '' : raw;
      draft.step = 'description';
      const promptText = draft.subject
        ? `Предмет: ${draft.subject}.\n\nОпиши задание подробнее — что именно должен сделать сын?`
        : 'Опиши задание — что именно должен сделать сын?';
      await bot.sendMessage(parentId, promptText);
      return;
    } else if (draft.step === 'description') {
      draft.rawDescription = text.trim();
      draft.step = 'confirmation';
      await bot.sendChatAction(parentId, 'typing');
      try {
        draft.refined = await refineQuestDescription(draft.subject, draft.rawDescription, null, null);
      } catch (e) {
        console.error('[Max] refineQuestDescription error:', e.message);
        draft.refined = draft.rawDescription;
      }
      const subjectLine = draft.subject ? `Предмет: ${draft.subject}\n` : '';
      await bot.sendMessage(parentId,
        `Предлагаю такое задание:\n\n${subjectLine}${draft.refined}\n\nПодтвердить? Или напиши уточнения.`
      );
      return;
    } else if (draft.step === 'confirmation') {
      if (CONFIRM_RE.test(text.trim())) {
        draft.step = 'reward';
        await bot.sendMessage(parentId, 'Задание принято! Сколько минут компьютерного времени за выполнение? (например: 30)');
      } else {
        // Clarification — re-refine
        await bot.sendChatAction(parentId, 'typing');
        try {
          draft.refined = await refineQuestDescription(draft.subject, draft.rawDescription, draft.refined, text.trim());
        } catch (e) {
          console.error('[Max] refineQuestDescription error:', e.message);
        }
        const subjectLine = draft.subject ? `Предмет: ${draft.subject}\n` : '';
        await bot.sendMessage(parentId,
          `Обновлённый вариант:\n\n${subjectLine}${draft.refined}\n\nПодтвердить? Или напиши ещё уточнения.`
        );
      }
      return;
    } else if (draft.step === 'reward') {
      const m = text.trim().match(REWARD_RE) || text.trim().match(/^(\d+)$/);
      if (!m) {
        await bot.sendMessage(parentId, 'Напиши число минут, например: 30 или +30мин');
        return;
      }
      const reward_minutes = parseInt(m[1], 10);
      const subject = draft.subject || 'Общее';
      const description = draft.refined;
      parentQuestDraft = null;
      const id = storage.addQuest({ subject, description, reward_minutes });
      if (session.isActive()) {
        session.addMessage('user', `[Sistema: el padre ha añadido una nueva misión ahora mismo: ${subject}: ${description} (+${reward_minutes} min). Anúnciasela al alumno en tu próxima respuesta.]`);
        console.log('[Max] Quest injected into active session:', id, subject);
      } else {
        const studentChatId = getChatId();
        if (studentChatId) {
          await bot.sendMessage(studentChatId,
            `¡Hola! Tu papá te ha asignado una nueva misión 🎯\n\n*${subject}*: ${description}\nRecompensa: +${reward_minutes} minutos de ordenador\n\n¿Cuándo estás listo para empezar?`,
            { parse_mode: 'Markdown' }
          );
          console.log('[Max] Quest announced to student:', id, subject);
        }
      }
      await bot.sendMessage(parentId,
        `🎯 Квест создан!\n\n${subject}: ${description}\nНаграда: +${reward_minutes} мин\n\n${getChatId() ? 'Макс уже написал сыну о квесте.' : 'Макс расскажет сыну о квесте при следующей сессии.'}`
      );
      console.log('[Max] Quest created via dialog:', id, subject);
      return;
    }
  }

  // ── Multi-step schedule reset dialog ────────────────────────────────────────
  if (parentScheduleDraft) {
    const draft = parentScheduleDraft;
    if (text.startsWith('/') && text !== '/resetschedule') {
      parentScheduleDraft = null;
      console.log('[Max] Schedule draft cancelled by command');
    } else {
      const day = WEEKDAYS[draft.step];
      const dayLabel = DAY_LABELS_RU_SHORT[day];
      const FREE_RE = /^(—|-|выходной|свободный|libre|nada|нет уроков|нет)$/i;
      let subjects;
      if (FREE_RE.test(text.trim())) {
        subjects = [];
      } else {
        await bot.sendChatAction(parentId, 'typing');
        try {
          const parsed = await askMaxOneShot(
            'Eres un parser. El padre te dice las asignaturas para un día. Devuelve SOLO un JSON array de strings con los nombres de las asignaturas en español correcto (con mayúscula). Ejemplo: ["Matemáticas", "Lengua", "Inglés"]. Sin explicaciones, solo el JSON array.',
            `Asignaturas: "${text}"`
          );
          const match = parsed.match(/\[[\s\S]*?\]/);
          subjects = match ? JSON.parse(match[0]) : text.split(/[,;]+/).map(s => s.trim()).filter(Boolean);
        } catch (e) {
          console.error('[Max] /resetschedule parse error:', e.message);
          subjects = text.split(/[,;]+/).map(s => s.trim()).filter(Boolean);
        }
      }
      draft.schedule[day] = subjects;
      draft.step++;
      const display = subjects.length > 0 ? subjects.join(', ') : '— (выходной)';
      if (draft.step < WEEKDAYS.length) {
        const nextDay = WEEKDAYS[draft.step];
        const nextLabel = DAY_LABELS_RU_SHORT[nextDay];
        await bot.sendMessage(parentId, `✅ ${dayLabel}: ${display}\n\nТеперь ${nextLabel} — напиши предметы через запятую (или «—» если выходной):`);
      } else {
        storage.saveSchedule(draft.schedule);
        parentScheduleDraft = null;
        let summary = `✅ ${dayLabel}: ${display}\n\n📅 Расписание сохранено:\n`;
        for (const d of WEEKDAYS) {
          const label = DAY_LABELS_RU_SHORT[d];
          const subjs = draft.schedule[d] || [];
          summary += `\n${label}: ${subjs.length > 0 ? subjs.join(', ') : '—'}`;
        }
        await bot.sendMessage(parentId, summary);
        console.log('[Max] Schedule fully reset by parent');
      }
      return;
    }
  }

  // ── Multi-step assign confirmation dialog ───────────────────────────────────
  if (parentAssignDraft) {
    const draft = parentAssignDraft;
    if (text.startsWith('/')) {
      parentAssignDraft = null;
      console.log('[Max] Assign draft cancelled by command');
    } else if (CONFIRM_RE.test(text.trim())) {
      const added = [];
      for (const task of draft.tasks) {
        const desc = task.description || task.description_es || task.description_ru;
        if (desc) {
          if (!task.description) {
            task.description = task.description_es && task.description_ru
              ? `${task.description_es} / ${task.description_ru}`
              : desc;
          }
          storage.addHomeworkTask(task);
          added.push(`• ${task.subject || 'General'}: ${task.description_ru || task.description}${task.due ? ` (до ${task.due})` : ''}`);
        }
      }
      parentAssignDraft = null;
      await bot.sendMessage(parentId, `✅ Сохранено ${added.length} задание(й):\n${added.join('\n')}`);
      console.log('[Max] Assign confirmed, saved', added.length, 'tasks');
      return;
    } else if (/^(нет|отмена|cancel|отменить)\.?$/i.test(text.trim())) {
      parentAssignDraft = null;
      await bot.sendMessage(parentId, 'Отменено. Можешь отправить /assign заново.');
      return;
    } else {
      await bot.sendChatAction(parentId, 'typing');
      const todayStr = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Madrid' });
      const tomorrowDate = new Date();
      tomorrowDate.setDate(tomorrowDate.getDate() + 1);
      const tomorrowStr = tomorrowDate.toLocaleDateString('sv-SE', { timeZone: 'Europe/Madrid' });
      try {
        const prevContext = draft.tasks.map((t, i) =>
          `${i + 1}. ${t.subject}: ES="${t.description_es || t.description}" / RU="${t.description_ru || ''}"${t.comment ? ` (${t.comment})` : ''}`
        ).join('\n');
        const parsed = await askMaxOneShot(
          `Eres un parser de deberes escolares. El padre revisa las tareas extraídas y envía correcciones.
Aplica las correcciones del padre a la lista de tareas y devuelve la lista actualizada como JSON array.
Cada tarea: {"subject": "Asignatura en español (con mayúscula)", "description_es": "Acción concreta en ESPAÑOL", "description_ru": "То же задание на РУССКОМ", "due": "YYYY-MM-DD o vacío", "comment": "Nota en RUSO si necesario, o vacío"}.
Si el padre dice eliminar una tarea — elimínala. Si dice cambiar algo — cámbialo. Si añade info — incorpórala.
Hoy es ${todayStr}. "mañana" = ${tomorrowStr}.`,
          `Tareas actuales:\n${prevContext}\n\nTexto original del que se extrajeron:\n"${draft.rawText.slice(0, 500)}"\n\nCorrección del padre: "${text.trim()}"`
        );
        const match = parsed.match(/\[[\s\S]*\]/);
        const tasks = match ? JSON.parse(match[0]) : draft.tasks;
        for (const t of tasks) {
          if (!t.description && (t.description_es || t.description_ru)) {
            t.description = t.description_es && t.description_ru
              ? `${t.description_es} / ${t.description_ru}`
              : (t.description_es || t.description_ru);
          }
        }
        draft.tasks = tasks;
        let preview = '📝 Обновлённый список:\n';
        tasks.forEach((t, i) => {
          preview += `\n${i + 1}. ${t.subject || 'General'}:`;
          preview += `\n   🇪🇸 ${t.description_es || t.description}`;
          preview += `\n   🇷🇺 ${t.description_ru || t.description}`;
          if (t.due) preview += `\n   📅 до ${t.due}`;
          if (t.comment) preview += `\n   💬 ${t.comment}`;
        });
        preview += '\n\nПодтвердить? Или напиши уточнения. /отмена — отменить.';
        await bot.sendMessage(parentId, preview);
      } catch (e) {
        console.error('[Max] Assign re-parse error:', e.message);
        await bot.sendMessage(parentId, 'Не удалось обработать уточнение. Подтвердить текущий вариант? Или /отмена.');
      }
      return;
    }
  }

  // /report — сессия за сегодня
  if (text === '/report') {
    const todayStr = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Madrid' });
    const sessionMd = storage.readSessionReport(todayStr);
    if (!sessionMd) {
      await bot.sendMessage(parentId, 'Сегодня сессий не было.');
    } else {
      await sendLongMessage(parentId, sessionMd);
    }
    return;
  }

  // /week — недельный дайджест
  if (text === '/week') {
    const weekStr = getISOWeekStr();
    const fs = require('fs');
    const path = require('path');
    const weeklyDir = path.join(process.env.KIDS_DATA_DIR || '/mnt/yadisk-agent/kids', 'weekly');
    const filePath = path.join(weeklyDir, `${weekStr}.md`);
    if (!fs.existsSync(filePath)) {
      await bot.sendMessage(parentId, 'Дайджест ещё не сгенерирован.');
    } else {
      await sendLongMessage(parentId, fs.readFileSync(filePath, 'utf8'));
    }
    return;
  }

  // /homework — ДЗ для родителя (по-русски), с ID для удаления
  if (text === '/homework') {
    const hw = storage.loadHomework();
    const pending = hw.tasks.filter(t => !t.done);
    if (pending.length === 0) {
      await bot.sendMessage(parentId, '✅ Нет невыполненных домашних заданий.');
      return;
    }
    let reply = '📝 Домашние задания:\n';
    for (const t of pending) {
      reply += `\n• ${t.subject}: ${t.description}${t.due ? ` (до ${t.due})` : ''}\n  🔹 /delhw ${t.id}`;
    }
    await bot.sendMessage(parentId, reply);
    return;
  }

  // /delhw <id> [id2 ...] — удалить одно или несколько ДЗ
  if (text.startsWith('/delhw ')) {
    const ids = text.slice('/delhw '.length).trim().split(/\s+/);
    const removed = [];
    const notFound = [];
    for (const id of ids) {
      const task = storage.removeHomeworkTask(id);
      if (task) {
        removed.push(`• ${task.subject}: ${task.description}`);
      } else {
        notFound.push(id);
      }
    }
    let reply = '';
    if (removed.length > 0) {
      reply += `🗑 Удалено ${removed.length} задание(й):\n${removed.join('\n')}`;
    }
    if (notFound.length > 0) {
      reply += `${reply ? '\n\n' : ''}Не найдено: ${notFound.join(', ')}`;
    }
    await bot.sendMessage(parentId, reply || 'Ничего не удалено.');
    return;
  }

  // /balance — баланс TimeGuard
  if (text === '/balance') {
    const bal = storage.loadBalance();
    await bot.sendMessage(parentId, `⏱ Баланс: ${formatBalance(bal.balance_minutes)}.`);
    return;
  }

  // /schedule — расписание сына
  if (text === '/schedule') {
    const schedule = storage.loadSchedule();
    if (!schedule) {
      await bot.sendMessage(parentId, 'Расписание ещё не заполнено.');
      return;
    }
    const days = { lunes: 'Пн', martes: 'Вт', miércoles: 'Ср', jueves: 'Чт', viernes: 'Пт' };
    let reply = `📅 Расписание (обновлено ${schedule.updated || '—'}):\n`;
    for (const [day, label] of Object.entries(days)) {
      const subjects = schedule[day];
      if (subjects && subjects.length > 0) {
        reply += `\n${label}: ${subjects.join(', ')}`;
      } else {
        reply += `\n${label}: —`;
      }
    }
    await bot.sendMessage(parentId, reply);
    return;
  }

  // /setday <день> <предметы через запятую> — редактирование одного дня расписания
  if (text.startsWith('/setday ')) {
    const rest = text.slice('/setday '.length).trim();
    const spaceIdx = rest.indexOf(' ');
    if (spaceIdx === -1) {
      await bot.sendMessage(parentId, 'Формат: /setday ср Математика, Английский, Физкультура\nИли: /setday ср — (выходной)');
      return;
    }
    const dayInput = rest.slice(0, spaceIdx);
    const dayKey = resolveDayName(dayInput);
    if (!dayKey) {
      await bot.sendMessage(parentId, `Неизвестный день: "${dayInput}"\nИспользуй: пн, вт, ср, чт, пт (или lunes, martes, miércoles, jueves, viernes)`);
      return;
    }
    const subjectsInput = rest.slice(spaceIdx + 1).trim();
    const FREE_RE = /^(—|-|выходной|свободный|libre|nada|нет уроков|нет)$/i;
    let subjects;
    if (FREE_RE.test(subjectsInput)) {
      subjects = [];
    } else {
      await bot.sendChatAction(parentId, 'typing');
      try {
        const parsed = await askMaxOneShot(
          'Eres un parser. El padre te dice las asignaturas para un día. Devuelve SOLO un JSON array de strings con los nombres de las asignaturas en español correcto (con mayúscula). Ejemplo: ["Matemáticas", "Lengua", "Inglés"]. Sin explicaciones, solo el JSON array.',
          `Asignaturas: "${subjectsInput}"`
        );
        const match = parsed.match(/\[[\s\S]*?\]/);
        subjects = match ? JSON.parse(match[0]) : subjectsInput.split(/[,;]+/).map(s => s.trim()).filter(Boolean);
      } catch (e) {
        console.error('[Max] /setday parse error:', e.message);
        subjects = subjectsInput.split(/[,;]+/).map(s => s.trim()).filter(Boolean);
      }
    }
    const schedule = storage.loadSchedule() || {};
    schedule[dayKey] = subjects;
    storage.saveSchedule(schedule);
    const dayLabel = DAY_LABELS_RU_SHORT[dayKey];
    const display = subjects.length > 0 ? subjects.join(', ') : '— (выходной)';
    await bot.sendMessage(parentId, `✅ ${dayLabel}: ${display}`);
    console.log('[Max] Schedule updated by parent:', dayKey, subjects);
    return;
  }

  // /resetschedule — пошаговый полный сброс расписания
  if (text === '/resetschedule') {
    parentScheduleDraft = { step: 0, schedule: {} };
    const firstLabel = DAY_LABELS_RU_SHORT[WEEKDAYS[0]];
    await bot.sendMessage(parentId, `📅 Пересоздаём расписание с нуля.\n\n${firstLabel} — напиши предметы через запятую (или «—» если выходной):`);
    return;
  }

  // /quests — активные квесты
  if (text === '/quests') {
    const quests = storage.getActiveQuests();
    if (quests.length === 0) {
      await bot.sendMessage(parentId, 'Нет активных квестов.');
      return;
    }
    let reply = '📋 Активные квесты:\n';
    quests.forEach((q, i) => {
      reply += `\n${i + 1}. ${q.subject} — ${q.description}\n   Награда: +${q.reward_minutes} мин | ID: ${q.id}`;
    });
    await bot.sendMessage(parentId, reply);
    return;
  }

  // /codes — текущий пул кодов
  if (text === '/codes') {
    const codesFile = storage.findLatestCodesFile();
    if (!codesFile) {
      await bot.sendMessage(parentId, '📦 Нет файла с кодами. Используй /gencodes чтобы создать новый.');
      return;
    }
    const filename = path.basename(codesFile);
    const codes = storage.loadCodes(codesFile);
    const remaining = codes.filter(c => !c.used).length;
    await bot.sendMessage(parentId, `📦 Коды призового времени\n\nФайл: ${filename}\nОсталось: ${remaining} из ${codes.length}`);
    return;
  }

  // /gencodes [N] — генерация новой партии кодов
  if (/^\/gencodes(?:\s+\d+)?$/.test(text)) {
    const m = text.match(/^\/gencodes(?:\s+(\d+))?$/);
    const n = m[1] ? Math.min(500, Math.max(1, parseInt(m[1], 10))) : 100;
    try {
      await bot.sendChatAction(parentId, 'typing');
      // Count existing files before generation (for stats message)
      const kidsDir = process.env.KIDS_DATA_DIR || '/mnt/yadisk-agent/kids';
      let prevFilesCount = 0;
      let prevKnownCount = 0;
      if (fs.existsSync(kidsDir)) {
        const prevFiles = fs.readdirSync(kidsDir).filter(f => /^codes_\d{8}\.md$/.test(f));
        prevFilesCount = prevFiles.length;
        for (const f of prevFiles) {
          prevKnownCount += storage.loadCodes(path.join(kidsDir, f)).length;
        }
      }
      const codes = storage.generateUniqueCodes(n);
      const madridDateStr = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Madrid' });
      const [y, mo, dd] = madridDateStr.split('-');
      const dateStr = dd + mo + y;
      const txtContent = storage.writePrizeFiles(codes, dateStr);
      await bot.sendDocument(parentId, Buffer.from(txtContent, 'utf8'), {
        caption: 'Импортируй этот файл в Time Boss Cloud. Коды уже сохранены в Максе.'
      }, {
        filename: `prize_${dateStr}.txt`,
        contentType: 'text/plain'
      });
      await bot.sendMessage(parentId,
        `✅ Сгенерировано ${n} кодов\n\nФайл prize_${dateStr}.txt — загрузи в Time Boss Cloud\nКоды сохранены в kids/codes_${dateStr}.md\nПредыдущих файлов проверено: ${prevFilesCount} (всего известных кодов: ${prevKnownCount})`
      );
    } catch (e) {
      console.error('[Max] /gencodes error:', e.message);
      await bot.sendMessage(parentId, 'Ошибка при генерации кодов: ' + e.message);
    }
    return;
  }

  // /assign <subject>: <description> — или свободный текст (парсинг через Claude с подтверждением)
  if (text.startsWith('/assign ')) {
    const rest = text.slice('/assign '.length).trim();
    if (!rest) {
      await bot.sendMessage(parentId, 'Формат: /assign Lengua: прочитать параграф 12\nИли просто вставь текст/письмо от учителя.');
      return;
    }
    // Строгий формат «Предмет: описание» — только если часть до : короткая (1-3 слова, ≤40 символов)
    // и вся строка однострочная. Иначе — свободный формат.
    const colonIdx = rest.indexOf(':');
    const isSingleLine = !rest.includes('\n');
    const candidateSubject = colonIdx !== -1 ? rest.slice(0, colonIdx).trim() : '';
    const isStrictFormat = colonIdx !== -1 && isSingleLine
      && candidateSubject.length <= 40
      && candidateSubject.split(/\s+/).length <= 3
      && rest.slice(colonIdx + 1).trim().length > 0;
    if (isStrictFormat) {
      const subject = candidateSubject;
      const description = rest.slice(colonIdx + 1).trim();
      storage.addHomeworkTask({ subject, description, due: '' });
      await bot.sendMessage(parentId, `✅ Задание добавлено: ${subject} — ${description}`);
      return;
    }
    // Свободный формат — Claude разбивает на конкретные пункты и добавляет уточнения
    await bot.sendChatAction(parentId, 'typing');
    const todayStr = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Madrid' });
    const tomorrowDate = new Date();
    tomorrowDate.setDate(tomorrowDate.getDate() + 1);
    const tomorrowStr = tomorrowDate.toLocaleDateString('sv-SE', { timeZone: 'Europe/Madrid' });
    try {
      const parsed = await askMaxOneShot(
        `Eres un parser de deberes/tareas escolares. El padre te envía un texto — puede ser un mensaje de un profesor, un email, una nota de agenda o una descripción propia. El alumno tiene 13 años, colegio español en Madrid.

Tu trabajo: extraer TODAS las tareas concretas que el alumno debe realizar. Devuelve SOLO un JSON array (sin texto extra).

Cada tarea: {"subject": "Asignatura en español (con mayúscula)", "description_es": "Acción concreta en ESPAÑOL que debe realizar el alumno", "description_ru": "То же самое задание на РУССКОМ языке", "due": "YYYY-MM-DD o vacío si no se menciona fecha", "comment": "Nota importante para el padre en RUSO: откуда взять материалы, связь с оценкой, пояснения если что-то неясно, или vacío si todo claro"}.

Reglas importantes:
- Desglosa textos largos en tareas INDIVIDUALES — cada acción concreta es una tarea separada.
- description_es y description_ru deben contener LA MISMA tarea, pero en español y en ruso respectivamente.
- Determina la asignatura del CONTEXTO del mensaje (profesor, tema mencionado, etc.), no solo de cada frase.
- Si un profesor dice que es de "Geografía e Historia", todas las tareas de ese mensaje son de esa asignatura (o de la sub-área correspondiente: "Historia" o "Geografía" según el contenido de la tarea).
- Ignora saludos, presentaciones, opiniones del profesor — extrae solo las ACCIONES para el alumno.
- El campo "comment" debe estar en RUSO y contener información práctica: dónde están los materiales (Teams, clase, etc.), si la tarea es para recuperación/evaluación, plazos implícitos, o advertencias sobre partes poco claras.
- Si no puedes determinar la asignatura, pon "General".
Hoy es ${todayStr}. "mañana" = ${tomorrowStr}. "esta semana" = hasta el viernes de esta semana.`,
        `Texto del padre:\n\n${rest}`
      );
      let tasks = [];
      const match = parsed.match(/\[[\s\S]*\]/);
      tasks = match ? JSON.parse(match[0]) : [];
      if (tasks.length === 0) {
        tasks = [{ subject: 'General', description_es: rest.slice(0, 200), description_ru: rest.slice(0, 200), due: '', comment: '' }];
      }
      // Формируем description = "ES / RU" для сохранения в homework.json
      for (const t of tasks) {
        if (!t.description && (t.description_es || t.description_ru)) {
          t.description = t.description_es && t.description_ru
            ? `${t.description_es} / ${t.description_ru}`
            : (t.description_es || t.description_ru);
        }
      }
      parentAssignDraft = { tasks, rawText: rest };
      let preview = '📝 Распознаны задания:\n';
      tasks.forEach((t, i) => {
        preview += `\n${i + 1}. ${t.subject || 'General'}:`;
        preview += `\n   🇪🇸 ${t.description_es || t.description}`;
        preview += `\n   🇷🇺 ${t.description_ru || t.description}`;
        if (t.due) preview += `\n   📅 до ${t.due}`;
        if (t.comment) preview += `\n   💬 ${t.comment}`;
      });
      preview += '\n\nВсё верно? Подтверди или напиши уточнения.';
      await bot.sendMessage(parentId, preview);
    } catch (e) {
      console.error('[Max] /assign freeform parse error:', e.message);
      storage.addHomeworkTask({ subject: 'General', description: rest, due: '' });
      parentAssignDraft = null;
      await bot.sendMessage(parentId, `✅ Задание добавлено: General — ${rest}`);
    }
    return;
  }

  // /quest — start multi-step dialog; OR fast path: /quest Subject "desc" +Nмин
  if (text === '/quest' || text.startsWith('/quest ')) {
    const rest = text.slice('/quest'.length).trim();
    // Fast path: old one-liner format still supported
    const fastMatch = rest.match(/^(\S+)\s+"([^"]+)"\s+\+(\d+)мин$/i);
    if (fastMatch) {
      const [, subject, description, minutesStr] = fastMatch;
      const reward_minutes = parseInt(minutesStr, 10);
      const id = storage.addQuest({ subject, description, reward_minutes });
      if (session.isActive()) {
        session.addMessage('user', `[Sistema: el padre ha añadido una nueva misión ahora mismo: ${subject}: ${description} (+${reward_minutes} min). Anúnciasela al alumno en tu próxima respuesta.]`);
        console.log('[Max] Quest injected into active session:', id, subject);
      } else {
        const studentChatId = getChatId();
        if (studentChatId) {
          await bot.sendMessage(studentChatId,
            `¡Hola! Tu papá te ha asignado una nueva misión 🎯\n\n*${subject}*: ${description}\nRecompensa: +${reward_minutes} minutos de ordenador\n\n¿Cuándo estás listo para empezar?`,
            { parse_mode: 'Markdown' }
          );
          console.log('[Max] Quest announced to student:', id, subject);
        }
      }
      await bot.sendMessage(parentId,
        `🎯 Квест создан!\n\n${subject}: ${description}\nНаграда: +${reward_minutes} мин\n\n${getChatId() ? 'Макс уже написал сыну о квесте.' : 'Макс расскажет сыну о квесте при следующей сессии.'}`
      );
      console.log('[Max] Quest created (fast path):', id, subject);
      return;
    }
    // Start dialog flow
    parentQuestDraft = { step: 'subject', subject: '', rawDescription: '', refined: '' };
    await bot.sendMessage(parentId,
      'Для какого предмета квест? (Например: Lengua, Inglés, Matemáticas)\nИли напиши «без предмета».'
    );
    return;
  }

  // /cancelquest <id>
  if (text.startsWith('/cancelquest ')) {
    const id = text.slice('/cancelquest '.length).trim();
    const ok = storage.cancelQuest(id);
    await bot.sendMessage(parentId, ok ? 'Квест отменён.' : 'Квест не найден.');
    return;
  }

  // /progress — общий прогресс по предметам
  if (text === '/progress') {
    const md = storage.readProgress();
    if (!md) {
      await bot.sendMessage(parentId, 'Прогресс пока не накоплен — сессий не было.');
    } else {
      await sendLongMessage(parentId, md);
    }
    return;
  }

  // /sessions [дата] — сессии за конкретный день или список дат
  if (text === '/sessions' || text.startsWith('/sessions ')) {
    const arg = text.slice('/sessions'.length).trim();
    if (!arg) {
      // Без даты — показываем список всех дат с сессиями
      const dates = storage.listSessionDates();
      if (dates.length === 0) {
        await bot.sendMessage(parentId, 'Сессий ещё не было.');
      } else {
        await bot.sendMessage(parentId, `Даты сессий:\n${dates.join('\n')}\n\nИспользуй /sessions ГГГГ-ММ-ДД чтобы посмотреть конкретный день.`);
      }
    } else {
      const md = storage.readSessionReport(arg);
      if (!md) {
        await bot.sendMessage(parentId, `Сессий за ${arg} не найдено.`);
      } else {
        await sendLongMessage(parentId, md);
      }
    }
    return;
  }

  // /help — справка по командам
  if (text === '/help') {
    await bot.sendMessage(parentId,
      'Команды для родителя:\n\n' +
      '📊 *Отчёты*\n' +
      '/report — сессия сегодня\n' +
      '/sessions — список всех дат сессий\n' +
      '/sessions ГГГГ-ММ-ДД — сессии за день\n' +
      '/week — недельный дайджест\n' +
      '/progress — прогресс по предметам\n\n' +
      '📅 *Расписание*\n' +
      '/schedule — посмотреть расписание\n' +
      '/setday <день> <предметы> — изменить один день\n' +
      '  Пример: /setday ср Математика, Английский\n' +
      '/resetschedule — пересоздать расписание с нуля\n\n' +
      '📝 *Домашние задания*\n' +
      '/homework — невыполненные ДЗ\n' +
      '/assign Предмет: задание — добавить ДЗ\n' +
      '/assign <текст> — свободный формат\n' +
      '📷 Или отправь фото ДЗ — бот распознает\n' +
      '/delhw <id> — удалить задание\n\n' +
      '🎯 *Квесты и призы*\n' +
      '/quest — создать квест (диалог)\n' +
      '/quests — активные квесты\n' +
      '/cancelquest <id>\n' +
      '/balance — баланс TimeGuard\n' +
      '/codes — статус пула кодов\n' +
      '/gencodes [N] — сгенерировать коды\n\n' +
      'Или просто напиши вопрос — например: "Как он учится?"',
      { parse_mode: 'Markdown' }
    );
    return;
  }

  // Неизвестная команда — показываем help
  if (text.startsWith('/')) {
    await bot.sendMessage(parentId,
      'Неизвестная команда. Напиши /help чтобы увидеть список команд.\n\nИли напиши вопрос без "/" — я отвечу развёрнуто.'
    );
    return;
  }

  // Свободный вопрос родителя — отвечает Claude с контекстом сессий и прогресса
  try {
    await bot.sendChatAction(parentId, 'typing');
    const answer = await askParent(text);
    await sendLongMessage(parentId, answer);
  } catch (e) {
    console.error('[Max] askParent error:', e.message);
    await bot.sendMessage(parentId, 'Не удалось обработать запрос. Попробуй ещё раз.');
  }
}

// ── Parent photo handler ──────────────────────────────────────────────────────

async function handleParentPhoto(msg) {
  const parentId = process.env.PARENT_CHAT_ID;
  try {
    await bot.sendChatAction(parentId, 'typing');
    const photo = msg.photo[msg.photo.length - 1];
    const { base64, mime_type } = await vision.downloadTelegramPhoto(
      bot, photo.file_id, process.env.TUTOR_BOT_TOKEN
    );
    const caption = msg.caption || '';
    const todayStr = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Madrid' });
    const tomorrowDate = new Date();
    tomorrowDate.setDate(tomorrowDate.getDate() + 1);
    const tomorrowStr = tomorrowDate.toLocaleDateString('sv-SE', { timeZone: 'Europe/Madrid' });

    const systemPrompt =
      `Eres un parser de deberes escolares. Analiza la foto enviada por el padre — puede ser una foto de agenda, pizarra, mensaje del profesor, o tarea escrita. El alumno tiene 13 años, colegio español en Madrid.

Extrae TODAS las tareas concretas visibles y devuelve SOLO un JSON array (sin texto extra).
Cada tarea: {"subject": "Asignatura en español (con mayúscula)", "description_es": "Acción concreta en ESPAÑOL", "description_ru": "То же задание на РУССКОМ", "due": "YYYY-MM-DD o vacío", "comment": "Nota en RUSO: откуда материалы, связь с оценкой, если что-то неразборчиво, o vacío si todo claro"}.
Hoy es ${todayStr}. "mañana" = ${tomorrowStr}.
Reglas:
- Cada acción concreta es una tarea separada.
- description_es y description_ru contienen LA MISMA tarea en español y ruso.
- Determina la asignatura del contexto visual (encabezado, nombre del profesor, tema).
- Si no puedes determinar la asignatura, pon "General".
- Si no puedes leer nada útil, devuelve un array vacío: [].
- Ignora contenido no relevante (saludos, firmas).`;

    const userText = caption
      ? `Contexto del padre: "${caption}"`
      : 'Analiza esta foto de deberes.';

    const parsed = await askMaxOneShotWithImage(systemPrompt, userText, base64, mime_type);

    let tasks = [];
    try {
      const match = parsed.match(/\[[\s\S]*\]/);
      tasks = match ? JSON.parse(match[0]) : [];
    } catch (e) {
      console.error('[Max] Parent photo homework parse error:', e.message);
      tasks = [];
    }

    if (tasks.length === 0) {
      await bot.sendMessage(parentId,
        'Не удалось распознать задания на фото.\nПопробуй отправить фото поближе или добавь описание через /assign.'
      );
      return;
    }

    for (const t of tasks) {
      if (!t.description && (t.description_es || t.description_ru)) {
        t.description = t.description_es && t.description_ru
          ? `${t.description_es} / ${t.description_ru}`
          : (t.description_es || t.description_ru);
      }
    }

    parentAssignDraft = { tasks, rawText: caption || '[фото ДЗ]' };
    let preview = '📝 Распознано с фото:\n';
    tasks.forEach((t, i) => {
      preview += `\n${i + 1}. ${t.subject || 'General'}:`;
      preview += `\n   🇪🇸 ${t.description_es || t.description}`;
      preview += `\n   🇷🇺 ${t.description_ru || t.description}`;
      if (t.due) preview += `\n   📅 до ${t.due}`;
      if (t.comment) preview += `\n   💬 ${t.comment}`;
    });
    preview += '\n\nВсё верно? Подтверди или напиши уточнения.';
    await bot.sendMessage(parentId, preview);
    console.log(`[Max] Parent photo: ${tasks.length} tasks recognized, awaiting confirmation`);
  } catch (e) {
    console.error('[Max] handleParentPhoto error:', e.message);
    await bot.sendMessage(parentId, 'Ошибка при обработке фото. Попробуй ещё раз или используй /assign.').catch(() => {});
  }
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
      await notifyParent('📚 Сессия завершена\n\n' + summary);
      const stuckFlag = report.checkStuckTopic(data);
      if (stuckFlag) await notifyParent(stuckFlag);
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
      scheduleText += `\n${WEEKDAY_LABELS[day]}:`;
      if (lessons.length === 0) {
        scheduleText += ' libre';
      } else {
        lessons.forEach((l, i) => { scheduleText += `\n  ${i + 1}. ${l}`; });
      }
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
  if (!msg.text) return; // voice/photo handled separately

  // Route parent messages before student flow
  if (isParent(msg)) {
    const text = msg.text.trim();
    try {
      await handleParentCommand(msg, text);
    } catch (e) {
      console.error('[Max] Parent command error:', e.message);
    }
    return;
  }

  if (!isAllowed(msg)) return;

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

    // Check if schedule is filled — if not, start onboarding
    if (!storage.isScheduleComplete()) {
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

    // Reply context: if student replied to a specific message, prepend context
    const sessionHistory = session.getHistory();
    const replyContext = buildReplyContext(msg, sessionHistory, { botName: 'Max' });
    const textForClaude = replyContext ? replyContext + '\n\n' + text : text;

    const msgMeta = { message_id: msg.message_id };
    if (msg.reply_to_message) msgMeta.reply_to_message_id = msg.reply_to_message.message_id;

    // Add to session + send to Claude
    session.addMessage('user', textForClaude, msgMeta);
    await bot.sendChatAction(chatId, 'typing');

    const history = session.getHistory();
    const context = session.getContext();
    const pending = storage.loadHomework().tasks.filter(t => !t.done);
    const reply = await askMax(history, context, pending, 'text');

    // Извлекаем маркеры выполненных ДЗ
    const { cleanText: noHwMarkers, doneIds } = extractDoneMarkers(reply);
    for (const id of doneIds) {
      storage.markHomeworkDone(id);
    }

    // Извлекаем маркеры выполненных квестов
    const { cleanText, questIds } = extractQuestDoneMarkers(noHwMarkers);
    let finalText = cleanText;
    for (const qid of questIds) {
      const result = storage.completeQuest(qid);
      if (result) {
        const { quest } = result;
        storage.addBalance(quest.reward_minutes);
        const codesFile = storage.findLatestCodesFile();
        const nextCode = codesFile ? storage.getNextCode(codesFile) : null;
        if (nextCode) {
          storage.markCodeUsed(codesFile, nextCode.code, quest.description);
          finalText += `\n\n🏆 ¡Misión completada!\n\n${quest.subject}: ${quest.description}\n¡Has ganado ${quest.reward_minutes} minutos extra de ordenador!\n\nTu código premio: **${nextCode.code}**\nIntrodúcelo en Time Boss para activar tu tiempo 🎮`;
          const remaining = storage.countRemainingCodes(codesFile);
          await notifyParent(`🏆 Квест выполнен!\n\n${quest.subject}: ${quest.description}\nСыну выдан код: ${nextCode.code} (+${quest.reward_minutes} мин)\nОсталось кодов: ${remaining}`);
          if (remaining <= 10) {
            await notifyParent(`⚠️ Коды призового времени заканчиваются\n\nОсталось: ${remaining} кодов\nПора сгенерировать новую партию и загрузить в Time Boss Cloud.`);
          }
        } else {
          finalText += '\n\n🏆 ¡Misión completada! Papá te dará tu premio pronto 🎁';
          await notifyParent(`🏆 Квест выполнен, но коды закончились!\n\n${quest.subject}: ${quest.description}\nЗагрузи новую партию в Time Boss Cloud.`);
        }
      }
    }

    const sentMsg = await sendLongMessage(chatId, finalText);
    const assistantMeta = sentMsg && sentMsg.message_id ? { message_id: sentMsg.message_id } : {};
    session.addMessage('assistant', finalText, assistantMeta);

  } catch (err) {
    console.error('[Max] Error:', err.message);
    await bot.sendMessage(chatId, formatErrorForUser(err)).catch(() => {});
  }
  }); // withLock
});

// ── Photo handler ─────────────────────────────────────────────────────────────

bot.on('photo', async (msg) => {
  if (isParent(msg)) {
    await handleParentPhoto(msg);
    return;
  }
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

    // Reply context for photo messages
    const photoHistory = session.getHistory();
    const replyCtx = buildReplyContext(msg, photoHistory, { botName: 'Max' });
    const photoCaption = replyCtx
      ? replyCtx + '\n\n' + (caption || '¿Puedes ayudarme con esto?')
      : (caption || '¿Puedes ayudarme con esto?');

    const content = vision.buildPhotoMessage(base64, mime_type, photoCaption);
    const history = session.getHistory();
    const context = session.getContext();

    // Send to Claude with full photo
    const messagesForClaude = [
      ...history.map(m => ({ role: m.role, content: m.content })),
      { role: 'user', content }
    ];
    const reply = await askMax(messagesForClaude, context, undefined, 'photo');

    const photoMeta = { message_id: msg.message_id };
    if (msg.reply_to_message) photoMeta.reply_to_message_id = msg.reply_to_message.message_id;

    // Store text placeholder in session, not base64
    session.addMessage('user', vision.photoPlaceholder(caption), photoMeta);
    const sentMsg = await sendLongMessage(chatId, reply);
    const assistantMeta = sentMsg && sentMsg.message_id ? { message_id: sentMsg.message_id } : {};
    session.addMessage('assistant', reply, assistantMeta);
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
    const text = await whisper.transcribe(Buffer.from(audioRes.data), 'voice.ogg', null);

    // M-4: без экранирования Markdown-символы в тексте транскрипции вызывают ошибку API
    const escapedText = text.replace(/[_*`\[]/g, '\\$&');
    await bot.sendMessage(chatId, `🎤 _"${escapedText}"_`, { parse_mode: 'Markdown' });

    // Check if schedule exists — if not, start onboarding
    if (onboarding) {
      const reply = await handleOnboarding(text);
      await sendLongMessage(chatId, reply);
      return;
    }

    if (!storage.isScheduleComplete()) {
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

    // Reply context for voice messages
    const voiceHistory = session.getHistory();
    const voiceReplyCtx = buildReplyContext(msg, voiceHistory, { botName: 'Max' });
    const textForClaude = voiceReplyCtx ? voiceReplyCtx + '\n\n' + text : text;

    const voiceMeta = { message_id: msg.message_id };
    if (msg.reply_to_message) voiceMeta.reply_to_message_id = msg.reply_to_message.message_id;

    session.addMessage('user', textForClaude, voiceMeta);

    const history = session.getHistory();
    const context = session.getContext();
    const pending = storage.loadHomework().tasks.filter(t => !t.done);
    const reply = await askMax(history, context, pending, 'voice');

    const { cleanText: noHwMarkersV, doneIds: doneIdsV } = extractDoneMarkers(reply);
    for (const id of doneIdsV) {
      storage.markHomeworkDone(id);
    }

    const { cleanText, questIds: questIdsV } = extractQuestDoneMarkers(noHwMarkersV);
    let finalTextV = cleanText;
    for (const qid of questIdsV) {
      const result = storage.completeQuest(qid);
      if (result) {
        const { quest } = result;
        storage.addBalance(quest.reward_minutes);
        const codesFile = storage.findLatestCodesFile();
        const nextCode = codesFile ? storage.getNextCode(codesFile) : null;
        if (nextCode) {
          storage.markCodeUsed(codesFile, nextCode.code, quest.description);
          finalTextV += `\n\n🏆 ¡Misión completada!\n\n${quest.subject}: ${quest.description}\n¡Has ganado ${quest.reward_minutes} minutos extra de ordenador!\n\nTu código premio: **${nextCode.code}**\nIntrodúcelo en Time Boss para activar tu tiempo 🎮`;
          const remaining = storage.countRemainingCodes(codesFile);
          await notifyParent(`🏆 Квест выполнен!\n\n${quest.subject}: ${quest.description}\nСыну выдан код: ${nextCode.code} (+${quest.reward_minutes} мин)\nОсталось кодов: ${remaining}`);
          if (remaining <= 10) {
            await notifyParent(`⚠️ Коды призового времени заканчиваются\n\nОсталось: ${remaining} кодов\nПора сгенерировать новую партию и загрузить в Time Boss Cloud.`);
          }
        } else {
          finalTextV += '\n\n🏆 ¡Misión completada! Papá te dará tu premio pronto 🎁';
          await notifyParent(`🏆 Квест выполнен, но коды закончились!\n\n${quest.subject}: ${quest.description}\nЗагрузи новую партию в Time Boss Cloud.`);
        }
      }
    }

    const sentVoiceMsg = await sendLongMessage(chatId, finalTextV);
    const voiceAssistantMeta = sentVoiceMsg && sentVoiceMsg.message_id ? { message_id: sentVoiceMsg.message_id } : {};
    session.addMessage('assistant', finalTextV, voiceAssistantMeta);

  } catch (err) {
    console.error('[Max] Voice error:', err.message);
    await bot.sendMessage(chatId, formatErrorForUser(err)).catch(() => {});
  }
  }); // withLock
});

// ── Startup ───────────────────────────────────────────────────────────────────

// Команды для меню Telegram (кнопка "/" в чате)
const BOT_COMMANDS_ES = [
  { command: 'homework',  description: 'Ver deberes pendientes 📝' },
  { command: 'schedule',  description: 'Ver mi horario escolar 📋' },
  { command: 'done',      description: 'Terminar la sesión de estudio ✅' },
  { command: 'status',    description: 'Estado del bot 🟢' },
  { command: 'reset',     description: 'Borrar historial de conversación 🗑' },
  { command: 'start',     description: '¡Empecemos! 👋' },
];
const BOT_COMMANDS_RU = [
  { command: 'homework',  description: 'Домашние задания 📝' },
  { command: 'schedule',  description: 'Моё расписание 📋' },
  { command: 'done',      description: 'Завершить учёбу ✅' },
  { command: 'status',    description: 'Статус бота 🟢' },
  { command: 'reset',     description: 'Сбросить историю чата 🗑' },
  { command: 'start',     description: 'Привет! 👋' },
];

async function registerBotCommands() {
  try {
    // Устанавливаем команды для двух языков: по умолчанию испанский, отдельно русский
    await bot.setMyCommands(BOT_COMMANDS_ES);
    await bot.setMyCommands(BOT_COMMANDS_RU, { language_code: 'ru' });
    console.log('[Max] Bot commands menu registered');
  } catch (e) {
    console.error('[Max] Failed to register bot commands:', e.message);
  }
}

async function main() {
  console.log('[Max] Starting...');

  storage.ensureDirs();
  loadState();
  await registerBotCommands();

  setupSchedules({
    bot,
    chatId: getChatId,
    storage,
    session,
    claude: { askMax, askMaxOneShot },
    report,
    sendLongMessage,
    setAwaitingHomework,
    startOnboarding,
    getLastHomeworkReminder: () => lastHomeworkReminder,
    setLastHomeworkReminder: (ts) => { lastHomeworkReminder = ts; }
  });

  const STARTUP_COOLDOWN_MS = 4 * 60 * 60 * 1000;

  if (appState.chatId) {
    // M-6: Жора может перезапускать сервис несколько раз — отправляем приветствие не чаще раза в 4 часа
    const lastSent = appState.lastStartupAt || 0;
    if (Date.now() - lastSent > STARTUP_COOLDOWN_MS) {
      try {
        const lang = langWeek.getCurrentLang();
        const startupMsg = lang === 'ru'
          ? '👋 Привет! Я Макс, твой помощник по учёбе. Начнём?'
          : '¡Hola! 👋 Soy Max, tu ayudante de estudio. ¿Empezamos?';
        await bot.sendMessage(appState.chatId, startupMsg);
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

  // Startup message to parent (same 4hr cooldown)
  if (process.env.PARENT_CHAT_ID) {
    const lastParentSent = appState.lastParentStartupAt || 0;
    if (Date.now() - lastParentSent > STARTUP_COOLDOWN_MS) {
      try {
        await bot.sendMessage(process.env.PARENT_CHAT_ID,
          '👋 Макс запущен. Напиши /report, /quests, /gencodes или /assign чтобы взаимодействовать.'
        );
        appState.lastParentStartupAt = Date.now();
        saveState();
        console.log('[Max] Startup message sent to parent:', process.env.PARENT_CHAT_ID);
      } catch (e) {
        console.error('[Max] Failed to send parent startup message:', e.message);
      }
    } else {
      console.log('[Max] Parent startup message skipped (cooldown)');
    }
  }

  console.log('[Max] Ready and listening.');
}

main().catch((e) => {
  console.error('[Max] Fatal error:', e);
  process.exit(1);
});
