# Skill: Google Calendar

## Description
Working with Google Calendar via OAuth2. Reading, creating, modifying, and deleting events.

## Available operations

### Reading events
- Events for today and the coming days
- Search events by name or time period
- List all active events

### Managing events
- Create an event (title, time, location, description)
- Create a recurring event with RRULE (daily, weekly, monthly, yearly)
- Modify an existing event
- Delete a single instance of a recurring event
- Delete an entire recurring event series
- Add attendees

### Recurring events
- "add a workout every Monday at 19:00" → `RRULE:FREQ=WEEKLY;BYDAY=MO`
- "remind me about vitamins every day at 09:00" → `RRULE:FREQ=DAILY`
- "mom's birthday April 12, every year" → `RRULE:FREQ=YEARLY`
- "skip the workout on Friday" → deletes only that instance (`delete_mode: single`)
- "delete all standups" → deletes the entire series (`delete_mode: all`), after confirming with the user

## Authorization
- OAuth2 via credentials.json (Desktop app)
- Token saved in token.json (in .gitignore)
- On first run — interactive flow via Telegram
- Scopes: calendar (read/write), gmail.modify

## Reminder schedule
- 30 minutes before each event — automatic notification
- Morning briefing (time configurable via Mini App Settings or `update_my_preferences`, default 08:00 Madrid) — list of events for the day
- Evening check-in (19:00 Madrid) — events for tomorrow

## Example requests from the user
- "What do I have today?"
- "Add a meeting with Alex tomorrow at 15:00"
- "Move the call to Friday"
- "Delete the 'Workout' event on Wednesday"
- "Add a standup every day at 10:00"
- "Schedule a team call every Friday at 15:00"
- "Skip the workout this Friday"
- "Delete all standups"
