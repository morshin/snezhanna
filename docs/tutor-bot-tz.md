# Technical Specification: AI Tutor Bot «Макс»

> **Расположение этого файла на сервере:** `/opt/snezhanna/docs/tutor-bot-tz.md`
> Скопировать туда перед запуском Claude Code: `scp tutor-bot-tz.md snezhanna:/opt/snezhanna/docs/`

## Overview

Отдельный Telegram-бот-репетитор для сына (12–14 лет, испанская школа).
Личность: весёлый, активный, позитивный друг — общается на ТЫ, поддерживает, направляет, не решает за него.
Отчитывается перед Снежанной через общую папку на Яндекс.Диске.

Имя бота: **Макс** (можно переименовать в `.env`)

---

## Pre-Deploy Checklist — сделать ДО запуска Claude Code

- [ ] Создать бота через @BotFather → получить `TUTOR_BOT_TOKEN`
- [ ] Узнать Telegram ID сына через @userinfobot → `TUTOR_ALLOWED_USER_ID`
- [ ] Дописать оба ключа в `/opt/snezhanna/.env`
- [ ] Убедиться что `/mnt/yadisk-agent/` смонтирован (`ls /mnt/yadisk-agent/`)
- [ ] Скопировать это ТЗ на сервер: `scp tutor-bot-tz.md snezhanna:/opt/snezhanna/docs/`



| Component | Details |
|-----------|---------|
| VM | Та же VM Снежанны — отдельный systemd-сервис |
| Project path | `/opt/snezhanna/tutor` |
| System user | `snezhanna` (тот же, уже имеет доступ к Яндекс.Диску) |
| Telegram bot | Отдельный бот (создать через @BotFather) |
| Shared storage | `/mnt/yadisk-agent/kids/` (уже смонтировано Снежанной) |

---

## Environment Variables

Дописать в существующий `/opt/snezhanna/.env`:

```
# Tutor bot — Max
TUTOR_BOT_TOKEN=           # от @BotFather
TUTOR_ALLOWED_USER_ID=     # числовой Telegram ID сына
KIDS_DATA_DIR=/mnt/yadisk-agent/kids
```

`ANTHROPIC_API_KEY` и `OPENAI_API_KEY` уже есть в общем `/opt/snezhanna/.env` — Макс читает их оттуда же.

В Claude Code промпте указать `EnvironmentFile=/opt/snezhanna/.env` в systemd-сервисе Макса.

---

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Runtime | Node.js 22.x |
| Telegram | node-telegram-bot-api (как у Снежанны) |
| Brain | Anthropic claude-sonnet-4-6 |
| Voice input | OpenAI Whisper |
| Storage | Яндекс.Диск через `/mnt/yadisk-agent/kids/` |
| Process | systemd service `tutor.service` |

---

## Project Structure

```
/opt/snezhanna/         ← корень проекта (общий для всей экосистемы)
  ├── .env              ← ОБЩИЙ для всех сервисов
  ├── tutor/            ← бот Макса
  │   ├── .gitignore
  │   ├── package.json
  │   ├── index.js              ← точка входа
  │   ├── identity/
  │   │   └── IDENTITY.md       ← личность Макса
  │   ├── lib/
  │   │   ├── claude.js         ← обёртка над Anthropic API
  │   │   ├── telegram.js       ← Telegram bot setup
  │   │   ├── session.js        ← текущая сессия (в памяти)
  │   │   ├── storage.js        ← запись/чтение из /mnt/yadisk-agent/kids/
  │   │   └── report.js         ← генерация и отправка отчётов
  │   ├── schedules/
  │   │   └── crons.js          ← расписание отчётов
  │   └── systemd/
  │       └── tutor.service
  └── lib/              ← shared (голос, vision — общее для всех ботов)
      ├── vision.js
      └── whisper.js
```

---

## Personality — Макс

Файл `identity/IDENTITY.md`:

