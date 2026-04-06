'use strict';

const cron = require('node-cron');
const langWeek = require('../lib/lang-week');

const TIMEZONE = 'Europe/Madrid';
const DAYS_ES = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

function getTodayDay() {
  const dayName = new Date().toLocaleDateString('es-ES', { weekday: 'long', timeZone: TIMEZONE });
  return dayName.toLowerCase();
}

function getTomorrowDay() {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  // C-1: используем Madrid-timezone для получения правильного дня недели
  const dayName = tomorrow.toLocaleDateString('es-ES', { weekday: 'long', timeZone: TIMEZONE });
  return dayName.toLowerCase(); // 'lunes', 'martes', etc.
}

function getTodayStr() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: TIMEZONE });
}

// Двуязычные тексты для автоматических сообщений
const T = {
  afternoonGreeting: {
    es: (subjects) => subjects.length > 0
      ? `¡Ey! 👋 ¿Cómo fue el cole?\nHoy tenías: ${subjects.join(', ')}.\n¿Qué deberes te han puesto? Dímelo por cada asignatura 📝`
      : '¡Ey! 👋 ¿Cómo fue el cole hoy?\n¿Qué deberes te han puesto? Dímelos todos 📝',
    ru: (subjects) => subjects.length > 0
      ? `Эй! 👋 Как школа?\nСегодня у тебя было: ${subjects.join(', ')}.\nЧто задали? Скажи по каждому предмету 📝`
      : 'Эй! 👋 Как сегодня в школе?\nЧто задали? Расскажи всё 📝'
  },
  scheduleIncomplete: {
    es: '¡Ey! 👋 Todavía no tengo tu horario. ¡Vamos a rellenarlo!',
    ru: 'Эй! 👋 У меня ещё нет твоего расписания. Давай заполним!'
  },
  tomorrowHas: {
    es: 'Mañana tienes:',
    ru: 'Завтра у тебя:'
  },
  pendingHomework: {
    es: 'Deberes aún pendientes:',
    ru: 'Домашние задания (ещё не сделано):'
  },
  eveningGreeting: {
    es: '¡Oye, antes de dormir! 🌙\n',
    ru: 'Эй, перед сном! 🌙\n'
  },
  homeworkHeader: {
    es: '\nDeberes:',
    ru: '\nДомашнее задание:'
  },
  done: {
    es: '— hecho',
    ru: '— готово'
  },
  pending: {
    es: '— pendiente',
    ru: '— не сделано'
  },
  allDone: {
    es: '\n\n¡Todo listo! Descansa bien 😴',
    ru: '\n\nВсё готово! Отдыхай хорошо 😴'
  },
  allDoneQuestion: {
    es: '\n\n¿Está todo listo? 😴',
    ru: '\n\nВсё сделано? 😴'
  },
  sessionTimeout: {
    es: '⏰ Se acabó el tiempo de la sesión. ¡Buen trabajo hoy!\n\n',
    ru: '⏰ Время сессии истекло. Молодец, хорошо поработал сегодня!\n\n'
  },
  sessionClosed: {
    es: '⏰ Sesión cerrada automáticamente. ¡Hasta la próxima! 👋',
    ru: '⏰ Сессия закрыта автоматически. До следующего раза! 👋'
  },
  weekGreeting: {
    es: (name) => `¡Hola${name ? ', ' + name : ''}! 👋 ¡Esta semana es la semana del español, te felicito! 😄 ¡Vamos a practicar todo en español esta semana!`,
    ru: (name) => `Привет${name ? ', ' + name : ''}! 👋 Эта неделя у нас — неделя русского языка, с чем я тебя и поздравляю! 😄 Так что давай, общаемся по-русски!`
  }
};

// Хелпер: возвращает текст по ключу на текущем языке недели
function t(key, ...args) {
  const lang = langWeek.getCurrentLang();
  const val = T[key][lang];
  return typeof val === 'function' ? val(...args) : val;
}

