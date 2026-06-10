'use strict';

const { db } = require('./db');

const VALID_CATEGORIES = ['health', 'kids', 'finance', 'bureaucracy', 'decisions', 'project'];

async function readMemory(category) {
  if (!VALID_CATEGORIES.includes(category)) {
    return { error: `Invalid category: ${category}. Valid: ${VALID_CATEGORIES.join(', ')}` };
  }

  const rows = db.prepare(
    'SELECT content FROM memory WHERE category = ? ORDER BY updated_at DESC'
  ).all(category);

  if (rows.length === 0) {
    return { category, content: '', note: 'No entries yet' };
  }

  const content = rows.map(r => r.content).join('\n\n---\n\n');
  return { category, content };
}

async function writeMemory(category, content, mode = 'append') {
  if (!VALID_CATEGORIES.includes(category)) {
    return { error: `Invalid category: ${category}. Valid: ${VALID_CATEGORIES.join(', ')}` };
  }

  if (mode === 'overwrite') {
    const del = db.prepare('DELETE FROM memory WHERE category = ?');
    const ins = db.prepare(
      "INSERT INTO memory (category, content, updated_at) VALUES (?, ?, datetime('now'))"
    );
    db.transaction(() => {
      del.run(category);
      ins.run(category, content);
    })();
  } else {
    db.prepare(
      "INSERT INTO memory (category, content, updated_at) VALUES (?, ?, datetime('now'))"
    ).run(category, content);
  }

  return { saved: true, category, mode };
}

module.exports = { readMemory, writeMemory, VALID_CATEGORIES };
