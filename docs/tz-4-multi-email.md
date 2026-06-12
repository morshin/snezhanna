# TZ-4: Multi-Mailbox Email

## Goal

Replace the current single-Gmail setup with a unified multi-account email system.
Support multiple Gmail accounts (OAuth) and IMAP accounts (Office 365 + any IMAP).
All accounts share the same monitoring, categorization, and notification logic.
Sending/drafts strictly require explicit user confirmation.
Email account management lives in the Mini App settings modal (extending TZ-3).

---

## 1. New Table: `email_accounts`

Add to `lib/db.js` `initSchema()`:

```sql
CREATE TABLE IF NOT EXISTS email_accounts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  label         TEXT NOT NULL,          -- display name e.g. "Рабочая", "Личная", "AMC"
  email         TEXT NOT NULL UNIQUE,
  type          TEXT NOT NULL,          -- 'gmail' | 'imap'
  account_type  TEXT NOT NULL DEFAULT 'personal',  -- 'personal' | 'corporate'
  enabled       INTEGER NOT NULL DEFAULT 1,
  bootstrapped  INTEGER NOT NULL DEFAULT 0,  -- 1 after first poll (no digest on first run)
  credentials   TEXT,                   -- JSON string: Gmail token OR IMAP config
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
```

Also add per-account seen message tracking:

```sql
CREATE TABLE IF NOT EXISTS email_seen (
  account_id  INTEGER NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
  message_id  TEXT NOT NULL,
  seen_at     TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (account_id, message_id)
);

CREATE INDEX IF NOT EXISTS idx_email_seen_account ON email_seen(account_id);
```

`email_seen` replaces `appState.emailDigestSeenIds` and `appState.emailDigestBootstrapped`.
Remove those two fields from `DEFAULT_STATE` in `lib/state.js` after migration.

### `credentials` JSON format

**Gmail:**
```json
{
  "access_token": "...",
  "refresh_token": "...",
  "expiry_date": 1234567890
}
```

**IMAP:**
```json
{
  "host": "outlook.office365.com",
  "port": 993,
  "tls": true,
  "user": "user@company.com",
  "password": "..."
}
```

---

## 2. Migration: Existing Gmail → `email_accounts`

Add to `scripts/migrate-from-yadisk.js` as a final step:

1. Read `token.json` if it exists.
2. Insert into `email_accounts`:
   ```
   label = '<your-snezhanna-email>'
   email = '<your-snezhanna-email>'
   type  = 'gmail'
   account_type = 'personal'
   enabled = 1
   bootstrapped = 1   ← treat as already bootstrapped to avoid re-digest on migration
   credentials = contents of token.json
   ```
3. Migrate `appState.emailDigestSeenIds` → insert each id into `email_seen` for this account.
4. Set `appState.emailDigestBootstrapped = true` and `appState.emailDigestSeenIds = []` in state, save.

After migration the old `token.json` can remain — `lib/google.js` calendar functions still use it (calendar is not migrated in this TZ).

---

## 3. New File: `lib/imap.js`

IMAP adapter using the existing `imap` package (already in `package.json` via B2B reference — add if missing: `npm install imap mailparser`).

### Exported functions

```js
async function getMessages(credentials, maxResults = 20, unreadOnly = true)
// Returns array of unified message objects (see section 5)

async function getMessage(credentials, uid)
// Returns full message with body

async function createDraft(credentials, to, subject, body, inReplyToId)
// Saves to Drafts folder via IMAP APPEND

async function sendMessage(credentials, to, subject, body, inReplyToId)
// Sends via SMTP (nodemailer) — only called with confirmed: true
// Add nodemailer to dependencies: npm install nodemailer

async function markAsRead(credentials, uid)
// Marks message as \Seen
```

SMTP config derived from IMAP credentials:
- Office 365: `smtp.office365.com:587` (STARTTLS)
- Generic: replace IMAP host with SMTP host heuristic, or allow explicit `smtp_host`/`smtp_port` in credentials JSON.

---

## 4. Refactor `lib/google.js` — Gmail Multi-Account

Split Gmail email functions out of the monolithic `lib/google.js` into a multi-account-aware interface.

