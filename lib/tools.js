'use strict';

const google = require('./google');
const yadisk = require('./yadisk');
const memory = require('./memory');
const yadiskDirs = require('./yadisk-dirs');
const tasks = require('./tasks');
const attachments = require('./attachments');
const chatMonitor = require('./chat-monitor');
const races = require('./races');
const strava = require('./strava');
const { readMonthLog } = require('./token-log');

// ── Tool definitions (Anthropic tool_use schema) ────────────────────────────

const TOOLS = [
  {
    name: 'get_calendar_events',
    description: 'Получить события из Google Calendar на ближайшие N дней.',
    input_schema: {
      type: 'object',
      properties: {
        days_ahead: { type: 'number', description: 'Количество дней вперёд (по умолчанию 1)', default: 1 }
      },
      required: []
    }
  },
  {
    name: 'create_calendar_event',
    description: 'Создать событие в Google Calendar. Поддерживает повторяющиеся события через RRULE.',
    input_schema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'Название события' },
        start_time: { type: 'string', description: 'Начало в формате ISO 8601 (например 2025-01-15T10:00:00)' },
        end_time: { type: 'string', description: 'Конец в формате ISO 8601' },
        description: { type: 'string', description: 'Описание события (опционально)' },
        location: { type: 'string', description: 'Место (опционально)' },
        recurrence: { type: 'string', description: 'RRULE для повторяющихся событий (опционально). Примеры: "RRULE:FREQ=DAILY" — каждый день; "RRULE:FREQ=WEEKLY;BYDAY=MO" — каждый понедельник; "RRULE:FREQ=WEEKLY;BYDAY=TU,TH" — вт и чт; "RRULE:FREQ=MONTHLY" — каждый месяц; "RRULE:FREQ=YEARLY" — каждый год.' }
      },
      required: ['summary', 'start_time', 'end_time']
    }
  },
  {
    name: 'update_calendar_event',
    description: 'Обновить существующее событие в Google Calendar по ID.',
    input_schema: {
      type: 'object',
      properties: {
        event_id: { type: 'string', description: 'ID события' },
        summary: { type: 'string', description: 'Новое название' },
        start_time: { type: 'string', description: 'Новое время начала (ISO 8601)' },
        end_time: { type: 'string', description: 'Новое время конца (ISO 8601)' },
        description: { type: 'string', description: 'Новое описание' },
        location: { type: 'string', description: 'Новое место' }
      },
      required: ['event_id']
    }
  },
  {
    name: 'delete_calendar_event',
    description: 'Удалить событие из Google Calendar по ID. Поддерживает удаление одного экземпляра или всей серии повторяющихся событий.',
    input_schema: {
      type: 'object',
      properties: {
        event_id: { type: 'string', description: 'ID события для удаления' },
        delete_mode: { type: 'string', enum: ['single', 'all'], description: 'Режим удаления: "single" — удалить только этот экземпляр серии (по умолчанию), "all" — удалить всю серию повторяющихся событий.' }
      },
      required: ['event_id']
    }
  },
  {
    name: 'get_gmail_messages',
    description: 'Получить список непрочитанных писем из Gmail (метаданные: от кого, тема, дата). Возвращает только UNREAD письма из Inbox.',
    input_schema: {
      type: 'object',
      properties: {
        max_results: { type: 'number', description: 'Максимальное количество писем (по умолчанию 10)', default: 10 }
      },
      required: []
    }
  },
  {
    name: 'read_gmail_message',
    description: 'Прочитать полный текст письма по ID. Автоматически помечает письмо как прочитанное.',
    input_schema: {
      type: 'object',
      properties: {
        message_id: { type: 'string', description: 'ID письма' }
      },
      required: ['message_id']
    }
  },
  {
    name: 'gmail_mark_read',
    description: 'Пометить письмо как прочитанное.',
    input_schema: {
      type: 'object',
      properties: {
        message_id: { type: 'string', description: 'ID письма' }
      },
      required: ['message_id']
    }
  },
  {
    name: 'read_gmail_attachment',
    description: 'Скачать и прочитать вложение из письма Gmail (PDF, XLSX, DOCX). Сначала прочитай письмо через read_gmail_message чтобы узнать attachment_id.',
    input_schema: {
      type: 'object',
      properties: {
        message_id: { type: 'string', description: 'ID письма' },
        attachment_id: { type: 'string', description: 'ID вложения (из поля attachments письма)' }
      },
      required: ['message_id', 'attachment_id']
    }
  },
  {
    name: 'create_gmail_draft',
    description: 'Создать черновик письма в Gmail. НЕ отправляет — только сохраняет как черновик.',
    input_schema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Адрес получателя' },
        subject: { type: 'string', description: 'Тема письма' },
        body: { type: 'string', description: 'Текст письма' }
      },
      required: ['to', 'subject', 'body']
    }
  },
  {
    name: 'search_files',
    description: 'Поиск файлов на Яндекс.Диске по ключевым словам (имя, путь).',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Поисковый запрос' }
      },
      required: ['query']
    }
  },
  {
    name: 'read_file',
    description: 'Прочитать содержимое файла с Яндекс.Диска (до 100KB).',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Относительный путь к файлу на Яндекс.Диске' }
      },
      required: ['path']
    }
  },
  {
    name: 'read_memory',
    description: 'Прочитать файл памяти Снежанны. Категории: health, kids, finance, bureaucracy, decisions.',
    input_schema: {
      type: 'object',
      properties: {
        category: { type: 'string', enum: ['health', 'kids', 'finance', 'bureaucracy', 'decisions'], description: 'Категория памяти' }
      },
      required: ['category']
    }
  },
  {
    name: 'write_memory',
    description: 'Записать в файл памяти Снежанны. Используй для сохранения важной информации.',
    input_schema: {
      type: 'object',
      properties: {
        category: { type: 'string', enum: ['health', 'kids', 'finance', 'bureaucracy', 'decisions'], description: 'Категория памяти' },
        content: { type: 'string', description: 'Текст для записи' },
        mode: { type: 'string', enum: ['append', 'overwrite'], description: 'Режим: append (дописать) или overwrite (перезаписать)', default: 'append' }
      },
      required: ['category', 'content']
    }
  },
  {
    name: 'create_project',
    description: 'Создать новый проект на Яндекс.Диске. Создаёт папку с шаблонными файлами (README, задачи, журнал, заметки).',
    input_schema: {
      type: 'object',
      properties: {
        project_name: { type: 'string', description: 'Название проекта (например: "Миграция-ERP-Альфа")' }
      },
      required: ['project_name']
    }
  },
  {
    name: 'list_projects',
    description: 'Показать список всех проектов на Яндекс.Диске с их статусом и платформой.',
    input_schema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'read_project_file',
    description: 'Прочитать файл проекта (README.md, tasks.md, log.md или notes.md).',
    input_schema: {
      type: 'object',
      properties: {
        project_name: { type: 'string', description: 'Название проекта (имя папки)' },
        file: { type: 'string', enum: ['README.md', 'tasks.md', 'log.md', 'notes.md'], description: 'Файл проекта' }
      },
      required: ['project_name', 'file']
    }
  },
  {
    name: 'write_project_file',
    description: 'Записать в файл проекта. Используй для обновления задач, журнала работ или заметок. Детальные материалы лучше выносить в docs/ через write_project_doc.',
    input_schema: {
      type: 'object',
      properties: {
        project_name: { type: 'string', description: 'Название проекта (имя папки)' },
        file: { type: 'string', enum: ['README.md', 'tasks.md', 'log.md', 'notes.md'], description: 'Файл проекта' },
        content: { type: 'string', description: 'Текст для записи' },
        mode: { type: 'string', enum: ['append', 'overwrite'], description: 'Режим: append (дописать) или overwrite (перезаписать)', default: 'append' }
      },
      required: ['project_name', 'file', 'content']
    }
  },
  {
    name: 'list_project_docs',
    description: 'Показать список файлов в папке docs/ проекта. Используй чтобы узнать какая документация уже есть перед чтением или записью.',
    input_schema: {
      type: 'object',
      properties: {
        project_name: { type: 'string', description: 'Название проекта (имя папки)' }
      },
      required: ['project_name']
    }
  },
  {
    name: 'read_project_doc',
    description: 'Прочитать файл из папки docs/ проекта. Используй для получения детального контекста по проекту (требования, архитектура, решения, контакты и т.д.).',
    input_schema: {
      type: 'object',
      properties: {
        project_name: { type: 'string', description: 'Название проекта (имя папки)' },
        filename: { type: 'string', description: 'Имя файла в папке docs/ (например: requirements.md, architecture.md)' }
      },
      required: ['project_name', 'filename']
    }
  },
  {
    name: 'write_project_doc',
    description: 'Создать или обновить файл в папке docs/ проекта. Используй для сохранения детальных материалов: требований, архитектурных решений, описаний интеграций, контактов, протоколов встреч и т.д. Файл будет создан если не существует.',
    input_schema: {
      type: 'object',
      properties: {
        project_name: { type: 'string', description: 'Название проекта (имя папки)' },
        filename: { type: 'string', description: 'Имя файла (например: requirements.md, decisions.md, contacts.md). Только имя файла, без пути.' },
        content: { type: 'string', description: 'Содержимое файла (markdown)' },
        mode: { type: 'string', enum: ['overwrite', 'append'], description: 'overwrite — полностью заменить файл (по умолчанию), append — дописать в конец с датой', default: 'overwrite' }
      },
      required: ['project_name', 'filename', 'content']
    }
  },
  {
    name: 'add_task',
    description: 'Добавить задачу в трекер. Задачи сортируются по матрице Эйзенхауэра (urgent + important).',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Заголовок задачи' },
        urgent: { type: 'boolean', description: 'Срочная? (по умолчанию false)' },
        important: { type: 'boolean', description: 'Важная? (по умолчанию false)' },
        project: { type: 'string', description: 'Имя проекта (если задача привязана к проекту)' },
        due_date: { type: 'string', description: 'Дедлайн в формате YYYY-MM-DD' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Теги (например: ["работа", "здоровье"])' },
        notes: { type: 'string', description: 'Дополнительные заметки' }
      },
      required: ['title']
    }
  },
  {
    name: 'list_tasks',
    description: 'Показать задачи из трекера. Без фильтров — все активные задачи, отсортированные по Эйзенхауэру.',
    input_schema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Фильтр по проекту' },
        status: { type: 'string', enum: ['pending', 'in_progress', 'done'], description: 'Фильтр по статусу' },
        urgent: { type: 'boolean', description: 'Фильтр: только срочные / только не срочные' },
        important: { type: 'boolean', description: 'Фильтр: только важные / только не важные' },
        tag: { type: 'string', description: 'Фильтр по тегу' }
      },
      required: []
    }
  },
  {
    name: 'update_task',
    description: 'Обновить задачу по ID. Можно менять заголовок, статус, срочность, важность, дедлайн, теги, заметки.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'ID задачи' },
        project: { type: 'string', description: 'Проект (если задача в проекте)' },
        title: { type: 'string', description: 'Новый заголовок' },
        status: { type: 'string', enum: ['pending', 'in_progress', 'done'], description: 'Новый статус' },
        urgent: { type: 'boolean', description: 'Срочная?' },
        important: { type: 'boolean', description: 'Важная?' },
        due_date: { type: 'string', description: 'Новый дедлайн (YYYY-MM-DD)' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Новые теги' },
        notes: { type: 'string', description: 'Новые заметки' }
      },
      required: ['id']
    }
  },
  {
    name: 'complete_task',
    description: 'Отметить задачу как выполненную.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'ID задачи' },
        project: { type: 'string', description: 'Проект (если задача в проекте)' }
      },
      required: ['id']
    }
  },
  {
    name: 'get_chat_digest',
    description: 'Получить дайджест сообщений из отслеживаемых Telegram-чатов за текущий день.',
    input_schema: {
      type: 'object',
      properties: {
        chat_name: { type: 'string', description: 'Имя чата (опционально, для конкретного чата)' },
        type: { type: 'string', enum: ['work', 'personal', 'all'], description: 'Тип чатов для фильтрации (по умолчанию all)' }
      },
      required: []
    }
  },
  {
    name: 'delete_task',
    description: 'Удалить задачу из трекера.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'ID задачи' },
        project: { type: 'string', description: 'Проект (если задача в проекте)' }
      },
      required: ['id']
    }
  },
  {
    name: 'save_file',
    description: 'Сохранить файл, полученный через Telegram, на Яндекс.Диск. Файл хранится в кэше 1 час после получения. По умолчанию сохраняй в inbox/, если пользователь не указал другой путь. Можно сохранять в projects/{name}/docs/, drafts/ и т.д.',
    input_schema: {
      type: 'object',
      properties: {
        cache_key: { type: 'string', description: 'Ключ файла в кэше — передаётся в сообщении о файле как [file_cache_key: ...]' },
        dest_path: { type: 'string', description: 'Путь внутри агентского хранилища, без ведущего слэша. Примеры: "inbox/отчёт.pdf", "projects/Клиент-X/docs/ТЗ.docx", "drafts/черновик.md"' }
      },
      required: ['cache_key', 'dest_path']
    }
  },
  {
    name: 'create_race',
    description: 'Создать новый старт (гонку). Создаёт структуру папок и файлов в fitness/races/ на Яндекс.Диске: README.md, plan.md, gear.md, result.md.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Название старта (например: "Ironman Barcelona")' },
        sport: { type: 'string', description: 'Вид спорта (бег, триатлон, велогонка и т.д.)' },
        date: { type: 'string', description: 'Дата старта в формате YYYY-MM-DD' },
        location: { type: 'string', description: 'Место проведения (город, страна)' }
      },
      required: ['name', 'date']
    }
  },
  {
    name: 'sync_strava',
    description: 'Загрузить тренировки из Strava за текущую неделю. Сохраняет данные в fitness/weekly/ на Яндекс.Диске. Автоматически запускается каждое воскресенье в 09:30, но можно вызвать вручную по запросу Вовы.',
    input_schema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'get_token_stats',
    description: 'Returns Anthropic API token usage statistics. ' +
      'Use when Vova asks about API costs, token consumption, usage patterns, or optimization hints. ' +
      'period: "current_month" | "last_month" | "last_7_days". Default: "current_month".',
    input_schema: {
      type: 'object',
      properties: {
        period: {
          type: 'string',
          enum: ['current_month', 'last_month', 'last_7_days'],
          description: 'Time period for statistics'
        }
      },
      required: []
    }
  }
];

