'use strict';

const { db } = require('./db');

// Build lookup map from SQLite on startup; fall back to config if table is empty
function buildChatMap() {
  try {
    const rows = db.prepare('SELECT * FROM monitored_chats').all();
    if (rows.length > 0) {
      const map = new Map();
      for (const row of rows) map.set(row.chat_id, row);
      return map;
    }
  } catch (e) {
    console.error('[ChatMonitor] Failed to load from SQLite:', e.message);
  }
  // Fallback: seed from config (first run before migration)
  const config = require('./config');
  const chats = (config.chat_monitor && config.chat_monitor.chats) || [];
  const map = new Map();
  for (const chat of chats) map.set(chat.chat_id, chat);
  return map;
}

const chatMap = buildChatMap();

// In-memory message store (cleared after evening check-in or restart)
const messages = [];

function isMonitored(chatId) {
  return chatMap.has(chatId);
}

function addMessage(chatId, from, text, date) {
  const chat = chatMap.get(chatId);
  if (!chat) return;

  messages.push({
    chatId,
    chatName: chat.name,
    type: chat.type,
    project: chat.project || null,
    category: chat.category || null,
    from,
    text,
    date
  });

  console.log(`[ChatMonitor] ${chat.name}: ${from}: ${text.slice(0, 80)}`);
}

function addChat(chat) {
  try {
    db.prepare(`
      INSERT OR REPLACE INTO monitored_chats (chat_id, name, type, category, project)
      VALUES (?, ?, ?, ?, ?)
    `).run(chat.chat_id, chat.name, chat.type || 'personal', chat.category || null, chat.project || null);
    chatMap.set(chat.chat_id, chat);
    console.log('[ChatMonitor] Added chat:', chat.name);
  } catch (e) {
    console.error('[ChatMonitor] addChat error:', e.message);
    throw e;
  }
}

function removeChat(chatId) {
  try {
    db.prepare('DELETE FROM monitored_chats WHERE chat_id = ?').run(chatId);
    chatMap.delete(chatId);
    console.log('[ChatMonitor] Removed chat:', chatId);
  } catch (e) {
    console.error('[ChatMonitor] removeChat error:', e.message);
    throw e;
  }
}

function listChats() {
  return db.prepare('SELECT * FROM monitored_chats ORDER BY name').all();
}

function getDigest(filter) {
  let filtered = messages;

  if (filter) {
    if (filter.type && filter.type !== 'all') {
      filtered = filtered.filter(m => m.type === filter.type);
    }
    if (filter.chatName) {
      const name = filter.chatName.toLowerCase();
      filtered = filtered.filter(m => m.chatName.toLowerCase().includes(name));
    }
  }

  if (filtered.length === 0) return null;

  // Group by chat
  const grouped = new Map();
  for (const msg of filtered) {
    if (!grouped.has(msg.chatName)) {
      grouped.set(msg.chatName, { type: msg.type, project: msg.project, category: msg.category, messages: [] });
    }
    const time = new Date(msg.date * 1000).toLocaleTimeString('ru-RU', {
      hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Madrid'
    });
    grouped.get(msg.chatName).messages.push(`[${time}] ${msg.from}: ${msg.text}`);
  }

  const sections = [];
  for (const [chatName, data] of grouped) {
    const typeLabel = data.type === 'work' ? '💼' : '👨‍👩‍👧‍👦';
    sections.push(`${typeLabel} ${chatName}\n${data.messages.join('\n')}`);
  }

  return sections.join('\n\n');
}

function getDigestForChat(chatId) {
  const chat = chatMap.get(chatId);
  if (!chat) return null;
  return getDigest({ chatName: chat.name });
}

function clear() {
  messages.length = 0;
}

function getStats() {
  const stats = {};
  for (const msg of messages) {
    stats[msg.chatName] = (stats[msg.chatName] || 0) + 1;
  }
  return stats;
}

module.exports = { isMonitored, addMessage, addChat, removeChat, listChats, getDigest, getDigestForChat, clear, getStats };
