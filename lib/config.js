'use strict';

function bool(val, def) {
  if (val === 'false' || val === '0') return false;
  if (val === 'true'  || val === '1') return true;
  return def;
}
function int(val, def) {
  const n = parseInt(val, 10);
  return isNaN(n) ? def : n;
}
function float(val, def) {
  const n = parseFloat(val);
  return isNaN(n) ? def : n;
}
function parseRepos() {
  try { return JSON.parse(process.env.GITHUB_REPOS || '[]'); }
  catch { return []; }
}

module.exports = {
  model:       process.env.CLAUDE_MODEL                    || 'claude-sonnet-4-6',
  max_tokens:  int(process.env.CLAUDE_MAX_TOKENS, 4096),
  temperature: float(process.env.CLAUDE_TEMPERATURE, 1.0),
  timezone:    process.env.TIMEZONE                        || 'Europe/Madrid',
  language:    'ru',

  user: {
    name:           process.env.USER_NAME       || 'шеф',
    assistant_name: process.env.ASSISTANT_NAME  || 'Снежанна',
  },

  history: {
    max_messages: int(process.env.HISTORY_MAX_MESSAGES, 40),
    keep_last:    int(process.env.HISTORY_KEEP_LAST, 30),
  },

  integrations: {
    strava:       bool(process.env.INTEGRATIONS_STRAVA,        true),
    github:       bool(process.env.INTEGRATIONS_GITHUB,        true),
    chat_monitor: bool(process.env.INTEGRATIONS_CHAT_MONITOR,  true),
  },

  gdrive: {
    root_folder: process.env.GDRIVE_ROOT_FOLDER || 'Снежанна',
  },

  voice: {
    transcription_model:    'whisper-1',
    transcription_language: 'ru',
    tts_model:              'tts-1',
    tts_voice:              process.env.VOICE_TTS_VOICE || 'nova',
  },

  mini_app: {
    port: int(process.env.MINI_APP_PORT, 3001),
  },

  database: {
    path: process.env.DATABASE_PATH || 'data/snezhanna.db',
  },

  github: {
    milestone_due_within_days: int(process.env.GITHUB_MILESTONE_DAYS, 14),
    repos:     parseRepos(),
    self_repo: process.env.GITHUB_SELF_REPO || 'morshin/snezhanna',
    app_id:    process.env.GITHUB_APP_ID    || '',
  },

  chat_monitor: {
    chats: [],
  },
};
