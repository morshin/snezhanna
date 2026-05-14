'use strict';

/**
 * One-time migration: memory/*.md + workload-history.json → SQLite
 * Run: node scripts/migrate-memory-workload.js [--dry-run]
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const fs = require('fs');
const path = require('path');

const config = JSON.parse(fs.readFileSync(path.join(__dirname, '../config/nanobot.json'), 'utf8'));
const { db } = require('../lib/db');

const DRY_RUN = process.argv.includes('--dry-run');
const AGENT_MOUNT = config.yadisk.agent_mount;

if (DRY_RUN) console.log('[migrate] DRY RUN — no writes');

let memoryCount = 0;
let workloadCount = 0;

// ── Step 1: memory/*.md ───────────────────────────────────────────────────────

const MEMORY_DIR = path.join(AGENT_MOUNT, 'memory');
const VALID_CATEGORIES = ['health', 'kids', 'finance', 'bureaucracy', 'decisions'];

if (fs.existsSync(MEMORY_DIR)) {
  const files = fs.readdirSync(MEMORY_DIR).filter(f => f.endsWith('.md'));
  for (const file of files) {
    const category = file.replace(/\.md$/, '');
    if (!VALID_CATEGORIES.includes(category)) {
      console.log(`[migrate] Skipping unknown category: ${file}`);
      continue;
    }
    const content = fs.readFileSync(path.join(MEMORY_DIR, file), 'utf8').trim();
    if (!content) continue;

    const existing = db.prepare('SELECT COUNT(*) AS cnt FROM memory WHERE category = ?').get(category);
    if (existing.cnt > 0) {
      console.log(`[migrate] memory/${file}: already has ${existing.cnt} rows, skipping`);
      continue;
    }

    console.log(`[migrate] memory/${file} → memory table (${content.length} chars)`);
    if (!DRY_RUN) {
      db.prepare(
        "INSERT INTO memory (category, content, updated_at) VALUES (?, ?, datetime('now'))"
      ).run(category, content);
    }
    memoryCount++;
  }
} else {
  console.log(`[migrate] Memory dir not found: ${MEMORY_DIR}`);
}

// ── Step 2: workload-history.json ─────────────────────────────────────────────

const HISTORY_FILE = path.join(AGENT_MOUNT, 'workload-history.json');

if (fs.existsSync(HISTORY_FILE)) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
  } catch (e) {
    console.error('[migrate] Failed to parse workload-history.json:', e.message);
    data = { history: [] };
  }

  const entries = data.history || [];
  const insert = db.prepare(`
    INSERT OR IGNORE INTO workload_history
      (date, overall_score, work_score, family_score, health_score, personal_score,
       trend, checkin_provided, key_risks, suggestions)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertMany = db.transaction((rows) => {
    for (const e of rows) {
      insert.run(
        e.date,
        e.overall_score ?? null,
        e.domains?.work?.score    ?? null,
        e.domains?.family?.score  ?? null,
        e.domains?.health?.score  ?? null,
        e.domains?.personal?.score ?? null,
        e.trend || null,
        e.checkin_provided ? 1 : 0,
        JSON.stringify(e.key_risks   || []),
        JSON.stringify(e.suggestions || [])
      );
    }
  });

  if (!DRY_RUN) insertMany(entries);
  workloadCount = entries.length;
  console.log(`[migrate] workload-history.json: ${workloadCount} entries`);
} else {
  console.log(`[migrate] workload-history.json not found: ${HISTORY_FILE}`);
}

// ── Summary ───────────────────────────────────────────────────────────────────

console.log('\nMigration complete:');
console.log(`  Memory files:     ${memoryCount}`);
console.log(`  Workload entries: ${workloadCount}`);
if (DRY_RUN) console.log('  (DRY RUN — nothing was written)');
