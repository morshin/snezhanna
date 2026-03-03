'use strict';

const fs = require('fs');
const path = require('path');
const diskLog = require('./disk-log');

const config = JSON.parse(fs.readFileSync(path.join(__dirname, '../config/nanobot.json'), 'utf8'));
const AGENT_MOUNT = config.yadisk.agent_mount;

const REQUIRED_DIRS = ['index', 'memory', 'projects', 'fitness', 'drafts', 'digests'];

const PROJECT_TEMPLATE_FILES = {
  'README.md': `# {PROJECT_NAME}

## Клиент
_Название компании / контактное лицо_

## Тип проекта
_Внедрение / Доработка / Сопровождение / Миграция / Аудит_

## Платформа
_1С:ERP / 1С:УТ / 1С:БП / 1С:ЗУП / Другое_

## Статус
Активный

## Контакты
- Ответственный: 
- Телефон: 
- Email: 

## Описание
_Краткое описание проекта и основных задач_
`,

  'tasks.md': `# Задачи — {PROJECT_NAME}

## В работе


## Ожидает


## Завершено

`,

  'log.md': `# Журнал работ — {PROJECT_NAME}

`,

  'notes.md': `# Заметки — {PROJECT_NAME}

`
};

// Проверяет и создаёт все обязательные подпапки в /mnt/yadisk-agent/
function ensureDirs() {
  if (!fs.existsSync(AGENT_MOUNT)) {
    console.log(`[yadisk-dirs] Agent mount not available: ${AGENT_MOUNT}`);
    return { ok: false, error: 'Agent mount not available' };
  }

  const created = [];
  const failed = [];

  for (const dir of REQUIRED_DIRS) {
    const fullPath = path.join(AGENT_MOUNT, dir);
    if (!fs.existsSync(fullPath)) {
      try {
        fs.mkdirSync(fullPath, { recursive: true });
        created.push(dir);
        diskLog.log('Создана папка', dir + '/');
        console.log(`[yadisk-dirs] Created: ${fullPath}`);
      } catch (err) {
        failed.push(dir);
        console.error(`[yadisk-dirs] Failed to create ${fullPath}: ${err.message}`);
      }
    }
  }

  if (created.length > 0) {
    console.log(`[yadisk-dirs] Created ${created.length} directories: ${created.join(', ')}`);
  }
  if (failed.length > 0) {
    console.error(`[yadisk-dirs] Failed to create ${failed.length} directories: ${failed.join(', ')}`);
  }
  if (created.length === 0 && failed.length === 0) {
    console.log('[yadisk-dirs] All directories OK');
  }

  return { ok: failed.length === 0, created, failed };
}

// Создаёт новый проект из шаблона
function createProject(projectName) {
  if (!projectName || typeof projectName !== 'string') {
    return { error: 'Не указано имя проекта' };
  }

  const safeName = projectName.replace(/[<>:"/\\|?*]/g, '_').trim();
  if (!safeName) {
    return { error: 'Некорректное имя проекта' };
  }

  const projectDir = path.join(AGENT_MOUNT, 'projects', safeName);
  if (fs.existsSync(projectDir)) {
    return { error: `Проект "${safeName}" уже существует` };
  }

  fs.mkdirSync(projectDir, { recursive: true });
  diskLog.log('Создан проект', safeName);

  const createdFiles = [];
  for (const [filename, template] of Object.entries(PROJECT_TEMPLATE_FILES)) {
    const content = template.replace(/\{PROJECT_NAME\}/g, projectName);
    fs.writeFileSync(path.join(projectDir, filename), content, 'utf8');
    createdFiles.push(filename);
  }

  console.log(`[yadisk-dirs] Created project "${safeName}" with files: ${createdFiles.join(', ')}`);
  return { created: true, name: safeName, files: createdFiles };
}

// Список проектов
function listProjects() {
  const projectsDir = path.join(AGENT_MOUNT, 'projects');
  if (!fs.existsSync(projectsDir)) {
    return { projects: [] };
  }

  const entries = fs.readdirSync(projectsDir, { withFileTypes: true });
  const projects = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;

    const projPath = path.join(projectsDir, entry.name);
    const readmePath = path.join(projPath, 'README.md');
    let status = 'Неизвестен';
    let platform = '';

    if (fs.existsSync(readmePath)) {
      const readme = fs.readFileSync(readmePath, 'utf8');
      const statusMatch = readme.match(/## Статус\n(.+)/);
      if (statusMatch) status = statusMatch[1].trim();
      const platformMatch = readme.match(/## Платформа\n(.+)/);
      if (platformMatch) platform = platformMatch[1].trim();
    }

    const files = fs.readdirSync(projPath);
    projects.push({
      name: entry.name,
      status,
      platform,
      files
    });
  }

  return { projects, total: projects.length };
}

// Чтение файла проекта
function readProjectFile(projectName, filename) {
  const allowed = ['README.md', 'tasks.md', 'log.md', 'notes.md'];
  if (!allowed.includes(filename)) {
    return { error: `Недопустимый файл. Доступны: ${allowed.join(', ')}` };
  }

  const filePath = path.join(AGENT_MOUNT, 'projects', projectName, filename);
  if (!fs.existsSync(filePath)) {
    return { error: `Файл не найден: ${projectName}/${filename}` };
  }

  return {
    project: projectName,
    file: filename,
    content: fs.readFileSync(filePath, 'utf8')
  };
}

// Запись в файл проекта
function writeProjectFile(projectName, filename, content, mode = 'append') {
  const allowed = ['README.md', 'tasks.md', 'log.md', 'notes.md'];
  if (!allowed.includes(filename)) {
    return { error: `Недопустимый файл. Доступны: ${allowed.join(', ')}` };
  }

  const projectDir = path.join(AGENT_MOUNT, 'projects', projectName);
  if (!fs.existsSync(projectDir)) {
    return { error: `Проект "${projectName}" не найден` };
  }

  const filePath = path.join(projectDir, filename);

  if (mode === 'overwrite') {
    fs.writeFileSync(filePath, content, 'utf8');
  } else {
    const dateHeader = `\n\n---\n_${new Date().toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Madrid' })}_\n\n`;
    fs.appendFileSync(filePath, dateHeader + content, 'utf8');
  }

  diskLog.log('Обновлён файл проекта', `${projectName}/${filename} (${mode})`);
  return { saved: true, project: projectName, file: filename, mode };
}

module.exports = {
  ensureDirs,
  createProject,
  listProjects,
  readProjectFile,
  writeProjectFile,
  REQUIRED_DIRS
};
