#!/usr/bin/env bash
#
# scripts/demo-pr-1466.sh
#
# End-to-end demo for PR #1466 (storage redesign + cross-project CLI rework).
# Designed to be run live for a screencast — silent narration via section
# banners, no live typing, deterministic output.
#
# Strict sandbox: redirects $HOME to /tmp/ao-demo-1466 so getAoBaseDir()
# resolves there instead of touching the operator's real ~/.agent-orchestrator.
# After the script exits the original $HOME of the parent shell is unaffected.
#
# Usage:
#   scripts/demo-pr-1466.sh
#
# Re-run is idempotent — wipes and recreates the sandbox each time.
#

set -euo pipefail

# ─── config ────────────────────────────────────────────────────────────────

DEMO_HOME="/tmp/ao-demo-1466"
DEMO_PORT="3947"
AO_REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AO_CLI="$AO_REPO/packages/cli/dist/index.js"

# Save the operator's real HOME so we can restore it for sub-commands
# that legitimately need it (running the full test suites — tests read
# getGlobalConfigPath() which honors AO_GLOBAL_CONFIG, and a sandboxed
# global config would break tests that touch the global registry).
REAL_HOME="$HOME"

# Sandbox the entire script under a fake HOME so AO's hardcoded
# ~/.agent-orchestrator path is redirected. Belt-and-suspenders: also
# pin AO_GLOBAL_CONFIG explicitly.
export HOME="$DEMO_HOME"
export AO_GLOBAL_CONFIG="$DEMO_HOME/.agent-orchestrator/config.yaml"

# Local CLI invoker — never use the system `ao`.
ao() {
  node "$AO_CLI" "$@"
}

banner() {
  printf '\n'
  printf '═══════════════════════════════════════════════════════════════════════\n'
  printf '  %s\n' "$1"
  printf '═══════════════════════════════════════════════════════════════════════\n'
  sleep 2
}

step() {
  printf '\n→ %s\n' "$1"
  sleep 1
}

note() {
  printf '   %s\n' "$1"
}

# ─── pre-flight ────────────────────────────────────────────────────────────

banner "Pre-flight: build CLI + reset sandbox"

if [[ ! -f "$AO_CLI" ]]; then
  note "CLI bundle not found, building..."
  (cd "$AO_REPO" && pnpm --filter @aoagents/ao-cli build >/dev/null)
fi

rm -rf "$DEMO_HOME"
mkdir -p "$DEMO_HOME/.agent-orchestrator"

# Minimal git config so worktree operations during the demo don't fail
# from the redirected HOME.
cat >"$DEMO_HOME/.gitconfig" <<'GITCONFIG'
[user]
  name = AO Demo
  email = demo@example.com
[init]
  defaultBranch = main
[advice]
  detachedHead = false
GITCONFIG

note "Repo:    $AO_REPO"
note "CLI:     $AO_CLI"
note "Sandbox: $DEMO_HOME"
note "Port:    $DEMO_PORT (no real ao daemon spawned in this demo)"
sleep 2

# ─── helpers: realistic project + session seeding ─────────────────────────

# seed_project DIR PKG_NAME
# Creates a real-looking Node/TypeScript project at DIR with multiple
# commits so reviewers see a credible source tree, not an empty README.
seed_project() {
  local dir="$1"
  local pkg="$2"
  mkdir -p "$dir/src/lib" "$dir/tests"

  cat >"$dir/package.json" <<EOF
{
  "name": "${pkg}",
  "version": "0.1.0",
  "description": "Demo project for the PR #1466 migration screencast",
  "type": "module",
  "main": "dist/index.js",
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "lint": "eslint src/"
  },
  "dependencies": { "zod": "^3.22.0" },
  "devDependencies": { "typescript": "^5.4.0", "vitest": "^1.0.0" }
}
EOF

  cat >"$dir/src/index.ts" <<'EOF'
import { processInput, validate } from "./lib/util.js";
import type { Result } from "./lib/types.js";

