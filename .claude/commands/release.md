---
description: Cut a new release: bump version, finalize CHANGELOG, tag, push
argument-hint: [patch|minor|major]
allowed-tools: [Read, Glob, Grep, Bash, Edit, Write, AskUserQuestion]
---

# Release

## Arguments

The user invoked this command with: $ARGUMENTS

If a bump type was passed (`patch`, `minor`, `major`) — use it directly.
If not — ask the user which type to use, showing the current version and what each type means.

## Steps

### 1. Check state

```bash
git status
git log --oneline -5
```

Make sure the working tree is clean (no uncommitted changes) and we're on `master`. If not — stop and tell the user.

### 2. Determine new version

Read `package.json` to get the current version. Apply the bump:
- `patch`: x.y.Z+1 — bug fixes
- `minor`: x.Y+1.0 — new features, backwards-compatible
- `major`: X+1.0.0 — breaking changes

Show the user: `v1.2.3 → v1.2.4 (patch)` and ask for confirmation.

### 3. Finalize CHANGELOG

In `CHANGELOG.md`:
- Rename `## [Unreleased]` to `## [<new-version>] — <YYYY-MM-DD>` (today's date)
- Add a fresh `## [Unreleased]` block above it with the comment template:

```markdown
## [Unreleased]

<!-- Entries added here automatically by /gh-issue, /new-feature, /update-docs -->
<!-- Format: - <One-sentence description> (#<issue or branch ref>) -->
<!-- Categories: Added | Changed | Fixed | Security | Removed -->
```

If `## [Unreleased]` has no entries — stop and tell the user: "Nothing to release — [Unreleased] is empty."

### 4. Bump version in package.json

Update the `"version"` field to the new version string.

### 5. Commit, tag, push, create GitHub Release

```bash
git add CHANGELOG.md package.json
git commit -m "chore: release v<new-version>"
git tag v<new-version>
git push origin master
git push origin v<new-version>
```

Then create a GitHub Release using the released CHANGELOG section as the body:

```bash
gh release create v<new-version> --title "v<new-version>" --notes "<released-changelog-body>"
```

### 6. Report back

Tell the user:
- New version
- What's included (paste the released CHANGELOG section)
- GitHub Release URL returned by `gh release create`
