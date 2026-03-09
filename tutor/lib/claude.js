'use strict';

const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const identity = fs.readFileSync(path.join(__dirname, '..', 'identity', 'IDENTITY.md'), 'utf8');

const MAX_MESSAGES = 40;
const KEEP_LAST = 30;
const MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS = 4096;

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

async function askMax(history, sessionContext) {
  const systemParts = [
    `Ahora: ${nowStr()} (Europe/Madrid).`,
    identity,
    sessionContext || ''
  ].filter(Boolean);

  const trimmed = trimHistory(history);

  try {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: systemParts.join('\n\n'),
      messages: trimmed
    });

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
