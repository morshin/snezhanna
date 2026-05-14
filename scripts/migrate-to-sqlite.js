#!/usr/bin/env node
'use strict';

/**
 * One-time migration: JSON files on Yandex.Disk → SQLite
 *
 * Usage:
 *   node scripts/migrate-to-sqlite.js [--dry-run]
 *
 * After a successful run the old files are NOT deleted (kept for rollback).
 * Re-running is safe: existing records are skipped.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const fs   = require('fs');
const path = require('path');

const config = JSON.parse(fs.readFileSync(path.join(__dirname, '../config/nanobot.json'), 'utf8'));
const AGENT_MOUNT = config.yadisk.agent_mount;
const DRY_RUN = process.argv.includes('--dry-run');

if (DRY_RUN) console.log('[migrate] DRY RUN — no writes to DB');

// Initialise DB (creates tables if needed)
const { db } = require('../lib/db');

// ── Helpers ───────────────────────────────────────────────────────────────────

function readJson(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    console.warn(`[migrate] Could not parse ${filePath}: ${e.message}`);
    return null;
  }
}

function readText(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    console.warn(`[migrate] Could not read ${filePath}: ${e.message}`);
    return null;
  }
}

function parseReadme(content) {
  if (!content) return {};
  const result = {};
  const m = (rx) => { const r = content.match(rx); return r ? r[1].trim() : null; };

  result.client      = m(/## Клиент\n(.+)/);
  result.type        = m(/## Тип проекта\n(.+)/);
  result.platform    = m(/## Платформа\n(.+)/);
  result.description = m(/## Описание\n([\s\S]*?)(?=\n##|$)/);

  // Status
  const statusRaw = m(/## Статус\n(.+)/);
  if (statusRaw) {
    const sl = statusRaw.toLowerCase();
    if (sl.includes('завер') || sl.includes('complet')) result.status = 'completed';
    else if (sl.includes('архив')) result.status = 'archived';
    else if (sl.includes('пауз') || sl.includes('pause')) result.status = 'paused';
    else result.status = 'active';
  }

  // Clean placeholder values
  for (const k of Object.keys(result)) {
    if (typeof result[k] === 'string' && result[k].startsWith('_') && result[k].endsWith('_')) {
      result[k] = null;
    }
  }

  return result;
}

// ── Migrate global tasks ──────────────────────────────────────────────────────

const insertTask = db.prepare(`
  INSERT OR IGNORE INTO tasks
    (id, title, status, urgent, important, project_id, due_date, tags, notes, source, created_at, updated_at, completed_at)
  VALUES
    (@id, @title, @status, @urgent, @important, @project_id, @due_date, @tags, @notes, @source, @created_at, @updated_at, @completed_at)
`);

const insertProject = db.prepare(`
  INSERT OR IGNORE INTO projects (name, display_name, client, type, platform, status, description)
  VALUES (@name, @display_name, @client, @type, @platform, @status, @description)
`);

const getProject = db.prepare('SELECT * FROM projects WHERE name = ?');
const insertLog  = db.prepare('INSERT INTO project_log (project_id, content, created_at) VALUES (?, ?, datetime(\'now\'))');
const insertNote = db.prepare('INSERT INTO project_notes (project_id, content, created_at) VALUES (?, ?, datetime(\'now\'))');
const upsertDoc  = db.prepare(`
  INSERT INTO project_docs (project_id, filename, content, updated_at)
  VALUES (?, ?, ?, datetime('now'))
  ON CONFLICT(project_id, filename) DO UPDATE SET content=excluded.content, updated_at=excluded.updated_at
`);

function migrateTask(taskData, projectId) {
  const tags = Array.isArray(taskData.tags) ? taskData.tags : [];
  const status = ['pending','in_progress','done','cancelled'].includes(taskData.status)
    ? taskData.status : 'pending';

  const row = {
    id:           taskData.id,
    title:        taskData.title || '(без названия)',
    status,
    urgent:       taskData.urgent    ? 1 : 0,
    important:    taskData.important ? 1 : 0,
    project_id:   projectId || null,
    due_date:     taskData.due_date  || null,
    tags:         JSON.stringify(tags),
    notes:        taskData.notes     || null,
    source:       taskData.source    || 'manual',
    created_at:   taskData.created_at  || new Date().toISOString(),
    updated_at:   taskData.updated_at  || new Date().toISOString(),
    completed_at: taskData.completed_at || null,
  };

  if (!DRY_RUN) {
    const info = insertTask.run(row);
    if (info.changes === 0) {
      console.log(`[migrate]   skip task #${row.id} (already exists)`);
    }
  } else {
    console.log(`[migrate]   [dry] task #${row.id} "${row.title}"`);
  }
}

// ── Run migration ─────────────────────────────────────────────────────────────

const migrate = db.transaction(() => {
  let tasksMigrated = 0;
  let projectsMigrated = 0;

  // 1. Global tasks
  const globalTasksPath = path.join(AGENT_MOUNT, 'tasks', 'tasks.json');
  const globalTasks = readJson(globalTasksPath);
  if (globalTasks && Array.isArray(globalTasks)) {
    console.log(`[migrate] Global tasks: ${globalTasks.length} found`);
    for (const t of globalTasks) {
      migrateTask(t, null);
      tasksMigrated++;
    }
  } else {
    console.log('[migrate] Global tasks: file not found or empty');
  }

  // 2. Projects
  const projectsDir = path.join(AGENT_MOUNT, 'projects');
  if (!fs.existsSync(projectsDir)) {
    console.log('[migrate] No projects directory found — skipping projects');
  } else {
    const entries = fs.readdirSync(projectsDir, { withFileTypes: true })
      .filter(e => e.isDirectory() && !e.name.startsWith('.'));

    console.log(`[migrate] Projects: ${entries.length} found`);

    for (const entry of entries) {
      const name = entry.name;
      const projPath = path.join(projectsDir, name);

      console.log(`[migrate] Processing project: ${name}`);

      // Parse README.md
      const readmeContent = readText(path.join(projPath, 'README.md'));
      const readme = parseReadme(readmeContent);

      if (!DRY_RUN) {
        insertProject.run({
          name,
          display_name: name,
          client:       readme.client   || null,
          type:         readme.type     || null,
          platform:     readme.platform || null,
          status:       readme.status   || 'active',
          description:  readme.description || readmeContent || null,
        });
      } else {
        console.log(`[migrate]   [dry] project "${name}"`);
      }

      const proj = !DRY_RUN ? getProject.get(name) : { id: null };
      if (!proj) {
        console.warn(`[migrate]   Could not fetch project "${name}" after insert`);
        continue;
      }
      projectsMigrated++;

      // Migrate project tasks
      const projTasksPath = path.join(projPath, 'tasks.json');
      const projTasks = readJson(projTasksPath);
      if (projTasks && Array.isArray(projTasks)) {
        console.log(`[migrate]   tasks: ${projTasks.length}`);
        for (const t of projTasks) {
          migrateTask(t, proj.id);
          tasksMigrated++;
        }
      }

      // Migrate log.md → project_log
      const logContent = readText(path.join(projPath, 'log.md'));
      if (logContent && logContent.trim() && proj.id && !DRY_RUN) {
        insertLog.run(proj.id, logContent);
        console.log(`[migrate]   log.md imported`);
      }

      // Migrate notes.md → project_notes
      const notesContent = readText(path.join(projPath, 'notes.md'));
      if (notesContent && notesContent.trim() && proj.id && !DRY_RUN) {
        insertNote.run(proj.id, notesContent);
        console.log(`[migrate]   notes.md imported`);
      }

      // Migrate docs/
      const docsDir = path.join(projPath, 'docs');
      if (fs.existsSync(docsDir)) {
        const docFiles = fs.readdirSync(docsDir).filter(f => !f.startsWith('.'));
        for (const docFile of docFiles) {
          const docContent = readText(path.join(docsDir, docFile));
          if (docContent && proj.id && !DRY_RUN) {
            upsertDoc.run(proj.id, docFile, docContent);
            console.log(`[migrate]   docs/${docFile} imported`);
          } else if (DRY_RUN) {
            console.log(`[migrate]   [dry] docs/${docFile}`);
          }
        }
      }
    }
  }

  return { tasksMigrated, projectsMigrated };
});

// ── Execute ───────────────────────────────────────────────────────────────────

console.log('[migrate] Starting migration...');
console.log(`[migrate] Source: ${AGENT_MOUNT}`);
console.log(`[migrate] Target: ${config.database.path}`);
console.log('');

try {
  const result = DRY_RUN ? (() => {
    // Dry run can't use transaction (no writes)
    let tasksMigrated = 0;
    let projectsMigrated = 0;

    const globalTasksPath = path.join(AGENT_MOUNT, 'tasks', 'tasks.json');
    const globalTasks = readJson(globalTasksPath);
    if (globalTasks && Array.isArray(globalTasks)) {
      console.log(`[migrate] Global tasks: ${globalTasks.length} found`);
      for (const t of globalTasks) { migrateTask(t, null); tasksMigrated++; }
    }

    const projectsDir = path.join(AGENT_MOUNT, 'projects');
    if (fs.existsSync(projectsDir)) {
      const entries = fs.readdirSync(projectsDir, { withFileTypes: true })
        .filter(e => e.isDirectory() && !e.name.startsWith('.'));
      for (const e of entries) {
        console.log(`[migrate]   [dry] project "${e.name}"`);
        projectsMigrated++;
      }
    }

    return { tasksMigrated, projectsMigrated };
  })() : migrate();

  console.log('');
  console.log(`[migrate] Done!`);
  console.log(`  Projects: ${result.projectsMigrated}`);
  console.log(`  Tasks:    ${result.tasksMigrated}`);
  if (!DRY_RUN) {
    console.log('');
    console.log('[migrate] Old JSON files are preserved. Delete manually after verifying the migration.');
  }
} catch (e) {
  console.error('[migrate] ERROR:', e.message);
  process.exit(1);
}
