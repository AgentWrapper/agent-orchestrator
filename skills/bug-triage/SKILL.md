---
name: bug-triage
description: Triage bugs reported in chat/issues, search for duplicates, file or update GitHub issues with full context, and push fix PRs.
trigger: User reports a bug, or asks to triage/file an issue for a reported problem.
---

# Bug Triage Skill

Triage bugs reported in chat/issues into well-structured GitHub issues on the correct upstream repo.

## Pre-flight

1. **Pull the latest code.** Run `git pull origin main` in the repo. Stale code = bad triage. No exceptions.
2. **Identify the target repo.** Always file on the **upstream org** (e.g., `ComposioHQ/agent-orchestrator`), NOT on user forks unless explicitly told otherwise.
3. **Record the source context:** chat URL, reporter name, any images attached.

## Step 0: Gather Report Context

Collect all available context about the bug:

1. **If from a chat thread:** Read the full thread history. Extract:
   - Reporter name and ID
   - Original bug description (the thread starter, not the person who tagged you)
   - All attachments and screenshots
   - Follow-up discussion and clarifications

2. **If from an existing issue:** Read the issue body and all comments.

3. **If from live observation:** Record session states, logs, metrics at the time of the bug.

The method for gathering context depends on where the report comes from:

| Source | How to gather |
|--------|---------------|
| **Discord thread** | Bot fetch script or Discord API |
| **Slack thread** | Slack API or Hermes adapter |
| **GitHub issue** | `gh issue view <number> --repo <repo> --json body,comments` |
| **Chat/DM** | Read the conversation history directly |
| **Live observation** | Pull live data via `ao_sessions`, `ao_observability` |

If you don't have access to the source platform's API, ask the reporter to paste the relevant details.

### Step 0b: Minimum Viable Report Gate

Before you start tracing code, the report must have enough substance to investigate.

**Required (must have ALL):**
- ✅ **What happened** — description of the bug, error message, or unexpected behavior
- ✅ **Where it happened** — which page/feature/command
- ✅ **When it started** — after an upgrade? first time? was it working before? This tells you whether to diff versions, bisect commits, or look at config changes.

**Required (at least 2 of 4):**
- ✅ **OS / Shell / Runtime** — or gather locally if on the same machine (see Step 0c)
- ✅ **AO version** — or run `ao --version` locally
- ✅ **Reproducibility** — consistent or intermittent? does it happen every time?
- ✅ **Reproduction steps** — even rough ones ("run ao start with this config")

**If the bug is on the same machine as you** — gather as much as you can yourself before asking (see Step 0c). Don't ask the reporter for info you can pull directly.

**Examples:**

| Report | Verdict | Action |
|--------|---------|--------|
| "AO broken" | ❌ Insufficient | Ask for all 3 required + 2 of 4 supporting |
| "Terminal blank on dashboard after upgrading to 0.5.0" | ✅ Sufficient | Start tracing, gather version locally |
| "ao start crashes with YAML parse error" | ⚠️ Almost | Start tracing, ask "when did this start?" |
| "it's slow" | ❌ Insufficient | Ask: which part? when did it start? always or sometimes? |

If the report is insufficient, respond with:
> "I'd like to triage this but need more info. Can you share:
> 1. **What exactly happened?** (error message, unexpected behavior)
> 2. **Where?** (which page/command/feature)
> 3. **When did it start?** (after upgrade? first time?)
> 4. **How can I reproduce it?** (steps, config, or rough description)"

### Step 0c: Local Diagnostics (when the bug is on the same machine)

When the bug is reproducible on the agent's own machine, gather everything you can **before** tracing code. Don't ask the reporter for info you can pull yourself.

**Environment (auto-gather):**
```bash
ao --version                              # Installed version
node --version                            # Node runtime
echo $SHELL                               # Current shell
uname -a                                  # OS kernel
cat agent-orchestrator.yaml               # Active config
cat ~/.agent-orchestrator/running.json    # Daemon state
```

