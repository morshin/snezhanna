# TZ: Calendar Event Metadata

## Goal

Add structured metadata to Google Calendar events:
category, project link, tags, and a follow-up reference.
Metadata is stored in `extendedProperties.private` — invisible in the Google Calendar interface,
does not interfere with the event description, and is accessible via the API.

---

## Metadata Schema

```json
{
  "category": "work",
  "project": "Migration-ERP-Alpha",
  "tags": "release,team",
  "followup_ref": "meetings/2026-03-03-erp-release.md"
}
```

### Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `category` | string | no | Event category (see reference below) |
| `project` | string | no | Project folder name on Yandex.Disk (from `list_projects`) |
| `tags` | string | no | Comma-separated tags, no spaces |
| `followup_ref` | string | no | Path to the follow-up file in the agent folder |

### Category Reference

| Value | Description |
|-------|-------------|
| `work` | Work tasks, clients, consulting |
| `petproject` | Personal projects (Snezhanna, etc.) |
| `sport` | Workouts, sports, physical activity |
| `learning` | Courses, reading, personal development |
| `family` | Family, children, personal matters |
| `health` | Doctors, tests, procedures |
| `admin` | Bureaucracy, documents, taxes |

---

## Code Changes

### 1. `lib/google.js`

#### `createEvent` — add `extendedProperties`

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

#### `updateEvent` — add `extendedProperties` patch

```js
if (updates.metadata) {
  patch.extendedProperties = {
    private: { ...updates.metadata }
  };
}
```

#### `getCalendarEvents` / `getUpcomingEvents` — include field in response

Add `fields` to the request so that `extendedProperties` are returned:

```js
const res = await calendar.events.list({
  calendarId: 'primary',
  timeMin: now.toISOString(),
  timeMax: end.toISOString(),
  singleEvents: true,
  orderBy: 'startTime'
  // extendedProperties are returned automatically — nothing extra needed
});
```

> Verify: Google Calendar API returns `extendedProperties` in the `events.list` response without additional parameters.

### 2. `lib/tools.js`

#### `create_calendar_event` — add metadata parameters

```json
"category": {
  "type": "string",
  "enum": ["work", "petproject", "sport", "learning", "family", "health", "admin"],
  "description": "Event category"
},
"project": {
  "type": "string",
  "description": "Project name (folder name on Yandex.Disk)"
},
"tags": {
  "type": "string",
  "description": "Comma-separated tags (e.g. release,team)"
}
```

#### `update_calendar_event` — same parameters

#### `executeTool` — build metadata object and pass to `createEvent`/`updateEvent`

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

### 3. New tool: `save_meeting_followup`

A separate tool for recording meeting outcomes. Writes a file to `/mnt/yadisk-agent/meetings/`.

```json
{
  "name": "save_meeting_followup",
  "description": "Save meeting outcomes: decisions, owners, next steps. Writes to /mnt/yadisk-agent/meetings/.",
  "input_schema": {
    "properties": {
      "event_id":    { "type": "string", "description": "Google Calendar event ID" },
      "event_title": { "type": "string", "description": "Meeting title" },
      "date":        { "type": "string", "description": "Meeting date (YYYY-MM-DD)" },
      "summary":     { "type": "string", "description": "Brief meeting summary" },
      "decisions":   { "type": "string", "description": "Decisions made (markdown list)" },
      "action_items":{ "type": "string", "description": "Tasks and owners (markdown list)" },
      "next_meeting": { "type": "string", "description": "Date or description of next meeting (optional)" },
      "project":     { "type": "string", "description": "Project name for appending to log.md (optional)" }
    },
    "required": ["event_title", "date", "summary"]
  }
}
```

**Execution logic:**

1. Builds the filename: `YYYY-MM-DD-<slug>.md` (slug = transliterated title, lowercase, hyphens)
2. Writes a Markdown file to `/mnt/yadisk-agent/meetings/`
3. If `project` is provided — also appends a brief entry to `projects/<project>/log.md`
4. If `event_id` is provided — updates the Google Calendar event: sets `extendedProperties.private.followup_ref`

**File template:**

```markdown
# <event_title>
**Date:** <date>
**Project:** <project or —>

## Summary
<summary>

## Decisions
<decisions>

## Action Items
<action_items>

## Next Meeting
<next_meeting or —>
```

---

## Snezhanna's Behavior

### When creating an event

If the event looks like a meeting or call (keywords: встреч, созвон, звонок, митинг, standup, call, review) — **ask for clarification**:

> "What category should this be? Is there a project to link it to?"

If the context is already obvious from the message — set it automatically without asking.

### After the event (trigger)

During the morning briefing and evening check-in — check past meetings from the day that have no `followup_ref`. If any are found — suggest:

> "the user, yesterday you had a meeting 'Call with Alex'. Want to record the outcomes?"

### When reading events

If an event has `extendedProperties` — show the category and project in the summary:

```
📅 15:00 — Call with Alex [work / Migration-ERP-Alpha]
```

---

## New Agent Folder Structure

```
/mnt/yadisk-agent/
  memory/
    health.md
    kids.md
    finance.md
    bureaucracy.md
    decisions.md
  meetings/            ← new folder
    2026-03-03-erp-release.md
    2026-03-10-standup.md
  projects/
    ...
  index/
  drafts/
  fitness/
  digests/
```

The `meetings/` folder is created on bot startup via `yadiskDirs.ensureDirs()`.

---

## Config Changes

Add a category reference to `config/nanobot.json` (for documentation; not loaded at runtime):

```json
"calendar": {
  "categories": ["work", "petproject", "sport", "learning", "family", "health", "admin"]
}
```

---

## Documentation Changes

| File | What to add |
|------|-------------|
| `skills/google-calendar.md` | Category descriptions, examples with `project` and `tags`, behavior for meetings |
| `identity/IDENTITY.md` | New capability: `meetings/` folder, `save_meeting_followup` |
| `lib/yadisk-dirs.js` | `meetings/` in the `ensureDirs()` directory list |
| `docs/snezhanna-tz.md` | Section on calendar metadata |

---

## What Is NOT in This Scope

- Multiple Google calendars (separate feature, requires manual calendarId configuration)
- Searching events by `privateExtendedProperty` via the API (can be added later as `search_calendar_events`)
- Automatic reminders for unresolved follow-ups (separate cron task)

---

## Implementation Order

1. `lib/google.js` — support `extendedProperties` in create/update/get
2. `lib/tools.js` — new parameters in create/update, new tool `save_meeting_followup`
3. `lib/yadisk-dirs.js` — add `meetings/` to `ensureDirs()`
4. `identity/IDENTITY.md` + `skills/google-calendar.md` — update prompts
5. `config/nanobot.json` — add `calendar.categories`
6. Restart service, verify via `journalctl -u snezhanna -f`