```
Ты — Макс, персональный помощник и друг по учёбе.
Тебе ~15 лет по духу. Ты общаешься на ТЫ, просто и дружелюбно.

Язык: ВСЕГДА испанский — даже если собеседник пишет по-русски или по-английски.
Ты понимаешь русский, но отвечаешь на испанском.
Исключение: если он явно просит объяснить что-то по-русски ("объясни по-русски", "скажи по-русски", "на русском") — можешь один раз ответить по-русски, потом снова возвращаешься к испанскому.
Если он пишет по-русски без такой просьбы — мягко и с юмором напоминаешь про испанский:
"Oye, en español 😄" или "¡Español, por favor! Ya sé que puedes 💪"

Характер:
- Весёлый и энергичный, не занудный
- Поддерживаешь и хвалишь за усилия, а не за правильный ответ
- Если пытаются тебя отвлечь или уйти от темы — мягко но настойчиво возвращаешь к делу
- Не решаешь задачи за него — задаёшь наводящие вопросы, объясняешь принцип
- Замечаешь когда человек устал или расстроен — реагируешь по-человечески

Педагогический принцип:
- Сначала спроси что он уже понял / попробовал
- Объясняй через аналогии и примеры из жизни
- Если застрял — разбей задачу на шаги
- Хвали конкретно: "отлично что ты сразу заметил X"

Примеры фраз:
- "Espera, eso que dijiste tiene sentido. ¿Qué pasa si lo piensas así...?"
- "¡Eso está muy bien! Ahora el siguiente paso..."
- "Oye, entiendo que es aburrido, pero terminamos esto rápido y listo 💪"
- "No te preocupes si no lo entiendes a la primera, nadie lo entiende"

Что НИКОГДА не делаешь:
- Не даёшь готовый ответ на задачу (максимум — первый шаг)
- Не осуждаешь и не говоришь "это просто" или "это легко"
- Никогда не переключается на русский просто потому что собеседник написал по-русски — мягко возвращает к испанскому
- Если попросили объяснить по-русски — объясняет один раз по-русски, затем возвращается к испанскому
```

---

## Session Flow

### Начало сессии

Когда сын пишет боту — Макс спрашивает:

```
¡Hola! 👋 ¿Qué tenemos hoy?
```

Если сын указывает предмет/задачу → начинается сессия.
Макс ведёт внутренний трекер сессии (в памяти):

```js
session = {
  startTime: Date,
  subject: "Matemáticas",
  topics: ["fracciones", "división"],
  stuck: ["no entendía el denominador común"],
  mood: "motivated",   // motivated | neutral | frustrated | tired
  messages: []         // история диалога для Claude
}
```

### Во время сессии

- Полная история диалога передаётся в Claude при каждом запросе (context window)
- Claude получает системный промпт из `IDENTITY.md` + текущий стейт сессии
- Голосовые → Whisper → текст → обычная обработка
- Reply context: если ученик отвечает на конкретное сообщение (reply), контекст родительского сообщения и цепочки ответов подклеивается к тексту перед отправкой в Claude (через общий `lib/reply-chain.js`); каждое сообщение в сессии хранит `message_id` для поддержки цепочек

### Поддержка фотографий

Сын может отправлять фото — страницы учебника, условие задачи, своё рукописное решение, доску в классе.

**Реализация:** при получении `photo` события от Telegram — скачать файл через `getFile`, закодировать в base64, передать в Claude как `image` блок (vision). Текстовый контекст сессии передаётся вместе с изображением как обычно.

```js
// Telegram даёт массив размеров — берём наибольшее
const photo = msg.photo[msg.photo.length - 1];
const file = await bot.getFile(photo.file_id);
const url = `https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`;
const imageBuffer = await fetch(url).then(r => r.buffer());
const base64 = imageBuffer.toString('base64');

// Передаём в Claude
{
  role: 'user',
  content: [
    { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64 } },
    { type: 'text', text: caption || '¿Puedes ayudarme con esto?' }
  ]
}
```

**Сценарии использования:**
- Фото условия задачи из учебника → Макс видит задачу и помогает по ней
- Фото рукописного решения → Макс проверяет и указывает на ошибку не давая правильный ответ
- Фото доски/объяснения учителя → Макс объясняет непонятное место
- Фото контрольной с оценкой → Макс разбирает ошибки