**Process and system health:**
```bash
pm2 status                                # Is AO running? restart count?
ps aux | grep ao                          # Running AO processes
tmux list-sessions                        # Active tmux sessions (orphans?)
lsof -i :3000                             # What's bound to dashboard port?
```

**AO event log** — structured timeline of everything that happened:
```bash
# Recent events (spawns, transitions, CI failures, errors)
ao events list --limit 50

# Filter by session or type
ao events list --session ao-5 --limit 100
ao events list --type lifecycle.transition --since 2h

# Filter errors only
ao events list --log-level error --since 1h

# Full-text search across event summaries
ao events search "spawn failed"
ao events search "stuck" --limit 50

# Event statistics (counts by kind and source)
ao events stats

# JSON output for programmatic processing
ao events list --session ao-5 --json
```

Event kinds you'll see: `session.spawned`, `session.spawn_failed`, `session.killed`, `lifecycle.transition`, `ci.failing`, `review.pending`, `runtime.probe_failed`, `agent.process_probe_failed`, `reaction.escalated`, `lifecycle.poll_failed`. Sources: `lifecycle`, `session-manager`, `api`, `runtime`, `agent`, `reaction`.

**AO observability (if running):**
- `ao_sessions` — current session states, are any stuck?
- `ao_observability` — health dashboard, worker status, SSE event stream state
- `ao_issues` — open issues that might be related

**Session state files:**
```bash
# Individual session state (lifecycle, runtime, config)
cat ~/.agent-orchestrator/projects/*/sessions/*.json | python3 -m json.tool

# What changed recently?
ls -lt ~/.agent-orchestrator/
```

**Reproducibility testing:**
If the reporter gave reproduction steps, **try them**. Running the actual command is worth 100 lines of code tracing. If you can reproduce it, you have the real error output, the real stack trace, and the real state — no guessing needed.

**What this gives you that the reporter can't:**
- Actual error output and stack traces (not screenshots of error text)
- Process state at the moment of failure
- Whether other sessions/projects are affected
- Whether the bug is environment-specific or reproducible on a clean setup
- Recent file changes that might have triggered it
- Full event timeline via `ao events`

## Step 1: Understand the Issue

1. Read the bug report carefully. Ask clarifying questions if ambiguous.
2. **Collect environment info.** Every triage should capture:
   ```
   - OS: Windows 11 / macOS 15 / Ubuntu 24.04
   - Shell: PowerShell 7.4 / bash 5.2 / zsh
   - Runtime: runtime-process (Windows default) / runtime-tmux (macOS/Linux default)
   - AO version: `ao --version` output
   - Node version: `node --version` output
   - Install method: npm global / pnpm / git clone
   ```
   If the reporter doesn't provide this, ask. Version mismatches between CLI and daemon have caused real bugs (e.g., [#1188](https://github.com/ComposioHQ/agent-orchestrator/issues/1188)). Install method matters because git installs have different update paths than npm. If you can't get all of it, collect what you can — partial info is better than none.
