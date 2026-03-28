# New Feature Development

Guide me through developing a new feature for Snezhanna end-to-end.

## Steps

1. **Clarify requirements** — Ask me what the feature should do if it's not fully described yet.

2. **Explore the codebase** — Read `index.js`, `lib/tools.js`, relevant files in `lib/`, `config/nanobot.json`, and `identity/IDENTITY.md` to understand the current architecture before proposing anything.

3. **Plan** — Describe the implementation approach: which files to create or modify, how it integrates with the tool system in `lib/tools.js`, what new keys are needed in `config/nanobot.json`, and what new env vars are required.

4. **Implement** — Write the code. Follow these conventions:
   - New capabilities go into `lib/` as individual modules (e.g. `lib/myfeature.js`).
   - To expose a capability as a Claude tool, add its definition to the `TOOLS` array in `lib/tools.js` and add a `case` for it inside the `executeTool()` switch statement in the same file.
   - Use `'use strict';` at the top of every JS file.
   - Log with `[ModuleName]` prefix, e.g. `console.log('[MyFeature] ...')`.
   - Handle errors gracefully — return `{ error: message }` from tools, never throw unhandled.
   - All times in `Europe/Madrid` timezone via `config.timezone`.
   - New config keys go into `config/nanobot.json`.

5. **Environment variables** — If the feature requires new secrets or credentials:
   - Add them to `.env` (the service reads it automatically via `EnvironmentFile=` in snezhanna.service).
   - Add the same variable names (with empty values) to `.env.example` so the template stays up to date.

6. **Update docs (required, same turn)** — Do **not** defer this to a separate `/update-docs` invocation. Follow the full checklist in `.claude/commands/update-docs.md` in this session: refresh `git diff` / `git status` against the working tree (not only `HEAD~1`), then update every doc that the change actually touches — at minimum check `CLAUDE.md` (Key files table, Architecture, env vars), `identity/IDENTITY.md` if users see new behavior, `docs/snezhanna-tz.md` for structure/infra/cron/env, `schedules/heartbeats.json` if schedules changed, matching `skills/*.md`, and any relevant `docs/tz-*.md` spec.

7. **Update CHANGELOG (required, same turn)** — Append one line to `CHANGELOG.md` under `## [Unreleased]` → `### Added` (or `### Changed` if appropriate):
   ```
   - <One-sentence description of what was added> (#<issue or branch ref>)
   ```
   If `## [Unreleased]` or the `### Added` section does not exist yet, create it.

8. **Summary** — Report what was created/modified and how to test it, then run `/deploy` to restart the service and verify it started cleanly.
