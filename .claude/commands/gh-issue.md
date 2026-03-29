---
description: Implement a GitHub issue end-to-end (branch → code → PR → close)
argument-hint: [issue-number]
allowed-tools: [Read, Glob, Grep, Bash, Edit, Write, AskUserQuestion, EnterPlanMode, ExitPlanMode]
---

# GitHub Issue Implementation

## Modes (required)

Work in **two phases**. Do not mix them.

| Phase | When | Tool |
|-------|------|------|
| **Planning** | From the moment the issue number is known until the user **confirms** the implementation plan | Call **`EnterPlanMode`** at the start of step 2 (before `gh issue view`). Stay in plan mode for steps 2–5 only. |
| **Execution** | After the user confirms the plan in step 5 | Call **`ExitPlanMode`** immediately **before** step 6. Then implement, commit, push, close issue. |

**In Plan mode:** study the issue, explore the codebase with read-only tools, assess scope, and write a concrete plan (files, logic). Do **not** use `Edit`, `Write`, `git commit`, or any Bash that modifies the repo or deploys changes.

**After `ExitPlanMode`:** run step 6 onward — checkout/pull, code changes, docs, CHANGELOG, commit, push, close.

## Setup

Ensure `gh` is available:
```
export PATH="$PATH:/home/vova/.local/bin"
```
If `GH_TOKEN` is not set, check `gh auth status` and ask the user to provide a token.

## Arguments

The user invoked this command with: $ARGUMENTS

If an issue number was passed as argument — skip step 1 and go directly to step 2 with that number.

## Steps

### 1. List open issues

Run:
```bash
gh issue list --state open
```

Display the results clearly and ask the user which issue number to implement.

### 2. Enter Plan mode and read the issue

1. Call **`EnterPlanMode`** (one short sentence: analyzing issue N and drafting a solution before any edits).
2. Then run:
```bash
gh issue view <number> --comments
```

Read the full issue body and all comments carefully. Extract what needs to be built, acceptance criteria, and any design decisions from comments.

### 3. Explore the codebase

Understand which files are relevant to this issue:
- Frontend: `src/App.jsx` or components in `src/components/`
- Backend: `server/index.js`
- Database: `server/db.js`

### 4. Assess scope

- **Small fix** (1–3 files, clear requirement, low risk): proceed to step 5
- **Large feature** (multiple files, new logic, DB changes, new routes, new env vars):
  Stop and tell the user:

  > This looks like a large feature. Run:
  > `/new-feature <issue title>`
  >
  > `<issue body>`

  Then call **`ExitPlanMode`** and stop. Do not implement anything so the user can run the other command.

### 5. Plan and confirm

Propose the implementation plan:
- Which files will change and why
- What logic will be added/modified

Ask for confirmation before writing any code.

### 6. Exit Plan mode and implement

1. When (and only when) the user has **confirmed** the plan, call **`ExitPlanMode`**.
2. Then run:
```bash
git fetch origin && git checkout master && git pull origin master
```

Make the changes exactly as described in the issue and the agreed plan. Follow project conventions: Tailwind, Russian UI strings, Spanish for learning content.

### 7. Update docs (if needed)

Run `git diff` to check what changed. If the change touches a documented feature, update the relevant file in `docs/`.

### 8. Update CHANGELOG (required)

Append one line to `CHANGELOG.md` under `## [Unreleased]` → `### Fixed`
(or `### Added` / `### Changed` as appropriate):
```
- <What was broken and now works, one sentence> (fixes #<number>)
```
If `## [Unreleased]` or the relevant `###` category does not exist yet, create it.

### 9. Commit

```bash
git add -A && git commit -m "fix: <short description> (closes #<number>)"
```

Use `feat:` prefix for new features, `fix:` for bug fixes.

### 10. Push

```bash
git push origin master
```

### 11. Close the issue

```bash
gh issue close <number> --comment "Implemented in commit $(git rev-parse --short HEAD)"
```

### 12. Report back

Tell the user:
- What was changed (files, logic)
- How to verify (browser scenario or test steps)
- Any notes or follow-up items
