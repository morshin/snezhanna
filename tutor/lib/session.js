'use strict';

let current = null;

function startSession(subject) {
  current = {
    startTime: new Date(),
    subject: subject || 'General',
    topics: [],
    stuck: [],
    mood: 'neutral',
    messages: [],
    lastActivity: Date.now()
  };
  return current;
}

function endSession() {
  if (!current) return null;
  const data = { ...current, endTime: new Date() };
  current = null;
  return data;
}

function isActive() {
  return current !== null;
}

function addMessage(role, content, meta = {}) {
  if (!current) return;
  const entry = { role, content };
  if (meta.message_id) entry.message_id = meta.message_id;
  if (meta.reply_to_message_id) entry.reply_to_message_id = meta.reply_to_message_id;
  current.messages.push(entry);
  current.lastActivity = Date.now();
}

function getHistory() {
  if (!current) return [];
  // L-2: возвращаем копию массива чтобы внешний код не мог случайно мутировать историю
  return [...current.messages];
}

function getContext() {
  if (!current) return '';
  const duration = Math.round((Date.now() - current.startTime.getTime()) / 60000);
  return [
    `Sesión activa: ${current.subject} (${duration} min)`,
    current.topics.length ? `Temas tratados: ${current.topics.join(', ')}` : '',
    current.stuck.length ? `Dificultades: ${current.stuck.join(', ')}` : '',
    `Estado de ánimo: ${current.mood}`
  ].filter(Boolean).join('\n');
}

function getLastActivityTime() {
  return current ? current.lastActivity : 0;
}

function updateMood(mood) {
  if (current) current.mood = mood;
}

function addTopic(topic) {
  if (current && !current.topics.includes(topic)) {
    current.topics.push(topic);
  }
}

function addStuck(item) {
  if (current) current.stuck.push(item);
}

function getSession() {
  return current;
}

module.exports = {
  startSession, endSession, isActive,
  addMessage, getHistory, getContext,
  getLastActivityTime, updateMood, addTopic, addStuck,
  getSession
};
