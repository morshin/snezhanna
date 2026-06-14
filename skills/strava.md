# Strava Integration

## Overview

Snezhanna syncs the user's Strava activities weekly and provides fitness analysis in the Sunday digest.

## Features

### Weekly Activity Sync
- **Schedule**: Every Sunday at 09:30 Madrid time
- **Source**: Strava API (`GET /athlete/activities`)
- **Storage**: Google Drive `fitness/weekly/YYYY-Www.json` + `YYYY-Www-summary.md`
- Fetches all activities for the current ISO week (Monday–Sunday)
- Calculates totals: distance, time, elevation, breakdown by sport

### Sunday Digest Fitness Block
- Runs at 10:00 (after sync at 09:30)
- Compares current week vs previous week
- Metrics: activity count, total volume (km), time (h/min), elevation (m), suffer score, by-sport breakdown
- Snezhanna provides coaching-style commentary in Russian

### Race Management
- **Tool**: `create_race` — creates a race folder structure on Google Drive
- **Path**: `fitness/races/YYYY-MM-DD_slug-name/`
- **Files created**: README.md, plan.md, gear.md, result.md
- Triggered by natural language: "Добавь старт...", "Создай гонку..."

## Configuration

Environment variables (in `.env`):
- `STRAVA_CLIENT_ID` — from Strava API settings
- `STRAVA_CLIENT_SECRET` — from Strava API settings
- `STRAVA_REFRESH_TOKEN` — obtained via OAuth2 flow (never expires)

If `STRAVA_REFRESH_TOKEN` is not set, all Strava features silently no-op.

## Modules

- `lib/strava.js` — Strava API client, sync logic, digest builder
- `lib/races.js` — Race folder creation
