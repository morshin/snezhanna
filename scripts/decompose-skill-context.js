'use strict';

require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const { db } = require('../lib/db');
const skillContext = require('../lib/skill-context');

async function main() {
  const row = db.prepare("SELECT value FROM user_settings WHERE key = 'character_notes'").get();
  if (!row) {
    console.log('character_notes not set, nothing to decompose');
    return;
  }

  const text = row.value;
  console.log('character_notes:\n', text, '\n');

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const prompt = [
    'Разбери следующую пользовательскую инструкцию для бота-ассистента на per-domain правила.',
    '',
    'Доступные домены:',
    '- global: стиль общения, тон, форматирование — применяется везде',
    '- email_poll: как обрабатывать автоматическую проверку почты и уведомления о письмах',
    '- morning_briefing: что включать/исключать в утреннем брифинге',
    '- evening_checkin: что включать/исключать в вечернем чек-ине',
    '- calendar_reminder: как работать с напоминаниями о событиях',
    '',
    'Инструкция пользователя:',
    text,
    '',
    'Верни JSON-объект где ключи — только те домены, для которых в инструкции есть релевантное правило.',
    'Значения — краткая инструкция для бота на русском, 1-2 предложения. Только JSON без пояснений.',
  ].join('\n');

  const resp = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 512,
    messages: [{ role: 'user', content: prompt }],
  });

  const raw = resp.content[0].text.trim();
  console.log('Claude:\n', raw, '\n');

  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) {
    console.error('No JSON found in response');
    process.exit(1);
  }

  const parsed = JSON.parse(match[0]);
  const validDomains = new Set(skillContext.listDomains().map(d => d.key));

  for (const [domain, instruction] of Object.entries(parsed)) {
    if (!validDomains.has(domain)) {
      console.warn('Unknown domain, skipping:', domain);
      continue;
    }
    skillContext.set(domain, instruction);
    console.log(`Saved skill_context:${domain} =>`, instruction);
  }

  console.log('\nDone.');
}

main().catch(e => { console.error(e); process.exit(1); });
