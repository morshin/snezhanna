# Backlog — ideas and future improvements

## Tools

### 🔍 Web search (`web_search`)
**Idea:** Add a web search tool to Snezhanna.

**What this enables:**
- Searching for hotels, flights, restaurants
- Looking up project information (documentation, news, competitors)
- Any up-to-date data not available in memory/disk

**How to implement:**
1. Register at [api.search.brave.com](https://api.search.brave.com) — free tier: 2000 requests/month
2. Add `BRAVE_SEARCH_API_KEY` to `.env`
3. Create `lib/websearch.js` with a Brave Search REST API call
4. Add the `web_search` tool definition to `lib/tools.js` (`TOOLS` array)
5. Add a case to `executeTool`

**Alternative:** Tavily API — 1000 requests/month free, designed for AI agents, returns ready-to-use page text (not just links).

**Status:** Idea, not started
**Added:** 2026-03-05
