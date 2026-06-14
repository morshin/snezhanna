# TZ-3: Settings in Mini App

## Goal

Add a settings modal to the Mini App accessible via a gear icon in the header.
The modal contains a single vertically scrollable page with sections:
Profile, Schedule, Integrations, Chats, Projects, Contacts.

All settings persist to SQLite (via new `lib/settings.js` module).
Snezhanna can change settings in dialogue via `update_my_preferences` tool.

---

## 1. New Table: `user_settings`

Add to `lib/db.js` `initSchema()`:

```sql
CREATE TABLE IF NOT EXISTS user_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

Simple key-value. All values stored as strings (booleans as `'true'`/`'false'`, numbers as strings).

### Default values

| Key | Default | Description |
|-----|---------|-------------|
| `preferred_name` | `'Вовик'` | How Snezhanna addresses the user |
| `formality` | `'informal'` | `'formal'` or `'informal'` |
| `response_style` | `'concise'` | `'concise'` or `'detailed'` |
| `briefing_time` | `'08:00'` | HH:MM |
| `github_enabled` | `'true'` | Include GitHub issues in briefing |
| `strava_enabled` | `'true'` | Include Strava in weekly digest |
| `email_poll_interval` | `'30'` | Minutes: 15, 30, or 60 |

---

## 2. New File: `lib/settings.js`

```js
// get(key) → string value or default, never throws
// set(key, value) → saves to DB
// getAll() → { key: value, ... } object of all settings
// DEFAULTS → exported object of default values
// getSystemPromptBlock() → formatted string for injection into system prompt
```

`getSystemPromptBlock()` returns a block injected after `IDENTITY.md` in the system prompt:

```
## User Preferences
- Address as: {preferred_name}
- Formality: {formality}
- Response style: {response_style}
```

In `index.js`: replace the current static identity injection with:
```js
const identity = fs.readFileSync('.../IDENTITY.md', 'utf8');
const userPrefs = settings.getSystemPromptBlock();
// system prompt = identity + '\n\n' + userPrefs + '\n\n' + timestamp
```

---

## 3. New Table: `monitored_chats`

Add to `lib/db.js` `initSchema()`:

```sql
CREATE TABLE IF NOT EXISTS monitored_chats (
  chat_id   INTEGER PRIMARY KEY,
  name      TEXT NOT NULL,
  type      TEXT NOT NULL DEFAULT 'personal',  -- personal | work
  category  TEXT,   -- kids | family | work | null
  project   TEXT    -- project name or null
);
```

### Migration from config

Add to `scripts/migrate-from-yadisk.js` a new step:

Read `config/nanobot.json → chat_monitor.chats` → insert all entries into `monitored_chats`.

After migration: `lib/chat-monitor.js` reads from SQLite instead of config on startup.

Rewrite `lib/chat-monitor.js` init:
```js
// On module load: query all rows from monitored_chats, build chatMap
// Add exported functions: addChat(chat), removeChat(chatId) — write to SQLite + update chatMap
```

---

## 4. New API Endpoints — `lib/api.js`

Add to `parseRoute()` and `handleRequest()`:

### Settings

```
GET  /api/settings          → getAll() from lib/settings.js
POST /api/settings          → body: { key, value } → settings.set(key, value)
POST /api/settings/batch    → body: { settings: { key: value, ... } } → set multiple
```

### Chats

```
GET    /api/chats           → SELECT * FROM monitored_chats
POST   /api/chats           → INSERT { chat_id, name, type, category, project }
DELETE /api/chats/:chat_id  → DELETE FROM monitored_chats WHERE chat_id = ?
                              + chatMonitor.removeChat(chat_id)
```

### Projects (extend existing)

```
GET   /api/projects                    → listProjects('active')
POST  /api/projects                    → createProject(name) + set initial params
PATCH /api/projects/:id                → UPDATE projects SET ... WHERE id = ?
GET   /api/projects/:id/params         → SELECT * FROM project_params WHERE project_id = ?
POST  /api/projects/:id/params         → upsertProjectParam(id, key, value)
```

### Contacts

```
GET    /api/contacts                   → SELECT * FROM contacts ORDER BY name
POST   /api/contacts                   → INSERT INTO contacts
PATCH  /api/contacts/:id               → UPDATE contacts SET ... WHERE id = ?
DELETE /api/contacts/:id               → DELETE FROM contacts WHERE id = ?
GET    /api/contacts/:id/projects      → SELECT p.* FROM projects p JOIN project_contacts pc ...
POST   /api/contacts/:id/projects      → INSERT INTO project_contacts
DELETE /api/contacts/:id/projects/:pid → DELETE FROM project_contacts
```

All new endpoints use the same `validateInitData()` guard as existing endpoints.

---

## 5. Frontend — `mini-app/index.html`

### Gear icon in header

Add to the existing header bar a gear icon button (`⚙️` or SVG) in the top-right corner.
On click: open the settings modal.

### Settings modal structure

Full-screen overlay with a close button (✕) at top-right.
Single scrollable content area with sections separated by section headers.

```
[✕]  Settings
─────────────────
PROFILE
  Name: [text input]
  Tone: [toggle: Informal / Formal]
  Response style: [toggle: Concise / Detailed]

─────────────────
SCHEDULE
  Briefing: [time input HH:MM]
  Quiet mode: [date picker or text "until DD.MM"] [Reset]

─────────────────
INTEGRATIONS
  GitHub Issues  [toggle]
  Strava         [toggle]
  Email: check every [15 / 30 / 60] min

