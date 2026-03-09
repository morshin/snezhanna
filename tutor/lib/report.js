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
  if (!sessionReport || sessionReport.trim() === `# ${dateStr}`) {
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
  const weekNum = getISOWeek(now);
  const year = now.getFullYear();
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

  // Clean up done homework older than a week
  const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  hw.tasks = hw.tasks.filter(t => !t.done || t.added > oneWeekAgo);
  storage.saveHomework(hw);
}

function getISOWeek(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
}

module.exports = { generateSessionSummary, generateDailySummary, generateWeeklySummary };
