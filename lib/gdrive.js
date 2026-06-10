'use strict';

const { google } = require('googleapis');
const { Readable } = require('stream');
const fs = require('fs');
const path = require('path');

const config = JSON.parse(fs.readFileSync(path.join(__dirname, '../config/nanobot.json'), 'utf8'));
const googleAuth = require('./google');

// ── ID cache: avoid repeated Drive API lookups ────────────────────────────────

// Map of 'folder:<parentId>:<name>' → folderId
const _folderCache = new Map();
// Map of 'file:<parentId>:<name>' → fileId
const _fileCache = new Map();

// ── Helpers ───────────────────────────────────────────────────────────────────

function getDrive() {
  return google.drive({ version: 'v3', auth: googleAuth.getAuth() });
}

function isConfigured() {
  return googleAuth.isAuthorized();
}

function escapeQ(s) {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function rootFolderName() {
  return config.gdrive?.root_folder || 'Snezhanna';
}

// ── Folder operations ─────────────────────────────────────────────────────────

async function getOrCreateFolder(name, parentId = 'root') {
  const cacheKey = `${parentId}:${name}`;
  if (_folderCache.has(cacheKey)) return _folderCache.get(cacheKey);

  const drive = getDrive();
  const q = `'${escapeQ(parentId)}' in parents and name = '${escapeQ(name)}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
  const res = await drive.files.list({ q, fields: 'files(id)', pageSize: 1 });

  let folderId;
  if (res.data.files.length > 0) {
    folderId = res.data.files[0].id;
  } else {
    const created = await drive.files.create({
      requestBody: { name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] },
      fields: 'id'
    });
    folderId = created.data.id;
    console.log(`[GDrive] Created folder: ${name} under ${parentId}`);
  }

  _folderCache.set(cacheKey, folderId);
  return folderId;
}

// Resolve a slash-separated folder path like "fitness/weekly" to its Drive folder ID.
// Creates intermediate folders as needed.
async function resolveFolderPath(folderPath) {
  const rootId = await getOrCreateFolder(rootFolderName(), 'root');
  if (!folderPath) return rootId;

  let parentId = rootId;
  for (const part of folderPath.split('/').filter(Boolean)) {
    parentId = await getOrCreateFolder(part, parentId);
  }
  return parentId;
}

// ── File lookup ───────────────────────────────────────────────────────────────

async function findFileId(name, parentId) {
  const cacheKey = `${parentId}:${name}`;
  if (_fileCache.has(cacheKey)) return _fileCache.get(cacheKey);

  const drive = getDrive();
  const q = `'${escapeQ(parentId)}' in parents and name = '${escapeQ(name)}' and mimeType != 'application/vnd.google-apps.folder' and trashed = false`;
  const res = await drive.files.list({ q, fields: 'files(id)', pageSize: 1 });

  if (res.data.files.length === 0) return null;
  const fileId = res.data.files[0].id;
  _fileCache.set(cacheKey, fileId);
  return fileId;
}

function _splitPath(filePath) {
  const parts = filePath.split('/');
  const name = parts.pop();
  const folder = parts.join('/');
  return { name, folder };
}

// ── Core I/O ──────────────────────────────────────────────────────────────────

// Read text file. Returns null if not found.
async function readFile(filePath) {
  const { name, folder } = _splitPath(filePath);
  const folderId = await resolveFolderPath(folder);
  const fileId = await findFileId(name, folderId);
  if (!fileId) return null;

  const drive = getDrive();
  const response = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'stream' });

  return new Promise((resolve, reject) => {
    const chunks = [];
    response.data.on('data', c => chunks.push(Buffer.from(c)));
    response.data.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    response.data.on('error', reject);
  });
}

// Read a file by its Drive file ID (for tools that return IDs from search).
// Limits to 1MB to prevent memory exhaustion from large files.
async function readFileById(fileId) {
  const drive = getDrive();

  // Check file size first to avoid memory issues
  const metaRes = await drive.files.get({ fileId, fields: 'size' });
  const sizeBytes = parseInt(metaRes.data.size, 10);
  const maxBytes = 1024 * 1024; // 1MB limit

  if (sizeBytes > maxBytes) {
    throw new Error(`File too large (${Math.round(sizeBytes / 1024)}KB > ${maxBytes / 1024}KB limit)`);
  }

  const response = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'stream' });

  return new Promise((resolve, reject) => {
    const chunks = [];
    response.data.on('data', c => chunks.push(Buffer.from(c)));
    response.data.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    response.data.on('error', reject);
  });
}

// Write (create or update) a text file.
async function writeFile(filePath, content) {
  const { name, folder } = _splitPath(filePath);
  const folderId = await resolveFolderPath(folder);
  const existingId = await findFileId(name, folderId);

  const drive = getDrive();

  if (existingId) {
    await drive.files.update({
      fileId: existingId,
      media: { mimeType: 'text/plain; charset=utf-8', body: content }
    });
    return existingId;
  }

  const res = await drive.files.create({
    requestBody: { name, parents: [folderId] },
    media: { mimeType: 'text/plain; charset=utf-8', body: content },
    fields: 'id'
  });

  _fileCache.set(`${folderId}:${name}`, res.data.id);
  return res.data.id;
}

// Append text to an existing file (or create it).
async function appendFile(filePath, appendContent) {
  const existing = await readFile(filePath) || '';
  await writeFile(filePath, existing + appendContent);
}

// Upload a binary Buffer to Drive.
async function uploadBinary(filePath, buffer, mimeType = 'application/octet-stream') {
  const { name, folder } = _splitPath(filePath);
  const folderId = await resolveFolderPath(folder);
  const existingId = await findFileId(name, folderId);

  const drive = getDrive();
  const body = Readable.from(buffer);

  if (existingId) {
    // Invalidate cache before overwriting
    _fileCache.delete(`${folderId}:${name}`);
    await drive.files.update({ fileId: existingId, media: { mimeType, body } });
    return existingId;
  }

  const res = await drive.files.create({
    requestBody: { name, parents: [folderId] },
    media: { mimeType, body },
    fields: 'id'
  });

  _fileCache.set(`${folderId}:${name}`, res.data.id);
  return res.data.id;
}

// ── Directory listing & search ────────────────────────────────────────────────

// List files in a folder path.
async function listFiles(folderPath) {
  const folderId = await resolveFolderPath(folderPath);
  const drive = getDrive();
  const res = await drive.files.list({
    q: `'${folderId}' in parents and trashed = false`,
    fields: 'files(id, name, mimeType, size, modifiedTime)',
    orderBy: 'name',
    pageSize: 100
  });
  return res.data.files || [];
}

// Full-text search scoped to the assistant's root Drive folder.
// Drive v3 has no recursive ancestor filter, so we filter post-hoc via the
// in-memory folder cache that gets populated as folders are accessed.
async function searchFiles(query, maxResults = 20) {
  const drive = getDrive();
  const rootId = await getOrCreateFolder(rootFolderName(), 'root');

  const res = await drive.files.list({
    q: `fullText contains '${escapeQ(query)}' and trashed = false`,
    fields: 'files(id, name, mimeType, size, modifiedTime, webViewLink, parents)',
    pageSize: Math.min(maxResults * 3, 100),
    orderBy: 'modifiedTime desc'
  });

  const files = res.data.files || [];
  const knownFolderIds = new Set([rootId, ..._folderCache.values()]);
  const scoped = files.filter(f => f.parents && f.parents.some(p => knownFolderIds.has(p)));

  // Fall back to unfiltered if cache is cold (fresh start, no folders accessed yet)
  return (scoped.length > 0 ? scoped : files).slice(0, maxResults);
}

// ── Backup helpers ────────────────────────────────────────────────────────────

// Delete old backup files, keeping the N most recent.
async function pruneBackups(folderPath, keepCount = 7) {
  const files = (await listFiles(folderPath))
    .filter(f => f.name.match(/^snezhanna_\d{8}\.db$/))
    .sort((a, b) => a.name.localeCompare(b.name));

  if (files.length <= keepCount) return;

  const drive = getDrive();
  const toDelete = files.slice(0, files.length - keepCount);
  for (const f of toDelete) {
    const folderId = await resolveFolderPath(folderPath);
    _fileCache.delete(`${folderId}:${f.name}`);
    await drive.files.delete({ fileId: f.id });
    console.log(`[GDrive] Pruned backup: ${f.name}`);
  }
}

// ── Startup ───────────────────────────────────────────────────────────────────

// Ensure the required folder structure exists under the root folder.
async function ensureDirs() {
  if (!isConfigured()) {
    console.log('[GDrive] Not authorized, skipping ensureDirs');
    return { ok: false, error: 'Not authorized' };
  }

  const required = [
    'memory',
    'fitness/weekly',
    'fitness/races',
    'drafts',
    'digests',
    'inbox',
    'analytics',
    'backups'
  ];

  for (const dir of required) {
    await resolveFolderPath(dir);
  }

  console.log(`[GDrive] Folder structure ensured under "${rootFolderName()}"`);
  return { ok: true };
}

module.exports = {
  isConfigured,
  readFile,
  readFileById,
  writeFile,
  appendFile,
  uploadBinary,
  listFiles,
  searchFiles,
  pruneBackups,
  ensureDirs,
  resolveFolderPath,
  getOrCreateFolder,
};
