'use strict';

const fs = require('fs');
const path = require('path');
const google = require('./google');
const yadisk = require('./yadisk');
const memory = require('./memory');
const yadiskDirs = require('./yadisk-dirs');
const tasks = require('./tasks');
const tasksMerge = require('./tasks-merge');
const attachments = require('./attachments');
const chatMonitor = require('./chat-monitor');
const races = require('./races');
const strava = require('./strava');
const { readMonthLog } = require('./token-log');
const github = require('./github');
const githubIssues = require('./github-issues');
const settings = require('./settings');
const mailManager = require('./mail-manager');
const archive = require('./archive');
const emailCredentials = require('./email-credentials');
const { db } = require('./db');

const config = require('./config');

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
    name: 'get_emails',
    description: 'Получить список непрочитанных писем из одного или всех подключённых ящиков.',
    input_schema: {
      type: 'object',
      properties: {
        account_id: { type: 'integer', description: 'ID конкретного ящика (из get_email_accounts). Если не указан — из всех ящиков.' },
        max_results: { type: 'integer', description: 'Максимальное количество писем (по умолчанию 20)', default: 20 },
        unread_only: { type: 'boolean', description: 'Только непрочитанные (по умолчанию true)', default: true }
      },
      required: []
    }
  },
  {
    name: 'read_email',
    description: 'Прочитать полный текст письма по ID. Помечает письмо как прочитанное.',
    input_schema: {
      type: 'object',
      properties: {
        account_id: { type: 'integer', description: 'ID ящика' },
        message_id: { type: 'string', description: 'ID письма' }
      },
      required: ['account_id', 'message_id']
    }
  },
  {
    name: 'mark_email_read',
    description: 'Пометить письмо как прочитанное.',
    input_schema: {
      type: 'object',
      properties: {
        account_id: { type: 'integer', description: 'ID ящика' },
        message_id: { type: 'string', description: 'ID письма' }
      },
      required: ['account_id', 'message_id']
    }
  },
  {
    name: 'read_email_attachment',
    description: 'Прочитать вложение из письма Gmail (PDF, XLSX, DOCX). Сначала прочитай письмо через read_email чтобы узнать attachment_id.',
    input_schema: {
      type: 'object',
      properties: {
        account_id: { type: 'integer', description: 'ID ящика (только Gmail)' },
        message_id: { type: 'string', description: 'ID письма' },
        attachment_id: { type: 'string', description: 'ID вложения (из поля attachments письма)' },
        filename: { type: 'string', description: 'Имя файла вложения' },
        mime_type: { type: 'string', description: 'MIME-тип вложения, например application/pdf' }
      },
      required: ['account_id', 'message_id', 'attachment_id']
    }
  },
  {
    name: 'create_draft',
    description: 'Создать черновик письма. Не отправляет — только сохраняет как черновик. Подтверждение не нужно.',
    input_schema: {
      type: 'object',
      properties: {
        account_id: { type: 'integer', description: 'ID ящика' },
        to: { type: 'string', description: 'Адрес получателя' },
        subject: { type: 'string', description: 'Тема письма' },
        body: { type: 'string', description: 'Текст письма' },
        in_reply_to: { type: 'string', description: 'ID письма, на которое отвечаем (опционально)' }
      },
      required: ['account_id', 'to', 'subject', 'body']
    }
  },
  {
    name: 'send_email',
    description: 'Подготовить письмо к отправке. НЕ отправляет напрямую: пользователю приходит сообщение в Telegram с текстом письма и кнопками «Отправить»/«Отмена» — отправка происходит только по физическому нажатию кнопки пользователем, это не контролируется этим инструментом. После вызова никогда не утверждай, что письмо уже отправлено — только что оно подготовлено и ждёт подтверждения.',
    input_schema: {
      type: 'object',
      properties: {
        account_id: { type: 'integer', description: 'ID ящика' },
        to: { type: 'string', description: 'Адрес получателя' },
        subject: { type: 'string', description: 'Тема письма' },
        body: { type: 'string', description: 'Текст письма' },
        in_reply_to: { type: 'string', description: 'ID письма, на которое отвечаем (опционально)' }
      },
      required: ['account_id', 'to', 'subject', 'body']
    }
  },
  {
    name: 'get_email_accounts',
    description: 'Получить список подключённых почтовых ящиков с их ID.',
    input_schema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'search_files',
    description: 'Полнотекстовый поиск файлов на Google Drive по ключевым словам. Возвращает список файлов с id, именем и ссылкой.',
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
    description: 'Прочитать текстовое содержимое файла с Google Drive по его id (id берётся из результатов search_files).',
    input_schema: {
      type: 'object',
      properties: {
        fileId: { type: 'string', description: 'Drive file id из результатов search_files' }
      },
      required: ['fileId']
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
    description: 'Создать новый проект в трекере задач.',
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
    description: 'Показать список всех проектов с их статусом и открытыми задачами.',
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
        notes: { type: 'string', description: 'Дополнительные заметки' },
        parent_id: { type: 'number', description: 'ID родительской задачи (для подзадач)' },
        source: { type: 'string', enum: ['manual', 'voice', 'email', 'chat', 'github'], description: 'Источник задачи (по умолчанию manual)' }
      },
      required: ['title']
    }
  },
  {
    name: 'list_tasks',
    description: 'Показать задачи из трекера и GitHub Milestones с близким дедлайном при настроенном GITHUB_TOKEN — один общий список по Эйзенхауэру. Элементы из GitHub — это вехи (milestones): source: "github", github_kind: "milestone", github_url, github_repo, due_date; закрыть веху можно только в GitHub.',
    input_schema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Фильтр по проекту' },
        status: { type: 'string', enum: ['pending', 'in_progress', 'done'], description: 'Фильтр по статусу' },
        urgent: { type: 'boolean', description: 'Фильтр: только срочные / только не срочные' },
        important: { type: 'boolean', description: 'Фильтр: только важные / только не важные' },
        tag: { type: 'string', description: 'Фильтр по тегу' },
        include_subtasks: { type: 'boolean', description: 'Включить подзадачи (по умолчанию true). false — только задачи верхнего уровня.' }
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
    name: 'search_archive',
    description: 'Поиск и просмотр долгосрочного архива всей переписки: диалог с шефом в этом чате, письма из подключённой почты (полный текст) и сообщения из отслеживаемых Telegram-чатов. Используй, когда шеф просит вспомнить что-то из прошлого — "пару месяцев назад обсуждали...", "найди в переписке с Х про проект Y", "что там писали про...". query — это буквальные ключевые слова, которые реально встречаются в тексте сообщений (тема, имя, деталь проекта) — НЕ общие фразы вроде "сообщения" или "чат", описывающие сам запрос, а не его содержание. Если шеф просит просто "покажи последние сообщения в чате Х" без конкретной темы — оставь query пустым и используй source_type/chat_name/date_from/date_to: тогда вернутся самые свежие записи по фильтрам, без поиска по ключевым словам. Каждый результат — это отдельное сообщение/письмо с фрагментом текста, датой, источником и (если есть) чатом/отправителем/проектом. Прочитай найденные фрагменты и сформулируй ответ своими словами, не просто вставляй список результатов. Если по ключевым словам ничего не нашлось — попробуй другие слова или синонимы, либо повтори запрос с пустым query для просмотра последних сообщений, прежде чем сказать шефу, что ничего нет.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Ключевые слова для поиска (тема, имена, детали проекта) — должны реально встречаться в тексте сообщений. Можно перечислить несколько слов через пробел — ищутся сообщения, содержащие любое из них. Оставь пустым, чтобы просто просмотреть последние записи по фильтрам (source_type/chat_name/даты), без поиска по словам.' },
        source_type: { type: 'string', enum: ['owner_chat', 'monitored_chat', 'email'], description: 'Ограничить одним источником (необязательно): owner_chat — переписка с шефом, monitored_chat — отслеживаемые чужие чаты, email — почта' },
        chat_name: { type: 'string', description: 'Ограничить конкретным чатом или почтовым ящиком по имени, частичное совпадение (необязательно)' },
        project: { type: 'string', description: 'Ограничить конкретным проектом (необязательно)' },
        date_from: { type: 'string', description: 'Не раньше этой даты, YYYY-MM-DD (необязательно)' },
        date_to: { type: 'string', description: 'Не позже этой даты, YYYY-MM-DD (необязательно)' },
        limit: { type: 'number', description: 'Максимум результатов, по умолчанию 20, максимум 50' }
      },
      required: []
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
    name: 'add_monitored_chat',
    description: 'Добавить Telegram-чат в список отслеживаемых (мониторинг чатов). Если пользователь переслал сообщение от человека или из группы, его ID виден в блоке [Переслано ...] — используй его как chat_id. Для публичных групп/каналов можно передать @ник вместо chat_id — ID определится автоматически.',
    input_schema: {
      type: 'object',
      properties: {
        chat_id: { type: 'number', description: 'Числовой ID чата (из блока [Переслано ...] или известный заранее)' },
        name: { type: 'string', description: 'Имя для отображения в дайджесте' },
        type: { type: 'string', enum: ['personal', 'work'], description: 'Тип чата (по умолчанию personal)' },
        username: { type: 'string', description: '@ник публичной группы/канала — chat_id определится автоматически, если он не передан' }
      },
      required: ['name']
    }
  },
  {
    name: 'remove_monitored_chat',
    description: 'Убрать чат из списка отслеживаемых (мониторинг чатов).',
    input_schema: {
      type: 'object',
      properties: {
        chat_id: { type: 'number', description: 'Числовой ID чата' }
      },
      required: ['chat_id']
    }
  },
  {
    name: 'list_monitored_chats',
    description: 'Показать текущий список отслеживаемых Telegram-чатов (имя, ID, тип).',
    input_schema: {
      type: 'object',
      properties: {},
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
    description: 'Сохранить файл, полученный через Telegram, на Google Drive. Файл хранится в кэше 1 час после получения. По умолчанию сохраняй в inbox/, если пользователь не указал другой путь. Можно сохранять в projects/{name}/docs/, drafts/ и т.д.',
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
    description: 'Создать новый старт (гонку). Создаёт структуру папок и файлов в fitness/races/ на Google Drive: README.md, plan.md, gear.md, result.md.',
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
    description: 'Загрузить тренировки из Strava за текущую неделю. Сохраняет данные в fitness/weekly/ на Google Drive. Автоматически запускается каждое воскресенье в 09:30, но можно вызвать вручную.',
    input_schema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'list_github_milestones',
    description: 'Получить открытые GitHub Milestones с дедлайном в настроенном окне (просроченные и до N дней вперёд, см. config github.milestone_due_within_days). Используй когда пользователь спрашивает о вехах, релизах, дедлайнах GitHub или сроках milestone.',
    input_schema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Фильтр по проекту (имя проекта из config, опционально)' },
        repo: { type: 'string', description: 'Конкретный репозиторий в формате owner/repo (опционально)' }
      },
      required: []
    }
  },
  {
    name: 'add_task_dependency',
    description: 'Установить зависимость между задачами: task_id не может начаться, пока не завершён depends_on_id.',
    input_schema: {
      type: 'object',
      properties: {
        task_id:      { type: 'number', description: 'ID задачи, которая зависит от другой' },
        depends_on_id: { type: 'number', description: 'ID задачи, от которой зависит task_id' }
      },
      required: ['task_id', 'depends_on_id']
    }
  },
  {
    name: 'get_task_with_subtasks',
    description: 'Получить задачу вместе со всеми подзадачами и зависимостями.',
    input_schema: {
      type: 'object',
      properties: {
        task_id: { type: 'number', description: 'ID задачи' }
      },
      required: ['task_id']
    }
  },
  {
    name: 'get_token_stats',
    description: 'Returns Anthropic API token usage statistics. ' +
      'Use when the user asks about API costs, token consumption, usage patterns, or optimization hints. ' +
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
  },
  {
    name: 'get_skill_context',
    description: 'Show current behavioral instructions per skill domain. Use when the user asks what rules are configured for a skill, or to check constraints before a complex task.',
    input_schema: {
      type: 'object',
      properties: {
        domain: {
          type: 'string',
          enum: ['global', 'email_poll', 'morning_briefing', 'evening_checkin', 'calendar_reminder'],
          description: 'Specific domain to show. If omitted — show all.'
        }
      },
      required: []
    }
  },
  {
    name: 'update_skill_context',
    description: 'Save a behavioral instruction for a specific skill domain. Use when the user says how they want a skill to behave — e.g. "рассылки не показывай", "добавь погоду в брифинг", "в чекин включай письма за день", "напоминай за час до встречи". Pass empty string to clear an instruction.',
    input_schema: {
      type: 'object',
      properties: {
        domain: {
          type: 'string',
          enum: ['global', 'email_poll', 'morning_briefing', 'evening_checkin', 'calendar_reminder'],
          description: 'Which skill domain this instruction applies to.'
        },
        instruction: {
          type: 'string',
          description: 'The instruction text. Pass empty string to clear.'
        }
      },
      required: ['domain', 'instruction']
    }
  },
  {
    name: 'update_my_preferences',
    description: 'Update user preferences and settings. Use when the user asks to change how the assistant behaves, communicates, or schedules things — e.g. "называй меня Вов", "отвечай покороче", "перенеси брифинг на 9:00", "включи Strava", "выключи GitHub", "будь построже", "меньше эмодзи", "не предлагай сохранять файлы без просьбы".',
    input_schema: {
      type: 'object',
      properties: {
        preferred_name:      { type: 'string', description: 'How to address the user' },
        formality:           { type: 'string', enum: ['formal', 'informal'] },
        response_style:      { type: 'string', enum: ['concise', 'detailed'] },
        briefing_time:       { type: 'string', description: 'HH:MM format' },
        github_enabled:      { type: 'boolean' },
        strava_enabled:      { type: 'boolean' },
        email_poll_interval: { type: 'integer', enum: [0, 15, 30, 60], description: '0 disables email polling entirely' },
        quiet_days:          { type: 'integer', description: '0 = cancel quiet mode, N = days' },
        character_notes:     { type: 'string', description: 'Freeform personality/style notes from the user — arbitrary preferences about how the assistant should communicate, what to emphasize, what to avoid. Appended to every system prompt as style guidance.' },
        user_gender:         { type: 'string', enum: ['female', 'male', 'neutral'], description: 'Grammatical gender to use when addressing the user in Russian' },
        bot_gender:          { type: 'string', enum: ['female', 'male', 'neutral'], description: 'Grammatical gender for the assistant\'s self-references in Russian (я сделал/а, написал/а etc.)' },
        bot_persona:         { type: 'string', description: 'Bot persona description (e.g. "Женщина, ~30 лет"). Overrides any persona described in the identity text.' }
      },
      required: []
    }
  },
  {
    name: 'set_quiet_mode',
    description: 'Set or cancel vacation/quiet mode. Use when the user asks to be left alone for a period, says "уйди на неделю", "не беспокой меня N дней", "тихий режим", "каникулы", etc.',
    input_schema: {
      type: 'object',
      properties: {
        days: {
          type: 'integer',
          description: 'Number of days for quiet mode. 0 = cancel quiet mode.',
          minimum: 0,
          maximum: 30
        }
      },
      required: ['days']
    }
  },
  {
    name: 'start_briefing',
    description: 'Call this ONLY when a note in the current message says the user was recently asked "Готов к брифингу?" and this message is their reply agreeing to it (in any phrasing — not necessarily an exact "да"). Sends the full morning briefing immediately. Do not call otherwise.',
    input_schema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'create_github_issue',
    description: `Создать issue в GitHub-репозитории Снежанны от имени пользователя.

КОГДА использовать — только после того, как пользователь явно согласился:
- Пользователь пожаловался на баг, и ты предложила составить репорт («хочешь, отправим разработчику?»)
- Пользователь попросил то, чего ты не умеешь, и согласился на запрос фичи
- Пользователь сам попросил создать issue

ПРОАКТИВНОЕ ПОВЕДЕНИЕ (не вызывай инструмент сразу, сначала предложи):
- Случился косяк — неверный ответ, облажался/ась → «Ну я всего лишь код, могу тупить. Хочешь, составим баг-репорт разработчику?»
- Пользователь просит то, чего ты не умеешь → «Пока не умею, но могу отправить разработчику запрос на эту фичу — составим?»
- Пользователь выражает фрустрацию от поведения бота → предложи зафиксировать

Если пользователь прислал фото в этом же сообщении — скриншот в issue НЕ прикрепляется (ограничение токена). Вместо этого: подробно опиши увиденное на скриншоте прямо в body issue — что изображено, какая ошибка/артефакт видна, воспроизводимые шаги если очевидны. Сообщи пользователю, что приложил текстовое описание вместо картинки.`,
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Краткий заголовок issue' },
        body:  { type: 'string', description: 'Подробное описание: что происходит, как воспроизвести, что ожидалось' },
        labels: {
          type: 'array',
          items: { type: 'string', enum: ['bug', 'enhancement', 'question'] },
          description: "Метки: 'bug' — ошибка, 'enhancement' — улучшение/пожелание, 'question' — вопрос"
        }
      },
      required: ['title', 'body']
    }
  },
  {
    name: 'update_bot',
    description: `Проверить доступность обновления и предложить его установить.

КОГДА использовать:
- Пользователь просит обновиться / обновить бота / поставить новую версию
- Пользователь спрашивает «есть ли обновления?»

Инструмент только проверяет версии. Если обновление доступно — отправляется
кнопка подтверждения (требует физического нажатия пользователем).
Если обновлений нет — сообщи что уже актуальная версия.`,
    input_schema: {
      type: 'object',
      properties: {},
      required: []
    }
  }
];

