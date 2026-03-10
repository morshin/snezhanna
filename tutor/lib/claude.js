'use strict';

const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const identity = fs.readFileSync(path.join(__dirname, '..', 'identity', 'IDENTITY.md'), 'utf8');

// M-1: читаем из общего конфига чтобы не дублировать значения
const config = require('../../config/nanobot.json');
const MAX_MESSAGES = config.history.max_messages;
const KEEP_LAST = config.history.keep_last;
const MODEL = config.model;
const MAX_TOKENS = config.max_tokens;

function nowStr() {
  return new Date().toLocaleString('es-ES', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
    timeZone: 'Europe/Madrid'
  });
}

function trimHistory(history) {
  if (history.length <= MAX_MESSAGES) return history;
  let sliceAt = history.length - KEEP_LAST;
  while (sliceAt > 0 && history[sliceAt].role !== 'user') {
    sliceAt--;
  }
  return history.slice(sliceAt);
}

function buildHomeworkContext(pendingHomework) {
  if (!pendingHomework || pendingHomework.length === 0) return '';
  const list = pendingHomework
    .map(t => `• [${t.id}] ${t.subject}: ${t.description}${t.due ? ` (para el ${t.due})` : ''}`)
    .join('\n');
  return (
    'Deberes pendientes del alumno:\n' + list + '\n\n' +
    'Si el alumno menciona que ya terminó alguno de estos deberes, escribe [DONE:ID] ' +
    'al principio de tu respuesta (antes del texto normal), donde ID es el identificador ' +
    'exacto de la tarea. Ejemplo: [DONE:hw_1741521600000]. ' +
    'El alumno no ve estos marcadores — son solo para el sistema.'
  );
}

async function askMax(history, sessionContext, pendingHomework) {
  const system = [
    { type: 'text', text: `Ahora: ${nowStr()} (Europe/Madrid).` },
    { type: 'text', text: identity, cache_control: { type: 'ephemeral' } }
  ];
  if (sessionContext) {
    system.push({ type: 'text', text: sessionContext });
  }
  const hwContext = buildHomeworkContext(pendingHomework);
  if (hwContext) {
    system.push({ type: 'text', text: hwContext });
  }

  const trimmed = trimHistory(history);

  try {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system,
      messages: trimmed
    });

    if (response.usage?.cache_read_input_tokens) {
      console.log(`[Cache] hit: ${response.usage.cache_read_input_tokens} tokens cached`);
    }

    const textBlocks = response.content.filter(b => b.type === 'text');
    return textBlocks.map(b => b.text).join('\n') || '';
  } catch (err) {
    console.error('[Claude] Error:', err.message);
    throw err;
  }
}

async function askMaxOneShot(systemPrompt, userPrompt) {
  try {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }]
    });

    const textBlocks = response.content.filter(b => b.type === 'text');
    return textBlocks.map(b => b.text).join('\n') || '';
  } catch (err) {
    console.error('[Claude] OneShot error:', err.message);
    throw err;
  }
}

module.exports = { askMax, askMaxOneShot };