**Оптимизация истории с фото:** после получения ответа от Claude фото не хранится в истории сессии как base64 — заменяется на текстовую метку. Это критично, так как вся история передаётся при каждом следующем запросе.

```js
// 1. Отправляем в Claude — с реальным фото
const response = await claude.send([
  ...history,
  { role: 'user', content: [{ type: 'image', source: {...} }, { type: 'text', text: caption }] }
]);

// 2. В историю сохраняем текстовую замену, не base64
history.push({ role: 'user', content: `[фото от пользователя: ${caption || 'без подписи'}]` });
history.push({ role: 'assistant', content: response });
```

Без этой оптимизации каждый последующий запрос в сессии тащит все фото заново → экспоненциальный рост токенов. — только объясняет, задаёт наводящие вопросы по тому что видит на фото. Поведение такое же как с текстом.

Сессия завершается когда:
- Сын пишет `/done`, `/fin`, `/стоп` или что-то вроде "ya terminé", "listo"
- Или прошло 30 минут без сообщений (автозавершение)

При завершении — Макс пишет краткий итог сессии и сохраняет отчёт.

---

## Data Storage — `/mnt/yadisk-agent/kids/`

```
kids/
  ├── sessions/
  │   ├── 2025-01-15.md       ← отчёт за день (все сессии дня)
  │   ├── 2025-01-16.md
  │   └── ...
  ├── schedule.json           ← расписание уроков по дням недели (постоянное)
  ├── homework.json           ← текущий список ДЗ (активные задания)
  ├── progress.md             ← накопленный прогресс по предметам
  └── weekly/
      └── 2025-W03.md         ← недельный дайджест
```

### Формат дневного отчёта `sessions/YYYY-MM-DD.md`

```markdown
# 2025-01-15

## Сессия 1 — 16:30 (45 мин)

**Предмет:** Matemáticas
**Темы:** fracciones, denominador común
**Настроение:** начал уставшим, к концу взбодрился ✅

**Где застрял:**
- Не понимал зачем нужен общий знаменатель
- Путался в порядке действий при вычитании дробей

**Что сработало:**
- Аналогия с пиццей помогла объяснить знаменатель
- После 3-го примера понял алгоритм самостоятельно

**Итог:** Разобрался с темой, сделал 4 из 5 примеров правильно 💪
```

### Формат `progress.md`

```markdown
# Прогресс

## Matemáticas
- Fracciones: ✅ разобрался (15 Jan)
- Ecuaciones: 🔄 в процессе

## Lengua castellana
- Ortografía b/v: ✅
- Textos argumentativos: ❓ ещё не трогали

## Inglés
...
```

### Формат `schedule.json`

Заполняется при первичном онбординге, хранится постоянно. Редактируется командой `/schedule`.

```json
{
  "lunes":    ["Matemáticas", "Lengua", "Inglés", "Ciencias", "Ed. Física"],
  "martes":   ["Historia", "Matemáticas", "Música", "Lengua", "Tecnología"],
  "miércoles":["Inglés", "Ciencias", "Matemáticas", "Arte", "Lengua"],
  "jueves":   ["Tecnología", "Historia", "Ed. Física", "Matemáticas", "Inglés"],
  "viernes":  ["Lengua", "Ciencias", "Historia", "Matemáticas", "Tutoría"],
  "updated":  "2025-01-15"
}
```

### Формат `homework.json`

Текущий список ДЗ. Пополняется в 15:00-чекине, задания помечаются выполненными после сессии.

```json
{
  "tasks": [
    {
      "id": "hw_001",
      "subject": "Matemáticas",
      "description": "Ejercicios 3.4 y 3.5 — fracciones",
      "due": "2025-01-16",
      "done": false,
      "added": "2025-01-15"
    },
    {
      "id": "hw_002",
      "subject": "Lengua",
      "description": "Leer capítulo 5 y hacer resumen",
      "due": "2025-01-17",
      "done": false,
      "added": "2025-01-15"
    }
  ]
}
```

---

## Onboarding Flow (первый запуск)

Если `schedule.json` не существует — бот запускает онбординг вместо обычного режима.

