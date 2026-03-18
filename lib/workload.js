'use strict';

const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');

const config = JSON.parse(fs.readFileSync(path.join(__dirname, '../config/nanobot.json'), 'utf8'));
const google = require('./google');
const tasks = require('./tasks');
const strava = require('./strava');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const { logTokens } = require('./token-log');

const HISTORY_FILE = path.join(config.yadisk.agent_mount, 'workload-history.json');
const SCORING_PROMPT = fs.readFileSync(path.join(__dirname, 'workload-scoring-prompt.md'), 'utf8');
const OVERLOAD_PROMPT = fs.readFileSync(path.join(__dirname, 'briefing-overload-prompt.md'), 'utf8');
const MAX_HISTORY = 12;

// ── Data collection ─────────────────────────────────────────────────────────

async function collectData() {
  const data = {
    calendar_past_week: [],
    calendar_today_tomorrow: [],
    gmail_summary: null,
    tasks_summary: null,
    strava_weekly: null,
    collected_at: new Date().toISOString()
  };

  // Calendar: past 7 days + today/tomorrow
  if (google.isAuthorized()) {
    try {
      // Past 7 days — use getCalendarEvents with negative-start trick via raw API
      const now = new Date();
      const weekAgo = new Date(now);
      weekAgo.setDate(weekAgo.getDate() - 7);
      const twoDaysAhead = new Date(now);
      twoDaysAhead.setDate(twoDaysAhead.getDate() + 2);

      const allEvents = await google.getCalendarEvents(2);
      data.calendar_today_tomorrow = allEvents.map(e => ({
        summary: e.summary,
        start: e.start.dateTime || e.start.date,
        end: e.end?.dateTime || e.end?.date,
        organizer: e.organizer?.email,
        attendees: (e.attendees || []).length,
        recurring: !!e.recurringEventId
      }));
    } catch (e) {
      console.error('[Workload] Calendar fetch error:', e.message);
    }

    // Gmail summary
    try {
      const messages = await google.getGmailMessages(20, false);
      const unread = messages.filter(m => m.unread);
      data.gmail_summary = {
        total_inbox: messages.length,
        unread_count: unread.length,
        subjects: messages.slice(0, 10).map(m => ({ from: m.from, subject: m.subject, unread: m.unread }))
      };
    } catch (e) {
      console.error('[Workload] Gmail fetch error:', e.message);
    }
  }

  // Tasks
  try {
    const today = new Date().toLocaleDateString('sv-SE', { timeZone: config.timezone });
    const allTasks = tasks.listTasks({}).tasks || [];
    const active = allTasks.filter(t => t.status !== 'done' && t.status !== 'cancelled');

    const q1 = active.filter(t => t.urgent && t.important);
    const q2 = active.filter(t => !t.urgent && t.important);
    const q3 = active.filter(t => t.urgent && !t.important);
    const q4 = active.filter(t => !t.urgent && !t.important);
    const overdue = active.filter(t => t.due_date && t.due_date < today);

    // Recent completions (updated in past 7 days with status done)
    const weekAgoStr = new Date(Date.now() - 7 * 86400000).toLocaleDateString('sv-SE', { timeZone: config.timezone });
    const recentDone = allTasks.filter(t =>
      t.status === 'done' && t.updated_at && t.updated_at.slice(0, 10) >= weekAgoStr
    );

    data.tasks_summary = {
      total_active: active.length,
      q1_count: q1.length,
      q1_tasks: q1.map(t => ({ title: t.title, project: t.project, due_date: t.due_date })),
      q2_count: q2.length,
      q3_count: q3.length,
      q3_tasks: q3.map(t => ({ title: t.title, project: t.project })),
      q4_count: q4.length,
      q4_tasks: q4.map(t => ({ title: t.title, project: t.project })),
      overdue_count: overdue.length,
      overdue_tasks: overdue.map(t => ({ title: t.title, project: t.project, due_date: t.due_date })),
      completed_this_week: recentDone.length
    };
  } catch (e) {
    console.error('[Workload] Tasks fetch error:', e.message);
  }

  // Strava
  if (strava.isConfigured()) {
    try {
      const now = new Date();
      const weekStr = strava.getISOWeekString(now);
      let weekData = strava.loadWeekData(weekStr);
      if (!weekData) {
        // Try syncing current week
        const synced = await strava.syncCurrentWeek();
        if (synced) weekData = strava.loadWeekData(weekStr);
      }
      if (weekData) {
        const activeDays = new Set(weekData.activities.map(a =>
          new Date(a.start_date_local).toLocaleDateString('sv-SE', { timeZone: config.timezone })
        ));
        data.strava_weekly = {
          activities_count: weekData.totals.activities_count,
          distance_km: (weekData.totals.distance_m / 1000).toFixed(1),
          moving_time_hours: (weekData.totals.moving_time_s / 3600).toFixed(1),
          active_days: activeDays.size,
          rest_days: 7 - activeDays.size,
          by_sport: weekData.totals.by_sport,
          activities: weekData.activities.map(a => ({
            name: a.name,
            type: a.type,
            distance_km: (a.distance / 1000).toFixed(1)
          }))
        };
      }
    } catch (e) {
      console.error('[Workload] Strava fetch error:', e.message);
    }
  }

  return data;
}

