'use strict';

// Groups of tools → human-readable capability lines (Russian).
// Each group fires only when at least one sentinel tool is present.
const GROUPS = [
  {
    sentinel: ['get_calendar_events'],
    label: '**Календарь**',
    text: 'Google Calendar — просмотр событий, создание (в т.ч. повторяющихся через RRULE), редактирование, удаление.',
  },
  {
    sentinel: ['get_emails'],
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
  '**Утренний брифинг** — ежедневный дайджест: календарь, почта, задачи, GitHub, погода, Strava.',
  '**Напоминания** — дедлайны задач, встречи за 30 мин, письма с запросом ответа.',
  '**Вечерний чекин** — сводка дня и сохранённых на Drive файлов.',
  '**Скор баланса** — еженедельная оценка нагрузки по 4 доменам (работа, семья, здоровье, личное).',
];

/**
 * Builds a "what I can do" block from the provided tools list.
 * Pass the result of getAvailableTools() or any array of { name } objects.
 *
 * @param {Array<{name: string}>} tools
 * @returns {string}
 */
function buildSkillsBlock(tools) {
  const names = new Set(tools.map(t => t.name));

  const lines = ['## Мои актуальные возможности\n'];

  for (const group of GROUPS) {
    if (group.sentinel.some(s => names.has(s))) {
      lines.push(`${group.label} — ${group.text}`);
    }
  }

  lines.push('');
  for (const line of ALWAYS_ON) {
    lines.push(line);
  }

  return lines.join('\n');
}

module.exports = { buildSkillsBlock };
