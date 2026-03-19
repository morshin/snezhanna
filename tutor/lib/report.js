'use strict';

const { askMaxOneShot } = require('./claude');
const storage = require('./storage');

async function generateSessionSummary(sessionData) {
  const duration = Math.round((sessionData.endTime - sessionData.startTime) / 60000);
  const timeStr = sessionData.startTime.toLocaleTimeString('es-ES', {
    hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Madrid'
  });

  const transcript = sessionData.messages
    .map(m => `${m.role === 'user' ? 'Alumno' : 'Max'}: ${typeof m.content === 'string' ? m.content : '[media]'}`)
    .join('\n');

  const prompt = `Analiza esta sesión de tutoría y genera un resumen en formato markdown (en RUSO para el padre).

Sesión: ${sessionData.subject}, ${timeStr}, ${duration} min
Temas: ${sessionData.topics.join(', ') || 'no especificado'}
Dificultades: ${sessionData.stuck.join(', ') || 'ninguna'}
Estado de ánimo: ${sessionData.mood}

Transcripción:
${transcript.slice(-6000)}

Formato requerido:
## Сессия — HH:MM (XX мин)

**Предмет:** ...
**Темы:** ...
**Настроение:** ...

**Где застрял:**
- ...

**Что сработало:**
- ...

**Итог:** ...`;

  const summary = await askMaxOneShot(
    'Eres un asistente que genera reportes de sesiones de tutoría para el padre del alumno. Escribe en RUSO.',
    prompt
  );

  const dateStr = sessionData.startTime.toLocaleDateString('sv-SE', { timeZone: 'Europe/Madrid' });
  storage.appendSessionReport(dateStr, summary);

  return summary;
}

async function generateDailySummary(dateStr) {
  const sessionReport = storage.readSessionReport(dateStr);
  // M-8: второе условие было мёртвым — appendSessionReport всегда добавляет больше чем просто заголовок
  if (!sessionReport) {
    console.log('[Report] No sessions for', dateStr, '— skipping daily summary');
    return;
  }

  const currentProgress = storage.readProgress();

  const prompt = `Вот отчёт о сессиях за ${dateStr}:

${sessionReport}

Текущий прогресс:
${currentProgress || '(пока пусто)'}

Обнови файл прогресса (progress.md) — добавь или обнови информацию по предметам на основе сегодняшних сессий. Формат:
# Прогресс

## Предмет
- Тема: статус (дата)

Статусы: ✅ разобрался, 🔄 в процессе, ❓ ещё не трогали`;

  const updated = await askMaxOneShot(
    'Обновляешь файл прогресса ученика на основе сессий за день. Пиши на русском.',
    prompt
  );

  storage.writeProgress(updated);
}

async function generateWeeklySummary() {
  const now = new Date();
  // M-2: номер недели и год считаем в Madrid-timezone, а не UTC
  const madridDateStr = now.toLocaleDateString('sv-SE', { timeZone: 'Europe/Madrid' });
  const madridDate = new Date(madridDateStr + 'T12:00:00Z');
  const weekNum = getISOWeek(madridDate);
  const year = madridDate.getFullYear();
  const weekStr = `${year}-W${String(weekNum).padStart(2, '0')}`;

  const progress = storage.readProgress();
  const hw = storage.loadHomework();

  const pendingHw = hw.tasks.filter(t => !t.done);
  const doneHw = hw.tasks.filter(t => t.done);

  const prompt = `Сгенерируй недельный дайджест учёбы.

Прогресс по предметам:
${progress || '(нет данных)'}

Домашние задания за неделю:
Выполнено: ${doneHw.length}
В ожидании: ${pendingHw.length}
${pendingHw.map(t => `- ${t.subject}: ${t.description} (до ${t.due})`).join('\n') || '(нет)'}

Напиши дайджест на русском для отца. Формат:
# Неделя ${weekStr}

## Общий итог
...

## По предметам
...

## Домашние задания
...

## Рекомендации
...`;

  const digest = await askMaxOneShot(
    'Генерируешь недельный дайджест учёбы для отца. Пиши на русском.',
    prompt
  );

  storage.writeWeeklyDigest(weekStr, digest);

  // H-4: удаляем выполненные ДЗ по дате ВЫПОЛНЕНИЯ (doneAt), не по дате добавления (added)
  // Так ДЗ добавленное 2 недели назад и сделанное вчера не удалится раньше времени
  const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  hw.tasks = hw.tasks.filter(t => !t.done || !t.doneAt || t.doneAt > oneWeekAgo);
  storage.saveHomework(hw);
}

function getISOWeek(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
}

// ── Subject avoidance detection ───────────────────────────────────────────────

