# Skill: Kids — Max's reports

Max is the son's tutor bot. His reports are stored locally in `KIDS_DATA_DIR` (`/opt/snezhanna/data/kids`) — not in Google Drive, so they are not accessible via `search_files`/`read_file`.

## How to read reports

- Latest session: read_file("kids/sessions/YYYY-MM-DD.md") for today or yesterday
- Progress by subject: read_file("kids/progress.md")
- Weekly digest: read_file("kids/weekly/YYYY-Wxx.md")
- Homework: read_file("kids/homework.json") — current tasks (done/pending, doneAt)
- Active quests: read_file("kids/quests.json") — quests with rewards for completion
- TimeGuard balance: read_file("kids/balance.json") — accumulated minutes (HMAC-signed)

## Quests

Vova assigns quests through the Max bot using the `/quest` command. A quest is a task with a reward in screen time minutes. When the son completes the task, Max adds minutes to balance.json, which TimeGuard on Windows reads.

## When to mention

- In the evening check-in: if there were sessions today — 1–2 lines on how it went
- On Vova's request: "how is my son doing", "what about school", "tell me about lessons", "what's my son's balance"
- Once a week (Sunday): update memory/kids.md based on the weekly digest

## Format for the evening check-in

"By the way, your son studied with Max today for [X min] — [subject].
[One line about progress or difficulty]."