**Do NOT touch calendar functions** — `getCalendarEvents`, `getUpcomingEvents`, `createEvent`, `updateEvent`, `deleteEvent`, `deleteEventSeries`, `getAuthUrl`, `saveToken`, `isAuthorized`. These stay in `lib/google.js` using `token.json` as before.

**Extract and refactor Gmail functions** to accept a `credentials` object instead of reading `token.json`:

```js
// lib/gmail.js (new file)

async function getMessages(credentials, maxResults = 20, unreadOnly = true)
async function getMessage(credentials, messageId)
async function createDraft(credentials, to, subject, body, inReplyToId)
async function sendMessage(credentials, to, subject, body, inReplyToId)
async function markAsRead(credentials, messageId)
async function getAttachment(credentials, messageId, attachmentId)
```

Each function constructs its own `OAuth2` client from the passed `credentials` object (same logic as current `getAuth()` but without reading from file).

Keep the old `lib/google.js` Gmail exports as thin wrappers that read `token.json` and call `lib/gmail.js` — for backwards compatibility during transition. Remove wrappers after all callers are migrated.

---

## 5. Unified Message Format

Both `lib/gmail.js` and `lib/imap.js` return messages in this format:

```js
{
  id: String,          // provider message id (Gmail message id or IMAP UID as string)
  accountId: Number,   // email_accounts.id
  accountEmail: String,
  from: String,
  to: String,
  subject: String,
  date: String,        // ISO string
  body: String,        // plain text, max 8000 chars
  unread: Boolean,
  attachments: [{ filename, mimeType, size }],
  needsReply: Boolean  // heuristic: subject has '?' OR direct question to user
}
```

`needsReply` heuristic (same as TZ-1 `hasSomethingToSay`):
- Subject contains `?`
- OR sender is not a noreply/newsletter domain (simple blacklist: `noreply`, `no-reply`, `newsletter`, `notifications`, `mailer-daemon`, `donotreply`)

---

## 6. New File: `lib/mail-manager.js`

Central coordinator. Iterates all enabled accounts, dispatches to correct adapter.

```js
async function pollAll()
// For each enabled account in email_accounts:
//   fetch new messages (not in email_seen)
//   bootstrap if not bootstrapped (seed seen IDs, set bootstrapped=1, skip digest)
//   categorize new messages
//   insert message IDs into email_seen
//   return { accountId, account, messages: categorized[] }
// Each account wrapped in try/catch — failure of one does not affect others
// Returns array of per-account results

async function getMessages(accountId, maxResults, unreadOnly)
// Fetch from specific account (used by Claude tools)

async function getMessage(accountId, messageId)
// Fetch full message from specific account

async function createDraft(accountId, to, subject, body, inReplyToId)
// Create draft in specific account (no confirmation needed — drafts are safe)

async function sendMessage(accountId, to, subject, body, inReplyToId)
// Send from specific account — ONLY called when confirmed: true

function getAdapter(account)
// Returns gmail adapter or imap adapter based on account.type
```

---

## 7. Message Categorization — `lib/mail-manager.js`

After fetching new messages, categorize each:

```js
function categorize(message, account) {
  // Returns: 'task' | 'event' | 'update' | 'info' | 'spam' | 'reply_needed'

  if (account.account_type === 'corporate') {
    // No spam category for corporate accounts
    // Add subproject detection (see below)
  }

  if (message.needsReply) return 'reply_needed';
  // Simple keyword heuristics on subject:
  if (/встреч|meeting|call|zoom|calendar|invite/i.test(message.subject)) return 'event';
  if (/задач|task|todo|deadline|срок/i.test(message.subject)) return 'task';
  if (/отчёт|report|update|статус|status/i.test(message.subject)) return 'update';
  if (isNoReplyDomain(message.from)) return 'info';
  return 'info';
}
```

**Corporate subproject detection**: for `account_type === 'corporate'`, attempt to match subject/sender against project names in `projects` table. Add `subproject` field to categorized message if match found.

---

## 8. Cron — `index.js`

Replace the existing `cron.schedule('*/30 * * * *', ...)` email handler with:

