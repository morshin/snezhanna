'use strict';

// Migrate personal data from Yandex Disk agent folder to Google Drive.
//
// Usage:
//   node scripts/migrate-yadisk-to-gdrive.js             # real run
//   node scripts/migrate-yadisk-to-gdrive.js --dry-run   # preview only
//
// Prerequisites:
//   1. /mnt/yadisk-agent must be mounted
//   2. Google OAuth must be complete (token.json must exist)
//
// What is migrated:
//   memory/health.md, kids.md, finance.md, bureaucracy.md, decisions.md
//   workload-history.json
//   fitness/weekly/*.json + *.md
//   fitness/races/{name}/*.md
//
// What is NOT migrated (already in SQLite or belongs to tutor bot):
//   index/, tasks/, projects/, drafts/, digests/, kids/

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const fs   = require('fs');
const path = require('path');

const config = require('../lib/config');
const google = require('../lib/google');
const gdrive = require('../lib/gdrive');

const YADISK  = '/mnt/yadisk-agent';
const DRY_RUN = process.argv.includes('--dry-run');

// ── Stats ──────────────────────────────────────────────────────────────────────

let uploaded = 0, skipped = 0, errors = 0;

// ── Upload helpers ─────────────────────────────────────────────────────────────

async function uploadTextFile(srcAbs, destRel) {
  if (!fs.existsSync(srcAbs)) {
    console.log(`  ⏭  ${destRel}  (нет на Яндекс.Диске)`);
    skipped++;
    return;
  }

  const content = fs.readFileSync(srcAbs, 'utf8');
  if (!content.trim()) {
    console.log(`  ⏭  ${destRel}  (пустой файл)`);
    skipped++;
    return;
  }

  const sizeKb = (Buffer.byteLength(content, 'utf8') / 1024).toFixed(1);

  if (DRY_RUN) {
    console.log(`  📄 ${destRel}  (${sizeKb} KB)  [dry run]`);
    uploaded++;
    return;
  }

  try {
    await gdrive.writeFile(destRel, content);
    console.log(`  ✅ ${destRel}  (${sizeKb} KB)`);
    uploaded++;
  } catch (err) {
    console.error(`  ❌ ${destRel}:  ${err.message}`);
    errors++;
  }
}

function scanDir(dirAbs, extensions) {
  if (!fs.existsSync(dirAbs)) return [];
  return fs.readdirSync(dirAbs)
    .filter(f => extensions.some(ext => f.endsWith(ext)));
}

function scanSubdirs(dirAbs) {
  if (!fs.existsSync(dirAbs)) return [];
  return fs.readdirSync(dirAbs, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  // ── Auth check ───────────────────────────────────────────────────────────────
  if (!google.isAuthorized()) {
    console.error('❌ Google не авторизован.\n   Запусти бота, выполни /auth <code>, затем повтори скрипт.');
    process.exit(1);
  }

  // ── Mount check ──────────────────────────────────────────────────────────────
  if (!fs.existsSync(YADISK)) {
    console.error(`❌ Яндекс.Диск не смонтирован: ${YADISK}\n   Смонтируй: mount /mnt/yadisk-agent`);
    process.exit(1);
  }

  const root = config.gdrive?.root_folder || 'Снежанна';
  console.log(`🚀 Миграция: ${YADISK}  →  Google Drive («${root}»)`);
  if (DRY_RUN) console.log('   Режим: DRY RUN (файлы НЕ загружаются)\n');
  else         console.log('');

  // ── memory/ ──────────────────────────────────────────────────────────────────
  console.log('📁 memory/');
  for (const f of ['health.md', 'kids.md', 'finance.md', 'bureaucracy.md', 'decisions.md']) {
    await uploadTextFile(path.join(YADISK, 'memory', f), `memory/${f}`);
  }

  // ── workload-history.json ────────────────────────────────────────────────────
  console.log('\n📁 workload-history.json');
  await uploadTextFile(path.join(YADISK, 'workload-history.json'), 'workload-history.json');

  // ── fitness/weekly/ ──────────────────────────────────────────────────────────
  console.log('\n📁 fitness/weekly/');
  const weeklyFiles = scanDir(path.join(YADISK, 'fitness/weekly'), ['.json', '.md']);
  if (weeklyFiles.length === 0) {
    console.log('  ⏭  (нет файлов)');
    skipped++;
  } else {
    for (const f of weeklyFiles) {
      await uploadTextFile(path.join(YADISK, 'fitness/weekly', f), `fitness/weekly/${f}`);
    }
  }

  // ── fitness/races/ ───────────────────────────────────────────────────────────
  console.log('\n📁 fitness/races/');
  const races = scanSubdirs(path.join(YADISK, 'fitness/races'));
  if (races.length === 0) {
    console.log('  ⏭  (нет стартов)');
    skipped++;
  } else {
    for (const race of races) {
      const mdFiles = scanDir(path.join(YADISK, 'fitness/races', race), ['.md']);
      for (const f of mdFiles) {
        await uploadTextFile(
          path.join(YADISK, 'fitness/races', race, f),
          `fitness/races/${race}/${f}`
        );
      }
    }
  }

  // ── Summary ──────────────────────────────────────────────────────────────────
  console.log('\n' + '─'.repeat(50));
  console.log(`📊 Загружено: ${uploaded}  |  Пропущено: ${skipped}  |  Ошибок: ${errors}`);

  if (errors > 0) {
    console.log('⚠️  Были ошибки — проверь вывод выше.');
    process.exit(1);
  }

  if (DRY_RUN) {
    console.log('\nЗапусти без --dry-run чтобы выполнить реальный перенос.');
  } else if (uploaded > 0) {
    console.log('✅ Готово! Данные доступны в Google Drive.');
  } else {
    console.log('ℹ️  Нечего переносить — Яндекс.Диск пустой или не смонтирован.');
  }
}

main().catch(err => {
  console.error('\n💥 Fatal:', err.message);
  process.exit(1);
});
