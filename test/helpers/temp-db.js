'use strict';

// Points lib/db.js at a throwaway SQLite file instead of the live one, so
// tests never touch production data. Must be required (and useTempDb() called)
// BEFORE any module that transitively requires '../lib/db' — set DATABASE_PATH
// before that first require happens, since lib/db.js reads it once at load time.
// `node --test` runs each test file as its own process, so this is safe as
// long as it's the first thing required in the file.

const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

function useTempDb() {
  const tmpPath = path.join(os.tmpdir(), `snezhanna-test-${crypto.randomBytes(6).toString('hex')}.db`);
  process.env.DATABASE_PATH = tmpPath;
  process.on('exit', () => {
    try { fs.unlinkSync(tmpPath); } catch {}
    try { fs.unlinkSync(tmpPath + '-wal'); } catch {}
    try { fs.unlinkSync(tmpPath + '-shm'); } catch {}
  });
  return tmpPath;
}

module.exports = { useTempDb };
