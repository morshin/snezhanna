# TZ — Strava Integration for Snezhanna

**Version:** 1.0  
**Status:** Ready for implementation  
**Context:** Supplement to the main TZ (`docs/snezhanna-tz.md`)

---

## Scope

Three independent features:

1. **Weekly activity sync** from Strava to Yandex.Disk (`fitness/`)
2. **Comparative analysis** in Sunday digest — current week vs previous + Snezhanna's opinion
3. **Race management** — Vova names a race (title, sport, location, date), Snezhanna creates folder structure in `fitness/races/`

---

## File Structure on Yandex.Disk

```
/mnt/yadisk-agent/fitness/
├── weekly/
│   ├── 2025-W01.json          ← raw Strava API data
│   ├── 2025-W01-summary.md    ← human-readable summary
│   ├── 2025-W02.json
│   ├── 2025-W02-summary.md
│   └── ...
└── races/
    ├── 2025-06-15_ironman-barcelona/
    │   ├── README.md          ← race info
    │   ├── plan.md            ← training plan
    │   ├── gear.md            ← gear checklist
    │   └── result.md          ← post-race result
    └── ...
```

---

## 1. Weekly Activity Sync

### Schedule

Every Sunday at **09:30 Madrid** (30 min before the 10:00 digest).

Add to `schedules/heartbeats.json`:
```json
{
  "id": "strava_sync",
  "name": "Strava Sync",
  "cron": "30 9 * * 0",
  "description": "Fetch last 7 days of activities from Strava, save to Yandex.Disk"
}
```

### Data Format

Strava API endpoint: `GET /athlete/activities?after=&before=`

Saved JSON (`weekly/YYYY-Www.json`):
```json
{
  "week": "2025-W23",
  "period": { "from": "2025-06-02", "to": "2025-06-08" },
  "fetched_at": "2025-06-08T09:30:00Z",
  "activities": [
    {
      "id": 12345678,
      "name": "Morning Run",
      "type": "Run",
      "start_date_local": "2025-06-03T07:15:00",
      "distance": 10230,
      "moving_time": 3120,
      "elapsed_time": 3300,
      "total_elevation_gain": 45,
      "average_heartrate": 148,
      "max_heartrate": 172,
      "suffer_score": 42,
      "average_speed": 3.279,
      "average_cadence": 178
    }
  ],
  "totals": {
    "activities_count": 4,
    "distance_m": 42300,
    "moving_time_s": 14400,
    "elevation_gain_m": 210,
    "by_sport": {
      "Run": { "count": 3, "distance_m": 32300 },
      "Ride": { "count": 1, "distance_m": 10000 }
    }
  }
}
```

---

## 2. Comparative Analysis in Sunday Digest

### Logic

Sunday digest (10:00) reads two files:
- `fitness/weekly/YYYY-Www.json` — current week (just synced at 09:30)
- `fitness/weekly/YYYY-W(w-1).json` — previous week

If previous week data is missing — digest runs without comparison.

### Metrics

| Metric | Unit |
|--------|------|
| Number of activities | count |
| Total volume | km |
| Total time | h / min |
| Elevation gain | m |
| Avg suffer_score | — |
| Breakdown by sport | — |

### Claude Prompt (injected into Sunday digest)

```
Analyze Vova's fitness for the week.

Current week (${currentWeek}):
${JSON.stringify(currentData.totals, null, 2)}
Activities: ${activitiesSummary}

Previous week (${prevWeek}):
${JSON.stringify(prevData.totals, null, 2)}

Provide:
1. Volume and activity count vs previous week — in % and absolute numbers
2. Changes by sport
3. Your honest opinion: was it a productive week, any red flags
   (very few sessions, sharp load spike, or solid consistency)
4. One concrete recommendation for next week

Be direct, speak like a coach. 3-5 sentences, no fluff.
Note: respond in Russian as always.
```

---

## 3. Race Management

### Trigger Phrases

- "Add a race — Ironman Barcelona, triathlon, June 15 2025, Barcelona"
- "Log a race: Madrid Marathon, running, September 21 2025"
- "Создай старт Valencia Half, триатлон, Валенсия, 22 октября" (Russian also works)

### Created Structure

Folder: `fitness/races/YYYY-MM-DD_slug-name/`  
`slug-name` = kebab-case of the race title (lowercase, spaces → dashes, special chars removed).

Four files:

**README.md** — filled immediately:
```markdown
# {Race Name}

| | |
|---|---|
| **Sport** | {sport} |
| **Date** | {date} |
| **Location** | {location} |
| **Status** | 🎯 Planned |
| **Created** | {creation date} |

## Description


## Links

- [ ] Official website
- [ ] Results page

## Notes

```

**plan.md** — template:
```markdown
# Training Plan — {Race Name}

## Goal


## Key Training Blocks

| Week | Focus | Volume |
|------|-------|--------|
| | | |

## Checkpoints

## Peak Load (X weeks before race)

```

