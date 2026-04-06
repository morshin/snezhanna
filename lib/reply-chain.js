'use strict';

const MAX_CHAIN_DEPTH = 5;
const MAX_MESSAGE_LENGTH = 500;
const MAX_CONTEXT_LENGTH = 2000;

function truncate(text, limit) {
  if (!text || text.length <= limit) return text;
  return text.slice(0, limit - 1) + '…';
}

function senderLabel(msg, botUsername) {
  if (!msg) return '?';
  if (msg.from && msg.from.is_bot) return botUsername || 'Бот';
  if (msg.from && msg.from.first_name) return msg.from.first_name;
  return 'Пользователь';
}

function extractText(msg) {
  if (!msg) return null;
  return msg.text || msg.caption || null;
}

/**
 * Build reply context string from a Telegram message and in-memory history.
 *
 * @param {object} msg - Telegram message object
 * @param {Array}  history - Array of { role, content, message_id? } entries
 * @param {object} [opts]
 * @param {string} [opts.botName] - Display name for the bot in quotes (default "Бот")
 * @param {string} [opts.userName] - Display name for the user (default "Пользователь")
 * @returns {string|null} - Formatted context block or null if no reply
 */
function buildReplyContext(msg, history, opts = {}) {
  if (!msg || !msg.reply_to_message) return null;

  const botName = opts.botName || 'Бот';
  const userName = opts.userName || 'Пользователь';

  const chain = buildChain(msg.reply_to_message, history, botName, userName);
  if (chain.length === 0) return null;

  // If user selected a specific quote, use it for the immediate parent
  if (msg.quote && msg.quote.text && chain.length > 0) {
    chain[chain.length - 1].text = msg.quote.text;
  }

  // Format the context block
  let block;
  if (chain.length === 1) {
    const entry = chain[0];
    block = `[Ответ на сообщение]\n> ${entry.sender}: ${truncate(entry.text, MAX_MESSAGE_LENGTH)}`;
  } else {
    const lines = chain.map((entry, i) =>
      `> (${i + 1}) ${entry.sender}: ${truncate(entry.text, MAX_MESSAGE_LENGTH)}`
    );
    block = `[Цепочка сообщений]\n${lines.join('\n')}`;
  }

  return truncate(block, MAX_CONTEXT_LENGTH);
}

/**
 * Walk the reply chain: start from reply_to_message, then try to extend
 * deeper using message_id lookups in history.
 */
function buildChain(replyMsg, history, botName, userName) {
  const chain = [];
  if (!replyMsg) return chain;

  const text = extractText(replyMsg);
  if (!text) return chain;

  const sender = replyMsg.from && replyMsg.from.is_bot ? botName : userName;
  chain.push({ sender, text, message_id: replyMsg.message_id });

  // Telegram only nests one level of reply_to_message — for deeper chains
  // we look up parent message_ids in our in-memory history
  if (history && history.length > 0 && replyMsg.message_id) {
    extendChainFromHistory(chain, replyMsg.message_id, history, botName, userName);
  }

  // chain is built newest-first; reverse so oldest is first
  chain.reverse();
  return chain;
}

/**
 * Extend the chain by walking backwards through history looking for
 * messages that were replies to each other (tracked via reply_to_message_id).
 */
function extendChainFromHistory(chain, startMessageId, history, botName, userName) {
  const byMessageId = new Map();
  for (const entry of history) {
    if (entry.message_id) {
      byMessageId.set(entry.message_id, entry);
    }
  }

  let currentEntry = byMessageId.get(startMessageId);
  let depth = 1; // already have 1 from the direct reply_to_message

  while (currentEntry && depth < MAX_CHAIN_DEPTH) {
    if (!currentEntry.reply_to_message_id) break;

    const parentEntry = byMessageId.get(currentEntry.reply_to_message_id);
    if (!parentEntry) break;

    const text = typeof parentEntry.content === 'string'
      ? parentEntry.content
      : (Array.isArray(parentEntry.content) ? '[медиа]' : String(parentEntry.content));

    const sender = parentEntry.role === 'assistant' ? botName : userName;
    chain.push({ sender, text, message_id: parentEntry.message_id });

    currentEntry = parentEntry;
    depth++;
  }
}

module.exports = { buildReplyContext };
