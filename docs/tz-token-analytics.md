# TZ: Token Usage Analytics

## Goal

Log Anthropic API token consumption after every call in both Snezhanna and Max bots,
persist the data to Yandex.Disk, and expose a `get_token_stats` tool so Snezhanna can
answer questions like "how much did we spend this week?" and surface optimization hints.

---

## Data Model

### Log entry (appended after every `anthropic.messages.create()`)

```json
{
  "ts": 1742300000000,
  "bot": "snezhanna",
  "type": "text",
  "tools_called": ["web_search", "get_calendar_events"],
  "history_len": 18,
  "usage": {
    "input_tokens": 3840,
    "output_tokens": 412,
    "cache_creation_input_tokens": 1200,
    "cache_read_input_tokens": 2640
  }
}
```

**`type` values:** `text` | `voice` | `photo` | `scheduled` | `auto_context`

- `scheduled` — morning briefing, evening check-in, weekly digest, event reminders
- `auto_context` — background Google Calendar/Gmail fetch without user message
- `voice` — user sent a voice message (Whisper transcription cost is tracked separately, no change needed)
- `photo` — user sent a photo (base64 input)

### Storage

One JSON file per calendar month, stored on Yandex.Disk:

```
/mnt/yadisk-agent/analytics/
  └── tokens-2026-03.json      ← array of log entries, one per line (NDJSON)
```

Use append mode: open file, append one JSON line, close. Do not parse/rewrite the whole file.

---

## New Module: `lib/token-log.js`

```
logTokens(entry)   — append one entry to the current month's NDJSON file
                     creates the file if it doesn't exist
                     silently catches all errors (never crashes the bot)

readMonthLog(year, month)  — read and parse NDJSON for the given month
                             returns [] on missing file or parse errors
```

`entry` fields: `{ bot, type, tools_called, history_len, usage }`
`ts` is added inside `logTokens`.

### File path logic

```js
const month = new Date().toISOString().slice(0, 7); // "2026-03"
const filePath = `/mnt/yadisk-agent/analytics/tokens-${month}.json`;
```

---

## Integration Points

### `index.js` (Snezhanna)

After every successful `anthropic.messages.create()` call, add:

```js
const toolsCalled = response.content
  .filter(b => b.type === 'tool_use')
  .map(b => b.name);

logTokens({
  bot: 'snezhanna',
  type: requestType,   // pass down from the call site
  tools_called: toolsCalled,
  history_len: history.length,
  usage: response.usage
});
```

`requestType` must be determined at each call site before the API call:
- Regular user text → `'text'`
- Voice message (after Whisper transcription) → `'voice'`
- Photo message → `'photo'`
- Scheduled jobs (heartbeats) → `'scheduled'`
- Auto calendar/gmail context fetch → `'auto_context'`

### `tutor/index.js` (Max)

Same pattern. `bot: 'max'`, types: `text` | `voice` | `photo`.

---

## New Tool: `get_token_stats`

Add to `lib/tools.js` (Snezhanna only, not Max).

### Tool definition

```js
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
}
```

### Tool handler

Reads the relevant NDJSON file(s), computes and returns:

```json
{
  "period": "current_month",
  "total_requests": 312,
  "by_bot": {
    "snezhanna": 287,
    "max": 25
  },
  "by_type": {
    "text": 198,
    "voice": 54,
    "photo": 12,
    "scheduled": 43,
    "auto_context": 5
  },
  "tokens": {
    "input_total": 1240000,
    "output_total": 87000,
    "cache_created": 420000,
    "cache_read": 820000,
    "cache_hit_rate_pct": 66
  },
  "avg_per_request": {
    "input": 3974,
    "output": 279,
    "history_len": 14
  },
  "top_tools": [
    { "name": "web_search", "calls": 41 },
    { "name": "get_calendar_events", "calls": 38 }
  ],
  "most_expensive_types": [
    { "type": "photo", "avg_input_tokens": 8200 },
    { "type": "scheduled", "avg_input_tokens": 5100 }
  ]
}
```

**`cache_hit_rate_pct`** = `cache_read / (cache_read + cache_creation) * 100`, rounded.

For `last_7_days`: filter entries where `ts >= Date.now() - 7 * 86400000`.
For `last_month`: read `tokens-YYYY-MM.json` of the previous calendar month.

---

## IDENTITY.md Addition

Add a short section to Snezhanna's system prompt so she knows how to use the tool and
what insights to provide:

```
## Token Analytics

Tool: get_token_stats(period?)

Use when the user asks about API costs, usage, or token consumption.
After fetching stats, always mention:
- cache hit rate (target >60%)
- most expensive request types
- if photo or voice requests are significantly more expensive — note it
- suggest concrete optimizations if cache_hit_rate_pct < 50%
```

---

## Directory Setup

Add `analytics/` to the list of required agent subdirectories in `lib/yadisk-dirs.js`
so it's auto-created on startup if missing.

---

## No New npm Packages

Use only:
- `fs.appendFileSync` or `fs.appendFile` for NDJSON writes
- `fs.readFileSync` + `.split('\n')` + `JSON.parse` for reads
- Built-in `Date` for time calculations

---

## Implementation Order

1. Create `lib/token-log.js`
2. Add `analytics/` to `lib/yadisk-dirs.js`
3. Instrument `index.js` — determine `requestType` at each call site, add `logTokens()` after each API response
4. Instrument `tutor/index.js` — same pattern
5. Add `get_token_stats` tool to `lib/tools.js` + handler
6. Update `identity/IDENTITY.md`
7. Restart both services, verify entries appear in `analytics/tokens-YYYY-MM.json`

---

## Verification

```bash
# Check file is being written
tail -f /mnt/yadisk-agent/analytics/tokens-$(date +%Y-%m).json

# Count entries after a few interactions
wc -l /mnt/yadisk-agent/analytics/tokens-$(date +%Y-%m).json

# Ask Snezhanna directly
"Снежанна, покажи статистику токенов за текущий месяц"
```