// Tools that require Google authorization
const GOOGLE_TOOLS = new Set([
  'get_calendar_events', 'create_calendar_event', 'update_calendar_event', 'delete_calendar_event',
  'get_gmail_messages', 'read_gmail_message', 'read_gmail_attachment', 'gmail_mark_read', 'create_gmail_draft'
]);

// Anthropic native web search — server-side tool, no local execution needed
const WEB_SEARCH_TOOL = {
  type: 'web_search_20250305',
  name: 'web_search',
  max_uses: 5
};

function getAvailableTools() {
  const custom = google.isAuthorized() ? TOOLS : TOOLS.filter(t => !GOOGLE_TOOLS.has(t.name));
  return [...custom, WEB_SEARCH_TOOL];
}

// ── Calendar formatting ──────────────────────────────────────────────────────

// Форматирует события Calendar для Claude: заменяет сырые ISO-строки на читаемое Madrid-время
// Без этого Claude видит "2026-03-11T10:00:00+01:00" и может интерпретировать как UTC → ошибка на 1 час
function formatEventsForClaude(events) {
  return events.map(e => {
    const out = { ...e };
    if (out.start?.dateTime) {
      out.start = {
        ...out.start,
        dateTime_madrid: new Date(out.start.dateTime).toLocaleString('ru-RU', {
          weekday: 'short', day: 'numeric', month: 'short',
          hour: '2-digit', minute: '2-digit',
          timeZone: 'Europe/Madrid'
        })
      };
    }
    if (out.end?.dateTime) {
      out.end = {
        ...out.end,
        dateTime_madrid: new Date(out.end.dateTime).toLocaleString('ru-RU', {
          hour: '2-digit', minute: '2-digit',
          timeZone: 'Europe/Madrid'
        })
      };
    }
    return out;
  });
}

