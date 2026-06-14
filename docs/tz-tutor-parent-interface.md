# TZ: Max — Parent Interface

**Feature set:** Parent notifications · Parent commands (`/report`, `/assign`) · Quest system · Prize code pool

**Scope:** Changes to `tutor/index.js`, `tutor/lib/storage.js`, `tutor/identity/IDENTITY.md`, `.env`. Plus one-time code generator script.  
**No new npm packages.**

## How the reward system works (overview)

1. Parent generates 100 prize codes via a local script → gets two files:
   - `prize_DDMMYYYY.txt` — import into Time Boss Cloud (one code per line, format `WORD*30*0*0*0*0`)
   - `kids/codes_DDMMYYYY.md` — uploaded to Yandex Disk, read by Max
2. Parent imports `.txt` into TBC once manually
3. When son completes a quest → Max picks the next unused code from the `.md` file, sends it to the son in chat, marks it used
4. Son enters the code himself in Time Boss interface → gets +30 min
5. When codes run low (≤10 remaining) → Max warns parent in Telegram

---

## 1. Environment

Add to `/opt/snezhanna/.env`:

```
PARENT_CHAT_ID=          # Vova's numeric Telegram ID (same value as TELEGRAM_ALLOWED_USER_ID in Snezhanna)
```

`PARENT_CHAT_ID` uses the **same** bot token as Max (`TUTOR_BOT_TOKEN`) — Vova gets notified via Max's bot, not Snezhanna.

---

## 2. Access control

Two actor types in Max's bot:

| Actor | Identified by | What they can do |
|-------|--------------|-----------------|
| Student (son) | `TUTOR_ALLOWED_USER_ID` | Chat, /done, /schedule, /homework, /reset, /status |
| Parent (Vova) | `PARENT_CHAT_ID` | /report, /week, /homework, /assign, /quest, /quests |

If `msg.from.id == PARENT_CHAT_ID` → route to parent handler, skip student flow entirely.  
Parent messages are never forwarded to Claude's tutoring session — they go to a separate handler.

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

### 3.2 Prize code pool — `/mnt/yadisk-agent/kids/codes_DDMMYYYY.md`

One file per generation batch, named with the date (e.g. `codes_28032026.md`).  
Max searches for the **most recently dated** `codes_*.md` file at startup and after each code use.

```markdown
# Prize Codes — 28.03.2026

| Code | Used | Used At | Quest |
|------|------|---------|-------|
| 125374ЩЕКА | false | | |
| 123474ЩУКА | false | | |
| 891234ВОЛК | false | | |
...
```

**Fields:**
- `Code` — the prize word (everything before `*` in the TB format)
- `Used` — `false` / `true`
- `Used At` — ISO date when issued to son
- `Quest` — quest description it was issued for (for audit trail)

Max marks a row as used by rewriting the file. Simple line-by-line parsing — no JSON needed.

### 3.3 Storage functions to add in `tutor/lib/storage.js`

```
findLatestCodesFile()          → full path to most recent codes_*.md | null
loadCodes(filePath)            → [{ code, used, usedAt, quest }]
saveCodes(filePath, codes)     → rewrites the .md file
getNextCode(filePath)          → { code, filePath } | null  (first unused)
markCodeUsed(filePath, code, questDescription)
countRemainingCodes(filePath)  → number
```

**Low-code warning threshold:** when `countRemainingCodes() <= 10` after marking a code used → send parent notification (see section 5.3).

---

## 4. Parent commands

Handled when `msg.from.id == PARENT_CHAT_ID`. Max responds in **Russian** to parent.

### `/report` — today's summary

