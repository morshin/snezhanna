'use strict';

const fs = require('fs');
const path = require('path');

const config = JSON.parse(fs.readFileSync(path.join(__dirname, '../config/nanobot.json'), 'utf8'));
const INDEX_FILE = config.yadisk.index_file;
const READONLY_MOUNT = config.yadisk.readonly_mount;

function searchFiles(query) {
  if (!fs.existsSync(INDEX_FILE)) {
    return { results: [], error: 'File index not found. Run indexer first.' };
  }

  const index = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);

  const scored = [];
  for (const file of index) {
    const haystack = `${file.name || ''} ${file.path || ''} ${(file.keywords || []).join(' ')}`.toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (haystack.includes(term)) score++;
    }
    if (score > 0) {
      scored.push({ ...file, _score: score });
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