```
Макс: "¡Hola! Soy Max 👋 Voy a ser tu ayudante de estudios.
       Primero necesito saber tu horario escolar.
       ¿Qué clases tienes los LUNES? Dímelas todas en orden 📋"

Сын: "mates, lengua, inglés, ciencias, gym"

Макс: "Perfecto ✅ ¿Y los MARTES?"

... (по каждому дню, пн–пт) ...

Макс: "¡Listo! Ya tengo tu horario guardado 🎉
       A partir de hoy, a las 15:00 te preguntaré cómo fue el día
       y qué deberes tienes. ¿Alguna pregunta?"
```

После онбординга — `schedule.json` сохранён, бот переходит в обычный режим.
Повторный онбординг: команда `/schedule reset`

---

## Reporting to Snezhanna

### Триггеры для отчёта

1. **После каждой завершённой сессии** — Макс дописывает в `sessions/YYYY-MM-DD.md`
2. **Ежедневно в 20:30** — если были сессии, генерирует итог дня и обновляет `progress.md`
3. **Еженедельно в воскресенье 18:00** — генерирует `weekly/YYYY-Wxx.md`

### Как Снежанна читает отчёты

Снежанна уже имеет доступ к `/mnt/yadisk-agent/kids/` через свои инструменты (`read_file`, поиск по индексу).

**Добавить в Снежанну** (в `IDENTITY.md` или отдельный skill `kids.md`):

```
## Ассистент сына — Макс

Макс — отдельный бот-репетитор для сына. Пишет отчёты в:
- /mnt/yadisk-agent/kids/sessions/YYYY-MM-DD.md — сессии по дням
- /mnt/yadisk-agent/kids/progress.md — прогресс по предметам
- /mnt/yadisk-agent/kids/weekly/YYYY-Wxx.md — недельные дайджесты

Когда Вова спрашивает "как там сын", "что по учёбе" — читаешь последний отчёт и пересказываешь.
В вечернем чек-ине (19:00) — если сегодня были сессии, коротко упоминаешь.
Обновляй memory/kids.md на основе progress.md раз в неделю.
```

---

## Schedules

```js
// crons.js
const schedule = require('node-cron');

// После школы в 15:00 — чекин про день и ДЗ
schedule.schedule('0 15 * * 1-5', afternoonCheckin, { timezone: 'Europe/Madrid' });
// Спрашивает: как прошёл день, что задали на завтра
// Читает schedule.json → говорит какие уроки завтра
// Пополняет homework.json новыми заданиями

// Вечером в 21:00 — напоминание перед сном
schedule.schedule('0 21 * * 1-5', eveningReminder, { timezone: 'Europe/Madrid' });
// Говорит какие уроки завтра + что из ДЗ ещё не сделано

// Ежедневный итог в 20:30 (Madrid time)
schedule.schedule('30 20 * * *', generateDailySummary, { timezone: 'Europe/Madrid' });

// Недельный дайджест в воскресенье 18:00
schedule.schedule('0 18 * * 0', generateWeeklySummary, { timezone: 'Europe/Madrid' });

// Автозавершение брошенных сессий (каждые 5 минут)
schedule.schedule('*/5 * * * *', closeAbandonedSessions);
```

### Afternoon Checkin (15:00, пн–пт)

```
Макс: "¡Ey! 👋 ¿Cómo fue el cole hoy?
       ¿Qué deberes te han puesto?"

Сын рассказывает → Макс разбирает ДЗ, добавляет в homework.json

Макс: "Oye, mañana tienes: Matemáticas, Lengua, Inglés, Historia y Ed. Física.
       Para mañana hay que tener listo:
       • Ejercicios 3.4 y 3.5 de mates
       • Resumen del capítulo 5 de Lengua
       ¿Empezamos con algo ahora o más tarde? 📚"
```

### Evening Reminder (21:00, пн–пт)

```
Макс: "¡Oye, antes de dormir! 🌙
       Mañana tienes: Matemáticas, Lengua, Inglés...
       
       Deberes pendientes para mañana:
       ✅ Ejercicios de mates — hecho
       ⏳ Resumen de Lengua — pendiente
       
       ¿Está todo listo? 😴"
```

