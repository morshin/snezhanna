'use strict';

const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const { logTokens } = require('../../lib/token-log');
const identity = fs.readFileSync(path.join(__dirname, '..', 'identity', 'IDENTITY.md'), 'utf8');
const langWeek = require('./lang-week');
const storage = require('./storage');

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

function buildLangBlock() {
  const lang = langWeek.getCurrentLang();
  if (lang === 'ru') {
    return 'ЯЗЫК ЭТОЙ НЕДЕЛИ: РУССКИЙ. Общайся по-русски. Если ученик пишет на испанском без явной просьбы — похвали за испанский и мягко верни к русскому.';
  }
  return 'LANGUAGE THIS WEEK: SPANISH. Always respond in Spanish. If the student writes in Russian without an explicit request — gently remind them to use Spanish.';
}

async function askMax(history, sessionContext, pendingHomework, requestType = 'text') {
  const lang = langWeek.getCurrentLang();
  const system = [
    { type: 'text', text: `Сейчас: ${nowStr()} (Europe/Madrid). Язык недели: ${lang === 'ru' ? 'русский' : 'испанский'}.` },
    { type: 'text', text: buildLangBlock() },
    { type: 'text', text: identity, cache_control: { type: 'ephemeral' } }
  ];
  if (sessionContext) {
    system.push({ type: 'text', text: sessionContext });
  }
  const hwContext = buildHomeworkContext(pendingHomework);
  if (hwContext) {
    system.push({ type: 'text', text: hwContext });
  }

  const activeQuests = storage.getActiveQuests();
  if (activeQuests.length > 0) {
    const questContext = `[Sistema: misiones activas del padre]\n` +
      activeQuests.map(q => `ID:${q.id} | ${q.subject}: ${q.description} (+${q.reward_minutes} min)`).join('\n');
    system.push({ type: 'text', text: questContext });
  }

  const trimmed = trimHistory(history);

  try {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system,
      messages: trimmed.map(({ role, content }) => ({ role, content }))
    });

    if (response.usage?.cache_read_input_tokens) {
      console.log(`[Cache] hit: ${response.usage.cache_read_input_tokens} tokens cached`);
    }

    logTokens({
      bot: 'max',
      type: requestType,
      tools_called: [],
      history_len: trimmed.length,
      usage: response.usage
    });

    const textBlocks = response.content.filter(b => b.type === 'text');
    return textBlocks.map(b => b.text).join('\n') || '';
  } catch (err) {
    console.error('[Claude] Error:', err.message);
    throw err;
  }
}

async function askMaxOneShot(systemPrompt, userPrompt, requestType = 'scheduled') {
  try {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }]
    });

    logTokens({
      bot: 'max',
      type: requestType,
      tools_called: [],
      history_len: 1,
      usage: response.usage
    });

    const textBlocks = response.content.filter(b => b.type === 'text');
    return textBlocks.map(b => b.text).join('\n') || '';
  } catch (err) {
    console.error('[Claude] OneShot error:', err.message);
    throw err;
  }
}

// Отвечает на свободный вопрос родителя по-русски, с контекстом сессий и прогресса
async function askParent(question) {
  // Собираем контекст: прогресс, последние 14 дней сессий, ДЗ
  const progress = storage.readProgress();
  const sessionDates = storage.listSessionDates().slice(0, 14);
  const sessionParts = sessionDates.map(d => {
    const md = storage.readSessionReport(d);
    return md ? `### ${d}\n${md}` : null;
  }).filter(Boolean);
  const hw = storage.loadHomework();
  const pending = hw.tasks.filter(t => !t.done);

  const contextParts = [];
  if (progress) contextParts.push(`## Прогресс ученика\n${progress}`);
  if (sessionParts.length > 0) contextParts.push(`## Сессии (последние ${sessionParts.length} дней)\n${sessionParts.join('\n\n')}`);
  if (pending.length > 0) {
    const hwList = pending.map(t => `• ${t.subject}: ${t.description}${t.due ? ` (до ${t.due})` : ''}`).join('\n');
    contextParts.push(`## Невыполненные домашние задания\n${hwList}`);
  } else {
    contextParts.push('## Домашние задания\nНевыполненных заданий нет.');
  }

  const systemPrompt = `Ты помощник-тьютор бота Макс. Ты общаешься с отцом ученика (13 лет, испанская школа в Мадриде).
Отвечай на русском языке. Будь конкретен, дружелюбен, по делу.
Используй только информацию из предоставленного контекста — не придумывай факты.
Если информации недостаточно, честно скажи об этом.
Сейчас: ${nowStr()} (Europe/Madrid).

${contextParts.join('\n\n')}`;

  return askMaxOneShot(systemPrompt, question, 'parent_query');
}

async function askMaxOneShotWithImage(systemPrompt, userText, imageBase64, mimeType, requestType = 'parent_photo') {
  try {
    const content = [
      { type: 'image', source: { type: 'base64', media_type: mimeType, data: imageBase64 } }
    ];
    if (userText) {
      content.push({ type: 'text', text: userText });
    }
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: systemPrompt,
      messages: [{ role: 'user', content }]
    });

    logTokens({
      bot: 'max',
      type: requestType,
      tools_called: [],
      history_len: 1,
      usage: response.usage
    });

    const textBlocks = response.content.filter(b => b.type === 'text');
    return textBlocks.map(b => b.text).join('\n') || '';
  } catch (err) {
    console.error('[Claude] OneShotWithImage error:', err.message);
    throw err;
  }
}

module.exports = { askMax, askMaxOneShot, askMaxOneShotWithImage, askParent };
