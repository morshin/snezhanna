# TZ: Max — Parent Interface

**Feature set:** Parent notifications · Parent commands (`/report`, `/assign`) · Quest system · TimeGuard balance file

**Scope:** Changes to `tutor/index.js`, `tutor/lib/storage.js`, `tutor/identity/IDENTITY.md`, `.env`.  
**No new npm packages.** No changes to Snezhanna or TimeGuard in this TZ (TimeGuard reads balance file as-is).

---

## 1. Environment

Add to `/opt/snezhanna/.env`:

```
PARENT_CHAT_ID=          # the user's numeric Telegram ID (same value as TELEGRAM_ALLOWED_USER_ID in Snezhanna)
QUEST_HMAC_SECRET=       # random 32-char string, shared with TimeGuard later
```

`PARENT_CHAT_ID` uses the **same** bot token as Max (`TUTOR_BOT_TOKEN`) — the user gets notified via Max's bot, not Snezhanna.

---

## 2. Access control

Two actor types in Max's bot:

| Actor | Identified by | What they can do |
|-------|--------------|-----------------|
| Student (son) | `TUTOR_ALLOWED_USER_ID` | Chat, /done, /schedule, /homework, /reset, /status |
| Parent (the user) | `PARENT_CHAT_ID` | /report, /week, /homework, /assign (text or photo), /quest, /quests, /setday, /resetschedule, /schedule, /balance, /codes, /gencodes |

If `msg.from.id == PARENT_CHAT_ID` → route to parent handler, skip student flow entirely.  
Parent messages are never forwarded to Claude's tutoring session — they go to a separate handler.  
Parent photos are routed to homework recognition (Claude vision) before the student photo handler.

**Note:** reply context (`msg.reply_to_message`) is supported for student messages via shared `lib/reply-chain.js`. Parent commands are routed before the student flow and do not use reply context since they are handled as discrete commands, not conversational turns with Claude.

---

## 3. Data storage additions

### 3.1 Quests — `/mnt/yadisk-agent/kids/quests.json`

```json
{
  "quests": [
    {
      "id": "quest_1747000000000",
      "subject": "Inglés",
      "description": "Present Perfect — unit test exercises p.45-47",
      "reward_minutes": 30,
      "status": "active",       // active | done | cancelled
      "created": "2025-03-19",
      "done_at": null,
      "done_session": null       // session date when completed
    }
  ]
}
```

### 3.2 Balance — `/mnt/yadisk-agent/kids/balance.json`

Signed file read by TimeGuard. Updated by Max when a quest is completed.

```json
{
  "balance_minutes": 90,
  "last_updated": "2025-03-19T18:30:00.000Z",
  "hmac": "sha256hex..."
}
```

HMAC is computed over the string `"${balance_minutes}|${last_updated}"` using `QUEST_HMAC_SECRET`.  
TimeGuard verifies this HMAC before trusting the balance. If HMAC is invalid → TimeGuard ignores the file.

### 3.3 Storage functions to add in `tutor/lib/storage.js`

```
loadQuests()                  → { quests: [] }
saveQuests(data)
addQuest({ subject, description, reward_minutes })  → id
completeQuest(id)             → { quest, balance_minutes_added }
cancelQuest(id)
getActiveQuests()             → quest[]

loadBalance()                 → { balance_minutes, last_updated, hmac } | { balance_minutes: 0 }
saveBalance(balance_minutes)  → writes file + recomputes HMAC
addBalance(minutes)           → loadBalance → balance + minutes → saveBalance
```

---

## 4. Parent commands

Handled when `msg.from.id == PARENT_CHAT_ID`. Max responds in **Russian** to parent.

### `/report` — today's summary

