'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const fs = require('fs');
const path = require('path');

const config = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../config/nanobot.json'), 'utf8')
);

const INDEX_FILE = config.yadisk.index_file;
const READONLY_MOUNT = config.yadisk.readonly_mount;

const EXCLUDE_EXT = new Set(config.index.exclude_extensions);
const EXCLUDE_FOLDERS = config.index.exclude_folders;
const MAX_SIZE = config.index.max_size_kb * 1024;
const MAX_AGE_MS = config.index.max_age_years * 365 * 24 * 60 * 60 * 1000;

function shouldExcludeFolder(name) {
  return EXCLUDE_FOLDERS.some(pattern => {
    if (pattern.endsWith('*')) return name.startsWith(pattern.slice(0, -1));
    if (pattern.startsWith('*')) return name.endsWith(pattern.slice(1));
    return name === pattern;
  });
}

function getCategoryFromPath(filePath) {
  if (filePath.includes('Документы') || filePath.includes('Spain taxes')) return 'documents';
  if (filePath.includes('Clients') || filePath.includes('Client')) return 'clients';
  if (filePath.includes('morshin.pro')) return 'work';
  if (filePath.includes('Фото') || filePath.includes('Photo')) return 'photos';
  return 'other';
}

function extractKeywords(name) {
  return name
    .replace(/\.[^.]+$/, '')
    .split(/[\s_\-\.]+/)
    .filter(w => w.length > 2)
    .map(w => w.toLowerCase());
}

function walkDir(dir, rootDir, results) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return;
  }

  for (const entry of entries) {
    if (shouldExcludeFolder(entry.name)) continue;

    const fullPath = path.join(dir, entry.name);
    const relPath = '/' + path.relative(rootDir, fullPath);

    if (entry.isDirectory()) {
      walkDir(fullPath, rootDir, results);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (EXCLUDE_EXT.has(ext)) continue;

      let stat;
      try {
        stat = fs.statSync(fullPath);
      } catch (e) {
        continue;
      }

      if (stat.size > MAX_SIZE) continue;
      const age = Date.now() - stat.mtimeMs;
      if (age > MAX_AGE_MS && getCategoryFromPath(relPath) !== 'documents') continue;

      results.push({
        path: relPath,
        name: entry.name,
        modified: stat.mtime.toISOString().split('T')[0],
        size_kb: Math.round(stat.size / 1024),
        category: getCategoryFromPath(relPath),
        keywords: extractKeywords(entry.name)
      });
    }
  }
}

function run() {
  const isIncremental = process.argv.includes('--incremental');
  console.log(`[indexer] Starting ${isIncremental ? 'incremental' : 'full'} index...`);

  if (!fs.existsSync(READONLY_MOUNT)) {
    console.error(`[indexer] Mount point not available: ${READONLY_MOUNT}`);
    process.exit(1);
  }

  const files = [];
  for (const folder of config.index.include_folders) {
    const folderPath = path.join(READONLY_MOUNT, folder);
    if (fs.existsSync(folderPath)) {
      walkDir(folderPath, READONLY_MOUNT, files);
    }
  }

  const indexDir = path.dirname(INDEX_FILE);
  if (!fs.existsSync(indexDir)) fs.mkdirSync(indexDir, { recursive: true });

  const index = {
    last_updated: new Date().toISOString(),
    total: files.length,
    files
  };
  fs.writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2));
  console.log(`[indexer] Done. Indexed ${files.length} files.`);
}

run();
