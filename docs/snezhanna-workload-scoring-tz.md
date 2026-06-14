# Technical Specification: Workload & Wellbeing Scoring for Snezhanna

## Overview

A new skill for the Snezhanna personal assistant that monitors the user's overall life balance across four domains (work, family, health, personal), synthesizes data from multiple sources, and produces a weekly **wellbeing score** (0–10) with per-domain breakdown, trend tracking, and actionable recommendations.

The feature is intentionally "human" — Snezhanna acts as a caring close friend who happens to have access to all the data, not as a metrics dashboard.

---

## Scoring Model

### Overall Score: 0–10

| Score | Color | Label | Meaning |
|-------|-------|-------|---------|
| 0–3 | 🔴 Red | Critical | Overload or neglect; burnout risk |
| 4–5 | 🟠 Orange | Strained | Things are slipping, attention needed |
| 6–7 | 🟡 Yellow | Okay | Holding up, but limited capacity |
| 8–9 | 🟢 Green | Good | Balanced, some capacity available |
| 10 | 💚 Bright Green | Thriving | Everything flows, capacity for new things |

### Domain Scores (each 0–10, averaged + weighted for overall)

| Domain | Weight | Data Sources |
|--------|--------|--------------|
| Work / Productivity | 30% | Google Calendar (work events), Gmail (volume/urgency), Yandex.Disk project tasks |
| Family / Children | 25% | Google Calendar (family events), self-reported updates |
| Health / Sport | 25% | Strava (activity frequency, volume), self-reported sleep/energy |
| Personal / Hobbies / Rest | 20% | Google Calendar (personal time), self-reported mood/leisure |

> Weights are defaults. Claude uses qualitative judgment — if one domain is in crisis, it can override the aggregate downward.

---

## Data Sources & Collection

### Automatic (no user input required)

| Source | What is extracted |
|--------|-------------------|
| **Google Calendar** | Events count per domain in past 7 days; presence of free time blocks; back-to-back meeting days; family/personal event presence |
| **Gmail** | Approximate email volume; presence of urgent/flagged threads; unanswered threads older than 3 days |
| **Yandex.Disk project tasks** | Task overload signals from `tasks/tasks.json` + `projects/*/tasks.json` — see details below |
| **GitHub Issues** | Open issues assigned to the user — fetched live via `lib/github-issues.js`, counted alongside local tasks |
| **Strava** | Number of activities in past 7 days; total distance/duration; rest days vs. active days |

### Yandex.Disk Tasks — Detail

Tasks are stored as JSON files, managed by `lib/tasks.js` (existing integration). Snezhanna already reads and writes these files.

**File locations:**
- Global tasks: `/mnt/yadisk-agent/tasks/tasks.json`
- Per-project tasks: `/mnt/yadisk-agent/projects/{project_name}/tasks.json`

**Eisenhower Matrix quadrants (existing schema):**
- Q1 — Urgent + Important (do now)
- Q2 — Not urgent + Important (schedule)
- Q3 — Urgent + Not important (delegate)
- Q4 — Not urgent + Not important (eliminate)

**What to extract per task for scoring:**

| Field | Notes |
|-------|-------|
| Status | `"todo"` / `"in_progress"` / `"done"` / `"cancelled"` |
| Quadrant | Derived from `urgent` (bool) × `important` (bool) → Q1/Q2/Q3/Q4 |
| Deadline | `due_date` field (`"YYYY-MM-DD"` or null) |
| Project | `project` field (null = global) |
| Overdue | `due_date` < today AND status is `todo` or `in_progress` |

**Signals used for scoring (Work domain):**

- Count of open Q1 tasks (`urgent:true, important:true`) — high Q1 backlog = fire-fighting mode, significant score penalty
- Count of overdue tasks (due_date in the past, status todo/in_progress) — 3+ overdue = major penalty
- Ratio of `done`/total tasks created or updated in past 7 days — low completion = loss of control
- Open Q3 tasks (`urgent:true, important:false`) still owned by the user — signal that delegation isn't happening
- Open Q4 tasks (`urgent:false, important:false`) — signal of inability to cut non-essential work
- Open GitHub Issues assigned to the user (from `lib/github-issues.js`) — counted alongside local tasks

**For the morning briefing overload block:** when score ≤ 5, Snezhanna picks 1–3 specific tasks by title — preferring Q3 (delegate candidates) and Q4 (cut candidates), plus oldest overdue Q1 if any — and names them with project context: *"This task is Q3 — maybe someone else could take it?"*

### Self-reported (collected via weekly check-in message)

On the weekly trigger, before running analysis, Snezhanna sends a short conversational check-in to the user asking 3–4 quick questions:

1. "How did this week feel overall — did you manage or not?" (1 sentence)
2. "Was there time with family / kids?" (yes/no or brief)
3. "How's sleep and energy?" (brief)
4. "Was there anything personal — hobbies, rest, your own time?" (brief)

