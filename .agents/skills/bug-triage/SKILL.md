---
name: bug-triage
description: Triage bugs reported in chat/issues, search for duplicates, file or update GitHub issues with full context, and push fix PRs.
trigger: User reports a bug, or asks to triage/file an issue for a reported problem.
---

# Bug Triage Skill

Triage bugs into well-structured GitHub issues on the ReverbCode repo.

> **ReverbCode is Go + Electron.** The backend is a Go daemon (`backend/`)
> exposing a loopback HTTP API on `127.0.0.1:3001`; the frontend is an Electron +
> React supervisor (`frontend/`). There is **no** pm2/tmux/Node runtime here —
> the daemon owns lifecycle and sessions run under the **Zellij** runtime
> adapter. Triage against _this_ stack, not the old TypeScript agent-orchestrator.

## ⚠️ Which `ao` are you running?

**`ReverbCode` ships no `ao` on your PATH.** A bare `ao` very likely resolves to a
**different** AO install — e.g. an old npm build at `~/.nvm/.../bin/ao` that talks
to port **:3000**. Triaging with the wrong binary produces bugs that don't exist
in ReverbCode (and miss ones that do).

Before any diagnostics:

```bash
which -a ao                      # see every ao on PATH — expect surprises
ao status 2>/dev/null            # if this shows port 3000, it is NOT ReverbCode
```

Use a ReverbCode binary explicitly:

```bash
# Option A — build from this repo (preferred during triage)
cd backend && go build -o /tmp/ao ./cmd/ao
/tmp/ao status                   # must report port: 3001

# Option B — the packaged app's bundled daemon
"/Applications/Agent Orchestrator.app/Contents/Resources/daemon/ao" status
```

**Confirm `ao status` reports `port: 3001` before trusting any output.** Throughout
this skill, `ao` means _your verified ReverbCode binary_ (`/tmp/ao` or the bundled
one), never a bare PATH lookup.

> Note: spawned sessions get a PATH pin so the _session's_ `ao` resolves to the
> daemon's own executable (see `hookPATH` in
> `backend/internal/session_manager/manager.go`). That pin only applies inside
> sessions — your interactive shell is still on its own PATH, so pin it yourself.

## 1. Pre-flight

- **Pull latest code:** `git pull origin main`. Stale code = bad triage.
- **Target repo:** Always file on **`aoagents/ReverbCode`** (the product repo, not
  a fork). ReverbCode is the product, not a thin fork of upstream.
- **Verify your binary:** confirm `ao status` shows port **3001** (see warning above).
- **Record source:** chat URL, reporter name, attachments.

## 2. Gather Context

### 2a. Extract the report

| Source                   | How to gather                                                                                                                        |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| **Discord/Slack thread** | Read full thread. Extract: reporter name, original description (the thread starter, not whoever tagged you), screenshots, follow-ups |
| **GitHub issue**         | `gh issue view <number> --repo aoagents/ReverbCode --json body,comments`                                                             |
| **Live observation**     | Pull live state via the daemon: `ao status`, `ao session ls`, `ao session get <id>`                                                  |

### 2b. Minimum viable report gate

Before tracing code, verify the report has enough substance:

**Required (ALL):** what happened, where (page/command/feature), when (after upgrade? first time?)

**Required (2 of 4):** OS/shell, AO version (`ao version`), reproducibility (consistent vs intermittent), reproduction steps

If insufficient, ask:

> "I'd like to triage this but need more info: (1) **What happened?** (error/behavior), (2) **Where?** (page/command), (3) **When did it start?**, (4) **How to reproduce?**"

### 2c. Local diagnostics (if bug is on same machine)

Gather everything yourself before asking the reporter. Use your **verified**
ReverbCode binary (`/tmp/ao` here) for every `ao` call:

```bash
# Environment
/tmp/ao version && go version && echo $SHELL && uname -a
which -a ao                                         # confirm no rogue ao shadows the build
cat ~/.ao/running.json                              # PID + port handshake (expect port 3001)

# Daemon health
/tmp/ao status                                      # daemon up? port? health/ready probes
/tmp/ao doctor                                      # local health checks
lsof -i :3001                                       # who's bound to the daemon port
tail -n 100 ~/.ao/daemon.log                        # daemon log

# Sessions & runtime
/tmp/ao session ls                                  # all sessions and their state
/tmp/ao session get <id>                            # one session: spawn config, runtime, lifecycle
zellij list-sessions                                # Zellij runtime sessions backing terminals

# Durable state (SQLite at ~/.ao/data)
sqlite3 ~/.ao/data/ao.db '.tables'                  # inspect schema/rows if state looks wrong
```

