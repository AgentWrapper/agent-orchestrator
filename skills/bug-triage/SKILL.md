# Bug Triage Skill

Use this skill any time a bug is reported — in chat, in issues, or from live observation.

## Prerequisites

Always pull the latest `main` before triaging. Stale code = bad triage.

```bash
git fetch origin && git merge --ff-only origin/main
```

## Workflow

### 1. Gather context

Reproduce or confirm the bug before acting:

- Read the error message and stack trace carefully.
- Identify which package, file, and function is involved.
- Check if the error happens in a specific environment (OS, Node version, pnpm version).
- Check `pnpm build` and `pnpm typecheck` to confirm the tree is clean.

### 2. Search for duplicates

Before filing anything, check if this is already known:

```bash
# Search commit history for related keywords
git log --oneline --all -S "keyword" -- path/to/file

# Search for the error message in source
rg "ErrorMessage" packages/
```

Check open GitHub issues for similar reports.

### 3. Root cause analysis

Trace the bug to its source:

- Follow the call stack from the error site back to the originating code.
- Use `git log -S "symbol"` to find when the behavior was introduced.
- For dependency regressions: compare `package.json` versions with the last known-good state.
- For flaky tests: check if the failure is timing-related, platform-specific, or environment-specific.

### 4. File or update a GitHub issue

If this is a new bug, file an issue with:

- **Title**: concise description (e.g., `[ao-web] tmux test crashes with ENOENT on hosts without tmux`)
- **Severity**: high / medium / low
- **Reproduction steps**: minimal steps to reproduce
- **Expected vs actual behavior**
- **Environment**: OS, Node version, pnpm version
- **Relevant files**: list the files involved

### 5. Push a fix PR

For single-file fixes, use `scripts/push_fix_to_github.py` to create a PR directly via the GitHub API without needing a local checkout:

```bash
python3 scripts/push_fix_to_github.py \
  --repo owner/repo \
  --branch fix/describe-the-fix \
  --file path/to/file.ts \
  --content "$(cat path/to/file.ts)" \
  --message "fix: describe the fix"
```

For multi-file fixes, create a branch locally, apply the fix, and open a PR:

```bash
git checkout -b fix/describe-the-fix
# ... apply fix ...
git commit -m "fix: describe the fix"
git push -u origin HEAD
gh pr create --title "fix: describe the fix" --body "..."
```

## Checklist

- [ ] Pulled latest `main`
- [ ] Confirmed reproduction
- [ ] Searched for duplicates
- [ ] Root cause identified
- [ ] GitHub issue filed or updated
- [ ] Fix implemented with a test that reproduces the bug
- [ ] PR created with clear description
