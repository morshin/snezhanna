'use strict';

const fs = require('fs');
const path = require('path');

const config = JSON.parse(fs.readFileSync(path.join(__dirname, '../config/nanobot.json'), 'utf8'));
const READONLY_MOUNT = config.yadisk.readonly_mount;
const { db } = require('./db');

function searchFiles(query) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return { results: [], total: 0 };

  const countRow = db.prepare('SELECT COUNT(*) AS cnt FROM file_index').get();
  if (!countRow || countRow.cnt === 0) {
    return { results: [], error: 'File index is empty. Run indexer first.' };
  }

  // Score each row in memory: SQLite LIKE for each term
  const rows = db.prepare('SELECT * FROM file_index').all();
  const scored = [];
  for (const file of rows) {
    const keywords = file.keywords ? JSON.parse(file.keywords) : [];
    const haystack = `${file.name || ''} ${file.path || ''} ${keywords.join(' ')}`.toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (haystack.includes(term)) score++;
    }
    if (score > 0) {
      const { keywords: _kw, ...rest } = file;
      scored.push({ ...rest, keywords, _score: score });
    }
  }

  scored.sort((a, b) => b._score - a._score);
  const results = scored.slice(0, 20).map(({ _score, ...rest }) => rest);
  return { results, total: scored.length };
}

function readFile(relativePath) {
  // Security: prevent path traversal
  const normalized = path.normalize(relativePath);
  if (normalized.startsWith('..') || path.isAbsolute(normalized)) {
    return { error: 'Invalid path: traversal not allowed' };
  }

  const fullPath = path.join(READONLY_MOUNT, normalized);
  // Double-check the resolved path is still under the mount
  if (!fullPath.startsWith(READONLY_MOUNT)) {
    return { error: 'Invalid path: outside mount boundary' };
  }

  if (!fs.existsSync(fullPath)) {
    return { error: `File not found: ${relativePath}` };
  }

  const stat = fs.statSync(fullPath);
  if (stat.size > 100 * 1024) {
    return { error: `File too large: ${(stat.size / 1024).toFixed(0)}KB (limit 100KB)` };
  }

  const content = fs.readFileSync(fullPath, 'utf8');
  return {
    path: relativePath,
    size: stat.size,
    content: content.slice(0, 10000)
  };
}

module.exports = { searchFiles, readFile };
