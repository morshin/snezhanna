'use strict';

const google = require('./google');
const yadisk = require('./yadisk');
const memory = require('./memory');

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
    description: 'Создать событие в Google Calendar.',
    input_schema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'Название события' },
        start_time: { type: 'string', description: 'Начало в формате ISO 8601 (например 2025-01-15T10:00:00)' },
        end_time: { type: 'string', description: 'Конец в формате ISO 8601' },
        description: { type: 'string', description: 'Описание события (опционально)' },
        location: { type: 'string', description: 'Место (опционально)' }
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
    description: 'Удалить событие из Google Calendar по ID.',
    input_schema: {
      type: 'object',
      properties: {
        event_id: { type: 'string', description: 'ID события для удаления' }
      },
      required: ['event_id']
    }
  },
  {
    name: 'get_gmail_messages',
    description: 'Получить список последних писем из Gmail (метаданные: от кого, тема, дата).',
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
    description: 'Прочитать полный текст письма по ID.',
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
  }
];

// Tools that require Google authorization
const GOOGLE_TOOLS = new Set([
  'get_calendar_events', 'create_calendar_event', 'update_calendar_event', 'delete_calendar_event',
  'get_gmail_messages', 'read_gmail_message', 'gmail_mark_read', 'create_gmail_draft'
]);

function getAvailableTools() {
  if (google.isAuthorized()) return TOOLS;
  return TOOLS.filter(t => !GOOGLE_TOOLS.has(t.name));
}

// ── Tool executor ───────────────────────────────────────────────────────────

async function executeTool(name, input) {
  switch (name) {
    case 'get_calendar_events':
      return await google.getCalendarEvents(input.days_ahead || 1);

    case 'create_calendar_event':
      return await google.createEvent(
        input.summary, input.start_time, input.end_time,
        input.description, input.location
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
      return await google.deleteEvent(input.event_id);

    case 'get_gmail_messages':
      return await google.getGmailMessages(input.max_results || 10);

    case 'read_gmail_message':
      return await google.getMessageById(input.message_id);

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

    default:
      return { error: `Unknown tool: ${name}` };
  }
}

module.exports = { TOOLS, getAvailableTools, executeTool };
