# Scaffold a New Tool

Create a new Claude tool for Snezhanna that will be available via the tool_use API.

## Steps

1. **Clarify** — Ask what the tool should do if not fully described. A tool needs: a name, a description, input parameters, and what it returns.

2. **Read existing tools** — Read `lib/tools/index.js` and one or two existing tool files in `lib/tools/` to understand the registration pattern and code conventions.

3. **Create the tool file** — Create `lib/tools/<tool-name>.js` following this structure:
   ```js
   'use strict';

   async function myTool(input) {
     // implementation
     return { result: '...' };
   }

   module.exports = {
     definition: {
       name: 'my_tool',
       description: 'What this tool does.',
       input_schema: {
         type: 'object',
         properties: {
           param: { type: 'string', description: 'What param is for' }
         },
         required: ['param']
       }
     },
     handler: myTool
   };
   ```

4. **Register** — Add the tool to `lib/tools/index.js` so it's included in `getAvailableTools()`.

5. **Update docs** — Add the new tool to the **Key files** table in `CLAUDE.md` if it introduces a significant capability. Create or update `skills/<capability>.md`.

6. **Test instructions** — Tell me how to test the tool manually by sending a message to Snezhanna.
