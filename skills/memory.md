# Skill: Memory

## Description
Long-term memory in files on Google Drive (the `memory/` folder inside the assistant's root folder).
Used to store important information between sessions.

## Memory files

### health.md
- Vova's health: test results, prescriptions, chronic conditions
- Family members' health (with their consent)
- Important dates: scheduled check-ups, vaccinations

### kids.md
- Children: names, ages, school
- Important events, achievements
- Schedules, extracurricular activities

### finance.md
- Financial goals
- Regular payments
- Important financial decisions and their dates

### bureaucracy.md
- Deadlines: taxes, documents, permits
- Document status
- What needs to be done and when

### decisions.md
- Vova's important decisions with date and context
- Why a particular decision was made

## Behavior

When receiving important information — offer to save it:
"Vova, should I save this to the memory file [health/kids/finance/bureaucracy/decisions]?"

When reading memory — use context to personalize responses.

## Examples
- "Remember: April 15 — file tax return"
- "What do I have in bureaucracy?"
- "Save: decided to move to Barcelona"
- "Remind me about health — what's important?"
