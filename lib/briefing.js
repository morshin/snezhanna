'use strict';

const google = require('./google');
const tasks = require('./tasks');

// Heuristic: sender is a real person/org AND subject/snippet contains '?'
function looksLikeReplyRequest(msg) {
  if (!msg) return false;
  const from = (msg.from || '').toLowerCase();
  const noReplyPatterns = ['noreply', 'no-reply', 'donotreply', 'newsletter', 'notifications', 'mailer', 'bounce'];
  if (noReplyPatterns.some(p => from.includes(p))) return false;
  if (msg.subject && msg.subject.includes('?')) return true;
  if (msg.snippet && msg.snippet.includes('?')) return true;
  return false;
}

// Returns true if there is at least one thing worth saying in the morning briefing
async function hasSomethingToSay() {
  const results = await Promise.allSettled([
    (async () => {
      if (!google.isAuthorized()) return false;
      const events = await google.getCalendarEvents(1);
      const todayStr = new Date().toLocaleDateString('sv-SE', { timeZone: require('../config/nanobot.json').timezone });
      return events.some(e => {
        const d = new Date(e.start.dateTime || e.start.date);
        return d.toLocaleDateString('sv-SE', { timeZone: require('../config/nanobot.json').timezone }) === todayStr;
      });
    })(),

    (async () => {
      const config = require('../config/nanobot.json');
      const todayStr = new Date().toLocaleDateString('sv-SE', { timeZone: config.timezone });
      const tmrw = new Date();
      tmrw.setDate(tmrw.getDate() + 1);
      const tmrwStr = tmrw.toLocaleDateString('sv-SE', { timeZone: config.timezone });
      const upcoming = tasks.getTodayTasks(2);
      return upcoming.some(t => t.due_date && t.due_date <= tmrwStr);
    })(),

    (async () => {
      const config = require('../config/nanobot.json');
      const todayStr = new Date().toLocaleDateString('sv-SE', { timeZone: config.timezone });
      const overdueUrgentImportant = tasks.getTodayTasks(0);
      return overdueUrgentImportant.some(t =>
        t.urgent && t.important && t.due_date && t.due_date < todayStr
      );
    })(),

    (async () => {
      if (!google.isAuthorized()) return false;
      const messages = await google.getGmailMessages(20, true);
      return messages.some(m => looksLikeReplyRequest(m));
    })(),
  ]);

  return results.some(r => r.status === 'fulfilled' && r.value === true);
}

// 0–2 days → 0 (normal), 3–6 → 1 (every other day), 7+ → 2 (full silence)
function computeSilenceLevel(silenceDaysCount) {
  if (silenceDaysCount >= 7) return 2;
  if (silenceDaysCount >= 3) return 1;
  return 0;
}

module.exports = { hasSomethingToSay, computeSilenceLevel, looksLikeReplyRequest };
