---
name: pr-review
description: Review PRs for the Agent Orchestrator repo — scope, correctness, conventions, and merge readiness. For use by AO bot agents and human reviewers.
version: 1.0.0
author: Hermes Agent
license: MIT
metadata:
  hermes:
    tags: [GitHub, Code-Review, Pull-Requests, Agent-Orchestrator]
    related_skills: [github-code-review, bug-triage]
---

# PR Review Skill (Agent Orchestrator)

Review pull requests on ComposioHQ/agent-orchestrator. Covers scope validation, correctness, project-specific conventions, and merge readiness.

**Use this skill when:**
- Someone asks you to review a PR
- You're reviewing your own agent-spawned PRs before merge
- A PR is flagged for review in Discord/Slack

**For general GitHub review mechanics** (API calls, inline comments, review submission), see `github-code-review`. This skill focuses on *what to check* for this project specifically.

---

## Step 1: Gather Context

```bash
# PR metadata
gh pr view <N> --json title,body,author,baseRefName,headRefName,files,additions,deletions,changedFiles

# File list with stats
gh api repos/ComposioHQ/agent-orchestrator/pulls/<N>/files --jq '.[] | "\(.status) +\(.additions) -\(.deletions) \(.filename)"'

# Full diff
gh pr diff <N>

# CI status
gh pr checks <N>
```

---

## Step 2: Scope & Hygiene Check (MANDATORY — do this first)

Before reviewing any code, verify the diff contains **only changes related to the PR's stated purpose**. This is a hard gate — violations block merge.

### What to scan for

| Category | Red flags | How to detect |
|---|---|---|
| **Submodules** | `160000` mode entries, new `.gitmodules` | `git diff --summary \| grep 'mode 160000'` |
| **Unrelated files** | Files that have nothing to do with the PR title/description | Read file list, cross-reference with PR description |
| **Stray docs/plans** | Design docs, planning files, notes, random markdown | Any `.md` not directly part of the change |
| **Config drift** | Unintended changes to `package.json`, CI configs, `.env*` | Diff those files specifically |
| **Accidental inclusions** | Leftovers from rebase, cherry-pick, or worktree state | Commits that don't match the PR author's pattern |

### Flagging scope violations

When you find unrelated changes, use this language:

> ⛔ **Scope violation:** The following changes are unrelated to this PR's purpose and must be removed before merge:
> - `path/to/file` — not related to the PR's stated goal
>
> Unrelated changes (stray docs, plans, submodule entries, config drift) are not encouraged in PRs and can lead to the PR not getting merged. Please remove them and open a separate PR or issue if needed.

---

## Step 3: Correctness Check

### Types & Interfaces (`packages/core/src/types.ts`)

- New interface fields **MUST be optional** (`field?: Type`). `Partial<X>` spread in web code will break CI on required fields.
- Check that runtime validators (Zod schemas) align with TypeScript types — missing fields get silently stripped.

### Cross-Platform (`packages/core/src/platform.ts`)

- Never inline `process.platform === "win32"`. Use `isWindows()` from `@aoagents/ao-core`.
- New platform branching? Add it to `platform.ts`, not at the call site.
- See `docs/CROSS_PLATFORM.md` for the full checklist.

### State & Lifecycle (`packages/core/src/lifecycle-manager.ts`, `lifecycle-state.ts`)

- Lifecycle state transitions must go through `deriveLegacyStatus()`.
- Check for stale re-dispatch bugs — does the polling loop correctly compare previous vs current state before emitting?

### Config (`agent-orchestrator.yaml`)

- `loadGlobalConfig()` is nullable. Use `?? createDefaultGlobalConfig()`.
- Config changes must handle the first-run case (no config file exists yet).

### Terminal / WebSocket (`packages/web/` terminal components)

- xterm v6: use `@xterm/xterm`, not `xterm`.
- WebSocket connections need reconnection logic.
- Check for `catch(() => true)` patterns that swallow errors — see `catch-true-health-check-audit` skill.

### Session Management

- New session states need corresponding `deriveLegacyStatus()` entries.
- Metadata files are `{sid}.json` with flat key=value format.
- Bash hooks use `head -c1` for status checks.

---

## Step 4: Code Quality

- **Surgical changes only.** PR should touch only what's necessary for the fix/feature.
- **No speculative features.** Don't add abstractions for single-use code.
- **Plugin slots** are the extension point — don't hardcode new agent/runtime/workspace types.
- **No `debugger`, `console.log`, `TODO`, `FIXME`** in production code.
- **No merge conflict markers** (`<<<<<<<`, `>>>>>>>`, `=======`).

---

## Step 5: Testing

- Bug fixes must include a test that reproduces the original bug.
- New features need proportional test coverage (~1:1 LOC for core logic).
- Run `pnpm test` (or `pnpm --filter @aoagents/ao-web test` for web).
- Check that CI is green: `gh pr checks <N>`.

---

## Step 6: PR Metadata

- **Title** follows conventional commits: `fix(cli):`, `feat(web):`, `chore:`, `docs:`, `refactor:`.
- **Description** explains the *why*, not just the *what*.
- **Links to issues** — use `Fixes #N` or `Closes #N` syntax.
- **Issue/PR refs are linkified:** `[#123](https://github.com/ComposioHQ/agent-orchestrator/pull/123)` — never bare `#123`.

---

## Step 7: Verdict & Review

Present findings using this severity structure:

### 🔴 Critical (blocks merge)
- Security vulnerabilities, data loss, crashes, broken core functionality

### ⚠️ Warning (usually blocks merge)
- Bugs in non-critical paths, missing error handling, missing tests

### 💡 Suggestion (non-blocking)
- Style, refactoring, performance, documentation

### ⛔ Scope Violation (blocks merge)
- Unrelated files, stray docs, submodules, config drift

### ✅ Looks Good
- Call out clean patterns, good test coverage, smart design

**Verdict:**
- **Approve** — zero critical/warning/scope items
- **Request Changes** — any critical, warning, or scope violation
- **Comment** — observations only (draft PRs, informational)

---

## Step 8: Submit Review

Post a structured summary comment and submit the formal review:

```bash
# Write review to temp file (avoids shell escaping issues)
cat > /tmp/pr-review.md <<'EOF'
## Code Review Summary

**Verdict: [Approved ✅ | Changes Requested 🔴]**

[findings]
EOF

# Submit review
gh pr review <N> --approve --body-file /tmp/pr-review.md
# or
gh pr review <N> --request-changes --body-file /tmp/pr-review.md
```

For inline comments, use `gh api` with `--input` and a JSON file — never `-f body=` with markdown (backticks break in bash).

---

## Pitfalls

- **False-positive "missing await"** — verify the function actually returns a Promise before flagging. `atomicWriteFileSync` and similar sync I/O return `void`.
- **Reviewing stale code** — always `git fetch` before reading the branch. The author may have pushed fixes since you last checked.
- **Trusting fix descriptions** — when an author says "fixed", verify against the actual code on the branch. Don't take their word for it.
- **Agent-spawned PRs** — these can carry worktree state (submodules, unrelated files). Always run the scope check.