```js
// Email poll — dynamic interval from user_settings
let emailCronJob = null;

function scheduleEmailPoll() {
  const interval = parseInt(settings.get('email_poll_interval') || '30');
  if (emailCronJob) emailCronJob.stop();
  emailCronJob = cron.schedule(`*/${interval} * * * *`, runEmailPoll, { timezone: config.timezone });
}

async function runEmailPoll() {
  if (!appState.chatId) return;
  try {
    const results = await mailManager.pollAll();
    for (const { account, messages } of results) {
      if (messages.length === 0) continue;

      // Hard alerts (bypass silence) — reply_needed messages
      const replyNeeded = messages.filter(m => m.category === 'reply_needed');
      for (const m of replyNeeded) {
        await sendToVova(
          `📬 Вов, нужен ответ: *${m.subject}* — от ${m.from} [${account.label}]`,
          { parse_mode: 'Markdown' }
        );
      }

      // Regular digest — only if silenceLevel === 0
      if (appState.silenceLevel > 0) continue;

      const regular = messages.filter(m => m.category !== 'reply_needed');
      if (regular.length === 0) continue;

      // Build digest per account
      const digest = buildEmailDigest(account, regular);
      if (digest) await sendToVova(digest);
    }
  } catch (e) {
    console.error('[Schedule] email_poll error:', e.message);
  }
}
```

Call `scheduleEmailPoll()` in `setupSchedules()` instead of the old hardcoded cron.

Also expose `rescheduleEmailPoll()` (same pattern as `rescheduleBriefing`) for when `email_poll_interval` changes via settings or `update_my_preferences` tool.

Remove from `appState` / `DEFAULT_STATE`: `emailDigestSeenIds`, `emailDigestBootstrapped`.

---

## 9. Email Digest Format

```js
function buildEmailDigest(account, messages) {
  if (messages.length === 0) return null;

  const byCategory = {};
  for (const m of messages) {
    if (!byCategory[m.category]) byCategory[m.category] = [];
    byCategory[m.category].push(m);
  }

  const labels = {
    task:   '📋 Задачи',
    event:  '📅 События',
    update: '📊 Апдейты',
    info:   'ℹ️ Инфо'
  };

  let text = `📬 *${account.label}* — ${messages.length} новых:\n`;
  for (const [cat, msgs] of Object.entries(byCategory)) {
    text += `\n${labels[cat] || cat}:\n`;
    for (const m of msgs.slice(0, 5)) {
      text += `• ${m.subject} — _${m.from}_\n`;
    }
    if (msgs.length > 5) text += `  ...и ещё ${msgs.length - 5}\n`;
  }
  return text;
}
```

---

## 10. Claude Tools Update — `lib/tools.js`

### Update existing email tools

`get_gmail_messages` → rename to `get_emails`, add `account_id` parameter (optional — if omitted, fetch from all accounts):

```js
{
  name: 'get_emails',
  description: 'Get recent emails from one or all connected mailboxes',
  input_schema: {
    properties: {
      account_id: { type: 'integer', description: 'Specific account ID, or omit for all' },
      max_results: { type: 'integer', default: 20 },
      unread_only: { type: 'boolean', default: true }
    }
  }
}
```

`get_message_by_id` → add `account_id` as required parameter.

`create_draft` → add `account_id` as required parameter. No confirmation needed.

### New tool: `send_email`

```js
{
  name: 'send_email',
  description: 'Send an email. IMPORTANT: only set confirmed=true if the user has explicitly said "отправь", "send it", "да отправляй" in this conversation turn. Never set confirmed=true on your own.',
  input_schema: {
    type: 'object',
    properties: {
      account_id:    { type: 'integer' },
      to:            { type: 'string' },
      subject:       { type: 'string' },
      body:          { type: 'string' },
      in_reply_to:   { type: 'string', description: 'message_id of the email being replied to' },
      confirmed:     { type: 'boolean', description: 'Must be true to actually send. If false or omitted, creates a draft instead.' }
    },
    required: ['account_id', 'to', 'subject', 'body']
  }
}
```

Handler:
```js
case 'send_email': {
  if (!input.confirmed) {
    // Create draft instead
    const draft = await mailManager.createDraft(input.account_id, input.to, input.subject, input.body, input.in_reply_to);
    return { draft_created: true, message: 'Создал черновик. Скажи "отправляй" чтобы отправить.' };
  }
  const result = await mailManager.sendMessage(input.account_id, input.to, input.subject, input.body, input.in_reply_to);
  return { sent: true, ...result };
}
```