// ── Scoring via Claude ──────────────────────────────────────────────────────

async function runScoring(collectedData, checkinText) {
  const history = loadHistory();

  const nowStr = new Date().toLocaleString('ru-RU', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    timeZone: config.timezone
  });

  let userMessage = `Дата: ${nowStr}\n\n`;
  userMessage += `## Собранные данные\n\n${JSON.stringify(collectedData, null, 2)}\n\n`;

  if (history.history.length > 0) {
    userMessage += `## История предыдущих недель\n\n${JSON.stringify(history.history.slice(-4), null, 2)}\n\n`;
  } else {
    userMessage += `## История\n\nИстория недоступна — это первая оценка.\n\n`;
  }

  if (checkinText) {
    userMessage += `## Ответ Вовы на чек-ин\n\n${checkinText}\n`;
  } else {
    userMessage += `## Чек-ин\n\nОтвета на чек-ин не было — оценивай только по данным.\n`;
  }

  try {
    const response = await anthropic.messages.create({
      model: config.model,
      max_tokens: 2048,
      system: [{ type: 'text', text: SCORING_PROMPT }],
      messages: [{ role: 'user', content: userMessage }]
    });

    logTokens({
      bot: 'snezhanna',
      type: 'scheduled',
      tools_called: [],
      history_len: 1,
      usage: response.usage
    });

    const text = response.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('');

    // Parse JSON from response, stripping possible markdown fences
    const cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    const result = JSON.parse(cleaned);

    console.log(`[Workload] Scoring complete: ${result.overall_score}/10 (${result.tone})`);
    return result;
  } catch (e) {
    console.error('[Workload] Scoring error:', e.message);
    throw e;
  }
}

// ── History persistence ─────────────────────────────────────────────────────

function loadHistory() {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    }
  } catch (e) {
    console.warn('[Workload] Failed to load history:', e.message);
  }
  return { history: [] };
}

function saveHistory(history, newEntry) {
  try {
    history.history.push(newEntry);
    if (history.history.length > MAX_HISTORY) {
      history.history = history.history.slice(-MAX_HISTORY);
    }
    const dir = path.dirname(HISTORY_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2), 'utf8');
    console.log('[Workload] History saved, entries:', history.history.length);
  } catch (e) {
    console.warn('[Workload] Failed to save history:', e.message);
  }
}

// ── Report building ─────────────────────────────────────────────────────────

function _scoreEmoji(score) {
  if (score <= 3) return '🔴';
  if (score <= 5) return '🟠';
  if (score <= 7) return '🟡';
  if (score <= 9) return '🟢';
  return '💚';
}

function _trendArrow(trend) {
  if (trend === 'up') return '📈';
  if (trend === 'down') return '📉';
  return '➡️';
}

