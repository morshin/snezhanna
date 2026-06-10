'use strict';

const path = require('path');
const diskLog = require('./disk-log');
const { db } = require('./db');
const gdrive = require('./gdrive');

// ── Prepared statements ───────────────────────────────────────────────────────

const stmts = {
  getProjectByName: db.prepare('SELECT * FROM projects WHERE name = ?'),
  insertProject:    db.prepare(`
    INSERT INTO projects (name, display_name, client, type, platform, status, description)
    VALUES (@name, @display_name, @client, @type, @platform, @status, @description)
  `),
  listProjects:     db.prepare(`
    SELECT p.*,
      (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status NOT IN ('done','cancelled')) AS open_tasks
    FROM projects p
    ORDER BY p.status, p.name
  `),
  updateProjectDesc: db.prepare('UPDATE projects SET description=?, updated_at=datetime(\'now\') WHERE id=?'),
  appendProjectDesc: db.prepare('UPDATE projects SET description=COALESCE(description,\'\') || ?, updated_at=datetime(\'now\') WHERE id=?'),

  insertLog:   db.prepare('INSERT INTO project_log (project_id, content) VALUES (?, ?)'),
  getLogs:     db.prepare('SELECT * FROM project_log WHERE project_id=? ORDER BY created_at DESC LIMIT 30'),
  insertNote:  db.prepare('INSERT INTO project_notes (project_id, content) VALUES (?, ?)'),
  getNotes:    db.prepare('SELECT * FROM project_notes WHERE project_id=? ORDER BY created_at DESC LIMIT 5'),

  upsertDoc:   db.prepare(`
    INSERT INTO project_docs (project_id, filename, content, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(project_id, filename) DO UPDATE SET content=excluded.content, updated_at=excluded.updated_at
  `),
  appendDoc: db.prepare(`
    INSERT INTO project_docs (project_id, filename, content, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(project_id, filename) DO UPDATE SET
      content = project_docs.content || ?,
      updated_at = excluded.updated_at
  `),
  getDoc:  db.prepare('SELECT * FROM project_docs WHERE project_id=? AND filename=?'),
  listDocs: db.prepare('SELECT filename, length(content) AS size_bytes, updated_at FROM project_docs WHERE project_id=? ORDER BY filename'),
};

// ── ensureDirs ────────────────────────────────────────────────────────────────

// Delegates to gdrive.ensureDirs() — creates required folder structure in Google Drive.
async function ensureDirs() {
  return gdrive.ensureDirs();
}

// ── Project CRUD (SQLite-backed) ──────────────────────────────────────────────

