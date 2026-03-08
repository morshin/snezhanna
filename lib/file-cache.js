'use strict';

// Временный кэш файлов, полученных через Telegram.
// Буфер хранится в памяти до тех пор, пока Claude не сохранит файл на диск,
// или до истечения TTL — чтобы не держать память вечно.

const TTL_MS = 60 * 60 * 1000; // 1 час

const cache = new Map();

function set(key, buffer, filename, mimeType) {
  cache.set(key, { buffer, filename, mimeType, createdAt: Date.now() });
}

function get(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.createdAt > TTL_MS) {
    cache.delete(key);
    return null;
  }
  return entry;
}

function remove(key) {
  cache.delete(key);
}

// Удаляем устаревшие записи каждые 10 минут
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of cache.entries()) {
    if (now - entry.createdAt > TTL_MS) {
      cache.delete(key);
    }
  }
}, 10 * 60 * 1000);

module.exports = { set, get, remove };