// Tools that require Google authorization
const GOOGLE_TOOLS = new Set([
  'get_calendar_events', 'create_calendar_event', 'update_calendar_event', 'delete_calendar_event',
  'get_emails', 'read_email', 'read_email_attachment', 'mark_email_read', 'create_draft',
  'send_email', 'get_email_accounts'
]);

const STRAVA_TOOLS = new Set(['sync_strava']);
const GITHUB_TOOLS_SET = new Set(['list_github_milestones']);
const CHAT_MONITOR_TOOLS = new Set(['get_chat_digest', 'add_monitored_chat', 'remove_monitored_chat', 'list_monitored_chats']);
// Drive-dependent tools: hide when Google not authorized yet
const DRIVE_TOOLS = new Set(['search_files', 'read_file', 'read_memory', 'write_memory', 'save_file', 'create_race']);

// Anthropic native web search — server-side tool, no local execution needed
const WEB_SEARCH_TOOL = {
  type: 'web_search_20250305',
  name: 'web_search',
  max_uses: 5
};

function getAvailableTools() {
  const integrations = config.integrations || {};
  const driveReady = google.isAuthorized();

  let custom = driveReady ? TOOLS : TOOLS.filter(t => !GOOGLE_TOOLS.has(t.name) && !DRIVE_TOOLS.has(t.name));

  if (integrations.strava === false)       custom = custom.filter(t => !STRAVA_TOOLS.has(t.name));
  if (integrations.github === false)       custom = custom.filter(t => !GITHUB_TOOLS_SET.has(t.name));
  if (!githubIssues.isConfigured())        custom = custom.filter(t => t.name !== 'create_github_issue');
  if (integrations.chat_monitor === false) custom = custom.filter(t => !CHAT_MONITOR_TOOLS.has(t.name));

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

// ── App state context (set from index.js for tools that mutate app state) ───

let _appState = null;
let _saveState = null;
let _rescheduleBriefing = null;
let _rescheduleEmailPoll = null;
let _bot = null;
let _startBriefing = null;

// Pending photo attached to the current incoming message (set from index.js photo handler)
let _pendingPhoto = null;

function setPendingPhoto(base64, mimeType) {
  _pendingPhoto = { base64, mimeType };
}

function clearPendingPhoto() {
  _pendingPhoto = null;
}

function setContext(appState, saveStateFn, rescheduleBriefingFn, rescheduleEmailPollFn, bot, startBriefingFn) {
  _appState = appState;
  _saveState = saveStateFn;
  _rescheduleBriefing = rescheduleBriefingFn || null;
  _rescheduleEmailPoll = rescheduleEmailPollFn || null;
  _bot = bot || null;
  _startBriefing = startBriefingFn || null;
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

    case 'get_email_accounts': {
      const accounts = db.prepare("SELECT id, label, email, type, account_type, enabled FROM email_accounts").all();
      return { accounts };
    }

    case 'get_emails': {
      if (input.account_id) {
        return await mailManager.getMessages(input.account_id, input.max_results || 20, true);
      }
      // No account_id — aggregate across every enabled account (not just the
      // first one), tagging each message so follow-up read_email/mark_email_read
      // calls have the account_id they need.
      const accounts = db.prepare("SELECT id, label FROM email_accounts WHERE enabled = 1").all();
      if (!accounts.length) return { messages: [], note: 'No email accounts configured' };
      const perAccountLimit = Math.max(5, Math.floor((input.max_results || 20) / accounts.length));
      const messages = [];
      for (const acc of accounts) {
        try {
          const msgs = await mailManager.getMessages(acc.id, perAccountLimit, true);
          for (const m of msgs) messages.push({ ...m, account_id: acc.id, account: acc.label });
        } catch (e) {
          messages.push({ account_id: acc.id, account: acc.label, error: e.message });
        }
      }
      return { messages };
    }

    case 'read_email':
      return await mailManager.getMessage(input.account_id, input.message_id);

    case 'read_email_attachment': {
      const account = db.prepare('SELECT * FROM email_accounts WHERE id = ?').get(input.account_id);
      if (!account) return { error: `Account ${input.account_id} not found` };
      const credentials = emailCredentials.readCredentials(account) || {};

      let buf;
      let filename = input.filename || 'unknown';
      let mimeType = input.mime_type || 'application/octet-stream';

      if (account.type === 'gmail') {
        const gmailAdapter = require('./gmail');
        try {
          buf = await gmailAdapter.getAttachment(credentials, input.message_id, input.attachment_id);
        } catch (err) {
          if (!err.message || !err.message.includes('Invalid attachment token')) throw err;
          console.warn('[Email] Invalid attachment token, re-fetching message...');
          const msgRetry = await gmailAdapter.getMessage(credentials, input.message_id);
          if (!msgRetry.attachments.length) throw err;
          const attRetry = (filename !== 'unknown' && msgRetry.attachments.find(a => a.filename === filename))
            || msgRetry.attachments.find(a => a.size > 0)
            || msgRetry.attachments[0];
          console.warn(`[Email] Retry with attachment: ${attRetry.filename}`);
          filename = attRetry.filename;
          mimeType = attRetry.mimeType;
          buf = await gmailAdapter.getAttachment(credentials, input.message_id, attRetry.id);
        }
      } else {
        return { error: 'Attachment download not supported for IMAP accounts' };
      }

      const text = await attachments.parseAttachment(buf, mimeType, filename);
      return { filename, mimeType, content: text };
    }

    case 'mark_email_read':
      return await mailManager.getMessage(input.account_id, input.message_id)
        .then(() => {
          const account = db.prepare('SELECT * FROM email_accounts WHERE id = ?').get(input.account_id);
          const credentials = emailCredentials.readCredentials(account) || {};
          const adapter = account.type === 'imap' ? require('./imap') : require('./gmail');
          return adapter.markAsRead(credentials, input.message_id);
        });

    case 'create_draft':
      return await mailManager.createDraft(
        input.account_id, input.to, input.subject, input.body, input.in_reply_to || null
      );

    case 'send_email': {
      // Without a live bot + known chatId there is nobody to show the button to —
      // a registered pending entry would just wait unconfirmable until TTL.
      if (!_bot || !_appState || !_appState.chatId) {
        return { error: 'Подтверждение отправки недоступно (бот ещё не готов). Сохрани письмо черновиком через create_draft.' };
      }

      const pendingEmail = require('./pending-email');
      const id = pendingEmail.register({
        account_id: input.account_id,
        to: input.to,
        subject: input.subject,
        body: input.body,
        in_reply_to: input.in_reply_to || null
      });

      const account = db.prepare('SELECT label, email FROM email_accounts WHERE id = ?').get(input.account_id);
      const accountLabel = account ? `${account.label} (${account.email})` : `ящик #${input.account_id}`;
      const preview = input.body.length > 800 ? input.body.slice(0, 800) + '…' : input.body;
      try {
        await _bot.sendMessage(_appState.chatId,
          `📧 Отправить письмо?\n\nКому: ${input.to}\nЯщик: ${accountLabel}\nТема: ${input.subject}\n───\n${preview}`,
          {
            reply_markup: {
              inline_keyboard: [[
                { text: '✅ Отправить', callback_data: `email:send:${id}` },
                { text: '❌ Отмена', callback_data: `email:cancel:${id}` }
              ]]
            }
          }
        );
      } catch (e) {
        console.error('[Tools] send_email confirmation message failed:', e.message);
        return { error: 'Не удалось показать письмо на подтверждение: ' + e.message };
      }

      return {
        pending_confirmation: true,
        note: 'Письмо подготовлено и отправлено пользователю на подтверждение кнопкой в Telegram. Отправка ещё НЕ произошла — не утверждай, что письмо отправлено.'
      };
    }

    case 'search_files':
      return await yadisk.searchFiles(input.query);

    case 'read_file':
      return await yadisk.readFile(input.fileId);

    case 'read_memory':
      return await memory.readMemory(input.category);

    case 'write_memory':
      return await memory.writeMemory(input.category, input.content, input.mode || 'append');

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
      return tasksMerge.listTasksWithGithub(input);

    case 'update_task':
      return tasks.updateTask(input);

    case 'complete_task':
      return tasks.completeTask(input);

    case 'delete_task':
      return tasks.deleteTask(input);

    case 'add_task_dependency':
      return tasks.addTaskDependency(input.task_id, input.depends_on_id);

    case 'get_task_with_subtasks':
      return tasks.getTaskWithSubtasks(input.task_id);

    case 'search_archive': {
      const results = archive.search(input.query, {
        source_type: input.source_type,
        chat_name: input.chat_name,
        project: input.project,
        date_from: input.date_from,
        date_to: input.date_to,
        limit: input.limit
      });
      return results.length > 0 ? { results } : { results: [], message: 'Ничего не найдено по этому запросу.' };
    }

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

    case 'add_monitored_chat': {
      let chatId = input.chat_id;

      // No numeric ID but a @username given → try to resolve via Bot API.
      // Works only for public groups/channels (and users who've talked to the bot);
      // Telegram does not expose private user IDs by username.
      if (!chatId && input.username) {
        if (!_bot) return { error: 'Бот недоступен для определения ID по нику — попроси переслать сообщение от этого пользователя.' };
        const handle = input.username.startsWith('@') ? input.username : `@${input.username}`;
        try {
          const chat = await _bot.getChat(handle);
          chatId = chat.id;
        } catch (e) {
          return { error: 'Telegram не позволяет узнать ID пользователя по нику — это закрыто в Bot API. Попроси пользователя написать мне напрямую хотя бы раз, или перешли мне любое их сообщение.' };
        }
      }

      if (!chatId) {
        return { error: 'Нужен числовой chat_id. Перешли мне сообщение от нужного человека или из чата — я возьму ID оттуда.' };
      }

      const result = chatMonitor.addChat({
        chat_id: Number(chatId),
        name: input.name,
        type: input.type || 'personal'
      });
      if (result?.error) return result;
      return { ok: true, chat_id: Number(chatId), name: input.name };
    }

    case 'remove_monitored_chat': {
      if (!chatMonitor.isMonitored(Number(input.chat_id))) {
        return { error: `Чат ${input.chat_id} не найден в списке отслеживаемых.` };
      }
      const result = chatMonitor.removeChat(Number(input.chat_id));
      if (result?.error) return result;
      return { ok: true, chat_id: Number(input.chat_id) };
    }

    case 'list_monitored_chats': {
      const chats = chatMonitor.listChats().map(c => ({ chat_id: c.chat_id, name: c.name, type: c.type }));
      return { count: chats.length, chats };
    }

    case 'save_file':
      return await yadiskDirs.saveFile(input.cache_key, input.dest_path);

    case 'create_race':
      return await races.createRace(input);

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

    case 'list_github_milestones': {
      if (!github.isConfigured()) {
        return { error: 'GitHub integration not configured (GITHUB_TOKEN missing or no repos in config)' };
      }
      try {
        const milestones = await github.getUpcomingMilestones(input.project || null);
        if (input.repo) {
          const filtered = milestones.filter(m => m.repo === input.repo);
          return { milestones: filtered, count: filtered.length };
        }
        return { milestones, count: milestones.length };
      } catch (e) {
        return { error: e.message };
      }
    }

    case 'get_skill_context': {
      const skillContext = require('./skill-context');
      if (input.domain) {
        const val = skillContext.get(input.domain);
        return { domain: input.domain, instruction: val || null };
      }
      const contexts = skillContext.listDomains().map(({ key, label }) => ({
        domain: key, label, instruction: skillContext.get(key) || null
      }));
      return { contexts };
    }

    case 'update_skill_context': {
      const skillContext = require('./skill-context');
      skillContext.set(input.domain, input.instruction || '');
      const saved = input.instruction && input.instruction.trim() ? input.instruction.trim() : null;
      console.log(`[SkillContext] Updated ${input.domain}: ${saved || '(cleared)'}`);
      return { updated: input.domain, instruction: saved };
    }

    case 'update_my_preferences': {
      const allowed = ['preferred_name', 'formality', 'response_style', 'briefing_time',
                       'github_enabled', 'strava_enabled', 'email_poll_interval', 'character_notes',
                       'user_gender', 'bot_gender', 'bot_persona'];
      const changed = [];
      for (const key of allowed) {
        if (input[key] !== undefined) {
          settings.set(key, String(input[key]));
          changed.push(key);
        }
      }
      if (input.quiet_days !== undefined) {
        if (!_appState || !_saveState) return { error: 'App state context not initialised' };
        if (input.quiet_days === 0) {
          _appState.quietUntil = null;
        } else {
          _appState.quietUntil = new Date(Date.now() + input.quiet_days * 86400000).toISOString();
          _appState.silenceDaysCount = 0;
          _appState.silenceLevel = 0;
        }
        _saveState(_appState);
        changed.push('quiet_mode');
      }
      if (input.briefing_time && _rescheduleBriefing) {
        _rescheduleBriefing(input.briefing_time);
      }
      if (input.email_poll_interval !== undefined && _rescheduleEmailPoll) {
        _rescheduleEmailPoll(input.email_poll_interval);
      }
      if (changed.includes('character_notes')) {
        const skillCtx = require('./skill-context');
        try {
          const parsed = await skillCtx.parseAndSave(input.character_notes);
          if (Object.keys(parsed).length) {
            console.log('[SkillContext] Auto-parsed domains:', Object.keys(parsed).join(', '));
          }
        } catch (e) {
          console.error('[SkillContext] Auto-parse failed:', e.message);
        }
      }
      return { updated: changed };
    }

    case 'set_quiet_mode': {
      if (!_appState || !_saveState) return { error: 'App state context not initialised' };
      const days = input.days;
      if (days === 0) {
        _appState.quietUntil = null;
        _saveState(_appState);
        return { success: true, message: 'Quiet mode cancelled' };
      }
      _appState.quietUntil = new Date(Date.now() + days * 86400000).toISOString();
      _appState.silenceDaysCount = 0;
      _appState.silenceLevel = 0;
      _saveState(_appState);
      const until = new Date(_appState.quietUntil).toLocaleDateString('ru-RU', { timeZone: config.timezone });
      return { success: true, message: `Quiet mode active until ${until}` };
    }

    case 'start_briefing': {
      if (!_startBriefing) return { error: 'Briefing context not initialised' };
      const started = await _startBriefing();
      return started
        ? { started: true, note: 'Брифинг отправлен — не дублируй его текстом в ответе.' }
        : { started: false, note: 'Брифинг не был ожидающим (briefingPending уже снят) — ничего не сделано.' };
    }

    case 'update_bot': {
      const releaseCheck = require('./release-check');
      const current = releaseCheck.getCurrentVersion();
      let releases;
      try {
        releases = await releaseCheck.getReleasesSince(current);
      } catch (e) {
        return { error: 'Не удалось проверить обновления: ' + e.message };
      }
      if (!releases || !releases.length) {
        return { up_to_date: true, version: current };
      }
      const latest = releases[releases.length - 1];
      // Do NOT exec update.sh here — execution must go through the Telegram button
      // callback (update:run), which requires a physical button click from the user
      // and cannot be triggered by prompt injection via external data.
      return { update_available: true, from: current, to: latest.tag, confirm_via_button: true };
    }

    case 'create_github_issue': {
      const photo = _pendingPhoto;
      clearPendingPhoto();
      return await githubIssues.createIssue({
        title: input.title,
        body: input.body,
        labels: input.labels || [],
        imageBase64: photo?.base64,
        imageMimeType: photo?.mimeType
      });
    }

    default:
      return { error: `Unknown tool: ${name}` };
  }
}

module.exports = { TOOLS, getAvailableTools, executeTool, setContext, setPendingPhoto, clearPendingPhoto };
