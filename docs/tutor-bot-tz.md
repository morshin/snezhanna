# Technical Specification: AI Tutor Bot «Max»

> **Location of this file on the server:** `/opt/snezhanna/docs/tutor-bot-tz.md`
> Copy there before launching Claude Code: `scp tutor-bot-tz.md snezhanna:/opt/snezhanna/docs/`

## Overview

A separate Telegram tutor bot for the son (12–14 years old, Spanish school).
Personality: a cheerful, energetic, positive friend — uses informal address, supports and guides, never solves problems outright.
Reports to Snezhanna via a shared folder on Yandex.Disk.

Bot name: **Max** (can be renamed in `.env`)

---

## Pre-Deploy Checklist — do BEFORE launching Claude Code

- [ ] Create a bot via @BotFather → get `TUTOR_BOT_TOKEN`
- [ ] Get son's Telegram ID via @userinfobot → `TUTOR_ALLOWED_USER_ID`
- [ ] Add both keys to `/opt/snezhanna/.env`
- [ ] Make sure `/mnt/yadisk-agent/` is mounted (`ls /mnt/yadisk-agent/`)
- [ ] Copy this spec to the server: `scp tutor-bot-tz.md snezhanna:/opt/snezhanna/docs/`



| Component | Details |
|-----------|---------|
| VM | Same VM as Snezhanna — separate systemd service |
| Project path | `/opt/snezhanna/tutor` |
| System user | `snezhanna` (same one, already has access to Yandex.Disk) |
| Telegram bot | Separate bot (create via @BotFather) |
| Shared storage | `/mnt/yadisk-agent/kids/` (already mounted by Snezhanna) |

---

## Environment Variables

Append to the existing `/opt/snezhanna/.env`:

```
# Tutor bot — Max
TUTOR_BOT_TOKEN=           # from @BotFather
TUTOR_ALLOWED_USER_ID=     # son's numeric Telegram ID
KIDS_DATA_DIR=/mnt/yadisk-agent/kids
```

`ANTHROPIC_API_KEY` and `OPENAI_API_KEY` are already in the shared `/opt/snezhanna/.env` — Max reads them from there.

Specify `EnvironmentFile=/opt/snezhanna/.env` in Max's systemd service.

---

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Runtime | Node.js 22.x |
| Telegram | node-telegram-bot-api (same as Snezhanna) |
| Brain | Anthropic claude-sonnet-4-6 |
| Voice input | OpenAI Whisper |
| Storage | Yandex.Disk via `/mnt/yadisk-agent/kids/` |
| Process | systemd service `tutor.service` |

---

## Project Structure

```
/opt/snezhanna/         ← project root (shared across the whole ecosystem)
  ├── .env              ← SHARED by all services
  ├── tutor/            ← Max's bot
  │   ├── .gitignore
  │   ├── package.json
  │   ├── index.js              ← entrypoint
  │   ├── identity/
  │   │   └── IDENTITY.md       ← Max's personality
  │   ├── lib/
  │   │   ├── claude.js         ← Anthropic API wrapper
  │   │   ├── telegram.js       ← Telegram bot setup
  │   │   ├── session.js        ← current session (in-memory)
  │   │   ├── storage.js        ← read/write from /mnt/yadisk-agent/kids/
  │   │   └── report.js         ← report generation and delivery
  │   ├── schedules/
  │   │   └── crons.js          ← report schedule
  │   └── systemd/
  │       └── tutor.service
  └── lib/              ← shared (voice, vision — common to all bots)
      ├── vision.js
      └── whisper.js
```

---

## Personality — Max

File `identity/IDENTITY.md`:

