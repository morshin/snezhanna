'use strict';

const { db } = require('./db');

const DEFAULTS = {
  preferred_name:      'Вовик',
  formality:           'informal',
  response_style:      'concise',
  briefing_time:       '08:00',
  github_enabled:      'true',
  strava_enabled:      'true',
  email_poll_interval: '30'
};

function get(key) {
  try {
    const row = db.prepare('SELECT value FROM user_settings WHERE key = ?').get(key);
    return row ? row.value : (DEFAULTS[key] ?? null);
  } catch (e) {
    console.error('[Settings] get error:', e.message);
    return DEFAULTS[key] ?? null;
  }
}

function set(key, value) {
  try {
    db.prepare('INSERT OR REPLACE INTO user_settings (key, value) VALUES (?, ?)').run(key, String(value));
  } catch (e) {
    console.error('[Settings] set error:', e.message);
  }
}

function getAll() {
  try {
    const rows = db.prepare('SELECT key, value FROM user_settings').all();
    const result = { ...DEFAULTS };
    for (const row of rows) {
      result[row.key] = row.value;
    }
    return result;
  } catch (e) {
    console.error('[Settings] getAll error:', e.message);
    return { ...DEFAULTS };
  }
}

function getSystemPromptBlock() {
  const name  = get('preferred_name')  || DEFAULTS.preferred_name;
  const form  = get('formality')       || DEFAULTS.formality;
  const style = get('response_style')  || DEFAULTS.response_style;

  return `## User Preferences\n- Address as: ${name}\n- Formality: ${form}\n- Response style: ${style}`;
}

module.exports = { get, set, getAll, getSystemPromptBlock, DEFAULTS };
