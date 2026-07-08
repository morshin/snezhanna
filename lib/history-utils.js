'use strict';

// Pure history-shaping helpers, extracted out of index.js so they're testable
// without booting the bot. No DB, no network, no Telegram.

// Removes orphaned tool_use / tool_result blocks from history — protects
// against a "poisoned" history (e.g. after a crash mid-tool-call) blocking
// every subsequent Claude request.
function sanitizeHistory(hist) {
  const out = [];
  for (let i = 0; i < hist.length; i++) {
    const entry = hist[i];

    if (entry.role === 'assistant' && Array.isArray(entry.content)) {
      const toolUseIds = entry.content.filter(b => b.type === 'tool_use').map(b => b.id);
      if (toolUseIds.length > 0) {
        const next = hist[i + 1];
        const hasResults = next &&
          next.role === 'user' &&
          Array.isArray(next.content) &&
          toolUseIds.every(id => next.content.some(b => b.type === 'tool_result' && b.tool_use_id === id));
        if (!hasResults) {
          console.warn(`[History] Dropping orphaned tool_use (${toolUseIds.length} calls): ${toolUseIds.join(', ')}`);
          // Пропускаем и следующий user-блок, если он — осиротевший tool_result
          if (hist[i + 1]?.role === 'user' && Array.isArray(hist[i + 1]?.content) &&
              hist[i + 1].content.some(b => b.type === 'tool_result')) {
            i++;
          }
          continue;
        }
      }
    }

    // Удаляем tool_result без предшествующего tool_use
    if (entry.role === 'user' && Array.isArray(entry.content) &&
        entry.content.some(b => b.type === 'tool_result')) {
      const prev = out[out.length - 1];
      const hasPrecedingToolUse = prev?.role === 'assistant' &&
        Array.isArray(prev.content) && prev.content.some(b => b.type === 'tool_use');
      if (!hasPrecedingToolUse) {
        console.warn('[History] Dropping orphaned tool_result block');
        continue;
      }
    }

    out.push(entry);
  }
  return out;
}

// Computes the trim point: never start on assistant, never orphan a tool_result.
function trimHistory(hist, maxMessages, keepLast) {
  if (hist.length <= maxMessages) return hist;
  let sliceAt = hist.length - keepLast;
  while (sliceAt > 0 && (
    hist[sliceAt].role !== 'user' ||
    (Array.isArray(hist[sliceAt].content) &&
     hist[sliceAt].content.some(b => b.type === 'tool_result'))
  )) {
    sliceAt--;
  }
  return hist.slice(sliceAt);
}

module.exports = { sanitizeHistory, trimHistory };