function buildWeeklyReport(scoringResult, history) {
  const s = scoringResult;
  const emoji = _scoreEmoji(s.overall_score);
  const trendArrow = _trendArrow(s.trend);

  let report = `${emoji} Твой недельный обзор, Вова\n\n`;
  report += `Общий скор: ${s.overall_score}/10 ${emoji} ${trendArrow}\n\n`;

  report += `🔵 Работа:       ${s.domains.work.score}/10 — ${s.domains.work.summary}\n`;
  report += `👨‍👩‍👦 Семья:        ${s.domains.family.score}/10 — ${s.domains.family.summary}\n`;
  report += `💪 Здоровье:     ${s.domains.health.score}/10 — ${s.domains.health.summary}\n`;
  report += `🎯 Личное:       ${s.domains.personal.score}/10 — ${s.domains.personal.summary}\n`;

  // Check for consecutive down trend
  const recentScores = history.history.slice(-3);
  const consecutiveDown = recentScores.length >= 2 &&
    recentScores.every(h => h.trend === 'down');

  if (s.key_risks && s.key_risks.length > 0) {
    report += `\n⚠️ ${s.key_risks.join('; ')}`;
  }

  if (s.suggestions && s.suggestions.length > 0) {
    report += '\n\n';
    for (const suggestion of s.suggestions) {
      report += `💡 ${suggestion}\n`;
    }
  }

  if (consecutiveDown) {
    report += '\n📉 Вов, это уже несколько недель подряд вниз. Давай серьёзно подумаем что можно поменять, м?';
  }

  return report;
}

// ── Overload coach for morning briefing ─────────────────────────────────────

async function buildOverloadBlock(lastScore, todayEvents, tomorrowEvents, openTasks) {
  const prompt = OVERLOAD_PROMPT.replace('SCORE', String(lastScore));

  let userMessage = `Текущий скор Вовы: ${lastScore}/10\n\n`;

  userMessage += `## События сегодня\n`;
  if (todayEvents && todayEvents.length > 0) {
    for (const e of todayEvents) {
      const time = e.start?.dateTime
        ? new Date(e.start.dateTime).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: config.timezone })
        : 'весь день';
      userMessage += `• ${e.summary} (${time})\n`;
    }
  } else {
    userMessage += `Нет событий\n`;
  }

  userMessage += `\n## События завтра\n`;
  if (tomorrowEvents && tomorrowEvents.length > 0) {
    for (const e of tomorrowEvents) {
      const time = e.start?.dateTime
        ? new Date(e.start.dateTime).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: config.timezone })
        : 'весь день';
      userMessage += `• ${e.summary} (${time})\n`;
    }
  } else {
    userMessage += `Нет событий\n`;
  }

  userMessage += `\n## Открытые задачи\n`;
  if (openTasks && openTasks.length > 0) {
    for (const t of openTasks.slice(0, 15)) {
      const q = (t.urgent && t.important) ? 'Q1' :
                (t.urgent ? 'Q3' : (t.important ? 'Q2' : 'Q4'));
      const proj = t.project ? ` [${t.project}]` : '';
      const overdue = t.due_date && t.due_date < new Date().toLocaleDateString('sv-SE', { timeZone: config.timezone })
        ? ' ⚠️просрочено' : '';
      userMessage += `• ${t.title}${proj} (${q})${overdue}\n`;
    }
  } else {
    userMessage += `Нет задач\n`;
  }

  try {
    const response = await anthropic.messages.create({
      model: config.model,
      max_tokens: 1024,
      system: [{ type: 'text', text: prompt }],
      messages: [{ role: 'user', content: userMessage }]
    });

    logTokens({
      bot: 'snezhanna',
      type: 'scheduled',
      tools_called: [],
      history_len: 1,
      usage: response.usage
    });

    const text = response.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('');

    if (text && text.trim().length > 10) {
      console.log('[Workload] Overload block generated');
      return text.trim();
    }
    return null;
  } catch (e) {
    console.error('[Workload] Overload block error:', e.message);
    return null;
  }
}

// ── Quick accessor ──────────────────────────────────────────────────────────

function getLastScore() {
  const history = loadHistory();
  if (history.history.length === 0) return null;
  return history.history[history.history.length - 1].overall_score;
}

module.exports = {
  collectData,
  runScoring,
  loadHistory,
  saveHistory,
  buildWeeklyReport,
  buildOverloadBlock,
  getLastScore
};
