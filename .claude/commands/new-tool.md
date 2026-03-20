# Scaffold a New Tool

Create a new Claude tool for Snezhanna that will be available via the tool_use API.

## Architecture

All tools live in a **single file** `lib/tools.js`:
- `TOOLS` array — Anthropic tool definitions (name, description, input_schema)
- `executeTool(name, input)` function — dispatch switch that calls the right handler

Tools are NOT split into separate files. The implementation logic usually lives in a dedicated `lib/<module>.js` that `tools.js` imports.

## Steps

1. **Clarify** — Ask what the tool should do if not fully described. A tool needs: a name, a description, input parameters, and what it returns.

2. **Read existing tools** — Read `lib/tools.js` in full to understand the TOOLS array format, the `executeTool()` switch, and code conventions.

3. **Implement the logic** — If the tool requires non-trivial logic, create `lib/<module>.js` for it. If it's simple (1–2 lines), implement it inline in `executeTool()`.

4. **Add the tool definition** — Append an entry to the `TOOLS` array in `lib/tools.js`:
   ```js
   {
     name: 'my_tool',
     description: 'What this tool does.',
     input_schema: {
       type: 'object',
       properties: {
         param: { type: 'string', description: 'What param is for' }
       },
       required: ['param']
     }
   }
   ```

5. **Add the handler** — Add a `case` inside the `executeTool()` switch in `lib/tools.js`:
   ```js
   case 'my_tool':
     return await myModule.doSomething(input.param);
   ```

6. **Update docs (required, same turn)** — Follow `.claude/commands/update-docs.md` in this session (working-tree `git diff` / `git status`); update `CLAUDE.md`, `identity/IDENTITY.md`, `docs/snezhanna-tz.md` if applicable, and any relevant `skills/*.md` / `docs/tz-*.md`. Do not skip or defer to a separate `/update-docs` only.

7. **Test instructions** — Tell me how to test the tool manually by sending a message to Snezhanna.
