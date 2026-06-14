'use strict';

// Groups of tools → human-readable capability lines (Russian).
// Each group fires only when at least one sentinel tool is present.
// domain: matches skill_context keys from lib/skill-context.js (optional).
const GROUPS = [
  {
    sentinel: ['get_calendar_events'],
    domain: 'calendar_reminder',
    label: '**Календарь**',
    text: 'Google Calendar — просмотр событий, создание (в т.ч. повторяющихся через RRULE), редактирование, удаление.',
  },
  {
    sentinel: ['get_emails'],
    domain: 'email_poll',
    label: '**Почта**',
    text: 'Подключённые ящики (Gmail и IMAP/SMTP) — чтение писем и вложений (PDF, XLSX, DOCX), создание черновиков, отправка.',
  },
  {
    sentinel: ['search_files'],
    label: '**Файлы (Google Drive)**',
    text: 'Полнотекстовый поиск, чтение содержимого, сохранение новых файлов.',
  },
  {
    sentinel: ['read_memory'],
    label: '**Долгосрочная память**',
    text: 'Категории: здоровье, дети, финансы, бюрократия, решения — читаю и обновляю между сессиями.',
  },
  {
    sentinel: ['add_task'],
    label: '**Задачи**',
    text: 'Трекер задач с подзадачами, зависимостями и статусами.',
  },
  {
    sentinel: ['create_project'],
    label: '**Проекты**',
    text: 'Создание проектов, ведение README, задач, журнала работ и документации (docs/).',
  },
  {
    sentinel: ['get_chat_digest'],
    label: '**Мониторинг Telegram-чатов**',
    text: 'Дайджест переписки из подключённых чатов.',
  },
  {
    sentinel: ['sync_strava', 'create_race'],
    label: '**Спорт и забеги**',
    text: 'Синхронизация тренировок Strava, управление беговыми стартами (Races).',
  },
  {
    sentinel: ['list_github_milestones'],
    label: '**GitHub**',
    text: 'Активные milestones с приближающимися или просроченными дедлайнами.',
  },
  {
    sentinel: ['web_search'],
    label: '**Веб-поиск**',
    text: 'Поиск актуальной информации в интернете — курсы валют, погода, новости, расписания.',
  },
  {
    sentinel: ['update_my_preferences', 'set_quiet_mode'],
    label: '**Настройки**',
    text: 'Изменение имени, стиля общения, персонажа бота; режим тишины / отпуска.',
  },
  {
    sentinel: ['get_token_stats'],
    label: '**Статистика токенов**',
    text: 'Аналитика использования API — токены, кэш-хиты, расходы.',
  },
];

// Capabilities that are always present (not tied to tools).
const ALWAYS_ON = [
  '**Голос** — расшифровка голосовых сообщений (OpenAI Whisper).',
  '**Фото и документы** — распознавание содержимого изображений.',
  {
    text: '**Утренний брифинг** — ежедневный дайджест: календарь, почта, задачи, GitHub, погода, Strava.',
    domain: 'morning_briefing',
  },
  '**Напоминания** — дедлайны задач, встречи за 30 мин, письма с запросом ответа.',
  {
    text: '**Вечерний чекин** — сводка дня и сохранённых на Drive файлов.',
    domain: 'evening_checkin',
  },
  '**Скор баланса** — еженедельная оценка нагрузки по 4 доменам (работа, семья, здоровье, личное).',
];

const META_INSTRUCTION = `
---
Перед нестандартными запросами проверяй:
1. Есть ли у тебя подходящий инструмент (список выше).
2. Не противоречит ли запрос текущим ⚙️-инструкциям.
Если есть ограничение — сообщи честно и предложи изменить инструкцию. Если инструмента нет — скажи прямо.
При автоматических задачах (брифинг, почта, чекин) применяй ⚙️-инструкции как фильтры до дорогих вызовов.`;

/**
 * Builds a "what I can do" block from the provided tools list and skill-context instructions.
 *
 * @param {Array<{name: string}>} tools
 * @param {Object} skillContexts  — map of domain → instruction string (from skill-context.getAll())
 * @returns {string}
 */
function buildSkillsBlock(tools, skillContexts = {}) {
  const names = new Set(tools.map(t => t.name));

  const lines = ['## Мои актуальные возможности\n'];

  for (const group of GROUPS) {
    if (group.sentinel.some(s => names.has(s))) {
      const ctx = group.domain ? skillContexts[group.domain] : null;
      lines.push(`${group.label} — ${group.text}`);
      if (ctx) lines.push(`  ⚙️ ${ctx}`);
    }
  }

  lines.push('');
  for (const item of ALWAYS_ON) {
    if (typeof item === 'string') {
      lines.push(item);
    } else {
      const ctx = item.domain ? skillContexts[item.domain] : null;
      lines.push(item.text);
      if (ctx) lines.push(`  ⚙️ ${ctx}`);
    }
  }

  const globalCtx = skillContexts['global'];
  if (globalCtx) {
    lines.push('');
    lines.push(`**Общая инструкция:** ${globalCtx}`);
  }

  lines.push(META_INSTRUCTION);

  return lines.join('\n');
}

module.exports = { buildSkillsBlock };
