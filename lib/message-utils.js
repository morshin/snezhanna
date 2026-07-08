'use strict';

// Splits text into chunks that each fit within `limit` (Telegram's message
// limit is 4096 chars). Prefers to split on paragraph breaks, then line
// breaks, then hard-cuts — never emits a chunk over the limit, unlike the
// previous sendLongMessage which left a lone paragraph longer than 4096 chars
// unsplit and let it fail at the Telegram API.
function splitMessage(text, limit = 4096) {
  const pieces = [];
  hardSplitInto(pieces, text, limit, ['\n\n', '\n']);
  return packGreedy(pieces, limit);
}

function hardSplitInto(out, text, limit, separators) {
  if (text.length <= limit) { out.push(text); return; }
  const [sep, ...rest] = separators;
  if (sep) {
    for (const part of text.split(sep)) {
      hardSplitInto(out, part, limit, rest);
    }
  } else {
    for (let i = 0; i < text.length; i += limit) out.push(text.slice(i, i + limit));
  }
}

function packGreedy(pieces, limit) {
  const chunks = [];
  let current = '';
  for (const piece of pieces) {
    if (!current) { current = piece; continue; }
    if (current.length + 2 + piece.length <= limit) {
      current += '\n\n' + piece;
    } else {
      chunks.push(current);
      current = piece;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

module.exports = { splitMessage };