function setupSchedules({ bot, chatId, storage, session, claude, report, sendLongMessage, setAwaitingHomework, startOnboarding, getLastHomeworkReminder, setLastHomeworkReminder }) {

  // Понедельничное приветствие с объявлением языка недели — пн 08:00
  cron.schedule('0 8 * * 1', async () => {
    if (!chatId()) return;
    try {
      const msg = t('weekGreeting', 'Рома');
      await bot.sendMessage(chatId(), msg);
      console.log('[Cron] Week greeting sent, lang:', langWeek.getCurrentLang());
    } catch (e) {
      console.error('[Cron] week greeting error:', e.message);
    }
  }, { timezone: TIMEZONE });

  // Afternoon checkin — 15:00 Mon–Fri
  cron.schedule('0 15 * * 1-5', async () => {
    if (!chatId()) return;
    try {
      // Если расписание не заполнено — напомнить и запустить онбординг
      if (!storage.isScheduleComplete()) {
        const lang = langWeek.getCurrentLang();
        await bot.sendMessage(chatId(), T.scheduleIncomplete[lang]);
        if (startOnboarding) {
          const onboardingMsg = startOnboarding();
          await bot.sendMessage(chatId(), onboardingMsg);
        }
        return;
      }

      const schedule = storage.loadSchedule();
      const todayDay = getTodayDay();
      const todayLessons = schedule[todayDay] || [];
      const tomorrowDay = getTomorrowDay();
      const tomorrowLessons = schedule[tomorrowDay] || [];
      const hw = storage.loadHomework();
      const pending = hw.tasks.filter(task => !task.done);
      const lang = langWeek.getCurrentLang();

      // Вопрос про ДЗ — с перечислением сегодняшних предметов
      let msg = T.afternoonGreeting[lang](todayLessons);

      if (tomorrowLessons.length > 0) {
        const numbered = tomorrowLessons.map((l, i) => `  ${i + 1}. ${l}`).join('\n');
        msg += `\n\n${t('tomorrowHas')}\n${numbered}`;
      }

      if (pending.length > 0) {
        msg += '\n\n' + t('pendingHomework');
        for (const task of pending) {
          msg += `\n• ${task.subject}: ${task.description}${task.due ? ` (para el ${task.due})` : ''}`;
        }
      }

      await bot.sendMessage(chatId(), msg);

      // Следующий ответ ученика будет автоматически распарсен как список ДЗ
      if (setAwaitingHomework) setAwaitingHomework(true);

    } catch (e) {
      console.error('[Cron] afternoon checkin error:', e.message);
    }
  }, { timezone: TIMEZONE });

  // Evening reminder — 21:00 Mon–Fri
  cron.schedule('0 21 * * 1-5', async () => {
    if (!chatId()) return;
    try {
      const schedule = storage.loadSchedule();
      if (!schedule) return;

      const tomorrowDay = getTomorrowDay();
      const tomorrowLessons = schedule[tomorrowDay] || [];
      const hw = storage.loadHomework();

      // Filter homework due tomorrow or earlier
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const tomorrowStr = tomorrow.toLocaleDateString('sv-SE', { timeZone: TIMEZONE });

      const pending = hw.tasks.filter(task => !task.done && (!task.due || task.due <= tomorrowStr));
      // H-5: показываем только выполненные за последние 7 дней, иначе список бесконечно растёт
      const sevenDaysAgoStr = new Date(Date.now() - 7 * 24 * 3600 * 1000)
        .toLocaleDateString('sv-SE', { timeZone: TIMEZONE });
      const done = hw.tasks.filter(task => task.done && task.doneAt && task.doneAt >= sevenDaysAgoStr);

      let msg = t('eveningGreeting');

      if (tomorrowLessons.length > 0) {
        const numbered = tomorrowLessons.map((l, i) => `  ${i + 1}. ${l}`).join('\n');
        msg += `${t('tomorrowHas')}\n${numbered}\n`;
      }

      if (pending.length > 0 || done.length > 0) {
        msg += t('homeworkHeader');
        for (const task of done) {
          msg += `\n✅ ${task.subject}: ${task.description} — ${t('done')}`;
        }
        for (const task of pending) {
          msg += `\n⏳ ${task.subject}: ${task.description} — ${t('pending')}`;
        }
      }

      if (pending.length === 0) {
        msg += t('allDone');
      } else {
        msg += t('allDoneQuestion');
      }

      await bot.sendMessage(chatId(), msg);
    } catch (e) {
      console.error('[Cron] evening reminder error:', e.message);
    }
  }, { timezone: TIMEZONE });

  // Daily summary — 20:30
  cron.schedule('30 20 * * *', async () => {
    try {
      await report.generateDailySummary(getTodayStr());
    } catch (e) {
      console.error('[Cron] daily summary error:', e.message);
    }
  }, { timezone: TIMEZONE });

  // Weekly digest — Sunday 18:00
  cron.schedule('0 18 * * 0', async () => {
    try {
      await report.generateWeeklySummary();
      // Check for subject avoidance and notify parent if found
      const parentId = process.env.PARENT_CHAT_ID;
      if (parentId) {
        const avoidanceFlag = report.checkSubjectAvoidance();
        if (avoidanceFlag) {
          await bot.sendMessage(parentId, avoidanceFlag).catch(e => {
            console.error('[Cron] Failed to send avoidance flag to parent:', e.message);
          });
        }
      }
    } catch (e) {
      console.error('[Cron] weekly digest error:', e.message);
    }
  }, { timezone: TIMEZONE });

  // Hourly homework reminder — 16:00-20:00 Mon–Fri
  cron.schedule('0 16-20 * * 1-5', async () => {
    if (!chatId()) return;
    try {
      const hw = storage.loadHomework();
      const pending = hw.tasks.filter(task => !task.done);
      if (pending.length === 0) return;
      if (session.isActive()) return;
      const lastReminder = getLastHomeworkReminder ? getLastHomeworkReminder() : null;
      if (lastReminder && (Date.now() - lastReminder) < 55 * 60 * 1000) return;
      const lang = langWeek.getCurrentLang();
      const n = pending.length;
      const msg = lang === 'ru'
        ? `Напоминание: у тебя ${n} невыполненн${n === 1 ? 'ое задание' : (n < 5 ? 'ых задания' : 'ых заданий')}. Напиши /homework чтобы посмотреть.`
        : `Recuerda que tienes ${n} deber${n === 1 ? '' : 'es'} pendiente${n === 1 ? '' : 's'}. Escribe /deberes para verlos.`;
      await bot.sendMessage(chatId(), msg);
      if (setLastHomeworkReminder) setLastHomeworkReminder(Date.now());
      console.log('[Cron] Homework reminder sent, pending:', n);
    } catch (e) {
      console.error('[Cron] homework reminder error:', e.message);
    }
  }, { timezone: TIMEZONE });

  // Close abandoned sessions — every 5 min
  cron.schedule('*/5 * * * *', async () => {
    if (!session.isActive()) return;
    const idle = Date.now() - session.getLastActivityTime();
    if (idle > 30 * 60 * 1000) {
      console.log('[Cron] Closing abandoned session (30 min idle)');
      const data = session.endSession();
      if (data && chatId()) {
        try {
          const summary = await report.generateSessionSummary(data);
          await sendLongMessage(chatId(), t('sessionTimeout') + summary);
          // Notify parent
          const parentId = process.env.PARENT_CHAT_ID;
          if (parentId) {
            await bot.sendMessage(parentId, '📚 Сессия завершена\n\n' + summary).catch(e => {
              console.error('[Cron] Failed to send session summary to parent:', e.message);
            });
            const stuckFlag = report.checkStuckTopic(data);
            if (stuckFlag) {
              await bot.sendMessage(parentId, stuckFlag).catch(e => {
                console.error('[Cron] Failed to send stuck flag to parent:', e.message);
              });
            }
          }
        } catch (e) {
          console.error('[Cron] Failed to generate session summary:', e.message);
          await bot.sendMessage(chatId(), t('sessionClosed')).catch(() => {});
        }
      }
    }
  });

  console.log('[Max] Schedules initialized (timezone: Europe/Madrid)');
}

module.exports = { setupSchedules };
