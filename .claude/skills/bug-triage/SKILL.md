---
name: bug-triage
description: Triage bugs reported in chat/issues, search for duplicates, file or update GitHub issues with full context, and push fix PRs.
trigger: User reports a bug, or asks to triage/file an issue for a reported problem.
---

# Bug Triage Skill

Triage bugs into well-structured GitHub issues on the correct upstream repo.

## 1. Pre-flight

- **Pull latest code:** `git pull origin main`. Stale code = bad triage.
- **Target repo:** Always file on the **upstream org** (`ComposioHQ/agent-orchestrator`), not forks.
- **Record source:** chat URL, reporter name, attachments.

## 2. Gather Context

### 2a. Extract the report

| Source | How to gather |
|--------|---------------|
| **Discord/Slack thread** | Read full thread. Extract: reporter name, original description (the thread starter, not whoever tagged you), screenshots, follow-ups |
| **GitHub issue** | `gh issue view <number> --repo <repo> --json body,comments` |
| **Live observation** | Pull live state via observability tools |

### 2b. Minimum viable report gate

Before tracing code, verify the report has enough substance:

**Required (ALL):** what happened, where (page/command/feature), when (after upgrade? first time?)

**Required (2 of 4):** OS/shell/runtime, AO version (`ao --version`), reproducibility (consistent vs intermittent), reproduction steps

If insufficient, ask:
> "I'd like to triage this but need more info: (1) **What happened?** (error/behavior), (2) **Where?** (page/command), (3) **When did it start?**, (4) **How to reproduce?**"

### 2c. Local diagnostics (if bug is on same machine)

Gather everything yourself before asking the reporter:

```bash
# Environment
ao --version && node --version && echo $SHELL && uname -a
cat agent-orchestrator.yaml
cat ~/.agent-orchestrator/running.json

# Process health
pm2 status
tmux list-sessions
lsof -i :3000

# AO event log — structured timeline
ao events list --limit 50                          # recent events
ao events list --session ao-5 --limit 100          # filter by session
ao events list --log-level error --since 1h        # errors only
ao events search "spawn failed"                    # full-text search
ao events stats                                    # counts by kind/source

# Session state files
cat ~/.agent-orchestrator/projects/*/sessions/*.json | python3 -m json.tool
```

Event kinds: `session.spawned`, `session.spawn_failed`, `session.killed`, `lifecycle.transition`, `ci.failing`, `review.pending`, `runtime.probe_failed`, `agent.process_probe_failed`, `reaction.escalated`, `lifecycle.poll_failed`. Sources: `lifecycle`, `session-manager`, `api`, `runtime`, `agent`, `reaction`.

**Try the reproduction steps.** Running the actual command is worth 100 lines of code tracing.

## 3. Investigate

### 3a. Trace the code path

**Always trace the actual code** — don't surface-level diagnose. [#1129](https://github.com/ComposioHQ/agent-orchestrator/issues/1129) looked like a simple `ao stop` issue but was actually a session lineage/cascade problem.

```bash
git fetch origin main && git log --oneline origin/main -5   # current HEAD
# Record the commit hash you're analyzing against
```