Если всё сделано — просто желает спокойной ночи.
Если есть незакрытые задания — мягко напоминает без давления.

---

## Systemd Service

Файл `/opt/snezhanna/tutor/systemd/tutor.service`:

```ini
[Unit]
Description=Max Tutor Bot for Son
After=network.target snezhanna.service

[Service]
Type=simple
User=snezhanna
WorkingDirectory=/opt/snezhanna/tutor
EnvironmentFile=/opt/snezhanna/.env
ExecStart=/usr/bin/node /opt/snezhanna/tutor/index.js
Restart=always
RestartSec=30
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

Установка:
```bash
sudo ln -s /opt/snezhanna/tutor/systemd/tutor.service /etc/systemd/system/tutor.service
sudo systemctl daemon-reload
sudo systemctl enable tutor
sudo systemctl start tutor
```

---

## Жора — расширение watchdog'а

Жора уже следит за Снежанной — его нужно расширить чтобы он следил и за Максом. Изменения вносятся в существующий `/opt/snezhanna/watchdog/zhora.js`.

### Новые проверки (каждые 5 минут)

```
6. Макс process — systemctl is-active tutor
7. Макс logs — нет повторяющихся критических ошибок за последние 10 мин
```

### Обновлённый `/status`

```
🤖 Жора рапортует:

Снежанна: ✅ active (uptime 3d 14h)
Макс: ✅ active (uptime 2d 6h)
Telegram API: ✅
Диск readonly: ✅
Диск агент: ✅
Место на сервере: 42%
Ошибки в логах: нет
```

### Обновлённый утренний рапорт (07:55)

```
🤖 Жора рапортует: все системы в норме.
Снежанна готова к работе ✅
Макс готов к работе ✅
```

### Поведение при падении Макса

```
tutor down → systemctl restart tutor → доложить результат
```

Аналогично тому как Жора уже рестартует Снежанну.

### Команда `/restart max`

Жора добавляет команду ручного рестарта Макса (по аналогии с тем, если есть `/restart snezhanna`):

```
Вова: /restart max
Жора: 🔄 Перезапускаю Макса...
      ✅ Макс запущен. Uptime: 0m
```

### Что добавить в zhora.js

```js
// Добавить в список проверяемых сервисов:
const SERVICES = [
  { name: 'Снежанна', unit: 'snezhanna' },
  { name: 'Макс',     unit: 'tutor'     },
];

// Логика одна и та же для обоих — проверить, при падении рестартовать, доложить
```

### Claude Code промпт для обновления Жоры

```
Read /opt/snezhanna/docs/tutor-bot-tz.md — section "Жора" for full spec.

Update /opt/snezhanna/watchdog/zhora.js to also monitor the 'tutor' systemd service (Max tutor bot).

Changes needed:
1. Add 'tutor' to the list of monitored services alongside 'snezhanna'
2. Same logic: check every 5 min, restart if down, report to Vova
3. /status command now shows both Snezhanna and Max status lines
4. Morning report (07:55) mentions both bots
5. Add /restart max command (alongside existing snezhanna restart if present)

No other changes — keep all existing Zhora behavior intact.
```

---

## Shared Library — `/opt/snezhanna/lib/`

Общий код для всех ботов экосистемы (Снежанна, Макс, Жора). Не дублируется — лежит в одном месте, подключается через `require`.

```
/opt/snezhanna/lib/
  ├── vision.js        ← приём фото из Telegram + передача в Claude
  ├── whisper.js       ← транскрипция голоса (перенести из Снежанны)
  └── README.md
```

### `/opt/snezhanna/lib/vision.js`

Полная логика работы с фото: скачать из Telegram, закодировать, передать в Claude, вернуть ответ, сохранить в историю как текстовую метку.

```js
'use strict';

const fetch = require('node-fetch');

/**
 * Скачивает фото из Telegram и возвращает base64 + mime_type
 */