3. **Always trace the actual code path** — don't surface-level diagnose. The obvious answer isn't always the real answer. Example: [#1129](https://github.com/ComposioHQ/agent-orchestrator/issues/1129) looked like a simple `ao stop` issue but was actually a session lineage/cascade problem.
4. Look at the **latest main** code to trace the root cause:
   - Run `git fetch origin main && git log --oneline origin/main -5` to see current HEAD
   - Record the **commit hash** you're analyzing against
   - Use `grep`, `rg`, or file search to trace the code path
5. **Git archaeology with `git log -S`:** When a CSS property, class name, or code pattern changed and broke something, use:
   ```bash
   git log --oneline -S 'exact-string' -- <file>
   git show <sha> -- <file> | grep -B 5 -A 10 'pattern'
   ```
   This finds which commits introduced or removed specific code. Example: [#1391](https://github.com/ComposioHQ/agent-orchestrator/issues/1391) traced a mobile layout break to a `display: flex` → `display: grid` change that silently broke `flex-direction: column` overrides.
6. **Research upstream dependencies** when the bug involves a library (xterm, node-pty, React, etc.):
   - Check installed vs latest version
   - Search the dependency's GitHub issues for the same symptom
   - Check changelogs for fixes between versions
   - The root cause is often an upstream bug, not your code

### Step 1b: Cross-Platform Check (Windows / macOS / Linux)

AO runs on **Windows, macOS, and Linux** as first-class targets. Many bugs are OS-specific — what works on Linux may be completely broken on Windows (different runtime, different shell, different paths). Environment info should already be collected (Step 1.2 or Step 0c). Use it here to determine if the bug could be platform-specific.

**Common Windows-specific bug patterns to check:**
- **Path separators** — `C:\Users\...` vs `/home/...`. Code using hardcoded `/` or `\` breaks cross-platform
- **Shell syntax** — PowerShell doesn't support `&&`, `$VAR`, `$(cat ...)`, `/dev/null`, here-docs. Bash-isms in spawn commands fail silently
- **`process.platform === "win32"` inline checks** — should use `isWindows()` from `@aoagents/ao-core` (see `docs/CROSS_PLATFORM.md`)
- **`process.kill(-pid)`** — negative PIDs are POSIX-only, silently fail on Windows. Should use `killProcessTree()`
- **Named pipes vs Unix sockets** — Windows IPC uses `\\.\pipe\ao-pty-<id>`, not Unix domain sockets
- **`localhost` vs `127.0.0.1`** — Windows resolves `localhost` to `::1` first, causing ~21s stalls if server is IPv4-only
- **NTFS case-insensitivity** — `D:\Foo` == `d:\foo`. Path comparisons must use `pathsEqual()`, not `===`
- **ConPTY orphan processes** — `conpty_console_list_agent.exe` can orphan and trigger WER dialogs if pty-host isn't shut down cooperatively
- **`.cmd`/`.bat` shim resolution** — spawning npm CLIs needs `shell: true` on Windows for `PATHEXT` lookup

**Key files for cross-platform code:**
- `packages/core/src/platform.ts` — central platform abstraction (`isWindows`, `getShell`, `killProcessTree`, `getEnvDefaults`)
- `docs/CROSS_PLATFORM.md` — full helper inventory, gotchas, pre-merge checklist
- `packages/plugins/runtime-process/` — Windows runtime (ConPTY, named pipes, pty-host)
- `packages/cli/src/lib/path-equality.ts` — `pathsEqual()`, `canonicalCompareKey()`

If the bug looks OS-specific, tag the issue with `to-reproduce` and include the reporter's system info.

### Step 1c: Stop-and-Ask Triggers

Don't burn tool calls cycling through hypotheses. If any of these conditions are met, **stop and ask the reporter for more info** before continuing:

- **3 failed hypotheses** — you've traced 3 different code paths and none explain the symptom. Stop.
- **Root cause is in a dependency** (upstream bug confirmed) — stop, file with upstream reference, don't guess at a local fix.
- **Bug only visible in UI** and you can't take a screenshot — ask the reporter to describe exactly what they see and when it happens.
- **Can't reproduce** after trying the reported steps — ask for additional context (different config? specific sequence?).

When stopping, tell the reporter what you've tried and what you need. Example:
> "I've traced through the lifecycle manager, session manager, and runtime code but can't pinpoint the root cause. Can you share: (1) exact steps to reproduce, (2) whether it's consistent or intermittent, (3) when it first started happening?"

## Step 2: Search for Duplicate and Related Issues

Search with multiple strategies — don't rely on a single keyword search:

```bash
# 1. Search by symptom (what the user sees)
gh issue list --repo <upstream-repo> --state all --search "blank terminal"
gh issue list --repo <upstream-repo> --state all --search "double sidebar"

# 2. Search by component (the file/module involved)
gh issue list --repo <upstream-repo> --state all --search "ProjectSidebar"
gh issue list --repo <upstream-repo> --state all --search "DirectTerminal"

# 3. Search by error message (exact strings from logs/screenshots)
gh issue list --repo <upstream-repo> --state all --search "session not found"

# 4. Check PRs too — sometimes a fix PR exists without a filed issue
gh pr list --repo <upstream-repo> --state all --search "<keywords>"
```

**Critical:** Always search **both open AND closed** issues (`--state all`). Bugs get closed as fixed and regress. Searching only open issues misses regressions of previously-fixed bugs. Also search PRs — sometimes fixes land without issues being filed.

If a match is found, go to Step 3. If not, go to Step 4.

## Step 3: Duplicate Found — Comment on Existing Issue

Add a comment with the new report's context:

```bash
gh issue comment <number> --repo <upstream-repo> --body "$(cat <<'EOF'
## New Report

**Reported by:** @<reporter> in [chat link](<url>)

**Date:** <YYYY-MM-DD>

**Checkout:** `<commit-hash>`

<Description of the new report, any additional context, differences from original>

<Screenshot if available>

<Observations — session states, metrics, logs>
EOF
)"
```

## Step 4: No Duplicate — File New Issue

### 4.1 Gather all context
- Source URL (chat thread, issue, etc.)
- Reporter name
- Screenshots
- Commit hash of checkout analyzed
- Root cause analysis with file paths and line numbers
- Live observability data if relevant

### 4.1b Pre-Submission Checklist

Before uploading screenshots and creating the issue, verify all of the following:

- [ ] **Reporter attribution is correct** — from the original bug report, not the person who tagged you
- [ ] **Commit hash recorded** — the exact hash you analyzed against
- [ ] **AO version recorded** — `ao --version` from the reporter or environment
- [ ] **Root cause confidence scored** — High / Medium / Low (see section below)
- [ ] **Related issues cross-linked** — searched by symptom, component, and error message
- [ ] **Reproduction steps are concrete** — not "it breaks" but specific steps a developer can follow
- [ ] **Screenshots ready for upload** — downloaded locally, ready to push to GitHub

If any of these are missing, go back and collect them before proceeding. Filing an incomplete issue wastes everyone's time.

### 4.1c Upload screenshots to GitHub

**⛔ NEVER use placeholder URLs.** Every image must be uploaded BEFORE the issue is created. Placeholder URLs (`placeholder-will-upload`, `TODO`, etc.) always result in broken links that need follow-up fixes. See [#1151](https://github.com/ComposioHQ/agent-orchestrator/issues/1151) for an RCA on this pattern.

Create a dedicated branch for issue assets (main is usually protected). Use a descriptive slug since the issue number doesn't exist yet:

```bash
# Create a branch for issue assets (use a slug, not issue number — issue doesn't exist yet)
SLUG="mobile-kanban-break"
gh api -X POST repos/<repo>/git/refs \
  -f ref="refs/heads/issue-assets-${SLUG}" \
  -f sha=$(git rev-parse origin/main)
```

Upload the image:

```bash
# Encode image as base64 (portable across Linux and macOS)
IMG_B64=$(base64 < /path/to/screenshot.png | tr -d '\n')
gh api -X PUT "repos/<repo>/contents/.issue-assets/${SLUG}/<descriptive-name>.png" \
  -f message="chore: upload screenshot for issue" \
  -f content="$IMG_B64" \
  -f branch="issue-assets-${SLUG}"
```

Extract the `download_url` from the response. Use the raw URL in the issue body:
```
![screenshot](https://raw.githubusercontent.com/<repo>/issue-assets-<slug>/.issue-assets/<filename>)
```

**Upload checklist — verify ALL before proceeding to 4.2:**
- [ ] Every image is uploaded to GitHub
- [ ] Every image has a working `raw.githubusercontent.com` URL
- [ ] The URL has been verified — confirm it resolves

### 4.2 Create the issue

```bash
gh issue create --repo <upstream-repo> \
  --title "<clear, concise title>" \
  --body "$(cat <<'EOF'
## Bug

<One-line summary>

**Source:** <url>
**Reported by:** @<reporter>
**Analyzed against:** `<commit-hash>`

## Screenshot

<Embed image or reference>

## Reproduction

1. <step>
2. <step>
3. <step>

## Root Cause

<Analysis with file paths and line numbers>

## Fix

<Suggested fix approach>

## Impact

- <effect 1>
- <effect 2>
EOF
)"
```

### 4.3 Add labels and priority

```bash
gh issue edit <number> --repo <upstream-repo> --add-label "bug"
```

**Priority assignment (use ONLY these labels):**
| Label | Criteria |
|-------|----------|
| `priority: critical` | Data loss, security, system down, all users affected |
| `priority: high` | Core feature broken, no workaround, many users affected |
| `priority: medium` | Feature degraded, workaround exists, some users affected |
| `priority: low` | Cosmetic, edge case, minor inconvenience |

**Available labels (complete list):**
- Priority: `priority: critical`, `priority: high`, `priority: medium`, `priority: low`
- Type: `bug`, `enhancement`
- Workflow: `good-first-issue`, `to-reproduce`, `to-explore`

Do NOT use other labels (no `p0`, `p1`, `p2`, etc.).

If the label doesn't exist:
```bash
gh label create "priority: medium" --repo <upstream-repo> --color "FBCA04" --description "Medium priority"
```

### 4.4 Root Cause Confidence Score

Rate your diagnosis before filing. This prevents other agents and developers from treating a guess like a confirmed diagnosis. Include this in the issue body as `**Confidence:** High/Medium/Low`.

| Level | Meaning | Labels to add |
|-------|---------|---------------|
| **High** | Traced exact code path, can point to specific lines, can explain the failure mechanism | `bug` only |
| **Medium** | Strong hypothesis consistent with the code, but unconfirmed (e.g., can't reproduce locally, or multiple plausible paths) | `bug`, `to-explore` |
| **Low** | Can't trace root cause, or multiple conflicting theories | `bug`, `to-reproduce` |

**Example:** The scroll regression in [PR #1608](https://github.com/ComposioHQ/agent-orchestrator/pull/1608) was initially diagnosed with high confidence as an xterm v6 issue. The real cause was a single `=` prefix on a tmux `set-option` call. Should have been `Medium` — the code tracing was consistent but unconfirmed via testing.

### 4.5 Cross-Link Related Issues

After creating the issue, search for **related** (not just duplicate) issues and include a `## Related` section in the issue body:

```bash
# Search by the subsystem/component involved
gh issue list --repo <repo> --state all --search "<component-or-subsystem>"
```

Include in the issue body:
```
## Related
- [#1020](url) — stale leftover session blocking ao start (same subsystem, different cause)
- [#1035](url) — duplicate of this issue (same race condition)
```

Cross-links help maintainers see the full picture — which subsystems are fragile, which patterns repeat, whether a fix in one area might affect another.

### 4.6 Create a PR for the fix (always attempt this)

**Always try to push a fix PR alongside the issue.**

**Guidelines:**
- **Trivial fix (few lines, obvious change):** Push the PR immediately.
- **Complex fix (needs new code, tests, architectural decisions):** Note the proposed fix in the issue and suggest spawning an agent.
- **Unclear fix:** Don't push a guess. Document findings and flag for investigation.

#### Push a fix via GitHub API

Use the `push_fix_to_github.py` script in this skill's `scripts/` directory:

```bash
OLD_STRING='<old code>' \
NEW_STRING='<new code>' \
python3 skills/bug-triage/scripts/push_fix_to_github.py \
  <owner/repo> \
  fix/descriptive-branch-name \
  path/to/file.tsx \
  "fix(scope): description" \
  "fix(scope): PR title" \
  "Fixes #<issue-number>

## Summary
<what changed>

## Test
<how to verify>"
```

The script reads the file from GitHub API, applies the replacement, creates a branch, pushes the commit, and opens a PR — entirely via API. No local checkout needed.

**Important notes on the push script:**
- It reads the file from **main**, applies one replacement, and pushes. For multiple changes to the same file, see "Multiple edits" below.
- `OLD_STRING` must match the file byte-for-byte on GitHub. Always verify by fetching the actual file first:
  ```bash
  gh api repos/<repo>/contents/<path>?ref=main -q '.content' | base64 -d
  ```

#### Multiple edits to the same file

The push script only applies one replacement per run (it starts from main's copy each time). For multiple changes, use `execute_code` or a Python script to read from the branch, apply all replacements, then push once:

```python
import base64, json, subprocess

# 1. Get current content FROM BRANCH (not main)
result = subprocess.run(
    ["gh", "api", f"repos/<repo>/contents/<path>?ref=<branch>", "--jq", ".content"],
    capture_output=True, text=True
)
content = base64.b64decode(result.stdout.strip()).decode("utf-8")

# 2. Apply all replacements
content = content.replace(old1, new1).replace(old2, new2)

# 3. Get file SHA and push
sha_result = subprocess.run(
    ["gh", "api", f"repos/<repo>/contents/<path>?ref=<branch>", "--jq", ".sha"],
    capture_output=True, text=True
)
file_sha = sha_result.stdout.strip()

payload = {
    "message": "fix: all changes",
    "content": base64.b64encode(content.encode()).decode(),
    "sha": file_sha,
    "branch": "<branch>"
}
with open("/tmp/push.json", "w") as f:
    json.dump(payload, f)
subprocess.run(["gh", "api", "-X", "PUT", f"repos/<repo>/contents/<path>", "--input", "/tmp/push.json"])
```

### 4.7 Post confirmation back

Report back with:
- Issue URL
- PR URL (if created)
- Labels applied
- Brief summary of root cause
- Whether a fix agent was suggested

## NPM Package Regression Diffing

When a regression occurs after upgrading npm packages, diff the **actual published packages**:

```bash
# Download and extract both versions
mkdir -p /tmp/ao-diff/{v1,v2}
curl -sL https://registry.npmjs.org/@scope/pkg/-/pkg-OLD.tgz | tar xz -C /tmp/ao-diff/v1
curl -sL https://registry.npmjs.org/@scope/pkg/-/pkg-NEW.tgz | tar xz -C /tmp/ao-diff/v2

# Diff server-side code
diff /tmp/ao-diff/v1/package/dist-server/file.js /tmp/ao-diff/v2/package/dist-server/file.js

# Diff client-side chunks
diff -rq /tmp/ao-diff/v1/package/.next/static/chunks/ /tmp/ao-diff/v2/package/.next/static/chunks/
```

**Why this matters:** The npm package may include pre-built bundles that differ from what `pnpm build` produces locally. The only authoritative source of truth is what's published. Example: [PR #1608](https://github.com/ComposioHQ/agent-orchestrator/pull/1608) had a scroll regression where source analysis led to wrong theories, but diffing the actual npm packages showed the **only change** was a single `=` prefix on a tmux `set-option` call.

## Remote Code Inspection (repo not cloned locally)

When the repo isn't available locally, triage fully using `gh api`:

```bash
# List all files
gh api repos/{owner}/{repo}/git/trees/main?recursive=1 --jq '.tree[].path'

# Read a file
gh api repos/{owner}/{repo}/contents/{path} --jq '.content' | base64 -d

# Search for a string across the codebase
gh search code "search term" --repo {owner}/{repo} --json path --jq '.[].path'

# Find which commits touched a file
gh api "repos/{owner}/{repo}/commits?path={path}&per_page=10" --jq '.[] | "\(.sha[0:8]) \(.commit.message | split("\n")[0])"'

# Read a file at a specific commit
gh api "repos/{owner}/{repo}/contents/{path}?ref={sha}" --jq '.content' | base64 -d
```

## Subsystem-Specific Triage Quick Reference

Different subsystems need different info and code tracing starting points. Use this to avoid wasting time in the wrong part of the codebase:

| Subsystem | Always collect | Key files to trace |
|-----------|---------------|-------------------|
| **CLI** (`ao start/stop/spawn`) | Config YAML, install method, version, OS | `packages/cli/src/commands/` |
| **Web UI / Dashboard** | Screenshot, browser, viewport size, OS | `packages/web/src/components/`, `globals.css` |
| **Terminal (xterm/tmux)** | Runtime type (`runtime-process` vs `runtime-tmux`), tmux version, shell | `DirectTerminal.tsx`, `useXtermTerminal.ts`, `terminal-touch-scroll.ts` |
| **Lifecycle / Status** | Lifecycle state transitions, session IDs | `core/src/lifecycle-manager.ts`, `core/src/lifecycle-state.ts` |
| **Session management** | Session ID, spawn config, runtime handle | `core/src/session-manager.ts` |
| **Plugins (agents)** | Plugin name (claude-code, codex, opencode), agent version | `packages/plugins/<agent>/` |
| **Config / Project setup** | `agent-orchestrator.yaml` contents, project path | `packages/core/src/config.ts` |

**Common misrouting patterns:**
- Terminal bugs → check if it's a **tmux issue** (runtime-tmux) or **xterm rendering issue** (web) or **PTY issue** (runtime-process on Windows). Don't assume — trace where the bytes flow.
- "Session stuck" bugs → check if it's a **lifecycle state machine** issue (lifecycle-manager) or **agent process** issue (plugin) or **runtime connection** issue (tmux/process). The lifecycle README documents the full state machine.
- "Config not saving" bugs → check if it's a **config loading** issue (c12/config.ts) or **project registration** issue (running-state.ts) or **YAML write** issue (file permissions).

## Formatting Rules

- **Always linkify issue/PR references.** When mentioning a GitHub issue or PR anywhere (issue bodies, PR descriptions, chat messages, comments), always include a clickable URL: `[#123](https://github.com/ComposioHQ/agent-orchestrator/issues/123)` or `[PR #456](https://github.com/ComposioHQ/agent-orchestrator/pull/456)`. Never write bare `#123` without a link — it forces the reader to manually search and navigate.

## Pitfalls

- **Cross-platform bugs are easy to miss.** AO runs on Windows, macOS, and Linux. If you're tracing code on Linux and can't find the bug, it might be a Windows-specific issue (wrong runtime, shell, or path handling). Always ask for OS + shell + runtime when root cause is unclear. See Step 1b.
- **Reporter ≠ person who tagged you.** The person who escalated the bug is often NOT the reporter. Always attribute to the actual reporter.
- **Always file on the upstream org repo**, not personal forks.
- **Always record the commit hash** you analyzed — code changes fast.
- **Always trace the code path** before speculating about root cause.
- **Include the source link and reporter name** — maintain the chain of context.
- **⛔ NEVER use placeholder image URLs.** Upload images BEFORE creating the issue. Get real URLs, then write the issue body.
- **GitHub issue is mandatory** — every triaged bug gets a GitHub issue, even if the fix is trivial. No exceptions.
- **`gh api --jq .content` truncates large files** — files over ~100KB get corrupted. Use local git for large files.
- **Push script `OSError: Argument list too long`** — long commit messages exceed OS arg limits. Use `execute_code` with JSON payloads instead.
- **Exact OLD_STRING matching** — `OLD_STRING` must match the file byte-for-byte on GitHub. Code traced locally may differ from what's on `origin/main`. Always fetch from GitHub API first.
- **Adding new required fields to shared TypeScript interfaces.** New fields on exported interfaces (`Session`, `SessionSpawnConfig`, etc.) MUST be optional (`field?: Type`). Downstream packages use `Partial<X>` spread — required fields break CI across all plugins. Progression: `field: T | null` → fails, `field?: T | null` → works. Example: [PR #1523](https://github.com/ComposioHQ/agent-orchestrator/pull/1523) hit this exact pattern.
