'use strict';

const fs = require('fs');
const path = require('path');

const config = JSON.parse(fs.readFileSync(path.join(__dirname, '../config/nanobot.json'), 'utf8'));
const monitoredChats = (config.chat_monitor && config.chat_monitor.chats) || [];

// Build lookup map: chatId → chat config
const chatMap = new Map();
for (const chat of monitoredChats) {
  chatMap.set(chat.chat_id, chat);
}

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
    const header = `${typeLabel} ${chatName}`;
    const body = data.messages.join('\n');
    sections.push(`${header}\n${body}`);
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

module.exports = { isMonitored, addMessage, getDigest, getDigestForChat, clear, getStats };
