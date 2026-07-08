'use strict';

// Pure scheduling helpers, extracted out of index.js so they're testable
// without booting the bot (cron, Telegram, timers).

// Normalizes a raw email_poll_interval setting value into a safe cron plan.
// node-cron's minute-step field only accepts 1..59, so this is the single
// choke point protecting against the crash this used to cause: `*/0 * * * *`
// (or any non-positive/non-numeric value) threw and crash-looped the process.
function normalizePollInterval(raw) {
  const interval = parseInt(raw, 10);
  if (!Number.isInteger(interval) || interval <= 0) {
    return { disabled: true };
  }
  if (interval >= 60) {
    return { cron: '0 * * * *', minutes: 60 };
  }
  const minutes = Math.max(interval, 5);
  return { cron: `*/${minutes} * * * *`, minutes };
}

// Pure boundary check for a HH:MM "is it within work hours" window.
// Handles overnight ranges (e.g. 22:00–06:00) where start > end.
function isWithinHours(nowStr, start, end) {
  if (start <= end) return nowStr >= start && nowStr < end;
  return nowStr >= start || nowStr < end;
}

module.exports = { normalizePollInterval, isWithinHours };