```
You are Max, a personal study helper and friend.
You have the spirit of someone ~15 years old. You use informal address, simple and friendly.

Language: ALWAYS Spanish — even if the other person writes in Russian or English.
You understand Russian, but respond in Spanish.
Exception: if they explicitly ask you to explain something in Russian ("объясни по-русски", "скажи по-русски", "на русском") — you may respond in Russian once, then switch back to Spanish.
If they write in Russian without such a request — gently and humorously remind them about Spanish:
"Oye, en español 😄" or "¡Español, por favor! Ya sé que puedes 💪"

Character:
- Cheerful and energetic, never boring
- You encourage and praise effort, not correct answers
- If someone tries to distract you or go off topic — you gently but persistently bring them back
- You don't solve tasks outright — you ask guiding questions and explain the principle
- You notice when the person is tired or upset — you respond humanly

Pedagogical principle:
- First ask what they already understand / tried
- Explain through analogies and real-life examples
- If stuck — break the task into steps
- Praise specifically: "great that you immediately noticed X"

Example phrases:
- "Espera, eso que dijiste tiene sentido. ¿Qué pasa si lo piensas así...?"
- "¡Eso está muy bien! Ahora el siguiente paso..."
- "Oye, entiendo que es aburrido, pero terminamos esto rápido y listo 💪"
- "No te preocupes si no lo entiendes a la primera, nadie lo entiende"

What you NEVER do:
- Never give a ready-made answer to a task (at most — the first step)
- Never criticize or say "this is simple" or "this is easy"
- Never switch to Russian just because the person wrote in Russian — gently bring them back to Spanish
- If asked to explain in Russian — explain once in Russian, then return to Spanish
```

---

## Session Flow

### Session start

When the son messages the bot — Max asks:

```
¡Hola! 👋 ¿Qué tenemos hoy?
```

If the son specifies a subject/task → a session begins.
Max maintains an internal session tracker (in memory):

```js
session = {
  startTime: Date,
  subject: "Matemáticas",
  topics: ["fracciones", "división"],
  stuck: ["no entendía el denominador común"],
  mood: "motivated",   // motivated | neutral | frustrated | tired
  messages: []         // conversation history for Claude
}
```

### During a session

- Full conversation history is passed to Claude on every request (context window)
- Claude receives the system prompt from `IDENTITY.md` + current session state
- Voice → Whisper → text → standard processing
- Reply context: if the student replies to a specific message (reply), the context of the parent message and reply chain is prepended to the text before sending to Claude (via shared `lib/reply-chain.js`); each message in the session stores `message_id` to support chains

### Photo support

The son can send photos — textbook pages, task conditions, handwritten solutions, a classroom whiteboard.

**Implementation:** on receiving a `photo` event from Telegram — download the file via `getFile`, encode to base64, pass to Claude as an `image` block (vision). The session text context is passed alongside the image as usual.

```js
// Telegram provides an array of sizes — take the largest
const photo = msg.photo[msg.photo.length - 1];
const file = await bot.getFile(photo.file_id);
const url = `https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`;
const imageBuffer = await fetch(url).then(r => r.buffer());
const base64 = imageBuffer.toString('base64');

// Pass to Claude
{
  role: 'user',
  content: [
    { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64 } },
    { type: 'text', text: caption || '¿Puedes ayudarme con esto?' }
  ]
}
```

**Use cases:**
- Photo of a textbook task → Max sees the task and helps with it
- Photo of a handwritten solution → Max checks it and points to the error without giving the correct answer
- Photo of a teacher's whiteboard/explanation → Max explains the confusing part
- Photo of a graded test → Max reviews the mistakes

**History optimization with photos:** after receiving Claude's response, the photo is not stored in session history as base64 — it is replaced with a text placeholder. This is critical since the full history is passed on every subsequent request.

```js
// 1. Send to Claude — with the real photo
const response = await claude.send([
  ...history,
  { role: 'user', content: [{ type: 'image', source: {...} }, { type: 'text', text: caption }] }
]);

// 2. Save a text substitute in history, not base64
history.push({ role: 'user', content: `[photo from user: ${caption || 'no caption'}]` });
history.push({ role: 'assistant', content: response });
```

Without this optimization every subsequent request in the session carries all photos again → exponential token growth. Max only explains and asks guiding questions based on what he sees in the photo. Behavior is the same as with text.

