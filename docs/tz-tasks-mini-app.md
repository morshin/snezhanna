# TZ: Tasks Mini App

## Goal

A Telegram Mini App that gives quick, touch-friendly access to the task list. The primary use case is reviewing and closing tasks on mobile without scrolling through chat messages.

---

## Entry point

Configured as the bot's **Menu Button** in BotFather — always visible at the bottom left of the chat input. Opens the Mini App instantly without any message interaction.

---

## User-facing behaviour

### Task list

- On open, shows today's tasks by default
- A toggle at the top switches between **"Today"** (tasks due today or overdue) and **"All"** (all active tasks)
- Tasks are grouped by Eisenhower quadrant — same grouping as the morning briefing: urgent+important first, then urgent, then important, then backlog
- Completed tasks are hidden

### Completing a task

- Tap a task row to mark it as done
- The task disappears from the list immediately with a satisfying visual feedback (checkmark animation or strikethrough before removal)
- No confirmation dialog

### Additional actions per task

Revealed on swipe left (mobile gesture) or via a "⋯" button:
- **Change priority** — toggle urgent / important flags independently
- **Move deadline** — date picker to set or change due date
- **Delete** — removes the task permanently, with a brief undo snackbar (3 seconds)

### Empty state

When all tasks are done: show a positive message, e.g. "Всё сделано 🎉"

---

## Data

The Mini App reads and writes task data via HTTP calls to a lightweight local API endpoint on the Snezhanna server. The server exposes task operations already implemented in `lib/tasks.js` — the Mini App does not access Yandex Disk directly.

The server endpoint must:
- Verify that the request comes from a legitimate Telegram Mini App session (validate `initData` from `window.Telegram.WebApp`)
- Support: list tasks, complete task, update task (priority / due date), delete task

---

## Design

- Follows Telegram's native theme colors (`var(--tg-theme-*)`), looks native on both light and dark themes
- Mobile-first, full-screen
- Task rows should be large enough to tap comfortably (min 48px height)
- Quadrant section headers are subtle, not dominant
- No heavy UI framework required — keep it simple and fast-loading

---

## Infrastructure

- The Mini App is a static HTML/JS file served over HTTPS
- The Snezhanna server (already running on the Hetzner VM) adds a small Express HTTP endpoint for task API calls
- HTTPS can be handled by a simple nginx reverse proxy on the same VM, or any static hosting with a public URL (required by Telegram for Mini Apps)
- No new npm packages for the Mini App itself if avoidable; the server-side API endpoint can reuse existing dependencies

---

## Constraints

- No new npm packages unless strictly necessary
- All task mutations go through `lib/tasks.js` — no direct file access from the Mini App
- Write access remains limited to `/mnt/yadisk-agent/` as with the rest of the bot
- The API endpoint must be protected — unauthenticated requests must be rejected
