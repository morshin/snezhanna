'use strict';

const { db } = require('./db');
const config = require('./config');

const DEFAULTS = {
  preferred_name:      config.user?.name || 'шеф',
  formality:           'informal',
  response_style:      'concise',
  briefing_time:       '08:00',
  briefing_enabled:    'true',
  checkin_enabled:     'true',
  weekends_enabled:    'true',
  github_enabled:      'true',
  strava_enabled:      'true',
  email_poll_interval: '30',
  work_hours_start:    '09:00',
  work_hours_end:      '22:00'
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

const GENDER_LABELS = {
  female:  'женский (к пользователю — «ты сделала», «ты написала», «ты молодец»)',
  male:    'мужской (к пользователю — «ты сделал», «ты написал», «ты молодец»)',
  neutral: 'нейтральный (избегай родовых форм там, где можно)',
};

function getSettingsBlock() {
  const name   = get('preferred_name')  || DEFAULTS.preferred_name;
  const form   = get('formality')       || DEFAULTS.formality;
  const style  = get('response_style')  || DEFAULTS.response_style;
  const notes  = get('character_notes');
  const persona = get('bot_persona');
  const traits  = get('bot_traits');
  const userGender = get('user_gender');

  const nameVariants = name.split(',').map(s => s.trim()).filter(Boolean);
  const nameStr = nameVariants.length > 1
    ? `один из вариантов: ${nameVariants.join(' / ')}`
    : name;

  // These settings override anything stated in the identity text above
  let block = `## Настройки (приоритет выше текста личности выше)\n- Обращение к пользователю (${nameStr})\n- Формальность: ${form}\n- Стиль ответов: ${style}`;
  if (userGender) block += `\n- Род пользователя: ${GENDER_LABELS[userGender] || userGender}`;
  if (persona) block += `\n- Образ ассистента: ${persona} — этот образ заменяет любое описание личности из текста выше`;
  if (traits)  block += `\n- Ключевые черты: ${traits}`;
  if (notes)   block += `\n- Дополнительно: ${notes}`;
  return block;
}

function getIdentityWithSettings(defaultIdentity) {
  const identity = get('identity') || defaultIdentity;
  return `${identity}\n\n${getSettingsBlock()}`;
}

function getIdentity(defaultIdentity) {
  return get('identity') || defaultIdentity;
}

module.exports = { get, set, getAll, getSettingsBlock, getIdentity, getIdentityWithSettings, DEFAULTS };