Reads `kids/sessions/YYYY-MM-DD.md` for today (Madrid date). If file is missing → "No sessions today."  
Sends the file content as-is (it's already formatted markdown).

### `/week` — weekly digest

Reads `kids/weekly/YYYY-Wxx.md` for current ISO week. If missing → "Digest not generated yet."

### `/homework` — pending tasks (parent view)

Same as student `/homework` but in Russian. Shows subject, description, due date.

### `/balance` — current TimeGuard balance

Shows `balance_minutes` from `balance.json`. Format: "Balance: 1h 20min (80 min)."

### `/quests` — list active quests

Lists all quests with `status: "active"`. Format:

```
📋 Active quests:

1. Inglés — Present Perfect (unit test p.45-47)
   Reward: +30 min | ID: quest_1747000000000

2. Matemáticas — Chapter 5: equations
   Reward: +20 min | ID: quest_1747000000001
```

### `/setday <day> <subjects>`

Updates schedule for a single day. Day names accepted in Russian (`пн`, `вт`, `ср`, `чт`, `пт`) or Spanish (`lunes`–`viernes`).  
Subjects are comma-separated; parsed through Claude to normalize to Spanish with correct capitalization.  
Use `—` or `выходной` to mark as free day.

Examples:  
- `/setday ср Математика, Английский, Физкультура`  
- `/setday viernes —`

Response: "✅ Wed: Matemáticas, Inglés, Educación Física"

### `/resetschedule`

Full guided schedule reset — 5-step dialog (one day at a time, Mon–Fri).  
State stored in `parentScheduleDraft` variable, same pattern as `/quest` dialog.  
After all 5 days entered: `storage.saveSchedule()`.

### `/assign <subject>: <description>` or `/assign <free text>`

Creates a homework task (no reward).

**Strict format** (with colon): `/assign Lengua: read paragraph 12` — subject and description parsed directly, saved immediately.

**Free-form** (no colon): `/assign submit history essay tomorrow` — Claude parses the text into concrete action items with subject, description, due date, and clarifying comments (e.g. "page not specified", "deadline unclear"). Bot shows a preview and waits for parent confirmation. Parent can confirm, correct (Claude re-parses with corrections), or cancel.

**Photo**: Parent can also send a photo of homework — Claude vision recognizes tasks with the same confirmation flow. Optional caption provides additional context.

State is stored in `parentAssignDraft` variable (cancelled by any `/` command).  
Saves to `homework.json` via `addHomeworkTask()` only after confirmation.

### `/delhw <id> [id2 ...]`

Deletes one or more homework tasks by ID. IDs are shown in `/homework` output.  
Supports multiple space-separated IDs for batch deletion.  
Response: list of deleted tasks, or "not found" for unknown IDs.

### `/quest <subject> "<description>" +<minutes>мин`

Creates a quest with time reward. Example:  
`/quest Inglés "Present Perfect — exercises p.45-47" +30мин`

Parsing: extract subject (before `"`), description (between `""`), minutes (after `+`, before `мин`).  
Saves to `quests.json` via `addQuest()`.  
Response:

```
🎯 Quest created!

Inglés: Present Perfect — exercises p.45-47
Reward: +30 min

Max will tell your son about the quest at the next session.
```

### `/cancelquest <id>`

Sets quest status to `cancelled`. Does not affect balance.  
Response: "Quest cancelled."

---

## 5. Parent notifications (proactive pushes)

All notifications sent via `bot.sendMessage(PARENT_CHAT_ID, text)`. In Russian.

### 5.1 Post-session summary (after every session end)

Triggered when: student sends `/done`, or session auto-closes after 30 min idle, or evening summary cron runs.

Sent immediately after session report is written. Content (generated by the same Claude call that writes the session report, as an extra field):

```
📚 Session complete

👦 Subject: Matemáticas
⏱ Duration: 42 min
😊 Mood: energetic, worked through the solution independently

✅ Done: fracciones — 4/5 examples correct
⚠️ Difficulties: confused about the order of fraction subtraction

📝 Homework: 1 task closed
```

If no session today → not sent.

### 5.2 Quest completed notification

Triggered when Max marks a quest done (see section 6).

```
🏆 Quest completed!

Inglés: Present Perfect — exercises p.45-47
Reward: +30 min added to balance
Balance now: 1h 50min
```

### 5.3 Flag: subject avoidance (weekly)

Sent as part of Sunday 18:00 weekly digest generation, if detected.  
Condition: same subject appears in "Stuck on" or is absent from sessions for 5+ consecutive school days.

```
⚠️ Heads up

Your son hasn't worked on Inglés for 5 days — he may be avoiding it.
Last entry: March 14.
```

### 5.4 Flag: stuck on topic (session-level)

Triggered when report generation detects the same topic in "Stuck on" for 2+ sessions.  
Sent immediately after post-session summary.

```
💡 Tip

Your son got stuck on fracciones for the second session in a row. 
It might be worth explaining the topic differently or finding additional material.
```

---

## 6. Quest integration in Max's tutoring sessions

### 6.1 Quest awareness in IDENTITY.md

Add section to `tutor/identity/IDENTITY.md`:

```
## Quests (Missions from Dad)

At the start of each session, you have access to the list of active quests in the system context.
- If there are active quests relevant to the current subject → mention them naturally and with energy:
  "¡Oye! Papá ha puesto una misión especial para ti en Inglés — si terminas los ejercicios de Present Perfect, ¡ganas 30 minutos extra de ordenador! ¿Aceptamos el reto? 🎯"
- Do NOT mention quests for other subjects during an unrelated session.
- When the student completes the work described in a quest (judge by topic + completion), append to your response:
  [QUEST_DONE:quest_id]
- Use this marker only when you are confident the quest objective was met. Do not use it prematurely.
- Never reveal the quest ID to the student. The marker is silent system metadata.
```

### 6.2 Quest injection into Claude context

In `tutor/lib/claude.js`, before building the messages array, load active quests:

```js
const activeQuests = storage.getActiveQuests();
const questContext = activeQuests.length > 0
  ? `\n\n[Sistema: misiones activas del padre]\n${activeQuests.map(q =>
      `ID:${q.id} | ${q.subject}: ${q.description} (+${q.reward_minutes} min)`
    ).join('\n')}`
  : '';
```

Append `questContext` to the system prompt (after identity, before conversation history).

### 6.3 QUEST_DONE marker extraction

In `tutor/index.js`, after receiving Claude's reply, extract quest markers (similar to existing `[DONE:id]` homework logic):

```js
function extractQuestDoneMarkers(text) {
  const pattern = /\[QUEST_DONE:([^\]]+)\]/g;
  const ids = [];
  let match;
  while ((match = pattern.exec(text)) !== null) ids.push(match[1]);
  const cleanText = text.replace(pattern, '').trim();
  return { cleanText, questIds: ids };
}
```

For each `questId`:
1. `storage.completeQuest(questId)` → returns `{ quest, balance_minutes_added }`
2. `storage.addBalance(quest.reward_minutes)`
3. Send parent notification (section 5.2)

---

## 7. `/assign` → session injection

Assigned tasks (added via `/assign`) are visible to Max during sessions via the existing `pending homework` context already injected in `askMax()`.

No additional change needed — `/assign` writes to `homework.json`, Max already sees pending homework.

The difference vs. quest: `/assign` has no reward, no `[QUEST_DONE]` marker needed. Max treats it as regular homework.

---

## 8. Scheduled tasks — no changes

Existing schedules are sufficient. Parent notifications are event-driven (session end, quest completion) not cron-based, except for the flag checks which piggyback on the Sunday 18:00 weekly digest generation.

---

## 9. Implementation notes

**Parsing `/quest` command:**  
Use a simple regex: `/^\/quest\s+(\S+)\s+"([^"]+)"\s+\+(\d+)мин$/i`  
If parse fails → reply with usage hint: `Format: /quest Inglés "task description" +30мин`

**Balance HMAC:**  
Use Node.js built-in `crypto` module (no new dependencies):
```js
const crypto = require('crypto');
function computeHmac(balance_minutes, last_updated) {
  return crypto.createHmac('sha256', process.env.QUEST_HMAC_SECRET)
    .update(`${balance_minutes}|${last_updated}`)
    .digest('hex');
}
```

**Parent chat startup message:**  
On bot startup, if `PARENT_CHAT_ID` is set, send once (with same 4-hour cooldown as student message):  
`"👋 Max is running. Send /report, /quests, or /assign to interact."`

**Error resilience:**  
If `PARENT_CHAT_ID` is not set → skip all parent notifications silently (don't crash).

---

## 10. Files changed

| File | Change |
|------|--------|
| `.env` | Add `PARENT_CHAT_ID`, `QUEST_HMAC_SECRET` |
| `tutor/lib/storage.js` | Add quest + balance functions |
| `tutor/lib/claude.js` | Inject active quests into system context |
| `tutor/index.js` | Parent command router, quest marker extraction, notifications |
| `tutor/identity/IDENTITY.md` | Add quest awareness section |

---

## 11. Claude Code prompt

```
Read /opt/snezhanna/docs/tutor-parent-interface-tz.md for the full spec.
Read /opt/snezhanna/tutor/index.js, tutor/lib/storage.js, tutor/lib/claude.js, tutor/identity/IDENTITY.md.

Implement the Max Parent Interface feature as described in the TZ:

1. storage.js — add quest and balance functions (loadQuests, saveQuests, addQuest, completeQuest,
   cancelQuest, getActiveQuests, loadBalance, saveBalance, addBalance).
   Balance HMAC uses Node.js crypto module (no new deps). QUEST_HMAC_SECRET from process.env.

2. claude.js — inject active quests into system context before conversation history.

3. identity/IDENTITY.md — append quest awareness section (see TZ section 6.1).

4. index.js:
   a. Add isParent(msg) helper: msg.from.id == process.env.PARENT_CHAT_ID
   b. Add handleParentCommand(msg, text) for: /report, /week, /homework, /balance,
      /quests, /assign, /quest, /cancelquest
   c. Route parent messages before student flow in message handler
   d. Add extractQuestDoneMarkers(text) — extract [QUEST_DONE:id], return cleanText + questIds
   e. After each Claude reply: run extractQuestDoneMarkers, complete quests, add balance,
      send parent notification
   f. Post-session summary to PARENT_CHAT_ID after session end (done command + auto-close)
   g. Startup message to PARENT_CHAT_ID (same 4hr cooldown logic as student message)
   h. Flag detection: in weekly digest generation, check for subject avoidance (5+ days absent)
      and notify parent if found

Do not install new npm packages. All changes in existing files only.
Restart: sudo systemctl restart tutor
```

---

## 12. Data flow summary

```
the user                    Max (tutor bot)              Son
  |                           |                        |
  |-- /quest Inglés +30 --> saves quests.json          |
  |                           |                        |
  |                           |<-- session starts -----+
  |                           |   (quest injected into context)
  |                           |-- "¡Misión de papá! 🎯" -->
  |                           |                        |
  |                           |<-- completes quest ----+
  |                           |
  |                     [QUEST_DONE:id]
  |                     completeQuest()
  |                     addBalance(+30)
  |                     → balance.json (HMAC signed)
  |<-- 🏆 Quest completed! --+
  |    Balance: 1h 50min      |
  |                           |
  |<-- 📚 Session complete --+
       (post-session summary)

TimeGuard (Windows)
  reads balance.json → verifies HMAC → adds 30 min
```