> Task status (overdue, volume, priorities) is collected automatically from Yandex.Disk — no need to ask the user about it.

the user can answer all in one message or skip questions. Responses are factored into scoring before analysis.

---

## Scheduling

- **Weekly trigger:** Every Monday at 09:00 Europe/Madrid
- **Flow:**
  1. Send check-in questions to the user
  2. Wait up to 30 minutes for responses (use a timeout handler)
  3. If no response within 30 min: proceed with automated data only, note "no check-in response"
  4. Fetch Google Calendar, Gmail, Strava data
  5. Run scoring analysis via Claude
  6. Send full weekly report to the user
- **On-demand:** the user can trigger analysis any time with commands like "как я справляюсь?", "мой скор", "обзор недели"

---

## Scoring Logic (Claude Prompt)

The scoring is performed by a dedicated Claude call (not inline in conversation) with a structured system prompt. Claude receives:

- Raw data from all sources (calendar events, gmail summary, strava stats)
- the user's self-reported check-in responses (if provided)
- Last week's score history from Yandex.Disk (for trend context)
- Current date and timezone

Claude must return a **structured JSON object**:

```json
{
  "overall_score": 6,
  "domains": {
    "work": { "score": 5, "summary": "Lots of meetings, tasks piling up" },
    "family": { "score": 7, "summary": "Had time with the kids on the weekend" },
    "health": { "score": 8, "summary": "3 workouts, good activity level" },
    "personal": { "score": 4, "summary": "Almost no personal time" }
  },
  "trend": "down",
  "key_risks": ["tasks accumulating without delegation", "no personal time"],
  "suggestions": [
    "Move or delegate Wednesday's meeting — it's non-essential",
    "Block at least 2 hours on Thursday just for yourself"
  ],
  "tone": "concerned"
}
```

`tone` values: `"great"` | `"supportive"` | `"concerned"` | `"urgent"`

---

## Weekly Report Format (Telegram message)

The report is a single Telegram message. Snezhanna writes it in her natural voice — warm, personal, not like a corporate dashboard.

**Structure:**

```
[Emoji + color indicator] Your weekly review, the user

Overall score: [SCORE]/10 [COLOR_EMOJI]

🔵 Work:         [score]/10 — [one-line summary]
👨‍👩‍👦 Family:       [score]/10 — [one-line summary]
💪 Health:       [score]/10 — [one-line summary]
🎯 Personal:     [score]/10 — [one-line summary]

[2–3 sentences of warm personal commentary from Snezhanna, 
 reflecting the data + check-in answers. Tone matches the score.]

[If score ≤ 5: empathetic paragraph + 2–3 specific actionable suggestions]
[If score 6–7: encouragement + 1–2 light suggestions]
[If score ≥ 8: celebratory/positive tone, maybe suggest something new/fun]

[If trend is "down" 2+ weeks in a row: gentle but direct flag]
```

**Tone examples by score range (canonical voice — use as prompt examples verbatim):**