Add to `IDENTITY.md`: "CRITICAL: Never set `confirmed: true` in `send_email` on your own. Only set it when the user explicitly says to send in the current message. Always create a draft first and show it to the user."

Update `update_my_preferences` tool handler to call `rescheduleEmailPoll()` when `email_poll_interval` changes.

---

## 11. Mini App — ПОЧТА Section

Add to the settings modal in `mini-app/index.html` a new section **ПОЧТА** between ИНТЕГРАЦИИ and ЧАТЫ:

```
─────────────────
ПОЧТА
  [list of email accounts]
  Each account row:
    • Label + email address
    • Badge: Gmail / IMAP
    • Toggle: вкл/выкл
    • [Переавторизовать] button (Gmail only, shown if token may be stale)
    • [Удалить] button

  [+ Добавить ящик] → expands inline form:
    Тип: [Gmail | IMAP]

    If Gmail:
      Email: [text input]
      [Авторизовать через Google] button
        → opens OAuth URL in browser (window.open)
        → user copies code
        → text input appears: "Вставь код авторизации"
        → [Подтвердить] → POST /api/email-accounts/oauth-callback

    If IMAP:
      Название: [text input]  ← label
      Email: [text input]
      Тип ящика: [Личный | Корпоративный]
      IMAP хост: [text input]  placeholder: outlook.office365.com
      IMAP порт: [number input] placeholder: 993
      Логин: [text input]
      Пароль: [password input]
      [Сохранить и проверить] → POST /api/email-accounts → server tests connection
```

### New API endpoints for email accounts

Add to `lib/api.js`:

```
GET    /api/email-accounts
       → SELECT id, label, email, type, account_type, enabled FROM email_accounts

POST   /api/email-accounts
       → body: { label, email, type, account_type, credentials }
       → for IMAP: test connection before saving (try getMessages with limit=1)
       → INSERT INTO email_accounts
       → return { id, success } or { error }

PATCH  /api/email-accounts/:id
       → body: { label?, enabled?, credentials? }
       → UPDATE email_accounts SET ... WHERE id = ?

DELETE /api/email-accounts/:id
       → DELETE FROM email_accounts WHERE id = ?
       → also DELETE FROM email_seen WHERE account_id = ?

POST   /api/email-accounts/oauth-callback
       → body: { email, code }
       → exchange code for token via lib/google.js saveTokenForAccount(code)
       → upsert into email_accounts
```

Add to `lib/google.js`:
```js
async function saveTokenForAccount(code)
// Same as saveToken() but returns token object instead of writing to file
// The caller (api.js) stores it in email_accounts.credentials
```

---

## 12. Files Modified

| File | Change |
|------|--------|
| `lib/db.js` | Add `email_accounts`, `email_seen` tables |
| `lib/gmail.js` | **New** — Gmail adapter (extracted from google.js), credentials-based |
| `lib/imap.js` | **New** — IMAP/SMTP adapter |
| `lib/mail-manager.js` | **New** — unified coordinator, categorization, digest builder |
| `lib/google.js` | Extract Gmail functions → gmail.js; add `saveTokenForAccount()`; keep calendar + thin Gmail wrappers |
| `lib/tools.js` | Rename `get_gmail_messages` → `get_emails`; update `get_message_by_id`, `create_draft`; add `send_email` |
| `lib/state.js` | Remove `emailDigestSeenIds`, `emailDigestBootstrapped` from `DEFAULT_STATE` |
| `lib/api.js` | Add email account endpoints |
| `lib/settings.js` | `rescheduleEmailPoll` integration |
| `index.js` | Replace email cron with `scheduleEmailPoll()`; import `mailManager` |
| `mini-app/index.html` | Add ПОЧТА section to settings modal |
| `identity/IDENTITY.md` | Add `send_email` confirmation rule |
| `scripts/migrate-from-yadisk.js` | Add email accounts migration step |
| `package.json` | Add `nodemailer` if not present; add `imap`+`mailparser` if not present |

---

## Dependencies

```bash
npm install nodemailer
npm install imap mailparser   # if not already installed
```

---

## Out of Scope

- Email search / full-text query across accounts
- Email labels/folders management
- Attachment download to Yadisk from email
- Push notifications via Gmail API (webhook) — using poll for now
- Read receipts