─────────────────
CHATS
  [list of monitored chats]
  [+ Add chat]  → inline form: chat_id, name, type, category

─────────────────
PROJECTS
  [list of active projects]
  tap → expand inline:
    storage_path [text input]
    github_repo  [text input]
    status       [toggle: Active / Archived]
    ── Parameters ──
    Tasks in briefing    [toggle]
    Calendar             [toggle]
    GitHub Issues        [toggle]
    Include in briefing  [toggle]
    Notifications        [toggle]
  [+ New project]

─────────────────
CONTACTS
  [search input]
  [list of contacts: name + role]
  tap → expand inline:
    name, role, company, telegram, email, phone, notes
    Projects: [chips with linked projects] [+ link]
  [+ Add contact]
```

### Auto-save behavior

All inputs auto-save on blur or toggle change — no "Save" button needed.
Show a brief ✓ confirmation inline after save (CSS transition, disappears after 1.5s).
On error: show ✗ in red.

### Schedule section and appState

`briefing_time` is saved to `user_settings` AND applied to `appState` by the server:
- `POST /api/settings` with `key=briefing_time` → server also updates the running cron job.
- Cron rescheduling: in `index.js`, expose a `rescheduleBriefing(newTime)` function that stops and restarts the morning briefing cron with the new time.

`quiet_until` (vacation mode): the settings panel shows the current value from `appState.quietUntil`.
- If set: show "Quiet mode until DD.MM" with a "Reset" button → `POST /api/settings { key: 'quiet_until', value: null }` → server clears `appState.quietUntil`.
- If not set: show a date picker (HTML `<input type="date">`) + "Enable" button.

Add API endpoint:
```
POST /api/quiet    → body: { until: 'YYYY-MM-DD' | null }
                    → sets/clears appState.quietUntil, persists state
```

---

## 6. `update_my_preferences` Tool — `lib/tools.js`

Port from B2B. Add to `TOOLS[]`:

```js
{
  name: 'update_my_preferences',
  description: 'Update user preferences and settings. Use when Vova asks to change how Snezhanna behaves, communicates, or schedules things.',
  input_schema: {
    type: 'object',
    properties: {
      preferred_name:     { type: 'string', description: 'How to address Vova' },
      formality:          { type: 'string', enum: ['formal', 'informal'] },
      response_style:     { type: 'string', enum: ['concise', 'detailed'] },
      briefing_time:      { type: 'string', description: 'HH:MM format' },
      github_enabled:     { type: 'boolean' },
      strava_enabled:     { type: 'boolean' },
      email_poll_interval:{ type: 'integer', enum: [15, 30, 60] },
      quiet_days:         { type: 'integer', description: '0 = cancel quiet mode, N = days' }
    }
  }
}
```

Handler in `executeTool()`:

```js
case 'update_my_preferences': {
  const allowed = ['preferred_name','formality','response_style','briefing_time',
                   'github_enabled','strava_enabled','email_poll_interval'];
  const changed = [];
  for (const key of allowed) {
    if (input[key] !== undefined) {
      settings.set(key, String(input[key]));
      changed.push(key);
    }
  }
  if (input.quiet_days !== undefined) {
    if (input.quiet_days === 0) {
      appState.quietUntil = null;
    } else {
      appState.quietUntil = new Date(Date.now() + input.quiet_days * 86400000).toISOString();
    }
    state.save(appState);
    changed.push('quiet_mode');
  }
  if (input.briefing_time) rescheduleBriefing(input.briefing_time);
  return { updated: changed };
}
```

Add to `IDENTITY.md` (tools section): "Use `update_my_preferences` when Vova says things like 'называй меня Вов', 'отвечай покороче', 'перенеси брифинг на 9:00', 'включи Strava', 'выключи GitHub'."

---

## 7. `rescheduleBriefing(newTime)` — `index.js`

Add a module-level variable:
```js
let briefingCronJob = null;
```

Extract the morning briefing cron body into a named async function `runMorningBriefing()`.

In `setupSchedules()`: assign `briefingCronJob = cron.schedule(...)` instead of inline.

New exported function (or module-level):
```js
function rescheduleBriefing(timeStr) {
  const [h, m] = timeStr.split(':');
  if (briefingCronJob) briefingCronJob.stop();
  briefingCronJob = cron.schedule(`${m} ${h} * * *`, runMorningBriefing, { timezone: config.timezone });
  console.log(`[Schedule] Briefing rescheduled to ${timeStr}`);
}
```

---

## 8. Files Modified

| File | Change |
|------|--------|
| `lib/db.js` | Add `user_settings` and `monitored_chats` tables to `initSchema()` |
| `lib/settings.js` | **New** — key-value settings access, `getSystemPromptBlock()` |
| `lib/chat-monitor.js` | Read chatMap from SQLite on init; add `addChat()`/`removeChat()` |
| `lib/tools.js` | Add `update_my_preferences` tool + handler |
| `lib/api.js` | Add settings, chats, projects (extend), contacts endpoints |
| `index.js` | Inject `settings.getSystemPromptBlock()` into system prompt; add `rescheduleBriefing()`; expose `appState` to `executeTool` for quiet_mode |
| `mini-app/index.html` | Add gear icon, settings modal with all sections |
| `scripts/migrate-from-yadisk.js` | Add step to migrate `chat_monitor.chats` → `monitored_chats` table |
| `identity/IDENTITY.md` | Add note about `update_my_preferences` usage |

---

## Out of Scope

- Identity/IDENTITY.md editing via UI (deferred)
- OAuth flow for cloud storage (deferred)
- Project history UI (deferred)
- Multi-user support