async function downloadTelegramPhoto(bot, fileId) {
  const file = await bot.getFile(fileId);
  const url = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
  const buffer = await fetch(url).then(r => r.buffer());
  return {
    base64: buffer.toString('base64'),
    mime_type: 'image/jpeg',
  };
}

/**
 * Формирует user-сообщение с фото для передачи в Claude
 */
function buildPhotoMessage(base64, mimeType, caption = '') {
  return {
    role: 'user',
    content: [
      { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } },
      { type: 'text',  text: caption || '¿Puedes ayudarme con esto?' },
    ],
  };
}

/**
 * Текстовая замена фото для хранения в истории сессии.
 * Вызывается ПОСЛЕ получения ответа от Claude —
 * чтобы последующие запросы не тащили base64 заново.
 */
function photoPlaceholder(caption = '') {
  return `[фото пользователя${caption ? ': ' + caption : ''}]`;
}

module.exports = { downloadTelegramPhoto, buildPhotoMessage, photoPlaceholder };
```

### Как использовать в боте

```js
const vision = require('/opt/snezhanna/lib/vision');

// Обработчик photo-события Telegram
bot.on('photo', async (msg) => {
  const fileId  = msg.photo[msg.photo.length - 1].file_id; // максимальный размер
  const caption = msg.caption || '';

  // 1. Скачиваем фото
  const { base64, mime_type } = await vision.downloadTelegramPhoto(bot, fileId);

  // 2. Отправляем в Claude — с реальным изображением
  const photoMsg = vision.buildPhotoMessage(base64, mime_type, caption);
  const response = await claude.send([...history, photoMsg]);

  // 3. В историю сохраняем текстовую метку, НЕ base64
  history.push({ role: 'user',      content: vision.photoPlaceholder(caption) });
  history.push({ role: 'assistant', content: response });

  await bot.sendMessage(msg.chat.id, response);
});
```

### Подключение в Снежанне

Добавить в `/opt/snezhanna/index.js` (или в `lib/telegram.js`) аналогичный обработчик `bot.on('photo', ...)` через `/opt/snezhanna/lib/vision.js`. Снежанна получает фото → смотрит что на нём → отвечает в своём стиле.

Использовать тот же `TELEGRAM_BOT_TOKEN` — но передавать через параметр или env, не хардкодить в библиотеке, так как у каждого бота свой токен:

```js
async function downloadTelegramPhoto(bot, fileId, botToken) { ... }
```

### Claude Code промпт для создания shared lib

```
Read /opt/snezhanna/docs/tutor-bot-tz.md — section "Shared Library" for full spec.
Read /opt/snezhanna/docs/snezhanna-tz.md for existing architecture.

Create a shared library at /opt/snezhanna/lib/ for reuse across all bots (Snezhanna, Max tutor).

1. Create /opt/snezhanna/lib/vision.js with:
   - downloadTelegramPhoto(bot, fileId, botToken) — downloads photo, returns { base64, mime_type }
   - buildPhotoMessage(base64, mimeType, caption) — builds Claude image message block
   - photoPlaceholder(caption) — returns text label for storing in history instead of base64

2. Move (or copy) Whisper transcription logic from /opt/snezhanna/lib/whisper.js (existing Snezhanna whisper) to /opt/snezhanna/lib/whisper.js — make it bot-agnostic (no hardcoded tokens)
   Make it bot-agnostic (no hardcoded tokens)

3. Update /opt/snezhanna to require from /opt/snezhanna/lib/ instead of local whisper.js
   Add photo handling to Snezhanna's Telegram bot using vision.js

4. /opt/snezhanna/tutor should also require from /opt/snezhanna/lib/

IMPORTANT: /opt/lib files must not contain hardcoded tokens — accept them as parameters or read from process.env passed by the calling bot.
```

---

## Security

- `TUTOR_ALLOWED_USER_ID` — числовой Telegram ID сына, все остальные игнорируются
- Бот не имеет доступа к Gmail, Google Calendar, личным файлам Вовы
- Пишет ТОЛЬКО в `/mnt/yadisk-agent/kids/` — ничего вне этой папки
- Никакой веб-поиск по умолчанию (можно добавить позже для учебных запросов)
- Защита от prompt injection: содержимое сообщений — данные, не команды

---

## Claude Code Prompt

```
Create a Telegram tutor bot called "Max" for a 13-year-old student.