function createProject(projectName) {
  if (!projectName || typeof projectName !== 'string') {
    return { error: 'Не указано имя проекта' };
  }

  const safeName = projectName.replace(/[<>:"/\\|?*]/g, '_').trim();
  if (!safeName) return { error: 'Некорректное имя проекта' };

  const existing = stmts.getProjectByName.get(safeName);
  if (existing) return { error: `Проект "${safeName}" уже существует` };

  try {
    stmts.insertProject.run({
      name:         safeName,
      display_name: projectName,
      client:       null,
      type:         null,
      platform:     null,
      status:       'active',
      description:  null,
    });
  } catch (e) {
    return { error: e.message };
  }

  console.log(`[yadisk-dirs] Created project "${safeName}" in SQLite`);
  return { created: true, name: safeName };
}

function listProjects() {
  const rows = stmts.listProjects.all();
  const projects = rows.map(r => ({
    name:        r.name,
    display_name: r.display_name || r.name,
    client:      r.client    || '',
    type:        r.type      || '',
    platform:    r.platform  || '',
    status:      r.status,
    open_tasks:  r.open_tasks,
  }));
  return { projects, total: projects.length };
}

function _getProject(name) {
  const proj = stmts.getProjectByName.get(name);
  if (!proj) return null;
  return proj;
}

function readProjectFile(projectName, filename) {
  const allowed = ['README.md', 'tasks.md', 'log.md', 'notes.md'];
  if (!allowed.includes(filename)) {
    return { error: `Недопустимый файл. Доступны: ${allowed.join(', ')}` };
  }

  const proj = _getProject(projectName);
  if (!proj) return { error: `Проект "${projectName}" не найден` };

  let content = '';

  if (filename === 'README.md') {
    content = `# ${proj.display_name || proj.name}

## Клиент
${proj.client || '_не указан_'}

## Тип проекта
${proj.type || '_не указан_'}

## Платформа
${proj.platform || '_не указана_'}

## Статус
${proj.status}

## Описание
${proj.description || '_нет описания_'}
`;
  } else if (filename === 'log.md') {
    const entries = stmts.getLogs.all(proj.id);
    if (entries.length === 0) {
      content = `# Журнал работ — ${proj.display_name || proj.name}\n\n_Записей нет._\n`;
    } else {
      content = `# Журнал работ — ${proj.display_name || proj.name}\n\n` +
        entries.map(e => `---\n_${e.created_at}_\n\n${e.content}`).join('\n\n');
    }
  } else if (filename === 'notes.md') {
    const entries = stmts.getNotes.all(proj.id);
    if (entries.length === 0) {
      content = `# Заметки — ${proj.display_name || proj.name}\n\n_Заметок нет._\n`;
    } else {
      content = `# Заметки — ${proj.display_name || proj.name}\n\n` +
        entries.map(e => `---\n_${e.created_at}_\n\n${e.content}`).join('\n\n');
    }
  } else if (filename === 'tasks.md') {
    // Tasks are now in the unified tasks table — show pending tasks for this project
    const rows = db.prepare(`
      SELECT * FROM tasks WHERE project_id=? AND status NOT IN ('done','cancelled')
      ORDER BY (urgent * important) DESC, urgent DESC, important DESC
    `).all(proj.id);

    if (rows.length === 0) {
      content = `# Задачи — ${proj.display_name || proj.name}\n\n_Активных задач нет._\n`;
    } else {
      content = `# Задачи — ${proj.display_name || proj.name}\n\n` +
        rows.map(r => {
          const tags = JSON.parse(r.tags || '[]');
          const prefix = r.urgent && r.important ? '🔴' : r.urgent ? '🟠' : r.important ? '🔵' : '⚪';
          return `${prefix} #${r.id} ${r.title}${r.due_date ? ` (до ${r.due_date})` : ''}${tags.length ? ` [${tags.join(', ')}]` : ''}`;
        }).join('\n');
    }
  }

  return { project: projectName, file: filename, content };
}

function writeProjectFile(projectName, filename, content, mode = 'append') {
  const allowed = ['README.md', 'tasks.md', 'log.md', 'notes.md'];
  if (!allowed.includes(filename)) {
    return { error: `Недопустимый файл. Доступны: ${allowed.join(', ')}` };
  }
  if (filename === 'tasks.md') {
    return { error: 'tasks.md недоступен для записи — задачи добавляются через add_task' };
  }

  const proj = _getProject(projectName);
  if (!proj) return { error: `Проект "${projectName}" не найден` };

  if (filename === 'README.md') {
    if (mode === 'overwrite') {
      stmts.updateProjectDesc.run(content, proj.id);
    } else {
      const sep = '\n\n---\n';
      stmts.appendProjectDesc.run(sep + content, proj.id);
    }
  } else if (filename === 'log.md') {
    stmts.insertLog.run(proj.id, content);
  } else if (filename === 'notes.md') {
    stmts.insertNote.run(proj.id, content);
  }

  return { saved: true, project: projectName, file: filename, mode };
}

function listProjectDocs(projectName) {
  const proj = _getProject(projectName);
  if (!proj) return { docs: [], note: `Проект "${projectName}" не найден` };

  const docs = stmts.listDocs.all(proj.id).map(r => ({
    name:       r.filename,
    size_bytes: r.size_bytes,
    modified:   r.updated_at,
  }));

  return { project: projectName, docs, total: docs.length };
}

function readProjectDoc(projectName, filename) {
  const safeName = path.basename(filename);
  if (safeName !== filename || safeName.startsWith('.') || !safeName) {
    return { error: 'Некорректное имя файла' };
  }

  const proj = _getProject(projectName);
  if (!proj) return { error: `Проект "${projectName}" не найден` };

  const doc = stmts.getDoc.get(proj.id, safeName);
  if (!doc) return { error: `Файл docs/${safeName} не найден в проекте "${projectName}"` };

  if (doc.content.length > 200 * 1024) {
    return { error: `Файл слишком большой (${Math.round(doc.content.length / 1024)}KB). Максимум 200KB.` };
  }

  return { project: projectName, file: `docs/${safeName}`, content: doc.content };
}

function writeProjectDoc(projectName, filename, content, mode = 'overwrite') {
  const safeName = path.basename(filename);
  if (safeName !== filename || safeName.startsWith('.') || !safeName) {
    return { error: 'Некорректное имя файла' };
  }

  const proj = _getProject(projectName);
  if (!proj) return { error: `Проект "${projectName}" не найден` };

  if (mode === 'append') {
    const dateHeader = `\n\n---\n_${new Date().toLocaleDateString('ru-RU', {
      day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Madrid'
    })}_\n\n`;
    stmts.appendDoc.run(proj.id, safeName, dateHeader + content, dateHeader + content);
  } else {
    stmts.upsertDoc.run(proj.id, safeName, content);
  }

  return { saved: true, project: projectName, file: `docs/${safeName}`, mode };
}

// ── saveFile (unchanged — saves Telegram files to Yandex.Disk) ───────────────

async function saveFile(cacheKey, destPath) {
  if (!gdrive.isConfigured()) {
    return { error: 'Google Drive not authorized. Use /auth to connect your Google account.' };
  }

  const fileCache = require('./file-cache');
  const entry = fileCache.get(cacheKey);
  if (!entry) {
    return { error: 'Файл не найден в кэше. Возможно, прошло более 1 часа с момента получения — попроси отправить файл ещё раз.' };
  }

  const safeDest = path.normalize(destPath).replace(/^(\.\.[\\/]|[\\/])+/, '');
  if (!safeDest) return { error: 'Некорректный путь назначения' };

  try {
    await gdrive.uploadBinary(safeDest, entry.buffer, entry.mimeType || 'application/octet-stream');
  } catch (err) {
    return { error: `Не удалось сохранить файл: ${err.message}` };
  }

  fileCache.remove(cacheKey);
  diskLog.log('Сохранён файл из Telegram', safeDest);
  console.log(`[yadisk-dirs] Saved file to Drive: ${safeDest}`);

  return {
    saved:      true,
    path:       safeDest,
    filename:   entry.filename,
    size_bytes: entry.buffer.length,
  };
}

module.exports = {
  ensureDirs,
  createProject,
  listProjects,
  readProjectFile,
  writeProjectFile,
  listProjectDocs,
  readProjectDoc,
  writeProjectDoc,
  saveFile,
};
