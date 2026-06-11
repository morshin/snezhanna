# Update Documentation

Review all recent changes to the codebase and update all project documentation to reflect them.

## Steps

1. Inspect what changed using **`git diff`** and **`git status`** (working tree + staged). Use `git diff HEAD~1 HEAD` only when you need the last *committed* commit; after a new feature, changes are often still uncommitted, so the working-tree diff is the source of truth.
2. Read the current `CLAUDE.md` to understand what's already documented.

### CLAUDE.md

3. Update `CLAUDE.md`:
   - Add new files to the **Key files** table if any were created.
   - Update the **Architecture** section if the feature changes how the bot works.
   - Update **Required environment variables** if new env vars were added.
   - Update any other sections that became outdated.

### skills/*.md

4. Update `skills/*.md` files if the feature touches Calendar, Gmail, Yandex Disk, Memory, Strava, or Kids capabilities. Create a new skill file if a new capability was added.

### identity/IDENTITY.md

5. Update `identity/IDENTITY.md` if:
   - A new user-facing capability was added (add a bullet to the "Что ты умеешь" section)
   - A capability was removed or changed
   - New important limitations or security rules appeared
   - The schedule changed (briefing times, new recurring tasks)

### docs/snezhanna-tz.md

6. Update `docs/snezhanna-tz.md` if:
   - New integrations or services were added/removed
   - The project structure changed (new files, new directories)
   - New environment variables were added
   - Systemd service files changed
   - Scheduled tasks (cron jobs) were added or changed
   - Zhora watchdog behaviour changed

### schedules/heartbeats.json

7. Update `schedules/heartbeats.json` if any cron job was added, removed, or its timing/description changed.

### lib/skills.js

8. **Always** review `lib/skills.js` after any code change and keep it in sync:
   - If a new tool was added to `lib/tools.js` — add or update the matching group in `GROUPS` (sentinel tool name(s), label, text).
   - If a tool was removed or renamed — update or remove its group.
   - If a new always-on capability was added (voice, photo, briefing, etc.) — add a line to `ALWAYS_ON`.
   - If a group's description became stale — update the `text` field.
   - The goal: `buildSkillsBlock()` must accurately reflect every real capability the bot has at the moment of the change.

### docs/tz-*.md

9. If the change relates to a feature that has its own spec file (`docs/tz-strava.md`, `docs/tz-task-tracking.md`, etc.) — update that spec file too if the implementation diverged from it.

---

## Rules

- Do NOT touch `node_modules/`, `.env`, `token.json`, or any gitignored files.
- Be concise and precise — only update what actually changed, do not rewrite sections that are still accurate.
- Report a summary of every file you changed and why.