A session ends when:
- The son sends `/done`, `/fin`, `/стоп`, or something like "ya terminé", "listo"
- Or 30 minutes pass with no messages (auto-close)

On close — Max writes a brief session summary and saves the report.

---

## Data Storage — `/mnt/yadisk-agent/kids/`

```
kids/
  ├── sessions/
  │   ├── 2025-01-15.md       ← daily report (all sessions for the day)
  │   ├── 2025-01-16.md
  │   └── ...
  ├── schedule.json           ← school timetable by weekday (persistent)
  ├── homework.json           ← current homework list (active tasks)
  ├── progress.md             ← accumulated progress by subject
  └── weekly/
      └── 2025-W03.md         ← weekly digest
```

### Daily report format `sessions/YYYY-MM-DD.md`

```markdown
# 2025-01-15

## Session 1 — 16:30 (45 min)

**Subject:** Matemáticas
**Topics:** fracciones, denominador común
**Mood:** started tired, picked up by the end ✅

**Where he got stuck:**
- Didn't understand why a common denominator is needed
- Got confused with the order of operations when subtracting fractions

**What worked:**
- The pizza analogy helped explain the denominator
- After the 3rd example, figured out the algorithm on his own

**Result:** Understood the topic, got 4 out of 5 examples right 💪
```

### `progress.md` format

```markdown
# Progress

## Matemáticas
- Fracciones: ✅ figured out (15 Jan)
- Ecuaciones: 🔄 in progress

## Lengua castellana
- Ortografía b/v: ✅
- Textos argumentativos: ❓ not covered yet

## Inglés
...
```

### `schedule.json` format

Filled during initial onboarding, stored persistently. Editable via `/schedule`.

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

### `homework.json` format

Current homework list. Populated at the 15:00 check-in; tasks are marked done after sessions.

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

## Onboarding Flow (first launch)

If `schedule.json` does not exist — the bot starts onboarding instead of normal mode.

```
Max: "¡Hola! Soy Max 👋 Voy a ser tu ayudante de estudios.
       Primero necesito saber tu horario escolar.
       ¿Qué clases tienes los LUNES? Dímelas todas en orden 📋"

Son: "mates, lengua, inglés, ciencias, gym"

Max: "Perfecto ✅ ¿Y los MARTES?"

... (for each day, Mon–Fri) ...

Max: "¡Listo! Ya tengo tu horario guardado 🎉
       A partir de hoy, a las 15:00 te preguntaré cómo fue el día
       y qué deberes tienes. ¿Alguna pregunta?"
```

After onboarding — `schedule.json` is saved, the bot switches to normal mode.
Repeat onboarding: command `/schedule reset`

---

## Reporting to Snezhanna

### Report triggers

1. **After each completed session** — Max appends to `sessions/YYYY-MM-DD.md`
2. **Daily at 20:30** — if there were sessions, generates the day summary and updates `progress.md`
3. **Weekly on Sunday at 18:00** — generates `weekly/YYYY-Wxx.md`

### How Snezhanna reads reports

Snezhanna already has access to `/mnt/yadisk-agent/kids/` via her tools (`read_file`, index search).

**Add to Snezhanna** (in `IDENTITY.md` or a separate skill `kids.md`):

```
## Son's assistant — Max

Max is a separate tutor bot for the son. He writes reports to:
- /mnt/yadisk-agent/kids/sessions/YYYY-MM-DD.md — sessions by day
- /mnt/yadisk-agent/kids/progress.md — progress by subject
- /mnt/yadisk-agent/kids/weekly/YYYY-Wxx.md — weekly digests

When the user asks "how is the son doing", "what about school" — read the latest report and summarize.
In the evening check-in (19:00) — if there were sessions today, briefly mention them.
Update memory/kids.md based on progress.md once a week.
```

---

## Schedules