The daemon owns lifecycle, sessions, storage, and the terminal mux; structured
state lives in `~/.ao/data/ao.db` (WAL: `ao.db-wal`, `ao.db-shm`). The PID+port
handshake is `~/.ao/running.json`.

**Try the reproduction steps.** Running the actual command against the daemon on
:3001 is worth 100 lines of code tracing.

## 3. Investigate

### 3a. Trace the code path

**Always trace the actual code** — don't surface-level diagnose. A symptom that
looks like a simple `ao stop` issue is often a lifecycle/session-manager problem
one layer down. ReverbCode's layers:

- CLI (Cobra, thin client over daemon HTTP): `backend/internal/cli/`, entrypoint
  `backend/cmd/ao/main.go`
- Daemon (loopback HTTP on :3001): `backend/internal/daemon/daemon.go`,
  controllers under `backend/internal/httpd/controllers/`
- Sessions & lifecycle: `backend/internal/session_manager/manager.go`
- Runtime adapter (Zellij): `backend/internal/adapters/runtime/`
- Agent harness adapters: `backend/internal/adapters/agent/<harness>/`
- Terminal mux: `backend/internal/terminal/`
- Agent hooks: `backend/internal/cli/hooks.go`

```bash
git fetch origin main && git log --oneline origin/main -5   # current HEAD
# Record the commit hash you're analyzing against
```

**Git archaeology** — find which commits introduced/removed specific code:

```bash
git log --oneline -S 'exact-string' -- <file>
git show <sha> -- <file> | grep -B 5 -A 10 'pattern'
```

**Research dependencies** (Zellij, the agent harness binary, Electron, React, the
SQLite driver) — check installed vs latest version, search their issue trackers,
check changelogs. Root cause is sometimes in a dependency, not ReverbCode.

### 3b. Cross-platform check

AO targets **macOS, Linux, and Windows**. If env info indicates Windows (or is
unknown), check for these patterns:

- **Path separators** — hardcoded `/` or `\`; use `filepath.Join`, not string concat
- **Shell syntax** — PowerShell lacks `&&`, `$VAR`, `$(cat ...)`, `/dev/null`, here-docs
- **`runtime.GOOS == "windows"` scattered inline** — centralize platform checks
- **Process-tree kills** — POSIX process groups vs Windows job objects
- **`localhost`** — Windows resolves to `::1` first; the daemon binds the explicit
  loopback host (see `config.LoopbackHost`) to avoid IPv4/IPv6 stalls
- **Case-insensitive filesystems** — don't compare paths with raw `==`
- **PATH / binary resolution** — `.exe`/`PATHEXT` lookup, the session PATH pin
  (`hookPATH` in `backend/internal/session_manager/manager.go`)

Key files: `backend/internal/config/config.go`, `backend/internal/session_manager/manager.go`,
`backend/internal/adapters/runtime/`, `backend/internal/terminal/`.

### 3c. Stop-and-ask triggers

Stop and ask for more info if:

- **3 failed hypotheses** — traced 3 code paths, none explain it
- **Root cause is a dependency** — file with the dependency reference, don't guess a local fix
- **UI-only bug** and you can't screenshot — ask reporter to describe
- **Can't reproduce** — ask for different config/sequence

## 4. Search for Duplicates

Search with multiple strategies, always using `--state all` (closed bugs regress):

```bash
gh issue list --repo aoagents/ReverbCode --state all --search "<symptom>"
gh issue list --repo aoagents/ReverbCode --state all --search "<component-name>"
gh issue list --repo aoagents/ReverbCode --state all --search "<error-message>"
gh pr list --repo aoagents/ReverbCode --state all --search "<keywords>"
```

### Duplicate found → comment on existing issue

```bash
gh issue comment <number> --repo aoagents/ReverbCode --body "$(cat <<'EOF'
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
- [ ] AO version recorded (`ao version`)
- [ ] Reproduced against ReverbCode (:3001 / Go code path), not another AO install
- [ ] Root cause confidence scored (see 5c)
- [ ] Related issues cross-linked
- [ ] Reproduction steps are concrete
- [ ] Screenshots uploaded with real URLs (see 5b)

