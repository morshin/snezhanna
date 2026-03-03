# New Feature Development

Guide me through developing a new feature for Snezhanna end-to-end.

## Steps

1. **Clarify requirements** — Ask me what the feature should do if it's not fully described yet.

2. **Explore the codebase** — Read `index.js`, relevant files in `lib/`, `config/nanobot.json`, and `identity/IDENTITY.md` to understand the current architecture before proposing anything.

3. **Plan** — Describe the implementation approach: which files to create or modify, how it integrates with the existing tool system (`lib/tools/`), what new env vars or config keys are needed.

4. **Implement** — Write the code. Follow these conventions:
   - New capabilities go into `lib/tools/` as individual tool files registered in `lib/tools/index.js`.
   - Use `'use strict';` at the top of every JS file.
   - Log with `[ModuleName]` prefix, e.g. `console.log('[Tools] ...')`.
   - Handle errors gracefully — return `{ error: message }` from tools, never throw unhandled.
   - All times in `Europe/Madrid` timezone via `config.timezone`.

5. **Update docs** — After implementation, automatically run `/update-docs` logic:
   - Update `CLAUDE.md` (Key files table, Architecture, env vars).
   - Create or update the relevant `skills/*.md` file.

6. **Summary** — Report what was created/modified and how to test it.
