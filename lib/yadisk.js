'use strict';

// File search and read via Google Drive — replaces the former Yandex Disk read-only mount.
// search_files uses Drive full-text search; read_file fetches content by Drive file ID.

const gdrive = require('./gdrive');

async function searchFiles(query) {
  if (!gdrive.isConfigured()) {
    return { results: [], error: 'Google Drive not authorized. Use /auth to connect your Google account.' };
  }

  try {
    const files = await gdrive.searchFiles(query, 20);
    const results = files.map(f => ({
      id: f.id,
      name: f.name,
      mimeType: f.mimeType,
      size_kb: f.size ? Math.round(Number(f.size) / 1024) : null,
      modified: f.modifiedTime,
      link: f.webViewLink || null
    }));
    return { results, total: files.length };
  } catch (err) {
    console.error('[yadisk] searchFiles error:', err.message);
    return { results: [], error: err.message };
  }
}

// Read file content by Drive file ID (returned from searchFiles).
async function readFile(fileId) {
  if (!gdrive.isConfigured()) {
    return { error: 'Google Drive not authorized.' };
  }

  if (!fileId || typeof fileId !== 'string') {
    return { error: 'fileId is required (use the id from search_files results)' };
  }

  try {
    const content = await gdrive.readFileById(fileId);
    if (content === null) return { error: 'File not found or cannot be read as text' };
    return { fileId, content: content.slice(0, 10000) };
  } catch (err) {
    console.error('[yadisk] readFile error:', err.message);
    return { error: err.message };
  }
}

module.exports = { searchFiles, readFile };