- Score 4–6 (scattered/overloaded): *"Вов, судя по последним дням мне кажется ты что-то в расфокусе. Накопилось много всего. Давай подумаем что можно было бы перенести — как думаешь, что если..."*
- Score 0–3 (burnout/stop): *"Слушай, ну вижу что не закрываешь совсем что-то задачки свои. Не успеваешь мне сообщить или и правда подвыгораешь? Если да, то давай найдем время для отдыха и себя — что если..."*
- Score 7–10 (everything's great): *"Ты — красавчик! 🖤 Всё получается)) И кажется, что можем вместе ещё за что-то интересное взяться — м?"*

These are not templates to fill in — they are the **reference voice**. Claude must write in this register: informal, warm, slightly playful, uses the short nickname form (configured `preferred_name`), short sentences, rhetorical questions, trailing "м?" or "да?" to invite dialogue. Never sounds like a report.

---

## History & Persistence (Yandex.Disk)

### File location
```
/mnt/yadisk-agent/snezhanna/workload-history.json
```

### Schema
```json
{
  "history": [
    {
      "date": "2025-10-06",
      "overall_score": 6,
      "domains": {
        "work": 5,
        "family": 7,
        "health": 8,
        "personal": 4
      },
      "trend": "down",
      "checkin_provided": true,
      "key_risks": ["..."],
      "suggestions": ["..."]
    }
  ]
}
```

- Keep last **12 weeks** of history (rolling window, oldest entry dropped)
- On each weekly run: read file → append new entry → write back
- Yandex.Disk mount may be unavailable: if write fails, log warning but do not block report delivery
- On read failure: proceed without trend context, note "history unavailable" in scoring prompt

---

## On-Demand Commands

the user can trigger analysis or query history via natural language. Snezhanna should recognize intents including (not exhaustive):

| Intent | Example phrases |
|--------|----------------|
| Full weekly analysis | "как я справляюсь?", "мой скор", "обзор недели", "что со мной не так" |
| Domain-specific | "как у меня со здоровьем?", "как дела на работе?" |
| Trend query | "как я в последнее время?", "лучше или хуже стало?" |
| History | "покажи мой скор за прошлые недели" |

On-demand analysis uses same logic as weekly, minus the check-in step (goes straight to data collection + scoring), unless the user naturally provides context in his message — in which case that context is included.

---

## Implementation Notes

### New files
- `lib/workload.js` — main module: scheduling, check-in collection, data aggregation, scoring, report generation
- `lib/workload-scoring-prompt.md` — system prompt for the scoring Claude call (separate for easy tuning)
- `lib/briefing-overload-prompt.md` — prompt for the morning briefing overload block

### Integration points (existing code to reuse)
- `lib/google.js` — Calendar + Gmail data (already exists)
- `lib/strava.js` — weekly activity data (already exists)
- `lib/tasks.js` — read global and per-project tasks from Yandex.Disk JSON (already exists)
- `lib/yadisk.js` — read/write `workload-history.json` on Yandex.Disk (already exists)
- `index.js` — register Monday 09:00 cron job + hook into morning briefing generator

### Scheduling
Use the existing cron/scheduler pattern already present in Snezhanna for morning briefings. Add a Monday 09:00 job for workload check-in trigger.

### Check-in timeout
Use a per-user state flag `awaitingWorkloadCheckin: true` with a timestamp. If next message arrives within 30 minutes and flag is set, treat it as check-in response. Clear flag after processing or timeout.

### Prompt injection protection
The scoring prompt must include the same injection-protection note as other prompts that process external content (Gmail, Calendar). External data is passed as structured fields, not raw text inserted into the instruction portion.

---

## Morning Briefing Integration: Overload Coach

### Trigger Condition

This block is added to the morning briefing **only when the last known weekly score is ≤ 5**. If no weekly score exists yet, skip. If score > 5, briefing runs as normal with no overload commentary.

The last weekly score is read from `workload-history.json` on Yandex.Disk at briefing time. If the file is unavailable, skip the block silently.

### What Snezhanna Does

After the standard briefing content (schedule, weather, tasks), Snezhanna appends an **Overload Coach block**. She looks at today's and tomorrow's calendar events and identifies candidates for:

- **Postponement** — event that is non-critical, has no external hard deadline, or has been rescheduled before
- **Delegation** — event that someone else could handle (detected by: the user is organizer but not the only attendee, or it's a routine/recurring sync)
- **Cancellation** — event with no clear purpose, very short, or a 1:1 with no agenda

She names the specific events by title and time, explains briefly why she thinks each could be moved/delegated/dropped, and asks for a reaction. She does **not** act on Calendar herself.

### Message Structure

```
[Standard briefing content]

---

💛 By the way, the user — based on recent data you're at [SCORE]/10, and it shows.
Looking at your day I see a couple of things that might be possible to drop:

• [Event title], [time] — [reason: "looks like a non-essential meeting", 
  "you're the organizer but Sasha could run it", "no agenda, can wait"]
• [Event title], [time] — [reason]

You don't have to do any of this — just keep it in mind. 
If you want — say the word and I'll help you draft a reschedule or cancellation.
```

### Tone

Informal, close, slightly playful — matches the canonical voice samples defined in the Weekly Report section. She uses "Вов" (not "Вовика"), short sentences, rhetorical questions. She never says "ты не справляешься" — she says things like "мне кажется ты что-то в расфокусе" or "накопилось много всего". At score 0–3 she first asks if he's okay before jumping to suggestions ("и правда подвыгораешь?"). The block always ends with an open invitation, never a directive.

### Follow-up

If the user responds positively (e.g. "да, перенеси ту встречу" / "помоги написать отмену"):
- Snezhanna drafts the cancellation/reschedule message text for him to send manually
- She can suggest a new time slot based on calendar free slots if asked

If the user ignores or dismisses: drop the topic, no follow-up nagging.

### Implementation Notes

- This logic lives in the existing morning briefing handler, not in `workload.js`
- At briefing generation time: load last score from Yandex.Disk → if ≤ 5, fetch today's + tomorrow's events → pass to Claude with overload coach prompt
- Claude returns: list of candidate events with suggested action + reason + tone-appropriate framing
- Separate small prompt file: `snezhanna/briefing-overload-prompt.md`
- Yandex.Disk unavailability: skip block, do not error

---

## Out of Scope (v1)

- Push notifications / reminders mid-week based on score
- Score-based calendar suggestions (auto-blocking time)
- Multi-user scoring (family members)
- Integration with task management tools beyond self-reported tasks