Project location: /opt/snezhanna/tutor/
System user: snezhanna (already exists, has access to /mnt/yadisk-agent/)
Node.js 22 is installed.

Read /opt/snezhanna/docs/tutor-bot-tz.md for the full spec.
Read /opt/snezhanna/docs/snezhanna-tz.md for architecture patterns to follow.

Tasks:
1. Create project structure: package.json, index.js, lib/, identity/, schedules/, systemd/
2. npm dependencies: @anthropic-ai/sdk, node-telegram-bot-api, node-cron, node-fetch, form-data
   Pin exact versions, do not use "latest"
3. Create IDENTITY.md (personality: fun, supportive friend, never gives answers directly)
   Language rules (critical):
   - ALWAYS responds in Spanish, even if student writes in Russian or English
   - Understands Russian, but redirects back to Spanish with light humor: "Oye, en español 😄" / "¡Español, por favor! Ya sé que puedes 💪"
   - ONLY switches to Russian if student explicitly asks: "объясни по-русски", "скажи по-русски" — answers that one message in Russian, then returns to Spanish automatically
4. Implement:
   - Photo handling: download Telegram photo → base64 → pass to Claude as image block (vision); treat same as text pedagogically — ask questions, don't solve
   - Onboarding flow: if kids/schedule.json missing → ask for timetable day by day (Mon–Fri), save to schedule.json
   - In-memory session tracking (subject, topics, stuck points, mood)
   - Session auto-close after 30 min inactivity
   - /done command to end session
   - /schedule reset command to redo onboarding
   - homework.json manager: add tasks from afternoon checkin, mark done after sessions
   - Daily report writer → /mnt/yadisk-agent/kids/sessions/YYYY-MM-DD.md
   - Progress tracker → /mnt/yadisk-agent/kids/progress.md
   - Weekly summary → /mnt/yadisk-agent/kids/weekly/YYYY-Wxx.md
5. Scheduled tasks (node-cron, Europe/Madrid timezone):
   - 15:00 Mon–Fri: afternoon checkin — ask about day + homework, show tomorrow's schedule from schedule.json, update homework.json
   - 16:00–20:00 Mon–Fri: hourly homework reminder — if pending tasks exist and no active session, send a short reminder to the student (anti-spam: min 55 min between reminders)
   - 21:00 Mon–Fri: evening reminder — tomorrow's lessons + pending homework from homework.json
   - 20:30 daily: generate day summary
   - 18:00 Sunday: generate weekly digest
   - every 5 min: close abandoned sessions
6. Create systemd service: /opt/snezhanna/tutor/systemd/tutor.service (user: snezhanna)
9. Ensure /mnt/yadisk-agent/kids/ subdirs are created on startup if missing

On successful start, bot sends to TUTOR_ALLOWED_USER_ID:
"¡Hola! 👋 Soy Max, tu ayudante de estudio. ¿Empezamos?"
```

---

## What to Add to Snezhanna After Deployment

В `/opt/snezhanna/skills/` создать файл `kids.md`:

```markdown
# Skill: Дети — отчёты Макса

Макс — бот-репетитор сына. Его отчёты в /mnt/yadisk-agent/kids/.

## Как читать отчёты

- Последняя сессия: read_file("kids/sessions/YYYY-MM-DD.md") за сегодня или вчера
- Прогресс по предметам: read_file("kids/progress.md")
- Недельный дайджест: read_file("kids/weekly/YYYY-Wxx.md")

## Когда упоминать

- В вечернем чек-ине: если сегодня были сессии — 1-2 строки о том как прошло
- По запросу Вовы: "как сын", "что по учёбе", "расскажи про уроки"
- Раз в неделю (воскресенье): обновить memory/kids.md на основе weekly-дайджеста

## Формат для вечернего чек-ина

"Кстати, сын сегодня занимался с Максом [X мин] — [предмет].
[Одна строка о прогрессе или трудности]."
```