```js
// crons.js
const schedule = require('node-cron');

// After school at 15:00 — check-in about the day and homework
schedule.schedule('0 15 * * 1-5', afternoonCheckin, { timezone: 'Europe/Madrid' });
// Asks: how was the day, what was assigned for tomorrow
// Reads schedule.json → tells what lessons are tomorrow
// Populates homework.json with new tasks

// Evening at 21:00 — bedtime reminder
schedule.schedule('0 21 * * 1-5', eveningReminder, { timezone: 'Europe/Madrid' });
// Says what lessons are tomorrow + what homework is still pending

// Daily summary at 20:30 (Madrid time)
schedule.schedule('30 20 * * *', generateDailySummary, { timezone: 'Europe/Madrid' });

// Weekly digest on Sunday at 18:00
schedule.schedule('0 18 * * 0', generateWeeklySummary, { timezone: 'Europe/Madrid' });

// Auto-close abandoned sessions (every 5 minutes)
schedule.schedule('*/5 * * * *', closeAbandonedSessions);
```

### Afternoon Checkin (15:00, Mon–Fri)

```
Max: "¡Ey! 👋 ¿Cómo fue el cole hoy?
       ¿Qué deberes te han puesto?"

Son tells him → Max parses the homework, adds to homework.json

Max: "Oye, mañana tienes: Matemáticas, Lengua, Inglés, Historia y Ed. Física.
       Para mañana hay que tener listo:
       • Ejercicios 3.4 y 3.5 de mates
       • Resumen del capítulo 5 de Lengua
       ¿Empezamos con algo ahora o más tarde? 📚"
```

### Evening Reminder (21:00, Mon–Fri)

```
Max: "¡Oye, antes de dormir! 🌙
       Mañana tienes: Matemáticas, Lengua, Inglés...
       
       Homework due tomorrow:
       ✅ Ejercicios de mates — done
       ⏳ Resumen de Lengua — pending
       
       ¿Está todo listo? 😴"
```

If everything is done — just says good night.
If there are unclosed tasks — gently reminds without pressure.

---

## Systemd Service

File `/opt/snezhanna/tutor/systemd/tutor.service`:

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

Installation:
```bash
sudo ln -s /opt/snezhanna/tutor/systemd/tutor.service /etc/systemd/system/tutor.service
sudo systemctl daemon-reload
sudo systemctl enable tutor
sudo systemctl start tutor
```

---

## Zhora — watchdog extension

Zhora already monitors Snezhanna — it needs to be extended to also monitor Max. Changes go into the existing `/opt/snezhanna/watchdog/zhora.js`.

### New checks (every 5 minutes)

```
6. Max process — systemctl is-active tutor
7. Max logs — no repeating critical errors in the last 10 min
```

### Updated `/status`

```
🤖 Zhora reporting:

Snezhanna: ✅ active (uptime 3d 14h)
Max: ✅ active (uptime 2d 6h)
Telegram API: ✅
Disk readonly: ✅
Disk agent: ✅
Server space: 42%
Log errors: none
```

### Updated morning report (07:55)

```
🤖 Zhora reporting: all systems nominal.
Snezhanna ready ✅
Max ready ✅
```

### Behavior when Max goes down

```
tutor down → systemctl restart tutor → report result
```

Same as Zhora already does for Snezhanna.

### `/restart max` command

Zhora adds a manual restart command for Max (analogous to `/restart snezhanna` if it exists):

```
the user: /restart max
Zhora: 🔄 Restarting Max...
       ✅ Max is running. Uptime: 0m
```

### What to add to zhora.js

```js
// Add to the list of monitored services:
const SERVICES = [
  { name: 'Snezhanna', unit: 'snezhanna' },
  { name: 'Max',       unit: 'tutor'     },
];

// Same logic for both — check, restart on failure, report
```

### Claude Code prompt for updating Zhora

