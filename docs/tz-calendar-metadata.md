# ТЗ: Метаданные событий календаря

## Цель

Добавить структурированные метаданные к событиям Google Calendar:
категорию, привязку к проекту, теги, ссылку на фоллоу-ап.
Метаданные хранятся в `extendedProperties.private` — невидимы в интерфейсе Google Calendar,
не мешают описанию события, доступны через API.

---

## Схема метаданных

```json
{
  "category": "work",
  "project": "Миграция-ERP-Альфа",
  "tags": "релиз,команда",
  "followup_ref": "meetings/2026-03-03-eрp-release.md"
}
```

### Поля

| Поле | Тип | Обязательное | Описание |
|------|-----|--------------|----------|
| `category` | string | нет | Категория события (см. справочник) |
| `project` | string | нет | Имя папки проекта на Яндекс.Диске (из `list_projects`) |
| `tags` | string | нет | Теги через запятую, без пробелов |
| `followup_ref` | string | нет | Путь к файлу фоллоу-апа в папке агента |

### Справочник категорий

| Значение | Описание |
|----------|----------|
| `work` | Рабочие задачи, клиенты, консалтинг |
| `petproject` | Собственные проекты (Снежанна и др.) |
| `sport` | Тренировки, спорт, физическая активность |
| `learning` | Курсы, чтение, личное развитие |
| `family` | Семья, дети, личные дела |
| `health` | Врачи, анализы, процедуры |
| `admin` | Бюрократия, документы, налоги |

---

## Изменения в коде

### 1. `lib/google.js`

#### `createEvent` — добавить `extendedProperties`

```js
async function createEvent(summary, startTime, endTime, description, location, recurrence, metadata) {
  // ...
  if (metadata && Object.keys(metadata).length > 0) {
    event.extendedProperties = {
      private: {
        category: metadata.category || '',
        project: metadata.project || '',
        tags: metadata.tags || '',
        followup_ref: metadata.followup_ref || ''
      }
    };
  }
  // ...
}
```

#### `updateEvent` — добавить патч `extendedProperties`

```js
if (updates.metadata) {
  patch.extendedProperties = {
    private: { ...updates.metadata }
  };
}
```

#### `getCalendarEvents` / `getUpcomingEvents` — включить поле в ответ

Добавить `fields` в запрос, чтобы `extendedProperties` возвращались:

```js
const res = await calendar.events.list({
  calendarId: 'primary',
  timeMin: now.toISOString(),
  timeMax: end.toISOString(),
  singleEvents: true,
  orderBy: 'startTime'
  // extendedProperties возвращаются автоматически — ничего добавлять не нужно
});
```

> Проверить: Google Calendar API возвращает `extendedProperties` в ответе `events.list` без дополнительных параметров.

### 2. `lib/tools.js`

#### `create_calendar_event` — добавить параметры метаданных

```json
"category": {
  "type": "string",
  "enum": ["work", "petproject", "sport", "learning", "family", "health", "admin"],
  "description": "Категория события"
},
"project": {
  "type": "string",
  "description": "Название проекта (имя папки на Яндекс.Диске)"
},
"tags": {
  "type": "string",
  "description": "Теги через запятую (например: релиз,команда)"
}
```

#### `update_calendar_event` — те же параметры

#### `executeTool` — собрать metadata-объект и передать в `createEvent`/`updateEvent`

```js
case 'create_calendar_event': {
  const metadata = {};
  if (input.category) metadata.category = input.category;
  if (input.project) metadata.project = input.project;
  if (input.tags) metadata.tags = input.tags;
  return await google.createEvent(
    input.summary, input.start_time, input.end_time,
    input.description, input.location, input.recurrence,
    Object.keys(metadata).length ? metadata : null
  );
}
```

### 3. Новый инструмент: `save_meeting_followup`

Отдельный tool для фиксации итогов встречи. Пишет файл в `/mnt/yadisk-agent/meetings/`.