Reads `kids/sessions/YYYY-MM-DD.md` for today (Madrid date). If file is missing → "No sessions today."  
Sends the file content as-is (it's already formatted markdown).

### `/week` — weekly digest

Reads `kids/weekly/YYYY-Wxx.md` for current ISO week. If missing → "Digest not yet generated."

### `/homework` — pending tasks (parent view)

Same as student `/homework` but in Russian. Shows subject, description, due date.

### `/codes` — current code pool status

Shows which `codes_*.md` file is active and how many codes remain.  
Format:
```
📦 Prize time codes

File: codes_28032026.md
Remaining: 47 of 100
```

### `/gencodes [N]` — generate new prize code batch

Generates N codes (default 100, max 500). Example: `/gencodes` or `/gencodes 150`

Steps:
1. Load all previously used/generated codes from all `codes_*.md` files in `KIDS_DIR` → build a Set of known codes (uniqueness guarantee across all batches)
2. Generate N unique 10-character alphanumeric codes (uppercase letters A-Z + digits 0-9, no special symbols) that are NOT in the known set
3. Write `codes_DDMMYYYY.md` to `KIDS_DIR` (new active pool)
4. Build `prize_DDMMYYYY.txt` in TBC format (`CODE*30*0*0*0*0` per line) as a Buffer
5. Send the `.txt` file to parent via `bot.sendDocument()` with caption: "Import this file into Time Boss Cloud. Codes are already saved in Max."

Parent downloads the file from Telegram → imports into TBC manually. Done.

Response after sending the file:
```
✅ Generated 100 codes

File prize_28032026.txt — upload to Time Boss Cloud
Codes saved in kids/codes_28032026.md
Previous files checked: 3 (total known codes: 287)
```

### `/quests` — list active quests

Lists all quests with `status: "active"`. Format:

```
📋 Active quests:

1. Inglés — Present Perfect (unit test p.45-47)
   Reward: +30 min | ID: quest_1747000000000

2. Matemáticas — Chapter 5: equations
   Reward: +20 min | ID: quest_1747000000001
```

### `/assign <subject>: <description>`

Creates a homework task (no reward). Example:  
`/assign Lengua: read paragraph 12 and write a brief summary`

Saves to `homework.json` via `addHomeworkTask()`.  
Response: "✅ Task added. Max will pass it to the son at the next session."

### `/quest <subject> "<description>" +<minutes>мин`

Creates a quest with time reward. Example:  
`/quest Inglés "Present Perfect — упражнения стр.45-47" +30мин`

Parsing: extract subject (before `"`), description (between `""`), minutes (after `+`, before `мин`).  
Saves to `quests.json` via `addQuest()`.  
Response:

```
🎯 Quest created!

Inglés: Present Perfect — exercises p.45-47
Reward: +30 min

Max will tell the son about the quest at the next session.
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
📚 Session ended

👦 Subject: Matemáticas
⏱ Duration: 42 min
😊 Mood: energetic, figured it out himself

✅ Done: fracciones — 4/5 examples correct
⚠️ Difficulties: got confused with the order of fraction subtraction

📝 Homework: 1 task closed
```

If no session today → not sent.

### 5.2 Quest completed + prize code issued

Triggered when Max marks a quest done (see section 6). Max picks the next unused code, then sends two messages.

**To son** (in chat, in Spanish — Max sends this as part of his regular reply):
```
🏆 ¡Misión completada!

Inglés: Present Perfect — ejercicios p.45-47
¡Has ganado 30 minutos extra de ordenador!

Tu código premio: **125374ЩЕКА**
Introdúcelo en Time Boss para activar tu tiempo 🎮
```

**To parent** (Telegram, in Russian, separate `bot.sendMessage`):
```
🏆 Quest completed!

Inglés: Present Perfect — exercises p.45-47
Code issued to son: 125374ЩЕКА (+30 min)
Codes remaining: 47
```

If no codes left → do NOT send code to son. Instead send to son: "¡Misión completada! Papá te dará tu premio pronto 🎁" and to parent: "🏆 Quest completed, but the codes are all used up! Upload a new batch to Time Boss Cloud."

### 5.3 Low codes warning

Sent to parent **additionally** right after section 5.2 notification, when `countRemainingCodes() <= 10`:

```
⚠️ Prize time codes are running low

Remaining: 8 codes
Time to generate a new batch and upload to Time Boss Cloud.
```

### 5.4 Flag: subject avoidance (weekly)

Sent as part of Sunday 18:00 weekly digest generation, if detected.  
Condition: same subject appears in "Where he got stuck" or is absent from sessions for 5+ consecutive school days.

```
⚠️ Note

The son hasn't worked on Inglés for 5 days — he may be avoiding it.
Last recorded: March 14.
```

### 5.4 Flag: stuck on topic (session-level)

Triggered when report generation detects the same topic in "Where he got stuck" for 2+ sessions.  
Sent immediately after post-session summary.

```
💡 Heads-up

The son got stuck on fracciones for the second session in a row.
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
1. `storage.completeQuest(questId)` → returns `{ quest }`
2. `const codesFile = storage.findLatestCodesFile()`
3. `const next = storage.getNextCode(codesFile)` → `{ code }` or `null`
4. If code exists: `storage.markCodeUsed(codesFile, code, quest.description)`
5. Send prize to son (in Spanish, appended to Claude's reply) + notification to parent (section 5.2)
6. If `storage.countRemainingCodes(codesFile) <= 10` → send low-codes warning to parent (section 5.3)

---

## 7. `/assign` → session injection

Assigned tasks (added via `/assign`) are visible to Max during sessions via the existing `pending homework` context already injected in `askMax()`.

No additional change needed — `/assign` writes to `homework.json`, Max already sees pending homework.

The difference vs. quest: `/assign` has no reward, no `[QUEST_DONE]` marker needed. Max treats it as regular homework.

---

## 8. Scheduled tasks — no changes

Existing schedules are sufficient. Parent notifications are event-driven (session end, quest completion) not cron-based, except for the flag checks which piggyback on the Sunday 18:00 weekly digest generation.

---

## 9. Code generation internals

Generation logic lives in `tutor/lib/storage.js` (no separate script needed).

**Code format:** 10 characters, uppercase A-Z + digits 0-9, no symbols. Examples: `A3FX92BNQT`, `7ZKMPW04LR`.  
Time Boss accepts any alphanumeric string as a prize code — no specific format required beyond no special characters.

**Uniqueness guarantee:**  
`generateUniqueCodes(n)` — loads all codes from ALL `codes_*.md` files in `KIDS_DIR` into a Set, then generates new codes in a loop until N unique ones are found that are not in the Set. Collision probability at 10^14 space and 500 codes is negligible, but the check is cheap.

**`prize_DDMMYYYY.txt` format** (TBC import format):
```
A3FX92BNQT*30*0*0*0*0
7ZKMPW04LR*30*0*0*0*0
```

The `.txt` file is built as a `Buffer` in memory and sent directly via `bot.sendDocument()` — never written to disk on the server.

**`codes_DDMMYYYY.md`** is written to `KIDS_DIR` and becomes the new active pool immediately.



## 10. Implementation notes

**Parsing `/quest` command:**  
Regex: `/^\/quest\s+(\S+)\s+"([^"]+)"\s+\+(\d+)мин$/i`  
On parse fail → `Format: /quest Inglés "task description" +30мин`

