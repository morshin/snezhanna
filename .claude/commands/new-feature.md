# New Feature Development

Guide me through developing a new feature for Snezhanna end-to-end.

## Steps

1. **Clarify requirements** — Ask me what the feature should do if it's not fully described yet.

2. **Explore the codebase** — Read `index.js`, `lib/tools.js`, relevant files in `lib/`, `config/nanobot.json`, and `identity/IDENTITY.md` to understand the current architecture before proposing anything.

3. **Plan** — Describe the implementation approach: which files to create or modify, how it integrates with the tool system in `lib/tools.js`, what new keys are needed in `config/nanobot.json`, and what new env vars are required.

4. **Implement** — Write the code. Follow these conventions:
   - New capabilities go into `lib/` as individual modules (e.g. `lib/myfeature.js`).
   - To expose a capability as a Claude tool, add its definition to the `TOOLS` array in `lib/tools.js` and add a `case` for it inside the `callTool()` switch statement in the same file.
   - Use `'use strict';` at the top of every JS file.
   - Log with `[ModuleName]` prefix, e.g. `console.log('[MyFeature] ...')`.
   - Handle errors gracefully — return `{ error: message }` from tools, never throw unhandled.
   - All times in `Europe/Madrid` timezone via `config.timezone`.
   - New config keys go into `config/nanobot.json`.

5. **Environment variables** — If the feature requires new secrets or credentials:
   - Add them to `.env`.
   - Add the same variable names to `systemd/snezhanna.service` under the `[Service]` section (it acts as the EnvironmentFile for the systemd unit).

6. **Update docs** — Run `/update-docs` to update `CLAUDE.md` and any relevant `skills/*.md` files.

7. **Summary** — Report what was created/modified and how to test it, then run `/deploy` to restart the service and verify it started cleanly.