### 5b. Upload screenshots

**⛔ NEVER use placeholder URLs.** Upload BEFORE creating the issue.

```bash
SLUG="descriptive-slug"
# Create asset branch
gh api -X POST repos/aoagents/ReverbCode/git/refs \
  -f ref="refs/heads/issue-assets-${SLUG}" \
  -f sha=$(git rev-parse origin/main)

# Upload (portable base64)
IMG_B64=$(base64 < /path/to/screenshot.png | tr -d '\n')
gh api -X PUT "repos/aoagents/ReverbCode/contents/.issue-assets/${SLUG}/name.png" \
  -f message="chore: upload screenshot" \
  -f content="$IMG_B64" \
  -f branch="issue-assets-${SLUG}"
# Use: ![screenshot](https://raw.githubusercontent.com/aoagents/ReverbCode/issue-assets-<slug>/.issue-assets/<file>)
```

### 5c. Create the issue

```bash
gh issue create --repo aoagents/ReverbCode --title "<title>" --body "$(cat <<'EOF'
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

**Check which labels actually exist first**, then apply only those:

```bash
gh label list --repo aoagents/ReverbCode          # source of truth — apply only these
gh issue edit <number> --repo aoagents/ReverbCode --add-label "bug"
```

The repo currently carries `bug`, `enhancement`, `priority: critical/high/medium/low`,
lane labels (`daemon`, `frontend`, `storage`, `coding-agents`, `lcm-sm`, `scm`,
`core`, `port`, `adapter`, `domain`), and workflow labels (`needs-triage`,
`needs-review`, `blocked`). **Do not invent labels** — if a priority or confidence
label you want doesn't exist, **state it in the issue body instead** (e.g.
"**Priority:** high — core feature broken, no workaround" / "**Confidence:** medium").

| Priority             | Criteria                            |
| -------------------- | ----------------------------------- |
| `priority: critical` | Data loss, security, system down    |
| `priority: high`     | Core feature broken, no workaround  |
| `priority: medium`   | Feature degraded, workaround exists |
| `priority: low`      | Cosmetic, edge case                 |

**Confidence scoring** (always state in the issue body):

| Level      | Meaning                                                     |
| ---------- | ----------------------------------------------------------- |
| **High**   | Traced exact code path, specific lines, mechanism explained |
| **Medium** | Strong hypothesis but unconfirmed                           |
| **Low**    | Can't trace, multiple conflicting theories                  |

### 5e. Cross-link related issues

Search by subsystem and add a `## Related` section to the issue body:

```
## Related
- [#20](url) — stale session blocking ao start (same subsystem)
- [#35](url) — same race condition
```

### 5f. Push a fix PR (always attempt)

ReverbCode is a Go repo — fixes go through a local branch, build, and `gh pr create`.
There is no remote-patch script.

- **Unclear fix:** Don't push a guess. Document and flag in the issue.
- **Trivial, verifiable fix** (you can build and test it yourself):

  ```bash
  git checkout -b fix/<slug> origin/main
  # make the edit
  cd backend && go build ./... && go test ./...   # must pass before pushing
  git commit -am "fix(<scope>): <summary>

  Fixes #<n>"
  git push -u origin fix/<slug>
  gh pr create --repo aoagents/ReverbCode --fill \
    --title "fix(<scope>): <summary>" \
    --body "Fixes #<n>

  ## Summary
  <what changed>

  ## Test
  cd backend && go build ./... && go test ./..."
  ```

