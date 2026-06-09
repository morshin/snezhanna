'use strict';

const fs = require('fs');
const path = require('path');

const ANALYTICS_DIR = path.join(__dirname, '../data/analytics');
if (!fs.existsSync(ANALYTICS_DIR)) fs.mkdirSync(ANALYTICS_DIR, { recursive: true });

function getFilePath() {
  const month = new Date().toISOString().slice(0, 7); // "2026-03"
  return path.join(ANALYTICS_DIR, `tokens-${month}.json`);
}

/**
 * Append one token usage entry to the current month's NDJSON file.
 * Never throws — all errors are silently caught.
 */
function logTokens(entry) {
  try {
    const line = JSON.stringify({
      ts: Date.now(),
      bot: entry.bot,
      type: entry.type,
      tools_called: entry.tools_called || [],
      history_len: entry.history_len || 0,
      usage: entry.usage || {}
    });
    fs.appendFileSync(getFilePath(), line + '\n', 'utf8');
  } catch (err) {
    console.error('[TokenLog] Write error:', err.message);
  }
}

/**
 * Read and parse NDJSON for the given month.
 * Returns [] on missing file or parse errors.
 */
function readMonthLog(year, month) {
  try {
    const mm = String(month).padStart(2, '0');
    const filePath = path.join(ANALYTICS_DIR, `tokens-${year}-${mm}.json`);
    if (!fs.existsSync(filePath)) return [];
    const data = fs.readFileSync(filePath, 'utf8');
    const entries = [];
    for (const line of data.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        entries.push(JSON.parse(trimmed));
      } catch (_) {
        // skip malformed lines
      }
    }
    return entries;
  } catch (err) {
    console.error('[TokenLog] Read error:', err.message);
    return [];
  }
}

module.exports = { logTokens, readMonthLog };
