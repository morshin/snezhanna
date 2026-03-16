# Workload & Wellbeing Scoring

Weekly life-balance assessment across four domains: work, family, health, personal.

## How it works

- **Monday 09:00** — Snezhanna sends a 4-question check-in. If Vova replies within 30 min, his answers are factored into scoring. Otherwise, scoring runs on automated data only.
- **On-demand** — phrases like "мой скор", "как я справляюсь", "обзор недели" trigger an immediate scoring run.
- **Morning briefing** — when last score ≤ 5, an overload coach block is appended with 1–3 specific calendar events or tasks to postpone/delegate/cancel.

## Data sources

| Source | What is used |
|--------|-------------|
| Google Calendar | Events count past 7 days, today/tomorrow events, free time, back-to-back days |
| Gmail | Inbox volume, unread count, recent subjects |
| Yandex.Disk tasks | Q1/Q2/Q3/Q4 counts, overdue tasks, completion rate |
| Strava | Activities count, distance, active vs rest days |
| Self-reported | Check-in answers (energy, sleep, family time, personal time) |

## Score scale

| Score | Meaning |
|-------|---------|
| 0–3 🔴 | Critical — overload/burnout risk |
| 4–5 🟠 | Strained — things slipping |
| 6–7 🟡 | Okay — holding up |
| 8–9 🟢 | Good — balanced |
| 10 💚 | Thriving |

## Files

- `lib/workload.js` — main module
- `lib/workload-scoring-prompt.md` — scoring system prompt
- `lib/briefing-overload-prompt.md` — overload coach prompt
- History: `/mnt/yadisk-agent/workload-history.json` (last 12 weeks)
