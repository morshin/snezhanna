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
| **Planning** | **Small fix:** from step 2 through step 5 until the user **confirms** the plan. **Large feature:** from step 2 through step 4 (scope assessment) only — no separate plan-confirm step. | Call **`EnterPlanMode`** at the start of step 2 (before `gh issue view`). |
| **Execution** | **Small fix:** after plan confirm — **`ExitPlanMode`** immediately **before** step 6, then implement through step 12. **Large feature:** **`ExitPlanMode`** at the start of **Large feature path**, then `new-feature` steps 1–7 + GitHub/deploy tail. |

**In Plan mode:** study the issue, explore the codebase with read-only tools, assess scope, and write a concrete plan (files, logic). Do **not** use `Edit`, `Write`, `git commit`, or any Bash that modifies the repo or deploys changes.

**After `ExitPlanMode`:** run step 6 onward — checkout/pull, code changes, docs, CHANGELOG, commit, push, close.

### Large feature path (orchestration, no hand-off to the user)

If step 4 classifies the work as a **large feature**, **do not** ask the user to run `/new-feature` manually. You own the full pipeline end-to-end.

1. **`ExitPlanMode`** (leave read-only issue analysis).
2. **Optional delegation:** If this environment supports spawning a **subagent** (or `Task`) with an isolated context, you may launch one pass whose **only** job is to execute `.claude/commands/new-feature.md` **steps 1–7** using issue `#<number>` (title, body, comments summary) as the requirement source — then return the list of changed files and any env/config notes. If subagents are not available, run steps 1–7 **yourself in this session** (same rules).  
   - Step 1 of `new-feature`: skip broad “what should it do?” if the issue + comments are sufficient; ask only **targeted** questions when something blocks implementation.
3. **GitHub + deploy tail** (your responsibility in the parent session if you used a subagent): After `new-feature` steps 1–7 are complete (code + `.env` / `.env.example` if needed + **docs** + **CHANGELOG** per that command):
   - `git fetch origin && git checkout master && git pull origin master` (resolve conflicts before committing).
   - **Commit** (if anything is unstaged): use `feat:` and message body referencing the issue, e.g. closes `#<number>` in the subject or footer.
   - **Push** (`git push origin master` or the branch you used for the feature — prefer the project’s usual branch).
   - **Deploy:** follow `.claude/commands/deploy.md` (restart services, `systemctl status`, `journalctl` sanity check).
   - **`gh issue close <number>`** with a comment citing the implementing commit SHA.
   - **Report** to the user (changed files, how to verify, follow-ups) — same quality as new-feature step 8’s summary.

Do **not** run standalone `/deploy` twice: the tail above is the single deploy for this flow.

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

- **Small fix** (1–3 files, clear requirement, low risk): proceed to step 5 (stay in Plan mode until step 6).
- **Large feature** (multiple files, new logic, DB changes, new routes, new env vars, new tools/modules per `lib/tools.js`, substantial config or docs):
  - In one short message, tell the user that issue `#<number>` is treated as a **large feature** and you will run the **`new-feature` pipeline** (plan + implementation) yourself, then docs/CHANGELOG/deploy/close.
  - Follow **Large feature path** in the section above (orchestration). **Do not** stop after `ExitPlanMode` waiting for the user to type `/new-feature`.

### 5. Plan and confirm *(small fix only — skip if step 4 used the large-feature path)*

Propose the implementation plan:
- Which files will change and why
- What logic will be added/modified

Ask for confirmation before writing any code.

### 6. Exit Plan mode and implement *(small fix only)*

1. When (and only when) the user has **confirmed** the plan, call **`ExitPlanMode`**.
2. Then run:
```bash
git fetch origin && git checkout master && git pull origin master
```

Make the changes exactly as described in the issue and the agreed plan. Follow project conventions: Tailwind, Russian UI strings, Spanish for learning content.

### 7. Update docs (if needed) *(small fix only)*

Run `git diff` to check what changed. If the change touches a documented feature, update the relevant file in `docs/`.

### 8. Update CHANGELOG (required) *(small fix only)*

Append one line to `CHANGELOG.md` under `## [Unreleased]` → `### Fixed`
(or `### Added` / `### Changed` as appropriate):
```
- <What was broken and now works, one sentence> (fixes #<number>)
```
If `## [Unreleased]` or the relevant `###` category does not exist yet, create it.

### 9. Commit *(small fix only)*

```bash
git add -A && git commit -m "fix: <short description> (closes #<number>)"
```

Use `feat:` prefix for new features, `fix:` for bug fixes.

### 10. Push *(small fix only)*

```bash
git push origin master
```

### 11. Close the issue *(small fix only)*

```bash
gh issue close <number> --comment "Implemented in commit $(git rev-parse --short HEAD)"
```

### 12. Report back *(small fix only — large-feature path already ends with a report in the orchestration tail)*

Tell the user:
- What was changed (files, logic)
- How to verify (browser scenario or test steps)
- Any notes or follow-up items
