# Changelog

All notable changes to this project will be documented in this file.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), [Semantic Versioning](https://semver.org/).

## [Unreleased]

<!-- Entries added here automatically by /gh-issue, /new-feature, /update-docs -->
<!-- Format: - <One-sentence description> (#<issue or branch ref>) -->
<!-- Categories: Added | Changed | Fixed | Security | Removed -->

### Added

- Max Parent Interface: prize code pool (`/gencodes`, `/codes`), code issuance on quest completion with Time Boss Cloud integration, and low-codes warning to parent

### Changed

- `/quest` command now starts a guided dialog: subject → description → Claude-refined proposal with confirmation loop → reward time; old one-liner format still works as a fast path (closes #5)

### Fixed

- Max now immediately messages the student when a new quest is assigned outside an active session (fixes #3)
- Max now announces a new quest immediately when it is created mid-session, and always responds about active quests when the student explicitly asks, regardless of current subject (fixes #2)
- Serialise askClaude calls with a mutex to prevent concurrent requests from corrupting history with orphaned tool_use blocks (fixes #1)

## [1.0.0] — 2026-03-28

### Added

- Snezhanna main bot with Claude claude-sonnet-4-6, rolling conversation history, and prompt caching
- Google Calendar and Gmail integration with OAuth2 and auto-context injection
- Yandex Disk indexer and WebDAV mount management
- Anthropic native web search tool
- Voice message transcription via OpenAI Whisper
- Workload & Wellbeing scoring (weekly life-balance score across 4 domains)
- Morning briefing, evening check-in, and weekly digest scheduled tasks
- Tasks Mini App (Telegram WebApp) with HTTP API
- Calendar tab in Mini App
- Max tutor bot with two-actor model (student + parent), quest system, and homework tracking
- Parent interface: post-session summaries, quest completion alerts, subject avoidance flags
- Zhora watchdog: monitors both bots, auto-restarts, morning health report
- Photo/vision support via shared `lib/vision.js`
- Strava integration: weekly sync, fitness digest, race management
- Token usage analytics for Snezhanna and Max
