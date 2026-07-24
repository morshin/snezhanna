'use strict';

const { db } = require('./db');

const insertArchive = db.prepare(`
  INSERT INTO archive (source_type, chat_id, chat_name, project, from_name, subject, content, message_id, account_id, timestamp)
  VALUES (@source_type, @chat_id, @chat_name, @project, @from_name, @subject, @content, @message_id, @account_id, @timestamp)
`);

const insertFts = db.prepare(`
  INSERT INTO archive_fts (rowid, content, subject, chat_name, from_name) VALUES (?, ?, ?, ?, ?)
`);

const addEntryTx = db.transaction((entry) => {
  const info = insertArchive.run({
    source_type: entry.source_type,
    chat_id: entry.chat_id ?? null,
    chat_name: entry.chat_name ?? null,
    project: entry.project ?? null,
    from_name: entry.from_name ?? null,
    subject: entry.subject ?? null,
    content: entry.content,
    message_id: entry.message_id ?? null,
    account_id: entry.account_id ?? null,
    timestamp: entry.timestamp
  });
  insertFts.run(info.lastInsertRowid, entry.content, entry.subject || '', entry.chat_name || '', entry.from_name || '');
  return info.lastInsertRowid;
});

// Writes into the long-term archive. Never throws — archiving must never break
// the actual message flow (chat reply, monitored-chat ingestion, email poll).
function addEntry(entry) {
  if (!entry || typeof entry.content !== 'string' || !entry.content.trim()) return null;
  try {
    return addEntryTx(entry);
  } catch (e) {
    console.error('[Archive] addEntry error:', e.message);
    return null;
  }
}

// Sanitizes free-text search input into a safe FTS5 MATCH expression: strips
// quote characters (so raw user phrasing can't break the query), then wraps
// each token in double quotes — this both escapes any remaining FTS5 syntax
// characters (^*():-, reserved keywords like OR/AND/NOT) and, combined with
// the trailing *, prefix-matches the token as a literal string. Prefix
// matching on Russian words still catches most inflected forms, since
// suffixes are appended after the stem (e.g. "проект"* matches "проектом").
function buildMatchQuery(query) {
  const tokens = (query || '')
    .split(/\s+/)
    .map(t => t.replace(/"/g, ''))
    .filter(t => t.length >= 2);
  if (tokens.length === 0) return null;
  return tokens.map(t => `"${t}"*`).join(' OR ');
}

// Timestamps are stored as full ISO-8601 UTC strings (toISOString()). A caller
// passing a bare "YYYY-MM-DD" date_to would otherwise be compared lexically
// against e.g. "2026-07-24T11:17:18.000Z" and lose — the bare date is a
// *prefix* of any same-day timestamp, so it sorts before it, silently
// excluding the entire day. Pad bare dates out to inclusive day boundaries.
function normalizeDateBound(value, isEnd) {
  if (!value) return value;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return value + (isEnd ? 'T23:59:59.999Z' : 'T00:00:00.000Z');
  }
  return value;
}

function buildFilterClauses(opts, tableAlias) {
  const { source_type, chat_name, project, date_from, date_to } = opts;
  const clauses = [];
  const params = [];
  if (source_type) { clauses.push(`${tableAlias}.source_type = ?`); params.push(source_type); }
  if (chat_name) { clauses.push(`${tableAlias}.chat_name LIKE ?`); params.push(`%${chat_name}%`); }
  if (project) { clauses.push(`${tableAlias}.project = ?`); params.push(project); }
  if (date_from) { clauses.push(`${tableAlias}.timestamp >= ?`); params.push(normalizeDateBound(date_from, false)); }
  if (date_to) { clauses.push(`${tableAlias}.timestamp <= ?`); params.push(normalizeDateBound(date_to, true)); }
  return { clauses, params };
}

function search(query, opts = {}) {
  const match = buildMatchQuery(query);
  const limit = Math.min(Math.max(parseInt(opts.limit, 10) || 20, 1), 50);

  // No usable keywords: browse mode — filter/order directly on `archive`,
  // newest first, instead of running an FTS MATCH (which requires terms).
  if (!match) {
    const { clauses, params } = buildFilterClauses(opts, 'a');
    clauses.unshift('1=1');
    params.push(limit);

    return db.prepare(`
      SELECT a.id, a.source_type, a.chat_name, a.project, a.from_name, a.subject, a.timestamp,
             substr(a.content, 1, 200) AS snippet
      FROM archive a
      WHERE ${clauses.join(' AND ')}
      ORDER BY a.timestamp DESC
      LIMIT ?
    `).all(...params);
  }

  const { clauses, params } = buildFilterClauses(opts, 'a');
  clauses.unshift('archive_fts MATCH ?');
  params.unshift(match);
  params.push(limit);

  return db.prepare(`
    SELECT a.id, a.source_type, a.chat_name, a.project, a.from_name, a.subject, a.timestamp,
           snippet(archive_fts, -1, '[', ']', '…', 12) AS snippet
    FROM archive_fts
    JOIN archive a ON a.id = archive_fts.rowid
    WHERE ${clauses.join(' AND ')}
    ORDER BY archive_fts.rank
    LIMIT ?
  `).all(...params);
}

module.exports = { addEntry, search, buildMatchQuery };
