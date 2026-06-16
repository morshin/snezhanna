#!/usr/bin/env node
'use strict';

/**
 * Migration runner. Called by update.sh after npm install, before restart.
 *
 * Migrations live in migrations/*.js, named {semver}-{description}.js.
 * Completed migrations are tracked in .nanobot/migrations.json.
 * Each migration module must export: { description, run() }
 * run() should be idempotent and return { applied: bool, message?: string }.
 */

const fs   = require('fs');
const path = require('path');

const ROOT       = path.join(__dirname, '..');
const STATE_FILE = path.join(ROOT, '.nanobot', 'migrations.json');
const MIG_DIR    = path.join(ROOT, 'migrations');

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { completed: [] };
  }
}

function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function compareSemver(a, b) {
  const pa = a.replace(/^v/, '').split('.').map(Number);
  const pb = b.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

function getMigrations() {
  let files;
  try { files = fs.readdirSync(MIG_DIR); }
  catch { return []; }

  return files
    .filter(f => /^\d+\.\d+\.\d+-.*\.js$/.test(f))
    .sort((a, b) => {
      const va = a.match(/^(\d+\.\d+\.\d+)/)[1];
      const vb = b.match(/^(\d+\.\d+\.\d+)/)[1];
      return compareSemver(va, vb);
    })
    .map(f => ({ file: f, id: path.basename(f, '.js'), version: f.match(/^(\d+\.\d+\.\d+)/)[1] }));
}

async function main() {
  const state      = loadState();
  const migrations = getMigrations();
  const pending    = migrations.filter(m => !state.completed.includes(m.id));

  if (!pending.length) {
    console.log('[Migrations] Nothing to run.');
    return;
  }

  console.log(`[Migrations] ${pending.length} pending migration(s).`);
  let anyFailed = false;

  for (const m of pending) {
    process.stdout.write(`  → ${m.id} … `);
    try {
      const mod    = require(path.join(MIG_DIR, m.file));
      const result = await mod.run();
      if (result.applied) {
        console.log(`✓ ${result.message || 'applied'}`);
      } else {
        console.log(`– ${result.message || 'skipped (already up to date)'}`);
      }
      state.completed.push(m.id);
      saveState(state);
    } catch (e) {
      console.log(`✗ FAILED: ${e.message}`);
      anyFailed = true;
      // Continue with remaining migrations — partial is better than none
    }
  }

  if (anyFailed) {
    console.warn('[Migrations] Some migrations failed — check output above.');
    process.exit(1);
  }
}

main().catch(e => {
  console.error('[Migrations] Fatal:', e.message);
  process.exit(1);
});