**Parsing `/gencodes` command:**  
Regex: `/^\/gencodes(?:\s+(\d+))?$/`. Extract optional N, clamp to range [1, 500], default 100.

**codes_*.md parsing:**  
Read line by line, skip header rows (`#`, `|---`, `| Code`). Split each data row by `|`, trim fields. `Used` field: string `"true"`/`"false"`. Rewrite whole file on update.

**findLatestCodesFile():**  
List `KIDS_DIR` files matching `codes_*.md`, parse `DDMMYYYY` from filename → sort descending → return first path.

**bot.sendDocument() for prize file:**  
```js
await bot.sendDocument(PARENT_CHAT_ID, Buffer.from(txtContent, 'utf8'), {
  caption: 'Import this file into Time Boss Cloud...'
}, {
  filename: `prize_${dateStr}.txt`,
  contentType: 'text/plain'
});
```

**Parent chat startup message:**  
Send once on startup (same 4-hour cooldown):  
`"👋 Max is running. Send /report, /quests, /gencodes, or /assign to interact."`

**Error resilience:**  
`PARENT_CHAT_ID` not set → skip all parent notifications silently.  
No codes file / no codes left → fallback message to son + alert to parent (section 5.2).

---

## 11. Files changed

| File | Change |
|------|--------|
| `.env` | Add `PARENT_CHAT_ID` |
| `tutor/lib/storage.js` | Add quest functions + codes functions incl. `generateUniqueCodes()` |
| `tutor/lib/claude.js` | Inject active quests into system context |
| `tutor/index.js` | Parent command router incl. `/gencodes`, quest marker extraction, code issuance, notifications |
| `tutor/identity/IDENTITY.md` | Add quest awareness section |