// ── Tool executor ───────────────────────────────────────────────────────────

async function executeTool(name, input) {
  switch (name) {
    case 'get_calendar_events': {
      const events = await google.getCalendarEvents(input.days_ahead || 1);
      return formatEventsForClaude(events);
    }

    case 'create_calendar_event':
      return await google.createEvent(
        input.summary, input.start_time, input.end_time,
        input.description, input.location, input.recurrence
      );

    case 'update_calendar_event': {
      const updates = {};
      if (input.summary) updates.summary = input.summary;
      if (input.start_time) updates.startTime = input.start_time;
      if (input.end_time) updates.endTime = input.end_time;
      if (input.description !== undefined) updates.description = input.description;
      if (input.location !== undefined) updates.location = input.location;
      return await google.updateEvent(input.event_id, updates);
    }

    case 'delete_calendar_event':
      if (input.delete_mode === 'all') {
        return await google.deleteEventSeries(input.event_id);
      }
      return await google.deleteEvent(input.event_id);

    case 'get_gmail_messages':
      return await google.getGmailMessages(input.max_results || 10);

    case 'read_gmail_message':
      return await google.getMessageById(input.message_id);

    case 'read_gmail_attachment': {
      const buf = await google.getAttachment(input.message_id, input.attachment_id);
      // Find attachment metadata by reading the message
      const msg = await google.getMessageById(input.message_id);
      const att = msg.attachments.find(a => a.id === input.attachment_id);
      const mimeType = att ? att.mimeType : 'application/octet-stream';
      const filename = att ? att.filename : 'unknown';
      const text = await attachments.parseAttachment(buf, mimeType, filename);
      return { filename, mimeType, content: text };
    }

    case 'gmail_mark_read':
      return await google.markAsRead(input.message_id);

    case 'create_gmail_draft':
      return await google.createDraft(input.to, input.subject, input.body);

    case 'search_files':
      return yadisk.searchFiles(input.query);

    case 'read_file':
      return yadisk.readFile(input.path);

    case 'read_memory':
      return memory.readMemory(input.category);

    case 'write_memory':
      return memory.writeMemory(input.category, input.content, input.mode || 'append');

    case 'create_project':
      return yadiskDirs.createProject(input.project_name);

    case 'list_projects':
      return yadiskDirs.listProjects();

    case 'read_project_file':
      return yadiskDirs.readProjectFile(input.project_name, input.file);

    case 'write_project_file':
      return yadiskDirs.writeProjectFile(input.project_name, input.file, input.content, input.mode || 'append');

    case 'list_project_docs':
      return yadiskDirs.listProjectDocs(input.project_name);

    case 'read_project_doc':
      return yadiskDirs.readProjectDoc(input.project_name, input.filename);

    case 'write_project_doc':
      return yadiskDirs.writeProjectDoc(input.project_name, input.filename, input.content, input.mode || 'overwrite');

    case 'add_task':
      return tasks.addTask(input);

    case 'list_tasks':
      return tasks.listTasks(input);

    case 'update_task':
      return tasks.updateTask(input);

    case 'complete_task':
      return tasks.completeTask(input);

    case 'delete_task':
      return tasks.deleteTask(input);

    case 'get_chat_digest': {
      const filter = {};
      if (input.chat_name) filter.chatName = input.chat_name;
      if (input.type) filter.type = input.type;
      const digest = chatMonitor.getDigest(filter);
      const stats = chatMonitor.getStats();
      return {
        digest: digest || 'Новых сообщений в отслеживаемых чатах нет.',
        stats
      };
    }

    case 'save_file':
      return yadiskDirs.saveFile(input.cache_key, input.dest_path);

    case 'create_race':
      return races.createRace(input);

    case 'sync_strava': {
      if (!strava.isConfigured()) {
        return { error: 'Strava не настроена (нет STRAVA_REFRESH_TOKEN в .env)' };
      }
      const result = await strava.syncCurrentWeek();
      if (!result) {
        return { error: 'Не удалось загрузить тренировки из Strava' };
      }
      return {
        week: result.weekStr,
        activities_count: result.totals.activities_count,
        distance_km: (result.totals.distance_m / 1000).toFixed(1),
        moving_time_min: Math.round(result.totals.moving_time_s / 60),
        elevation_m: result.totals.elevation_gain_m,
        by_sport: result.totals.by_sport,
        activities: result.activities.map(a => ({
          name: a.name,
          type: a.type,
          distance_km: (a.distance / 1000).toFixed(1),
          moving_time_min: Math.round(a.moving_time / 60),
          average_heartrate: a.average_heartrate
        }))
      };
    }

    case 'get_token_stats': {
      const period = input.period || 'current_month';
      const now = new Date();
      const curYear = now.getFullYear();
      const curMonth = now.getMonth() + 1;

      let entries = [];

      if (period === 'current_month') {
        entries = readMonthLog(curYear, curMonth);
      } else if (period === 'last_month') {
        const d = new Date(curYear, curMonth - 2, 1);
        entries = readMonthLog(d.getFullYear(), d.getMonth() + 1);
      } else if (period === 'last_7_days') {
        const cutoff = Date.now() - 7 * 86400000;
        const curEntries = readMonthLog(curYear, curMonth);
        // May span month boundary
        const prevD = new Date(curYear, curMonth - 2, 1);
        const prevEntries = readMonthLog(prevD.getFullYear(), prevD.getMonth() + 1);
        entries = [...prevEntries, ...curEntries].filter(e => e.ts >= cutoff);
      }

      const totalRequests = entries.length;

      // by_bot
      const byBot = {};
      for (const e of entries) {
        byBot[e.bot] = (byBot[e.bot] || 0) + 1;
      }

      // by_type
      const byType = {};
      for (const e of entries) {
        byType[e.type] = (byType[e.type] || 0) + 1;
      }

      // tokens
      let inputTotal = 0, outputTotal = 0, cacheCreated = 0, cacheRead = 0;
      let historyLenSum = 0;
      for (const e of entries) {
        inputTotal += e.usage?.input_tokens || 0;
        outputTotal += e.usage?.output_tokens || 0;
        cacheCreated += e.usage?.cache_creation_input_tokens || 0;
        cacheRead += e.usage?.cache_read_input_tokens || 0;
        historyLenSum += e.history_len || 0;
      }
      const cacheHitRate = (cacheCreated + cacheRead) > 0
        ? Math.round(cacheRead / (cacheRead + cacheCreated) * 100)
        : 0;

      // top_tools
      const toolCounts = {};
      for (const e of entries) {
        for (const t of (e.tools_called || [])) {
          toolCounts[t] = (toolCounts[t] || 0) + 1;
        }
      }
      const topTools = Object.entries(toolCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([name, calls]) => ({ name, calls }));

      // most_expensive_types (by avg input tokens)
      const typeInputSums = {};
      const typeCounts = {};
      for (const e of entries) {
        const t = e.type;
        typeInputSums[t] = (typeInputSums[t] || 0) + (e.usage?.input_tokens || 0);
        typeCounts[t] = (typeCounts[t] || 0) + 1;
      }
      const mostExpensiveTypes = Object.keys(typeInputSums)
        .map(t => ({ type: t, avg_input_tokens: Math.round(typeInputSums[t] / typeCounts[t]) }))
        .sort((a, b) => b.avg_input_tokens - a.avg_input_tokens)
        .slice(0, 3);

      return {
        period,
        total_requests: totalRequests,
        by_bot: byBot,
        by_type: byType,
        tokens: {
          input_total: inputTotal,
          output_total: outputTotal,
          cache_created: cacheCreated,
          cache_read: cacheRead,
          cache_hit_rate_pct: cacheHitRate
        },
        avg_per_request: totalRequests > 0 ? {
          input: Math.round(inputTotal / totalRequests),
          output: Math.round(outputTotal / totalRequests),
          history_len: Math.round(historyLenSum / totalRequests)
        } : { input: 0, output: 0, history_len: 0 },
        top_tools: topTools,
        most_expensive_types: mostExpensiveTypes
      };
    }

    default:
      return { error: `Unknown tool: ${name}` };
  }
}

module.exports = { TOOLS, getAvailableTools, executeTool };