- **Non-trivial fix** (broad change, needs iteration, or you can't fully verify):
  spawn a ReverbCode worker session to do the work in its own worktree instead of
  pushing a guess:

  ```bash
  ao spawn --project reverbcode --prompt "Fix #<n>: <one-line problem statement>. \
  Root cause: <file:line + mechanism>. Suggested approach: <approach>. \
  Build with 'cd backend && go build ./... && go test ./...' before opening a PR against aoagents/ReverbCode."
  ```

  Note the issue with which path you took (PR or spawned worker).

### 5g. Report back

Issue URL, PR URL (if created) or spawned worker session ID, labels applied (and
any priority/confidence stated in the body), root cause summary.

---

## Appendix

### A. Subsystem Quick Reference

| Subsystem                       | Collect                                   | Key files                                                                  |
| ------------------------------- | ----------------------------------------- | -------------------------------------------------------------------------- |
| **CLI** (`ao start/stop/spawn`) | Version, install method, OS, which binary | `backend/internal/cli/`, `backend/cmd/ao/main.go`                          |
| **Daemon / HTTP API**           | `ao status`, port, daemon.log             | `backend/internal/daemon/daemon.go`, `backend/internal/httpd/controllers/` |
| **Sessions / Lifecycle**        | Session ID, spawn config, runtime, state  | `backend/internal/session_manager/manager.go`                              |
| **Runtime (Zellij)**            | Zellij version, `zellij list-sessions`    | `backend/internal/adapters/runtime/`                                       |
| **Terminal mux**                | Runtime type, shell, attach behavior      | `backend/internal/terminal/`                                               |
| **Agent harness**               | Harness name + version                    | `backend/internal/adapters/agent/<harness>/`                               |
| **Storage**                     | DB state, migrations                      | `backend/internal/storage/sqlite/`, `~/.ao/data/ao.db`                     |
| **Hooks**                       | Hook event, agent, payload                | `backend/internal/cli/hooks.go`                                            |
| **Frontend (Electron/React)**   | Screenshot, viewport, daemon connectivity | `frontend/src/`                                                            |

**Misrouting patterns:**

- Terminal bugs → Zellij runtime adapter vs the terminal mux vs the Electron xterm
  surface. Trace where bytes flow (daemon → mux → frontend).
- "Session stuck" → lifecycle/session-manager state vs agent harness process vs
  Zellij runtime connection.
- "Config not saving" → config loading (`backend/internal/config/config.go`) vs
  project registration vs SQLite write (`~/.ao/data/ao.db`).
- "Command does nothing / wrong port" → you're on the wrong `ao` binary (:3000 vs
  :3001). Re-check `which -a ao` and `ao status`.

### B. Remote Code Inspection (no local clone)

```bash
gh api repos/aoagents/ReverbCode/git/trees/main?recursive=1 --jq '.tree[].path'    # list files
gh api repos/aoagents/ReverbCode/contents/{path} --jq '.content' | python3 -c "import base64,sys; sys.stdout.buffer.write(base64.b64decode(sys.stdin.read()))"  # read file
gh search code "term" --repo aoagents/ReverbCode --json path --jq '.[].path'        # search code
gh api "repos/aoagents/ReverbCode/commits?path={path}&per_page=10" --jq '.[] | "\(.sha[0:8]) \(.commit.message | split("\n")[0])"'  # file history
```

### C. Build / Version Diagnostics

ReverbCode is built from source, not published to npm. Pin the binary under test
and reproduce against a known build:

```bash
cd backend && go build -o /tmp/ao ./cmd/ao    # build the binary under test
/tmp/ao version                               # record version/commit
go version                                    # toolchain (build issues are often here)
git log --oneline origin/main -1              # the commit you're analyzing against
```

To bisect a regression, build `ao` at two commits and compare behavior:

```bash
git stash; git checkout <good-sha>; (cd backend && go build -o /tmp/ao-good ./cmd/ao)
git checkout <bad-sha>;             (cd backend && go build -o /tmp/ao-bad  ./cmd/ao)
git checkout - ; git stash pop
# run the repro against /tmp/ao-good vs /tmp/ao-bad
```

## Formatting Rules

- **Linkify all issue/PR refs:** `[#123](https://github.com/aoagents/ReverbCode/issues/123)`, `[PR #456](url)`. Never bare `#123`.

## Pitfalls

- **Wrong `ao` binary.** A bare `ao` may be a different AO install (old npm build on
  :3000). Always pin a ReverbCode binary and confirm `ao status` shows port **3001**.
- **Verify the bug reproduces against ReverbCode (:3001 / Go code path) before
  filing** — symptoms first seen in another AO install may not reproduce here.
- **Reporter ≠ person who tagged you.** Always attribute to the original reporter.
- **Record the commit hash** you analyzed — code changes fast.
- **GitHub issue is mandatory** — every triaged bug gets one, even if fix is trivial.
- **Only apply labels that exist** (`gh label list --repo aoagents/ReverbCode`).
  State priority/confidence in the body when no matching label exists.
- **Build before you push.** `cd backend && go build ./... && go test ./...` must
  pass; never open a PR with an unverified Go change.
- **`gh api --jq .content` truncates large files** (>~100KB). Use local git instead.
- **Don't invent Go file paths.** Grep the repo to confirm a path before citing it
  in an issue.