---

## 12. Claude Code prompt

```
Read /opt/snezhanna/docs/tz-tutor-parent-interface.md for the full spec.
Read /opt/snezhanna/tutor/index.js, tutor/lib/storage.js, tutor/lib/claude.js, tutor/identity/IDENTITY.md.

Implement the Max Parent Interface feature as described in the TZ:

1. storage.js — add:
   - Quest functions: loadQuests, saveQuests, addQuest, completeQuest, cancelQuest, getActiveQuests
   - Codes functions: findLatestCodesFile, loadCodes, saveCodes, getNextCode, markCodeUsed,
     countRemainingCodes, generateUniqueCodes(n)
   - generateUniqueCodes: scans ALL codes_*.md files in KIDS_DIR to build known-codes Set,
     generates N unique 10-char alphanumeric codes (A-Z + 0-9, uppercase), returns array of strings
   - writePrizeFiles(codes, dateStr): writes codes_DDMMYYYY.md to KIDS_DIR,
     returns prize txt content as a string (not written to disk)

2. claude.js — inject active quests into system context before conversation history.

3. identity/IDENTITY.md — append quest awareness section (see TZ section 6.1).

4. index.js:
   a. isParent(msg): msg.from.id == process.env.PARENT_CHAT_ID
   b. handleParentCommand(msg, text) for:
      /report, /week, /homework, /codes, /gencodes, /quests, /assign, /quest, /cancelquest
      - /gencodes [N]: generate codes, send prize_*.txt via bot.sendDocument() as Buffer,
        confirm with stats message
   c. Route parent messages before student flow
   d. extractQuestDoneMarkers(text): extract [QUEST_DONE:id], return cleanText + questIds
   e. After each Claude reply: run extractQuestDoneMarkers; for each completed quest:
      pick next code, mark used, append prize message to son's reply,
      send parent notification; if remaining <= 10 → send low-codes warning
   f. Post-session summary to PARENT_CHAT_ID after session end
   g. Startup message to PARENT_CHAT_ID (4hr cooldown)
   h. Flag detection in weekly digest: subject absent 5+ school days → notify parent

No new npm packages.
Restart: sudo systemctl restart tutor
```

---

## 13. Data flow summary

```
Vova (when codes running low)
  |
  |-- /gencodes 100
  |     Max scans all codes_*.md → builds known-codes Set
  |     generates 100 unique alphanumeric codes
  |     writes codes_28032026.md → /mnt/yadisk-agent/kids/
  |     sends prize_28032026.txt → Telegram (bot.sendDocument)
  |
  Vova downloads file → imports into Time Boss Cloud (manual, 1 min)
  |
Vova                    Max (tutor bot)              Son
  |                           |                        |
  |-- /quest Inglés +30 --> quests.json                |
  |                           |                        |
  |                           |<-- session starts -----+
  |                           | (quest in Claude context)
  |                           |-- "¡Misión de papá! 🎯" -->
  |                           |                        |
  |                           |<-- completes quest ----+
  |                     [QUEST_DONE:id]
  |                     getNextCode() → A3FX92BNQT
  |                     markCodeUsed() → codes_28032026.md updated
  |                           |
  |                           +-- "Tu código: A3FX92BNQT 🎮" --> son enters in Time Boss → +30 min
  |<-- 🏆 Code: A3FX92BNQT --+
  |    Remaining: 47          |
  |<-- 📚 Session ended ------+
```