```json
{
  "name": "save_meeting_followup",
  "description": "Сохранить итоги встречи: решения, ответственные, следующие шаги. Пишет в /mnt/yadisk-agent/meetings/.",
  "input_schema": {
    "properties": {
      "event_id":    { "type": "string", "description": "ID события в Google Calendar" },
      "event_title": { "type": "string", "description": "Название встречи" },
      "date":        { "type": "string", "description": "Дата встречи (YYYY-MM-DD)" },
      "summary":     { "type": "string", "description": "Краткое резюме встречи" },
      "decisions":   { "type": "string", "description": "Принятые решения (markdown-список)" },
      "action_items":{ "type": "string", "description": "Задачи и ответственные (markdown-список)" },
      "next_meeting": { "type": "string", "description": "Дата или описание следующей встречи (опционально)" },
      "project":     { "type": "string", "description": "Название проекта для дублирования в log.md (опционально)" }
    },
    "required": ["event_title", "date", "summary"]
  }
}
```

**Логика выполнения:**

1. Формирует имя файла: `YYYY-MM-DD-<slug>.md` (slug = транслит названия, строчные, дефисы)
2. Пишет Markdown-файл в `/mnt/yadisk-agent/meetings/`
3. Если передан `project` — дополнительно дописывает краткую запись в `projects/<project>/log.md`
4. Если передан `event_id` — обновляет событие в Google Calendar: ставит `extendedProperties.private.followup_ref`

**Шаблон файла:**

```markdown
# <event_title>
**Дата:** <date>
**Проект:** <project или —>

## Резюме
<summary>

## Решения
<decisions>

## Задачи
<action_items>

## Следующая встреча
<next_meeting или —>
```

---

## Поведение Снежанны

### При создании события

Если событие похоже на встречу/звонок (ключевые слова: встреч, созвон, звонок, митинг, standup, call, review) — **уточнить**:

> «К какой категории отнести? Есть привязка к проекту?»

Если в сообщении уже очевиден контекст — проставить автоматически, не спрашивая.

### После события (триггер)

При утреннем брифинге и вечернем чек-ине — проверять прошедшие за день встречи (у которых нет `followup_ref`). Если есть — предлагать:

> «Вова, вчера была встреча "Созвон с Алексом". Записать итоги?»

### При чтении событий

Если событие имеет `extendedProperties` — показывать категорию и проект в сводке:

```
📅 15:00 — Созвон с Алексом [work / Миграция-ERP-Альфа]
```

---

## Новая структура папки агента

```
/mnt/yadisk-agent/
  memory/
    health.md
    kids.md
    finance.md
    bureaucracy.md
    decisions.md
  meetings/            ← новая папка
    2026-03-03-eрp-release.md
    2026-03-10-standup.md
  projects/
    ...
  index/
  drafts/
  fitness/
  digests/
```

Папка `meetings/` создаётся при старте бота через `yadiskDirs.ensureDirs()`.

---

## Изменения в конфиге

В `config/nanobot.json` добавить справочник категорий (для документации, не загружается в runtime):

```json
"calendar": {
  "categories": ["work", "petproject", "sport", "learning", "family", "health", "admin"]
}
```

---

## Изменения в документации

| Файл | Что добавить |
|------|-------------|
| `skills/google-calendar.md` | Описание категорий, примеры с `project` и `tags`, поведение при встречах |
| `identity/IDENTITY.md` | Новая capabilities: `meetings/` папка, `save_meeting_followup` |
| `lib/yadisk-dirs.js` | `meetings/` в список директорий `ensureDirs()` |
| `docs/snezhanna-tz.md` | Раздел про calendar metadata |

---

## Что НЕ входит в этот scope

- Несколько Google-календарей (отдельная фича, требует ручной настройки calendarId)
- Поиск событий по `privateExtendedProperty` через API (можно добавить позже как `search_calendar_events`)
- Автоматические напоминания о незакрытых фоллоу-апах (отдельная крон-задача)

---

## Порядок реализации

1. `lib/google.js` — поддержка `extendedProperties` в create/update/get
2. `lib/tools.js` — новые параметры в create/update, новый tool `save_meeting_followup`
3. `lib/yadisk-dirs.js` — добавить `meetings/` в `ensureDirs()`
4. `identity/IDENTITY.md` + `skills/google-calendar.md` — обновить промпты
5. `config/nanobot.json` — добавить `calendar.categories`
6. Рестарт сервиса, проверка через `journalctl -u snezhanna -f`