export async function main(input: string): Promise<Result> {
  const validated = validate(input);
  return processInput(validated);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv[2] ?? "")
    .then((r) => console.log(r))
    .catch((e) => {
      console.error("error:", e.message);
      process.exit(1);
    });
}
EOF

  cat >"$dir/src/lib/util.ts" <<'EOF'
import type { Result, Validated } from "./types.js";

export function validate(input: string): Validated {
  if (!input || input.length < 2) throw new Error("input must be at least 2 chars");
  return { value: input.trim(), receivedAt: new Date().toISOString() };
}

export async function processInput(v: Validated): Promise<Result> {
  return { input: v.value, output: v.value.toUpperCase(), processedAt: new Date().toISOString() };
}
EOF

  cat >"$dir/src/lib/types.ts" <<'EOF'
export interface Validated { value: string; receivedAt: string }
export interface Result { input: string; output: string; processedAt: string }
EOF

  cat >"$dir/tests/index.test.ts" <<'EOF'
import { describe, it, expect } from "vitest";
import { main } from "../src/index.js";

describe("main", () => {
  it("uppercases input", async () => {
    expect((await main("hello")).output).toBe("HELLO");
  });

  it("rejects too-short input", async () => {
    await expect(main("")).rejects.toThrow();
  });
});
EOF

  cat >"$dir/.gitignore" <<'EOF'
node_modules/
dist/
*.log
.env
.DS_Store
EOF

  cat >"$dir/tsconfig.json" <<'EOF'
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "strict": true,
    "esModuleInterop": true,
    "outDir": "dist",
    "declaration": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*"]
}
EOF

  cat >"$dir/README.md" <<EOF
# ${pkg}

