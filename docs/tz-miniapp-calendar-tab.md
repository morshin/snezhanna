# TZ: Calendar Tab in Mini App

## Goal

Add a second tab to the existing Mini App. The first tab (Tasks) stays unchanged. The new tab shows Google Calendar events in two modes: day timeline and week list.

---

## Navigation

Two tabs at the bottom of the screen:
- **Задачи** — existing screen, no changes
- **Календарь** — new screen described below

---

## Calendar screen

### Day / Week toggle

A segmented control at the top of the Calendar screen switches between two views. Defaults to **Day** on open.

### Day view

A vertical timeline of today from 07:00 to 23:00 (or from the first event if earlier). Each event is a block on the timeline showing:
- Event title
- Time range (e.g. 14:00–15:00)
- Color accent if available from Google Calendar

Current time is shown as a horizontal line so it's immediately clear what's coming next.

Empty slots between events are visible — this is the main value of the timeline view (seeing free time at a glance).

### Week view

A compact list of events grouped by day for the next 7 days. Each day is a section header, events listed below it. Days with no events are hidden.

Each event shows: title, time (or "весь день" for all-day events).

Tapping an event does nothing for now — read-only view.

---

## Data

The Mini App fetches calendar data from a new API endpoint on the existing Node.js server (port 3001), which reads from `lib/google.js` — already available in the codebase.

Two endpoints needed:
- `GET /api/calendar/day` — today's events
- `GET /api/calendar/week` — events for the next 7 days

Both must validate the Telegram `initData` the same way the tasks endpoints do.

---

## Design

- Follows the same visual style as the Tasks tab — Telegram theme colors, native feel
- Timeline should feel spacious, not cramped — readable at a glance
- No create/edit/delete — read-only for now

---

## Constraints

- No new npm packages
- Reuse `lib/google.js` for calendar data — no direct Google API calls from the Mini App
- Only add endpoints to the existing API server Claude Code already set up