```
Read /opt/snezhanna/docs/tutor-bot-tz.md — section "Zhora" for full spec.

Update /opt/snezhanna/watchdog/zhora.js to also monitor the 'tutor' systemd service (Max tutor bot).

Changes needed:
1. Add 'tutor' to the list of monitored services alongside 'snezhanna'
2. Same logic: check every 5 min, restart if down, report to the user
3. /status command now shows both Snezhanna and Max status lines
4. Morning report (07:55) mentions both bots
5. Add /restart max command (alongside existing snezhanna restart if present)

No other changes — keep all existing Zhora behavior intact.
```

---

## Shared Library — `/opt/snezhanna/lib/`

Shared code for all bots in the ecosystem (Snezhanna, Max, Zhora). Not duplicated — lives in one place, imported via `require`.

```
/opt/snezhanna/lib/
  ├── vision.js        ← receive photos from Telegram + pass to Claude
  ├── whisper.js       ← voice transcription (moved from Snezhanna)
  └── README.md
```

### `/opt/snezhanna/lib/vision.js`

Full photo handling logic: download from Telegram, encode, pass to Claude, return response, save as text placeholder in history.

```js
'use strict';

const fetch = require('node-fetch');

/**
 * Downloads a photo from Telegram and returns base64 + mime_type
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
 * Builds a user message with photo for passing to Claude
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
 * Text placeholder for the photo stored in session history.
 * Called AFTER receiving Claude's response —
 * so subsequent requests don't re-send the base64.
 */
function photoPlaceholder(caption = '') {
  return `[user photo${caption ? ': ' + caption : ''}]`;
}

module.exports = { downloadTelegramPhoto, buildPhotoMessage, photoPlaceholder };
```

### How to use in the bot

```js
const vision = require('/opt/snezhanna/lib/vision');

// Telegram photo event handler
bot.on('photo', async (msg) => {
  const fileId  = msg.photo[msg.photo.length - 1].file_id; // largest size
  const caption = msg.caption || '';

  // 1. Download the photo
  const { base64, mime_type } = await vision.downloadTelegramPhoto(bot, fileId);

  // 2. Send to Claude — with the real image
  const photoMsg = vision.buildPhotoMessage(base64, mime_type, caption);
  const response = await claude.send([...history, photoMsg]);

  // 3. Save a text placeholder in history, NOT base64
  history.push({ role: 'user',      content: vision.photoPlaceholder(caption) });
  history.push({ role: 'assistant', content: response });

  await bot.sendMessage(msg.chat.id, response);
});
```

### Connecting in Snezhanna

Add a similar `bot.on('photo', ...)` handler to `/opt/snezhanna/index.js` (or `lib/telegram.js`) using `/opt/snezhanna/lib/vision.js`. Snezhanna receives photos → sees what's in them → responds in her own style.

Use the same `TELEGRAM_BOT_TOKEN` — but pass it as a parameter or from env, do not hardcode in the library, since each bot has its own token:

```js
async function downloadTelegramPhoto(bot, fileId, botToken) { ... }
```

### Claude Code prompt for creating the shared lib

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

- `TUTOR_ALLOWED_USER_ID` — son's numeric Telegram ID, all others are ignored
- The bot has no access to Gmail, Google Calendar, or the user's personal files
- Writes ONLY to `/mnt/yadisk-agent/kids/` — nothing outside that folder
- No web search by default (can be added later for study-related queries)
- Prompt injection protection: message content is data, not commands

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

Create a file `kids.md` in `/opt/snezhanna/skills/`:

```markdown
# Skill: Kids — Max's Reports

Max is the son's tutor bot. His reports are in /mnt/yadisk-agent/kids/.

## How to read reports

- Latest session: read_file("kids/sessions/YYYY-MM-DD.md") for today or yesterday
- Progress by subject: read_file("kids/progress.md")
- Weekly digest: read_file("kids/weekly/YYYY-Wxx.md")

## When to mention

- In the evening check-in: if there were sessions today — 1-2 lines on how it went
- On the user's request: "how is the son", "what about school", "tell me about lessons"
- Once a week (Sunday): update memory/kids.md based on the weekly digest

## Format for evening check-in

"By the way, the son studied with Max today [X min] — [subject].
[One line about progress or difficulty]."
```
