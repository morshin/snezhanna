# Update Documentation

Review all recent changes to the codebase and update the project documentation to reflect them.

## Steps

1. Run `git diff HEAD~1 HEAD` (or `git diff --staged` if there are staged changes) to see what changed.
2. Read the current `CLAUDE.md` to understand what's already documented.
3. Read any relevant `skills/*.md` files that may need updating.
4. Update `CLAUDE.md`:
   - Add new files to the **Key files** table if any were created.
   - Update the **Architecture** section if the feature changes how the bot works.
   - Update **Required environment variables** if new env vars were added.
   - Update any other sections that became outdated.
5. Update `skills/*.md` files if the feature touches Calendar, Gmail, Yandex Disk, or Memory capabilities. Create a new skill file if a new capability was added.
6. Do NOT touch `node_modules/`, `.env`, `token.json`, or any gitignored files.
7. Report a summary of every file you changed and why.

Be concise and precise — only update what actually changed, do not rewrite sections that are still accurate.