Demo project for the AO PR #1466 migration screencast. Standard TypeScript
package layout — sources in \`src/\`, tests in \`tests/\`, vitest harness.

## Develop

\`\`\`bash
pnpm install
pnpm test
pnpm build
\`\`\`
EOF

  # Commit history so the project looks alive, not stamped-out
  git -C "$dir" init --quiet -b main
  git -C "$dir" add README.md .gitignore
  git -C "$dir" commit -q -m "init: scaffold ${pkg}"
  git -C "$dir" add tsconfig.json package.json
  git -C "$dir" commit -q -m "chore: typescript + package.json"
  git -C "$dir" add src/lib/types.ts
  git -C "$dir" commit -q -m "feat: add Validated and Result types"
  git -C "$dir" add src/lib/util.ts
  git -C "$dir" commit -q -m "feat: validate and processInput helpers"
  git -C "$dir" add src/index.ts
  git -C "$dir" commit -q -m "feat: main entry point"
  git -C "$dir" add tests/index.test.ts
  git -C "$dir" commit -q -m "test: cover main happy path and validation"
}

# seed_session HASH_DIR SESSION_ID PROJECT_KEY METADATA_BODY
seed_session() {
  local hash_dir="$1"
  local sid="$2"
  shift 2
  local body="$*"
  printf '%s\n' "$body" >"$hash_dir/sessions/$sid"
}

# ───────────────────────────────────────────────────────────────────────────
banner "Act 1 — Migration: V1 hash dirs → V2 projects/  (most-reviewed code)"
# ───────────────────────────────────────────────────────────────────────────

step "Seed a realistic environment: 2 projects, 6 sessions, real worktree content"

# Project 1: myproject (TS package, full source tree, 6-commit history)
DEMO_REPO_A="$DEMO_HOME/myproject"
seed_project "$DEMO_REPO_A" "myproject"

# Project 2: frontend (also TS package — different code so two distinct projects)
DEMO_REPO_B="$DEMO_HOME/frontend"
seed_project "$DEMO_REPO_B" "frontend"

# ── V1 hash dir 1: myproject ──────────────────────────────────────────────
# In V1: terminated sessions were MOVED from sessions/<sid> into
# sessions/archive/<sid>_<timestamp> as separate files. Active sessions
# stayed in sessions/<sid>.
# In V2 (this PR): the archive directory is removed entirely. Terminated
# sessions just stay in sessions/<sid>.json with lifecycle.session.state =
# "terminated". The migrator flattens archive entries into sessions/.
HASH_DIR_A="$DEMO_HOME/.agent-orchestrator/aaaaaa000000-myproject"
mkdir -p "$HASH_DIR_A/sessions/archive" "$HASH_DIR_A/worktrees"

LIFECYCLE_WORKING='{"version":2,"session":{"kind":"worker","state":"working"},"runtime":{"state":"alive"},"pr":{"state":"unknown"}}'
LIFECYCLE_STUCK='{"version":2,"session":{"kind":"worker","state":"stuck","reason":"agent_idle_too_long"},"runtime":{"state":"alive"},"pr":{"state":"unknown"}}'
LIFECYCLE_ORCH='{"version":2,"session":{"kind":"orchestrator","state":"working"},"runtime":{"state":"alive"},"pr":{"state":"none"}}'

# ao-1: the headline session — has BOTH agent-report state AND report-watcher
# counters set, plus PR fields. Exercises the entire @ashish921998 flat-key
# contract in a single record.
seed_session "$HASH_DIR_A" "ao-1" \
"project=myproject
agent=claude-code
status=working
createdAt=2026-04-21T12:00:00.000Z
agentReportedState=needs_input
agentReportedAt=2026-04-21T12:35:00.000Z
agentReportedNote=please clarify the spec
agentReportedPrUrl=https://github.com/demo/myproject/pull/41
agentReportedPrNumber=41
agentReportedPrIsDraft=true
reportWatcherTriggerCount=2
reportWatcherActiveTrigger=stale_report
reportWatcherTriggerActivatedAt=2026-04-21T12:30:00.000Z
reportWatcherLastAuditedAt=2026-04-21T12:36:00.000Z
prAutoDetect=on
dashboardPort=3000
terminalWsPort=3001
branch=session/ao-1
worktree=$DEMO_REPO_A/worktrees/ao-1
statePayload=$LIFECYCLE_WORKING
stateVersion=2
issue=demo/myproject#101
pr=demo/myproject#41
runtimeHandle={\"id\":\"ao-1\",\"runtimeName\":\"tmux\",\"data\":{\"name\":\"my-1\"}}"

# ao-3: stuck session with report-watcher counter (also exercises @ashish921998 fix)
seed_session "$HASH_DIR_A" "ao-3" \
"project=myproject
agent=claude-code
status=stuck
createdAt=2026-04-21T13:00:00.000Z
agentReportedState=working
agentReportedAt=2026-04-21T14:50:00.000Z
reportWatcherTriggerCount=3
reportWatcherActiveTrigger=stale_report
reportWatcherTriggerActivatedAt=2026-04-21T14:00:00.000Z
reportWatcherLastAuditedAt=2026-04-21T14:55:00.000Z
prAutoDetect=on
dashboardPort=3000
branch=session/ao-3
worktree=$DEMO_REPO_A/worktrees/ao-3
statePayload=$LIFECYCLE_STUCK
stateVersion=2"

# Orchestrator session — different `kind`, exercises lifecycle.session.kind=orchestrator
seed_session "$HASH_DIR_A" "my-orchestrator-1" \
"project=myproject
agent=claude-code
status=working
createdAt=2026-04-21T11:00:00.000Z
prAutoDetect=on
dashboardPort=3000
branch=orchestrator/my-orchestrator-1
worktree=$DEMO_REPO_A/worktrees/my-orchestrator-1
statePayload=$LIFECYCLE_ORCH
stateVersion=2
role=orchestrator"

# ao-2 in archive — V1 archive file at sessions/archive/<sid>_<ts>.
# Migration's job: flatten this into sessions/ao-2.json with terminated lifecycle.
cat >"$HASH_DIR_A/sessions/archive/ao-2_20260420T100000Z" <<'V1META'
project=myproject
agent=claude-code
status=killed
createdAt=2026-04-20T08:00:00.000Z
branch=session/ao-2
statePayload={"version":2,"session":{"kind":"worker","state":"terminated","reason":"manually_killed"},"runtime":{"state":"missing","reason":"manual_kill_requested"},"pr":{"state":"unknown"}}
stateVersion=2
V1META

# Real worktree content for ao-1 — proves worktree migration moves files,
# not just empty directories. Uses git worktree add so it's a registered
# worktree, exactly what the migrator handles in production.
git -C "$DEMO_REPO_A" worktree add -b session/ao-1 "$HASH_DIR_A/worktrees/ao-1" main >/dev/null 2>&1 || true
echo "// pending edits for issue #101" >"$HASH_DIR_A/worktrees/ao-1/src/lib/util.ts.draft"

# ── V1 hash dir 2: frontend ───────────────────────────────────────────────
HASH_DIR_B="$DEMO_HOME/.agent-orchestrator/bbbbbb111111-frontend"
mkdir -p "$HASH_DIR_B/sessions/archive" "$HASH_DIR_B/worktrees"

# fe-1: working session with PR fields populated
seed_session "$HASH_DIR_B" "fe-1" \
"project=frontend
agent=claude-code
status=pr_open
createdAt=2026-04-21T09:00:00.000Z
prAutoDetect=on
dashboardPort=3000
branch=session/fe-1
worktree=$DEMO_REPO_B/worktrees/fe-1
issue=demo/frontend#7
pr=demo/frontend#12
statePayload={\"version\":2,\"session\":{\"kind\":\"worker\",\"state\":\"working\"},\"runtime\":{\"state\":\"alive\"},\"pr\":{\"state\":\"open\",\"number\":12}}
stateVersion=2"

# fe-2 in archive — terminated by runtime_lost
cat >"$HASH_DIR_B/sessions/archive/fe-2_20260419T160000Z" <<'V1META'
project=frontend
agent=claude-code
status=killed
createdAt=2026-04-19T14:00:00.000Z
branch=session/fe-2
statePayload={"version":2,"session":{"kind":"worker","state":"terminated","reason":"runtime_lost"},"runtime":{"state":"missing","reason":"agent_process_exited"},"pr":{"state":"unknown"}}
stateVersion=2
V1META

# ── Pre-seed the global config the migrator reads ────────────────────────
cat >"$DEMO_HOME/.agent-orchestrator/config.yaml" <<CFG
port: $DEMO_PORT
defaults:
  runtime: tmux
  agent: claude-code
  workspace: worktree
  notifiers: []
projects:
  myproject:
    projectId: myproject
    path: $DEMO_REPO_A
    repo:
      owner: demo
      name: myproject
      platform: github
      originUrl: https://github.com/demo/myproject
    defaultBranch: main
    source: ao-project-add
    registeredAt: 1776000000
    displayName: myproject
    sessionPrefix: my
    storageKey: aaaaaa000000
  frontend:
    projectId: frontend
    path: $DEMO_REPO_B
    repo:
      owner: demo
      name: frontend
      platform: github
      originUrl: https://github.com/demo/frontend
    defaultBranch: main
    source: ao-project-add
    registeredAt: 1776000100
    displayName: frontend
    sessionPrefix: fe
    storageKey: bbbbbb111111
CFG

step "Before — V1 layout on disk (real repo + multi-session inventory)"
echo "  Source repos (realistic TS package layout, multi-commit history):"
echo "    myproject/  ($(git -C "$DEMO_REPO_A" log --oneline | wc -l | tr -d ' ') commits, $(find "$DEMO_REPO_A" -type f -not -path '*/.git/*' -not -path '*/worktrees/*' | wc -l | tr -d ' ') files)"
echo "    frontend/   ($(git -C "$DEMO_REPO_B" log --oneline | wc -l | tr -d ' ') commits, $(find "$DEMO_REPO_B" -type f -not -path '*/.git/*' -not -path '*/worktrees/*' | wc -l | tr -d ' ') files)"
echo
echo "  ~/.agent-orchestrator/  (V1: hash-prefixed dirs, key=value session files):"
ls -1 "$DEMO_HOME/.agent-orchestrator/" | sed 's/^/    /'
echo
echo "  V1 hash dir 1 (myproject):"
echo "    sessions/         : $(ls "$HASH_DIR_A/sessions" | grep -v '^archive$' | tr '\n' ' ')"
echo "    sessions/archive/ : $(ls "$HASH_DIR_A/sessions/archive" 2>/dev/null | tr '\n' ' ')"
echo "    worktrees/        : $(ls "$HASH_DIR_A/worktrees" 2>/dev/null | tr '\n' ' ')"
echo
echo "  V1 hash dir 2 (frontend):"
echo "    sessions/         : $(ls "$HASH_DIR_B/sessions" | grep -v '^archive$' | tr '\n' ' ')"
echo "    sessions/archive/ : $(ls "$HASH_DIR_B/sessions/archive" 2>/dev/null | tr '\n' ' ')"
echo
echo "  Session metadata format (key=value, flat strings) — ao-1:"
sed 's/^/    /' "$HASH_DIR_A/sessions/ao-1"
sleep 6

step "ao migrate-storage --dry-run  (shows the plan, mutates nothing)"
ao migrate-storage --dry-run --force || true
sleep 3

step "ao migrate-storage  (atomic per-project, with rollback on failure)"
ao migrate-storage --force
sleep 2

step "After — V2 layout (projects/{projectId}/sessions/{sid}.json)"
echo "  Top level:"
ls -1 "$DEMO_HOME/.agent-orchestrator/" | sed 's/^/    /'
echo
echo "  projects/ (one dir per project, archives flattened into sessions/):"
for p in "$DEMO_HOME"/.agent-orchestrator/projects/*; do
  pname=$(basename "$p")
  [[ "$pname" == *.migrated ]] && continue
  echo "    $pname/"
  echo "      sessions/  : $(ls "$p/sessions" 2>/dev/null | tr '\n' ' ')"
  if [[ -d "$p/worktrees" ]]; then
    echo "      worktrees/ : $(ls "$p/worktrees" 2>/dev/null | tr '\n' ' ')"
  fi
done
echo
# Inspect the JSON for ao-1 (the headline session: agent-report state set,
# PR fields, runtimeHandle as embedded JSON — exercises the most fields).
MIGRATED_PROJECT="myproject"
SESSION_JSON="$DEMO_HOME/.agent-orchestrator/projects/$MIGRATED_PROJECT/sessions/ao-1.json"
sleep 4

step "Migrated session JSON (note: typed fields, no key=value soup)"
node -e "
const fs = require('fs');
const d = JSON.parse(fs.readFileSync('$SESSION_JSON', 'utf-8'));
const out = {
  branch: d.branch, status: d.status, agent: d.agent, prAutoDetect: d.prAutoDetect,
  dashboard: d.dashboard, lifecycle: d.lifecycle ? '(...)' : undefined,
  agentReportedState: d.agentReportedState,
  agentReportedAt: d.agentReportedAt,
  agentReportedNote: d.agentReportedNote,
  reportWatcherTriggerCount: d.reportWatcherTriggerCount,
  reportWatcherActiveTrigger: d.reportWatcherActiveTrigger,
  agentReport_nested_wrapper: d.agentReport ?? '(undefined — correct)',
  reportWatcher_nested_wrapper: d.reportWatcher ?? '(undefined — correct)',
};
console.log(JSON.stringify(out, null, 2).split('\n').map(l => '    ' + l).join('\n'));
"
sleep 4

step "Verify @ashish921998 fix: agent-report keys stayed FLAT after migration"
note "Live runtime readers (parseExistingAgentReport, lifecycle-manager)"
note "look up flat keys on session.metadata. readMetadataRaw → flattenToStringRecord"
note "does NOT unfold nested objects, so a nested agentReport.* would silently"
note "drop this state. Migration keeps these flat — proven below:"
echo
node -e "
const fs = require('fs');
const d = JSON.parse(fs.readFileSync('$SESSION_JSON', 'utf-8'));
const required = [
  'agentReportedState', 'agentReportedAt', 'agentReportedNote',
  'reportWatcherTriggerCount', 'reportWatcherActiveTrigger',
];
let ok = true;
for (const k of required) {
  const present = d[k] !== undefined;
  console.log('    ' + (present ? '✓' : '✗') + ' ' + k + ' = ' + (d[k] ?? 'MISSING'));
  if (!present) ok = false;
}
if (d.agentReport !== undefined || d.reportWatcher !== undefined) {
  console.log('    ✗ nested wrapper present — would shadow flat keys via flattenToStringRecord');
  ok = false;
}
console.log();
console.log('    ' + (ok ? 'PASS' : 'FAIL') + ' — agent-report flat-key contract preserved');
"
sleep 5

step "Rollback safety: re-running migration is a no-op (markers prevent re-process)"
ao migrate-storage --force 2>&1 | tail -5
sleep 3

# ───────────────────────────────────────────────────────────────────────────
banner "Act 2 — Cross-project CLI (the P1 review fix)"
# ───────────────────────────────────────────────────────────────────────────

note "Behavior under test:"
note "  1. ao start (project=A)            → running.json {pid, projects:[A]}"
note "  2. ao stop A                       → projects:[]            (parent alive)"
note "  3. ao start A                      → projects:[A] same pid  (ATTACH, no 2nd daemon)"
note ""
note "Pre-fix: step 3 fell through to runStartup() → spawned a SECOND dashboard"
note "on a new port, clobbered running.json. Reproduced and fixed in commit bfc7f48f."
sleep 3

step "The regression test that asserts no second daemon is registered"
echo
sed -n '/attaches to existing daemon (no second dashboard)/,/^  });$/p' \
  "$AO_REPO/packages/cli/__tests__/commands/start.test.ts" \
  | head -50 | sed 's/^/    /'
sleep 5

step "Run the test live (filtered by test name via vitest -t)"
(cd "$AO_REPO" && pnpm --filter @aoagents/ao-cli test -- start.test.ts -t "attaches to existing daemon" 2>&1 \
  | grep -E "✓|✗|FAIL|Test Files|^\s*Tests " | head -10 | sed 's/^/    /') || true
sleep 3

step "removeProjectFromRunning + addProjectToRunning are the round-trip primitives"
echo
grep -n "export async function \(removeProjectFromRunning\|addProjectToRunning\)" \
  "$AO_REPO/packages/cli/src/lib/running-state.ts" | sed 's/^/    /'
sleep 3

# ───────────────────────────────────────────────────────────────────────────
banner "Act 3 — Dashboard sidebar shows ALL projects regardless of route"
# ───────────────────────────────────────────────────────────────────────────

note "useSessionEvents on the dashboard is now called WITHOUT a project filter."
note "Per-project filtering happens client-side via the projectSessions memo."
sleep 2

step "The fix in Dashboard.tsx"
grep -B 1 -A 7 "No project filter — sidebar needs all sessions" \
  "$AO_REPO/packages/web/src/components/Dashboard.tsx" 2>/dev/null \
  | sed 's/^/    /' || note "(see commit 53e8476f)"
sleep 4

# ───────────────────────────────────────────────────────────────────────────
banner "Act 4 — Restore from ao stop  (last-stop.json round-trip)"
# ───────────────────────────────────────────────────────────────────────────

step "Simulate what ao stop writes to last-stop.json"
cat >"$DEMO_HOME/.agent-orchestrator/last-stop.json" <<JSON
{
  "stoppedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "projectId": "$MIGRATED_PROJECT",
  "sessionIds": ["ao-1"],
  "otherProjects": []
}
JSON
echo
sed 's/^/    /' "$DEMO_HOME/.agent-orchestrator/last-stop.json"
sleep 3

step "What ao start does with it (start.ts)"
echo
grep -n "readLastStop\|Restore .* sessions" \
  "$AO_REPO/packages/cli/src/commands/start.ts" | head -6 | sed 's/^/    /'
sleep 3

step "Cross-project sessions in the prompt — otherProjects field"
echo
grep -n "otherProjects" \
  "$AO_REPO/packages/cli/src/lib/running-state.ts" \
  "$AO_REPO/packages/cli/src/commands/start.ts" | head -6 | sed 's/^/    /'
sleep 3

# ───────────────────────────────────────────────────────────────────────────
banner "Act 5 — Ctrl+C performs a full graceful shutdown (no tmux orphans)"
# ───────────────────────────────────────────────────────────────────────────

note "SIGINT/SIGTERM handler in start.ts mirrors ao stop:"
note "  kill all sessions → write last-stop.json → unregister → process.exit"
note "  10s hard timeout via setTimeout().unref() in case cleanup hangs."
sleep 2

step "The shutdown handler"
echo
grep -n "shutdown.*signal: NodeJS.Signals\|10s hard timeout\|SHUTDOWN_TIMEOUT_MS" \
  "$AO_REPO/packages/cli/src/commands/start.ts" | head -10 | sed 's/^/    /'
sleep 3

# ───────────────────────────────────────────────────────────────────────────
banner "Act 6 — Empty-repo guard for ao start <URL>"
# ───────────────────────────────────────────────────────────────────────────

note "Before fix: empty repos caused 'Unable to resolve base ref' deep inside"
note "the worktree plugin. Now we detect via origin/HEAD and fail early with"
note "a useful message before ensureOrchestrator runs."
sleep 2

step "The detection helper + the early-exit message"
echo
sed -n '/detectClonedRepoDefaultBranch/,/^}/p' \
  "$AO_REPO/packages/cli/src/commands/start.ts" \
  | head -25 | sed 's/^/    /'
echo
grep -B 1 -A 4 "appears to be empty (no commits or refs)" \
  "$AO_REPO/packages/cli/src/commands/start.ts" | head -10 | sed 's/^/    /'
sleep 5

# ───────────────────────────────────────────────────────────────────────────
banner "Test summary: 560 CLI + 981 core (last full run)"
# ───────────────────────────────────────────────────────────────────────────

# Restore the real HOME and unset sandbox env vars when running the full
# test suites — otherwise tests that read getGlobalConfigPath() see the
# demo's sparse config and fail spuriously.
step "pnpm --filter @aoagents/ao-cli test"
(cd "$AO_REPO" && env -u AO_GLOBAL_CONFIG HOME="$REAL_HOME" pnpm --filter @aoagents/ao-cli test 2>&1 \
  | grep -E "^\s*(Tests|Test Files|Duration)" | sed 's/^/    /') || true

step "pnpm --filter @aoagents/ao-core test"
(cd "$AO_REPO" && env -u AO_GLOBAL_CONFIG HOME="$REAL_HOME" pnpm --filter @aoagents/ao-core test 2>&1 \
  | grep -E "^\s*(Tests|Test Files|Duration)" | sed 's/^/    /') || true

# ───────────────────────────────────────────────────────────────────────────
banner "Demo complete — sandbox left in $DEMO_HOME for inspection"
# ───────────────────────────────────────────────────────────────────────────

note "To re-run:    scripts/demo-pr-1466.sh"
note "To clean:     rm -rf $DEMO_HOME"
note ""
note "Reviewer next steps:"
note "  • Inspect $DEMO_HOME/.agent-orchestrator/ to verify V2 shape"
note "  • Diff against base:   git diff origin/main...storage-redesign"
note "  • Visual spec:         pr-1466.html"
note "  • Behavior dashboard:  https://theharshitsingh.com/static/pr-1466.html"
echo