// Reads the last 7 days of session reports and checks which subjects appeared.
// Returns an alert string if any scheduled subject was absent for 5+ school days, else null.
function checkSubjectAvoidance() {
  const TIMEZONE = 'Europe/Madrid';
  const SCHOOL_DAYS = ['lunes', 'martes', 'miércoles', 'jueves', 'viernes'];
  const now = new Date();

  // Collect last 5 school day date strings
  const schoolDayDates = [];
  for (let i = 1; i <= 14 && schoolDayDates.length < 5; i++) {
    const d = new Date(now.getTime() - i * 24 * 3600 * 1000);
    const dow = d.toLocaleDateString('es-ES', { weekday: 'long', timeZone: TIMEZONE }).toLowerCase();
    if (SCHOOL_DAYS.includes(dow)) {
      schoolDayDates.push(d.toLocaleDateString('sv-SE', { timeZone: TIMEZONE }));
    }
  }

  if (schoolDayDates.length < 5) return null;

  // Read session files for those dates, extract mentioned subjects
  const subjectsSeenDates = {}; // subject (lowercase) -> latest date string
  for (const dateStr of schoolDayDates) {
    const report = storage.readSessionReport(dateStr);
    if (!report) continue;
    const matches = [...report.matchAll(/\*\*Предмет:\*\*\s*(.+)/g)];
    for (const m of matches) {
      const subj = m[1].trim().toLowerCase();
      if (!subjectsSeenDates[subj]) subjectsSeenDates[subj] = dateStr;
    }
  }

  // Get all scheduled subjects
  const schedule = storage.loadSchedule();
  if (!schedule) return null;

  const allSubjects = new Set();
  for (const day of SCHOOL_DAYS) {
    for (const subj of (schedule[day] || [])) allSubjects.add(subj);
  }

  // Find subjects absent from all last 5 school day sessions
  const flags = [];
  for (const subject of allSubjects) {
    const subjLower = subject.toLowerCase();
    const seen = Object.keys(subjectsSeenDates).some(s =>
      s.includes(subjLower) || subjLower.includes(s)
    );
    if (!seen) {
      // Find last time it was mentioned anywhere (scan 30 days back)
      let lastDate = null;
      for (let i = 1; i <= 30; i++) {
        const d = new Date(now.getTime() - i * 24 * 3600 * 1000);
        const dateStr = d.toLocaleDateString('sv-SE', { timeZone: TIMEZONE });
        const rep = storage.readSessionReport(dateStr);
        if (rep && rep.toLowerCase().includes(subjLower)) {
          lastDate = dateStr;
          break;
        }
      }
      flags.push({ subject, lastDate });
    }
  }

  if (flags.length === 0) return null;

  let msg = '⚠️ Обрати внимание\n\n';
  for (const { subject, lastDate } of flags) {
    if (lastDate) {
      const formatted = new Date(lastDate + 'T12:00:00Z')
        .toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', timeZone: 'UTC' });
      msg += `Сын уже 5 дней не занимался ${subject} — возможно, избегает.\nПоследняя запись: ${formatted}.\n\n`;
    } else {
      msg += `Сын давно не занимался ${subject} — возможно, избегает.\n\n`;
    }
  }
  return msg.trim();
}

// ── Stuck-topic detection ─────────────────────────────────────────────────────

// Checks if the current session's stuck topics also appeared in the previous session report.
// Returns an alert string if so, else null.
function checkStuckTopic(sessionData) {
  if (!sessionData.stuck || sessionData.stuck.length === 0) return null;

  const TIMEZONE = 'Europe/Madrid';
  const now = new Date();

  // Find previous session file (scan last 7 days excluding today)
  const todayStr = now.toLocaleDateString('sv-SE', { timeZone: TIMEZONE });
  let prevReport = null;
  let prevSubject = null;
  for (let i = 1; i <= 7; i++) {
    const d = new Date(now.getTime() - i * 24 * 3600 * 1000);
    const dateStr = d.toLocaleDateString('sv-SE', { timeZone: TIMEZONE });
    if (dateStr === todayStr) continue;
    const rep = storage.readSessionReport(dateStr);
    if (rep) {
      prevReport = rep;
      break;
    }
  }

  if (!prevReport) return null;

  // Extract "Где застрял" section from previous report
  const stuckSection = prevReport.match(/\*\*Где застрял:\*\*([\s\S]*?)(?=\*\*|$)/);
  if (!stuckSection) return null;

  const prevStuckText = stuckSection[1].toLowerCase();

  // Check if any current stuck topic appears in previous stuck section
  const repeated = sessionData.stuck.filter(topic =>
    topic && prevStuckText.includes(topic.toLowerCase())
  );

  if (repeated.length === 0) return null;

  const subjectStr = sessionData.subject || repeated[0];
  return `💡 Подсказка\n\nСын второй раз подряд застрял на ${repeated[0]}.\nВозможно, стоит объяснить тему иначе или найти дополнительный материал.`;
}

module.exports = {
  generateSessionSummary,
  generateDailySummary,
  generateWeeklySummary,
  checkSubjectAvoidance,
  checkStuckTopic
};
