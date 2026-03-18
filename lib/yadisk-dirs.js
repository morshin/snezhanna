'use strict';

const fs = require('fs');
const path = require('path');
const diskLog = require('./disk-log');

const config = JSON.parse(fs.readFileSync(path.join(__dirname, '../config/nanobot.json'), 'utf8'));
const AGENT_MOUNT = config.yadisk.agent_mount;

const REQUIRED_DIRS = ['index', 'memory', 'projects', 'fitness', 'fitness/weekly', 'fitness/races', 'drafts', 'digests', 'tasks', 'inbox', 'analytics'];

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

## Документация
Детальные материалы — в папке \`docs/\`. Используй \`list_project_docs\` чтобы увидеть актуальный список файлов.
`,

  'tasks.md': `# Задачи — {PROJECT_NAME}

> Требования и спецификации задач — в \`docs/\`

## В работе


## Ожидает


## Завершено

`,

  'log.md': `# Журнал работ — {PROJECT_NAME}

> Детали архитектурных решений и договорённостей — в \`docs/\`

`,

  'notes.md': `# Заметки — {PROJECT_NAME}

> Расширенные описания, схемы, ТЗ — в \`docs/\`

`
};

const DOCS_INDEX_TEMPLATE = `# Документация — {PROJECT_NAME}

Здесь хранятся детальные материалы по проекту.
Основные файлы проекта (README, задачи, журнал, заметки) содержат краткие сводки со ссылками сюда.

## Файлы документации

_Список появится по мере создания файлов_

## Рекомендуемые файлы

- \`requirements.md\` — требования и ТЗ
- \`architecture.md\` — архитектурные решения
- \`decisions.md\` — принятые решения (ADR)
- \`contacts.md\` — контакты, договорённости, реквизиты
- \`integrations.md\` — интеграции и внешние системы
- \`onboarding.md\` — как войти в контекст проекта
`;

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

  // Создаём подпапку docs/ с индексным файлом
  const docsDir = path.join(projectDir, 'docs');
  fs.mkdirSync(docsDir, { recursive: true });
  const docsIndex = DOCS_INDEX_TEMPLATE.replace(/\{PROJECT_NAME\}/g, projectName);
  fs.writeFileSync(path.join(docsDir, 'index.md'), docsIndex, 'utf8');
  createdFiles.push('docs/index.md');

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

// Список файлов в папке docs/ проекта
function listProjectDocs(projectName) {
  const docsDir = path.join(AGENT_MOUNT, 'projects', projectName, 'docs');
  if (!fs.existsSync(docsDir)) {
    return { docs: [], note: 'Папка docs/ ещё не создана. Используй write_project_doc чтобы создать первый файл.' };
  }

  const entries = fs.readdirSync(docsDir, { withFileTypes: true });
  const docs = entries
    .filter(e => e.isFile() && !e.name.startsWith('.'))
    .map(e => {
      const filePath = path.join(docsDir, e.name);
      const stat = fs.statSync(filePath);
      return {
        name: e.name,
        size_bytes: stat.size,
        modified: stat.mtime.toISOString()
      };
    });

  return { project: projectName, docs, total: docs.length };
}

// Чтение файла из папки docs/ проекта
function readProjectDoc(projectName, filename) {
  const safeName = path.basename(filename);
  if (safeName !== filename || safeName.startsWith('.') || !safeName) {
    return { error: 'Некорректное имя файла' };
  }

  const docsDir = path.join(AGENT_MOUNT, 'projects', projectName, 'docs');
  const filePath = path.join(docsDir, safeName);

  if (!fs.existsSync(filePath)) {
    return { error: `Файл docs/${safeName} не найден в проекте "${projectName}"` };
  }

  const stat = fs.statSync(filePath);
  if (stat.size > 200 * 1024) {
    return { error: `Файл слишком большой (${Math.round(stat.size / 1024)}KB). Максимум 200KB.` };
  }

  return {
    project: projectName,
    file: `docs/${safeName}`,
    content: fs.readFileSync(filePath, 'utf8')
  };
}

// Запись файла в папку docs/ проекта (создаёт файл если не существует)
function writeProjectDoc(projectName, filename, content, mode = 'overwrite') {
  const safeName = path.basename(filename);
  if (safeName !== filename || safeName.startsWith('.') || !safeName) {
    return { error: 'Некорректное имя файла' };
  }

  const projectDir = path.join(AGENT_MOUNT, 'projects', projectName);
  if (!fs.existsSync(projectDir)) {
    return { error: `Проект "${projectName}" не найден` };
  }

  const docsDir = path.join(projectDir, 'docs');
  if (!fs.existsSync(docsDir)) {
    fs.mkdirSync(docsDir, { recursive: true });
  }

  const filePath = path.join(docsDir, safeName);

  if (mode === 'append') {
    const dateHeader = `\n\n---\n_${new Date().toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Madrid' })}_\n\n`;
    fs.appendFileSync(filePath, dateHeader + content, 'utf8');
  } else {
    fs.writeFileSync(filePath, content, 'utf8');
  }

  diskLog.log('Обновлён doc-файл проекта', `${projectName}/docs/${safeName} (${mode})`);
  return { saved: true, project: projectName, file: `docs/${safeName}`, mode };
}

// Сохранить файл из кэша Telegram на Яндекс.Диск
function saveFile(cacheKey, destPath) {
  const fileCache = require('./file-cache');
  const entry = fileCache.get(cacheKey);
  if (!entry) {
    return { error: 'Файл не найден в кэше. Возможно, прошло более 1 часа с момента получения — попроси Вову отправить файл ещё раз.' };
  }

  // Защита от path traversal: убираем ведущие ../ и /
  const safeDest = path.normalize(destPath).replace(/^(\.\.[\\/]|[\\/])+/, '');
  if (!safeDest) {
    return { error: 'Некорректный путь назначения' };
  }

  const fullPath = path.join(AGENT_MOUNT, safeDest);
  const destDir = path.dirname(fullPath);

  try {
    fs.mkdirSync(destDir, { recursive: true });
    fs.writeFileSync(fullPath, entry.buffer);
  } catch (err) {
    return { error: `Не удалось сохранить файл: ${err.message}` };
  }

  fileCache.remove(cacheKey);
  diskLog.log('Сохранён файл из Telegram', safeDest);
  console.log(`[yadisk-dirs] Saved file to: ${fullPath}`);

  return {
    saved: true,
    path: safeDest,
    filename: entry.filename,
    size_bytes: entry.buffer.length
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
  REQUIRED_DIRS
};