**Git archaeology** — find which commits introduced/removed specific code:
```bash
git log --oneline -S 'exact-string' -- <file>
git show <sha> -- <file> | grep -B 5 -A 10 'pattern'
```
Example: [#1391](https://github.com/ComposioHQ/agent-orchestrator/issues/1391) traced a mobile layout break to a `display: flex` → `display: grid` change.

**Research upstream dependencies** (xterm, node-pty, React, etc.) — check installed vs latest version, search their GitHub issues, check changelogs. Root cause is often upstream.

### 3b. Cross-platform check

AO runs on **Windows, macOS, Linux** as first-class targets. If env info indicates Windows (or is unknown), check for these patterns:

- **Path separators** — hardcoded `/` or `\` breaks cross-platform
- **Shell syntax** — PowerShell lacks `&&`, `$VAR`, `$(cat ...)`, `/dev/null`, here-docs
- **`process.platform === "win32"` inline** — must use `isWindows()` from `@aoagents/ao-core`
- **`process.kill(-pid)`** — POSIX-only; use `killProcessTree()`
- **Named pipes vs Unix sockets** — Windows uses `\\.\pipe\ao-pty-<id>`
- **`localhost`** — Windows resolves to `::1` first, causing ~21s stalls on IPv4-only servers
- **NTFS case-insensitivity** — use `pathsEqual()`, not `===`
- **ConPTY orphans** — can trigger WER dialogs if pty-host not shut down cooperatively
- **`.cmd` shim resolution** — needs `shell: true` for `PATHEXT` lookup

Key files: `packages/core/src/platform.ts`, `docs/CROSS_PLATFORM.md`, `packages/plugins/runtime-process/`, `packages/cli/src/lib/path-equality.ts`

### 3c. Stop-and-ask triggers

Stop and ask for more info if:
- **3 failed hypotheses** — traced 3 code paths, none explain it
- **Root cause is upstream** — file with upstream reference, don't guess a local fix
- **UI-only bug** and you can't screenshot — ask reporter to describe
- **Can't reproduce** — ask for different config/sequence

## 4. Search for Duplicates

Search with multiple strategies, always using `--state all` (closed bugs regress):

```bash
gh issue list --repo <repo> --state all --search "<symptom>"
gh issue list --repo <repo> --state all --search "<component-name>"
gh issue list --repo <repo> --state all --search "<error-message>"
gh pr list --repo <repo> --state all --search "<keywords>"
```

### Duplicate found → comment on existing issue

```bash
gh issue comment <number> --repo <repo> --body "$(cat <<'EOF'
## New Report
**Reported by:** @<reporter> in [chat](<url>)
**Date:** <YYYY-MM-DD> | **Checkout:** `<commit-hash>`
<context, differences from original, screenshots>
EOF
)"
```

### No duplicate → file new issue (next section)

## 5. File New Issue

### 5a. Pre-submission checklist

- [ ] Reporter attribution correct (original reporter, not who tagged you)
- [ ] Commit hash recorded
- [ ] AO version recorded
- [ ] Root cause confidence scored (see 5c)
- [ ] Related issues cross-linked
- [ ] Reproduction steps are concrete
- [ ] Screenshots uploaded with real URLs (see 5b)

### 5b. Upload screenshots

**⛔ NEVER use placeholder URLs.** Upload BEFORE creating the issue. ([#1151](https://github.com/ComposioHQ/agent-orchestrator/issues/1151) RCA on this pattern.)

```bash
SLUG="descriptive-slug"
# Create asset branch
gh api -X POST repos/<repo>/git/refs \
  -f ref="refs/heads/issue-assets-${SLUG}" \
  -f sha=$(git rev-parse origin/main)

# Upload (portable base64)
IMG_B64=$(base64 < /path/to/screenshot.png | tr -d '\n')
gh api -X PUT "repos/<repo>/contents/.issue-assets/${SLUG}/name.png" \
  -f message="chore: upload screenshot" \
  -f content="$IMG_B64" \
  -f branch="issue-assets-${SLUG}"
# Use: ![screenshot](https://raw.githubusercontent.com/<repo>/issue-assets-<slug>/.issue-assets/<file>)
```

### 5c. Create the issue

```bash
gh issue create --repo <repo> --title "<title>" --body "$(cat <<'EOF'
## Bug
<summary>

**Source:** <url> | **Reported by:** @<reporter> | **Analyzed against:** `<hash>`
**Confidence:** High/Medium/Low

## Reproduction
1. <step>

## Root Cause
<file paths, line numbers, explanation>

## Fix
<suggested approach>

## Impact
- <effects>
EOF
)"
```

### 5d. Label and prioritize

```bash
gh issue edit <number> --repo <repo> --add-label "bug"
```

| Priority label | Criteria |
|----------------|----------|
| `priority: critical` | Data loss, security, system down |
| `priority: high` | Core feature broken, no workaround |
| `priority: medium` | Feature degraded, workaround exists |
| `priority: low` | Cosmetic, edge case |

**Confidence scoring** (include in issue body):

| Level | Meaning | Extra labels |
|-------|---------|-------------|
| **High** | Traced exact code path, specific lines, mechanism explained | `bug` only |
| **Medium** | Strong hypothesis but unconfirmed | `bug`, `to-explore` |
| **Low** | Can't trace, multiple conflicting theories | `bug`, `to-reproduce` |

Example: [PR #1608](https://github.com/ComposioHQ/agent-orchestrator/pull/1608) was diagnosed High as xterm v6 issue — real cause was a `=` prefix on tmux `set-option`. Should have been Medium.

**All available labels:** `priority: critical/high/medium/low`, `bug`, `enhancement`, `good-first-issue`, `to-reproduce`, `to-explore`. No others (no `p0`, `p1`, etc.).

### 5e. Cross-link related issues

Search by subsystem and add a `## Related` section to the issue body:
```
## Related
- [#1020](url) — stale session blocking ao start (same subsystem)
- [#1035](url) — same race condition
```

### 5f. Push a fix PR (always attempt)

- **Trivial fix:** Push immediately.
- **Complex fix:** Note in issue, suggest spawning an agent.
- **Unclear fix:** Don't push a guess. Document and flag.

