'use strict';

const { db } = require('./db');

// Skill domains: each maps to a skill_context:* key in user_settings.
const DOMAINS = [
  { key: 'global',            label: 'Общие инструкции' },
  { key: 'email_poll',        label: 'Почта (автопроверка)' },
  { key: 'morning_briefing',  label: 'Утренний брифинг' },
  { key: 'evening_checkin',   label: 'Вечерний чек-ин' },
  { key: 'calendar_reminder', label: 'Напоминания' },
];

const KEY_PREFIX = 'skill_context:';

function get(domain) {
  try {
    const row = db.prepare('SELECT value FROM user_settings WHERE key = ?').get(KEY_PREFIX + domain);
    return row ? row.value : null;
  } catch (e) {
    console.error('[SkillContext] get error:', e.message);
    return null;
  }
}

function set(domain, text) {
  try {
    if (!text || !text.trim()) {
      db.prepare('DELETE FROM user_settings WHERE key = ?').run(KEY_PREFIX + domain);
    } else {
      db.prepare('INSERT OR REPLACE INTO user_settings (key, value) VALUES (?, ?)').run(KEY_PREFIX + domain, text.trim());
    }
  } catch (e) {
    console.error('[SkillContext] set error:', e.message);
  }
}

// Returns { domain: instruction } for all domains that have instructions set.
function getAll() {
  const result = {};
  for (const { key } of DOMAINS) {
    const val = get(key);
    if (val) result[key] = val;
  }
  return result;
}

function listDomains() {
  return DOMAINS;
}

const PARSE_PROMPT_PREFIX = [
  'Разбери следующую пользовательскую инструкцию для бота-ассистента на per-domain правила.',
  '',
  'Доступные домены:',
  '- global: стиль общения, тон, форматирование — применяется везде',
  '- email_poll: как обрабатывать автоматическую проверку почты и уведомления о письмах',
  '- morning_briefing: что включать/исключать в утреннем брифинге',
  '- evening_checkin: что включать/исключать в вечернем чек-ине',
  '- calendar_reminder: как работать с напоминаниями о событиях',
  '',
  'Верни JSON-объект где ключи — только те домены, для которых в инструкции есть явное правило.',
  'Значения — краткая инструкция для бота на русском, 1-2 предложения. Только JSON без пояснений.',
  '',
  'Инструкция пользователя:',
].join('\n');

// Parses freeform text into per-domain instructions and saves them.
// Only writes domains mentioned in the response — does not clear unmentioned ones.
async function parseAndSave(text) {
  if (!text || !text.trim()) return {};

  const Anthropic = require('@anthropic-ai/sdk');
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const resp = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 512,
    messages: [{ role: 'user', content: PARSE_PROMPT_PREFIX + text }],
  });

  const raw = resp.content[0].text.trim();
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) {
    console.warn('[SkillContext] parseAndSave: no JSON in response');
    return {};
  }

  let parsed;
  try {
    parsed = JSON.parse(match[0]);
  } catch (e) {
    console.error('[SkillContext] parseAndSave: JSON parse error:', e.message);
    return {};
  }

  const validDomains = new Set(DOMAINS.map(d => d.key));
  const saved = {};
  for (const [domain, instruction] of Object.entries(parsed)) {
    if (!validDomains.has(domain)) continue;
    set(domain, instruction);
    saved[domain] = instruction;
    console.log(`[SkillContext] Auto-parsed ${domain}:`, instruction);
  }
  return saved;
}

module.exports = { get, set, getAll, listDomains, parseAndSave, DOMAINS };
