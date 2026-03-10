'use strict';

const cron = require('node-cron');

const TIMEZONE = 'Europe/Madrid';
const DAYS_ES = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

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

function setupSchedules({ bot, chatId, storage, session, claude, report, sendLongMessage, setAwaitingHomework }) {

  // Afternoon checkin — 15:00 Mon–Fri
  cron.schedule('0 15 * * 1-5', async () => {
    if (!chatId()) return;
    try {
      const schedule = storage.loadSchedule();
      if (!schedule) return;

      const tomorrowDay = getTomorrowDay();
      const tomorrowLessons = schedule[tomorrowDay] || [];
      const hw = storage.loadHomework();
      const pending = hw.tasks.filter(t => !t.done);

      let msg = '¡Ey! 👋 ¿Cómo fue el cole hoy?\n¿Qué deberes te han puesto? Dímelos todos 📝';

      if (tomorrowLessons.length > 0) {
        msg += `\n\nMañana tienes: ${tomorrowLessons.join(', ')}.`;
      }

      if (pending.length > 0) {
        msg += '\n\nDeberes aún pendientes:';
        for (const t of pending) {
          msg += `\n• ${t.subject}: ${t.description}${t.due ? ` (para el ${t.due})` : ''}`;
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

      const pending = hw.tasks.filter(t => !t.done && (!t.due || t.due <= tomorrowStr));
      // H-5: показываем только выполненные за последние 7 дней, иначе список бесконечно растёт
      const sevenDaysAgoStr = new Date(Date.now() - 7 * 24 * 3600 * 1000)
        .toLocaleDateString('sv-SE', { timeZone: TIMEZONE });
      const done = hw.tasks.filter(t => t.done && t.doneAt && t.doneAt >= sevenDaysAgoStr);

      let msg = '¡Oye, antes de dormir! 🌙\n';

      if (tomorrowLessons.length > 0) {
        msg += `Mañana tienes: ${tomorrowLessons.join(', ')}.\n`;
      }

      if (pending.length > 0 || done.length > 0) {
        msg += '\nDeberes:';
        for (const t of done) {
          msg += `\n✅ ${t.subject}: ${t.description} — hecho`;
        }
        for (const t of pending) {
          msg += `\n⏳ ${t.subject}: ${t.description} — pendiente`;
        }
      }

      if (pending.length === 0) {
        msg += '\n\n¡Todo listo! Descansa bien 😴';
      } else {
        msg += '\n\n¿Está todo listo? 😴';
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
    } catch (e) {
      console.error('[Cron] weekly digest error:', e.message);
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
          await sendLongMessage(chatId(),
            '⏰ Se acabó el tiempo de la sesión. ¡Buen trabajo hoy!\n\n' + summary
          );
        } catch (e) {
          console.error('[Cron] Failed to generate session summary:', e.message);
          await bot.sendMessage(chatId(), '⏰ Sesión cerrada automáticamente. ¡Hasta la próxima! 👋').catch(() => {});
        }
      }
    }
  });

  console.log('[Max] Schedules initialized (timezone: Europe/Madrid)');
}

module.exports = { setupSchedules };