```bash
OLD_STRING='<old>' NEW_STRING='<new>' \
python3 skills/bug-triage/scripts/push_fix_to_github.py \
  <owner/repo> fix/slug path/to/file.tsx \
  "fix(scope): commit msg" "fix(scope): PR title" \
  "Fixes #<n>

## Summary
<what changed>

## Test
<how to verify>"
```

The script reads from GitHub API, applies one replacement, pushes, opens PR — no local checkout needed. **Verify `OLD_STRING` matches GitHub first:** `gh api repos/<repo>/contents/<path>?ref=main -q '.content' | python3 -c "import base64,sys; sys.stdout.buffer.write(base64.b64decode(sys.stdin.read()))"`

**Multiple edits to same file:** The push script does one replacement per run. For multiple changes, use a Python script to read from the branch (`gh api` + `base64.b64decode`), apply all replacements, then push via `gh api -X PUT` with the updated SHA.

### 5g. Report back

Issue URL, PR URL (if created), labels, root cause summary, whether fix agent was suggested.

---

## Appendix

### A. Subsystem Quick Reference

| Subsystem | Collect | Key files |
|-----------|---------|-----------|
| **CLI** (`ao start/stop/spawn`) | Config YAML, install method, version, OS | `packages/cli/src/commands/` |
| **Web UI** | Screenshot, browser, viewport | `packages/web/src/components/`, `globals.css` |
| **Terminal** | Runtime type, tmux version, shell | `DirectTerminal.tsx`, `useXtermTerminal.ts` |
| **Lifecycle** | State transitions, session IDs | `core/src/lifecycle-manager.ts`, `core/src/lifecycle-state.ts` |
| **Sessions** | Session ID, spawn config, runtime | `core/src/session-manager.ts` |
| **Plugins** | Plugin name, agent version | `packages/plugins/<agent>/` |
| **Config** | YAML contents, project path | `packages/core/src/config.ts` |

**Misrouting patterns:**
- Terminal bugs → tmux (runtime-tmux) vs xterm (web) vs PTY (runtime-process/Windows). Trace where bytes flow.
- "Session stuck" → lifecycle state machine vs agent process vs runtime connection.
- "Config not saving" → config loading (c12) vs project registration (running-state.ts) vs YAML write (permissions).

### B. Remote Code Inspection (no local clone)

```bash
gh api repos/{owner}/{repo}/git/trees/main?recursive=1 --jq '.tree[].path'    # list files
gh api repos/{owner}/{repo}/contents/{path} --jq '.content' | python3 -c "import base64,sys; sys.stdout.buffer.write(base64.b64decode(sys.stdin.read()))"  # read file
gh search code "term" --repo {owner}/{repo} --json path --jq '.[].path'        # search code
gh api "repos/{owner}/{repo}/commits?path={path}&per_page=10" --jq '.[] | "\(.sha[0:8]) \(.commit.message | split("\n")[0])"'  # file history
```

### C. NPM Package Regression Diffing

Diff **published** packages (not local builds) when regression follows an upgrade:

```bash
mkdir -p /tmp/ao-diff/{v1,v2}
curl -sL https://registry.npmjs.org/@scope/pkg/-/pkg-OLD.tgz | tar xz -C /tmp/ao-diff/v1
curl -sL https://registry.npmjs.org/@scope/pkg/-/pkg-NEW.tgz | tar xz -C /tmp/ao-diff/v2
diff -rq /tmp/ao-diff/v1/package/ /tmp/ao-diff/v2/package/
```

Example: [PR #1608](https://github.com/ComposioHQ/agent-orchestrator/pull/1608) — source analysis led to wrong theories, npm diff showed the only change was a `=` prefix on tmux `set-option`.

## Formatting Rules

- **Linkify all issue/PR refs:** `[#123](https://github.com/ComposioHQ/agent-orchestrator/issues/123)`, `[PR #456](url)`. Never bare `#123`.

## Pitfalls

- **Reporter ≠ person who tagged you.** Always attribute to the original reporter.
- **Record the commit hash** you analyzed — code changes fast.
- **GitHub issue is mandatory** — every triaged bug gets one, even if fix is trivial.
- **`gh api --jq .content` truncates large files** (>~100KB). Use local git instead.
- **Push script arg limits** — long commit messages hit `OSError: Argument list too long`. Use a Python script with JSON payloads instead.
- **`OLD_STRING` must match GitHub byte-for-byte** — local code may differ from `origin/main`.
- **New fields on shared TS interfaces MUST be optional** (`field?: Type`). Downstream `Partial<X>` spreads break on required fields. Example: [PR #1523](https://github.com/ComposioHQ/agent-orchestrator/pull/1523).