**gear.md** — template:
```markdown
# Gear — {Race Name}

## Mandatory Checklist

- [ ]
- [ ]

## Nutrition & Hydration

## Transition Bag

```

**result.md** — empty until race day:
```markdown
# Result — {Race Name}

_Fill in after finishing_

## Finish Time

## Splits

## How It Felt

## What to Improve

```

### Confirmation to Vova (in Russian)

```
🏁 Старт добавлен!

Ironman Barcelona
📅 15 июня 2025 · Барселона · Триатлон

fitness/races/2025-06-15_ironman-barcelona/
├── README.md ✅
├── plan.md ✅
├── gear.md ✅
└── result.md ✅

Скажи когда будешь готов заполнить план подготовки.
```

---

## Strava OAuth 2.0 Setup (one-time manual step)

### Environment Variables

Add to `.env`:
```
STRAVA_CLIENT_ID=
STRAVA_CLIENT_SECRET=
STRAVA_REFRESH_TOKEN=
```

### Getting Tokens

1. Create app at [strava.com/settings/api](https://www.strava.com/settings/api)
   - Callback URL: `http://localhost`
   - Required scope: `activity:read_all`

2. Open authorization URL in browser:
   ```
   https://www.strava.com/oauth/authorize?client_id={CLIENT_ID}&response_type=code&redirect_uri=http://localhost&approval_prompt=force&scope=activity:read_all
   ```

3. After authorizing, copy the `code` param from the redirect URL

4. Exchange for tokens:
   ```bash
   curl -X POST https://www.strava.com/oauth/token \
     -d client_id=CLIENT_ID \
     -d client_secret=CLIENT_SECRET \
     -d code=CODE_FROM_STEP_3 \
     -d grant_type=authorization_code
   ```

5. Copy `refresh_token` from the response into `.env` — it never expires

### Token Refresh Logic

Before each API call, exchange `refresh_token` for a fresh `access_token` (TTL 6h). Cache in memory with `expires_at` check:

```javascript
// lib/strava.js
let _cachedToken = null;
let _tokenExpiresAt = 0;

async function getAccessToken() {
  if (_cachedToken && Date.now() / 1000 < _tokenExpiresAt - 300) {
    return _cachedToken;
  }
  const res = await fetch('https://www.strava.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: process.env.STRAVA_CLIENT_ID,
      client_secret: process.env.STRAVA_CLIENT_SECRET,
      refresh_token: process.env.STRAVA_REFRESH_TOKEN,
      grant_type: 'refresh_token'
    })
  });
  const data = await res.json();
  _cachedToken = data.access_token;
  _tokenExpiresAt = data.expires_at;
  return _cachedToken;
}
```

---

## New Modules

### `lib/strava.js`

```
getAccessToken()            — refresh → access_token (cached)
getActivities(from, to)     — GET /athlete/activities?after=&before=
calcWeekTotals(activities)  — aggregate by sport { activities_count, distance_m, moving_time_s, elevation_gain_m, by_sport }
saveWeekData(week, ...)     — write YYYY-Www.json + YYYY-Www-summary.md to Yandex.Disk
loadWeekData(week)          — read YYYY-Www.json, return null if not found
getISOWeekString(date)      — return "2025-W23"
syncCurrentWeek()           — fetch → calc → save → return { weekStr, activities, totals }
```

No new npm packages. Uses built-in `fetch` (Node 18+).

### `lib/races.js`

```
createRace({ name, sport, date, location })
  — derive folder slug from name
  — create fitness/races/YYYY-MM-DD_slug/ with four template files
  — return { path, files[] }
```

---

## Changes to Existing Files

| File | Change |
|------|--------|
| `index.js` | Add strava_sync cron (09:30 Sun), update Sunday digest prompt with fitness block, add `create_race` tool |
| `lib/yadisk-dirs.js` | Add `fitness/races` and `fitness/weekly` to REQUIRED_DIRS |
| `identity/IDENTITY.md` | Add Strava sync and race management to capabilities |
| `schedules/heartbeats.json` | Add strava_sync entry |
| `.env.example` | Add STRAVA_CLIENT_ID, STRAVA_CLIENT_SECRET, STRAVA_REFRESH_TOKEN |

New files: `lib/strava.js`, `lib/races.js`, `skills/strava.md`

---

## Error Handling

| Situation | Behavior |
|-----------|----------|
| Strava API unreachable | Log error, digest runs without fitness section |
| No previous week file | Show current week only, skip comparison |
| `STRAVA_REFRESH_TOKEN` not set | Warn in startup log, Strava features silently disabled |
| Yandex.Disk write error | Log, do not interrupt digest |

---

## Out of Scope

- Writing activities to Strava (write API)
- Charts and visualization
- Integration with TrainingPeaks or similar
- Per-workout push notifications
