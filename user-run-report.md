# AgentMesh — Pre-Launch Master Checklist

**Audited:** 2026-06-17 | **Version:** 0.9.2 | **Repo:** `ch1kim0n1/parallel-agents`  
**Original verdict:** Ready for Internal Testing — NOT ready to sell  
**Updated 2026-06-17 (remediation pass):** All P0/P1/P2 code + doc action points in this checklist are ✅ closed and statically verified (`pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm build`). Remaining gates are **live-environment** (RUN/QA/INT) and **commercial** (see PART 12). Verdict: **Technically launch-ready; not yet commercially sellable** until PART 12 is done.

This file is the single source of truth before selling to real users.  
Every item must be checked off. P0 and P1 items block all launch activity.

---

## Quick Status Summary

| Category                           | Status                                                                                                 | Blocking? |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------ | --------- |
| Docs / links                       | ✅ FIXED — `absolute-docs/` renamed to `docs/`; all referenced files/assets resolve                    | Closed    |
| README images                      | ✅ FIXED — banner + button assets resolve under `docs/assets/`                                         | Closed    |
| Build (typecheck/test/lint/format) | ✅ VERIFIED — root `test`, `typecheck`, `lint`, `format:check`, and `build` all pass on Node `20.18.3` | Closed    |
| Windows runtime config             | ✅ FIXED — `runtime: tmux` removed; auto-detect picks `process` on Windows; `$schema` + `repo` added   | Closed    |
| AgentMesh page                     | ✅ FIXED — `TASK-1` removed; page renders only TaskBoard                                               | Closed    |
| New component tests                | ✅ ADDED — 7 TaskBoard + 6 QALoopStatus tests, all passing                                             | Closed    |
| Inline styles                      | ✅ FIXED — score/retry bars use `--progress` CSS var + `.qa-progress-bar__fill`                        | Closed    |
| JSON schema (agentmesh:)           | ✅ FIXED — `agentmesh` block (enabled/qa/policy/prGate/roles/messaging) added                          | Closed    |
| better-sqlite3 on Windows          | ✅ FIXED — LockManager + CostTracker now degrade to in-memory (no startup crash)                       | Closed    |
| Phantom plugin alternatives        | ✅ FIXED — Docker/K8s/SSH/e2b/Jira/goose removed or marked "planned" in README/SETUP/ao README         | Closed    |
| OpenCode/KimiCode adapters         | ✅ FIXED — both registered in `services.ts`; Devin/Gemini documented as intentionally manual           | Closed    |

> Environment caveat during this pass: the host machine's default Node is **v20.17.0** (engines want **≥20.18.3**). Static verification was run via `npx -y node@20.18.3 ...`; RUN-1 still needs live verification in a compliant default environment.

---

## PART 1 — BUG FIXES (P0 and P1, must fix before anything else)

### [P0-1] Fix `docs/` directory — all links and images broken

**What broke:** `docs/` directory does not exist. All documentation links in README, SETUP.md, CONTRIBUTING.md, DESIGN.md return 404. All banner images, demo screenshots return 404. Actual docs are at `absolute-docs/`.

**Files affected:**

- `README.md` — 5 broken image `src=`, 3 broken doc links
- `SETUP.md` — 3 broken links to `docs/DEVELOPMENT.md`
- `CONTRIBUTING.md` — 4 broken links (DEVELOPMENT.md, CROSS_PLATFORM.md, PLUGIN_SPEC.md)
- `DESIGN.md` — 3 broken links (dashboard-language.md, kanban.html, session.html)
- `packages/ao/README.md` — 2 absolute GitHub URLs to dead `docs/` paths

**Fix options (pick one):**

```bash
# Option A: rename the directory
git mv absolute-docs docs
# then update every reference in CLAUDE.md that says "absolute-docs" to "docs"

# Option B: bulk-replace all doc references
# find+replace "absolute-docs/" -> "docs/" in all markdown
# find+replace "docs/" -> "absolute-docs/" in all markdown
```

**Verification:**

```bash
# After fix, every link must resolve:
ls docs/CLI.md
ls docs/DEVELOPMENT.md
ls docs/CROSS_PLATFORM.md
ls docs/PLUGIN_SPEC.md
ls docs/assets/agent_orchestrator_banner.png
ls docs/assets/demo-video-tweet.png
ls docs/assets/article-tweet.png
ls docs/assets/btn-watch-demo.png
ls docs/assets/btn-read-article.png
ls docs/design/mockups/kanban.html
ls docs/design/mockups/session.html
```

---

### [P0-2] Fix `agent-orchestrator.yaml` — hardcoded `runtime: tmux` breaks Windows

**What broke:** Root `agent-orchestrator.yaml` has `runtime: tmux`. tmux does not exist on Windows. Running `ao start` from this repo on Windows will fail immediately.

**Current (broken):**

```yaml
agent: claude-code
runtime: tmux
workspace: worktree

projects:
  agentmesh:
    path: .
    displayName: AgentMesh
```

**Fixed version:**

```yaml
$schema: https://raw.githubusercontent.com/ComposioHQ/agent-orchestrator/main/schema/config.schema.json
port: 3000

projects:
  agentmesh:
    repo: ch1kim0n1/parallel-agents
    path: .
    displayName: AgentMesh
    defaultBranch: main
```

Remove `runtime: tmux` so auto-detection picks `process` on Windows and `tmux` on Mac/Linux. Add `repo:` so GitHub integration works. Add `$schema` so editors autocomplete.

**Verification:**

```bash
# On Windows — should NOT error about tmux
ao start --dry-run 2>&1 | grep -v "tmux"

# Check runtime auto-detection
node -e "import('@aoagents/ao-core').then(m => console.log(m.getDefaultRuntime()))"
```

---

### [P1-1] Fix AgentMesh page — hardcoded `taskId="TASK-1"`

**File:** `packages/web/src/app/agentmesh/page.tsx`

**What broke:** `<QALoopStatus taskId="TASK-1" />` — QA panel always shows state for a non-existent task. On every fresh install, TASK-1 does not exist and the panel is meaningless or shows error state.

**Fix:** Either wire it to the selected task from TaskBoard, or remove QALoopStatus from the page layout until task selection is implemented.

**Minimum acceptable fix:**

```tsx
// Remove QALoopStatus from the page entirely until task selection exists
export default function AgentMeshPage() {
  return (
    <div className="h-full">
      <TaskBoard />
    </div>
  );
}
```

**Verification:**

- Navigate to `/agentmesh` with zero tasks in DB — no error, no misleading "TASK-1" state
- Create a task — it appears in the board
- No console errors about 404 task fetches

---

### [P1-2] Add tests for TaskBoard and QALoopStatus

**Files missing tests:**

- `packages/web/src/components/TaskBoard.tsx` (460 lines, zero test coverage)
- `packages/web/src/components/QALoopStatus.tsx` (254 lines, zero test coverage)

**Required test file:** `packages/web/src/components/__tests__/TaskBoard.test.tsx`

Minimum test cases:

1. Renders loading state on mount
2. Renders error state when `/api/agentmesh/tasks` returns 500
3. Renders empty state when tasks array is empty
4. Renders task cards in correct columns by status
5. Create task modal opens on button click
6. Create task button disabled when title is empty
7. Create task calls POST `/api/agentmesh/tasks` with correct payload

**Required test file:** `packages/web/src/components/__tests__/QALoopStatus.test.tsx`

Minimum test cases:

1. Renders loading state on mount
2. Renders error gracefully when fetch fails (currently silent — must show error message)
3. Renders correct state label for each `state` value (idle, building, qa_running, etc.)
4. Shows retry count badge when `retryCount > 0`
5. Shows QA findings when `lastQAResult` is present

**Verification:**

```bash
pnpm --filter @aoagents/ao-web test -- --reporter=verbose 2>&1 | grep -E "TaskBoard|QALoopStatus"
# Must show: TaskBoard > ... ✓, QALoopStatus > ... ✓
```

---

### [P1-3] Fix QALoopStatus inline styles

**File:** `packages/web/src/components/QALoopStatus.tsx`

**Lines with violations:**

- `style={{ width: \`${qaState.lastQAResult.score}%\` }}` (line ~180)
- `style={{ width: \`${(qaState.retryCount / qaState.maxRetries) \* 100}%\` }}` (line ~233)

**Fix:** Use CSS custom properties instead:

```tsx
// In JSX:
<div
  className="qa-progress-bar__fill"
  style={{ '--progress': `${score}%` } as React.CSSProperties}
/>

// In globals.css:
.qa-progress-bar__fill {
  width: var(--progress, 0%);
  transition: width 0.3s ease;
}
```

**Verification:**

```bash
grep -n "style=" packages/web/src/components/QALoopStatus.tsx
# Must return 0 results (or only data-* attributes, no width/color styles)
pnpm lint
# Must pass with no new errors
```

---

### [P1-4] Add `agentmesh:` block to `schema/config.schema.json`

**What broke:** `examples/agentmesh-coordination.yaml` uses `agentmesh:` as a top-level key. This key is absent from `schema/config.schema.json`. When users paste the `$schema` line into their config and use a YAML editor, the `agentmesh:` block shows as an unknown property error. More critically, any typo in `qa.maxRetries` or `policy.rules` is silently ignored.

**Fix:** Add to `schema/config.schema.json` under `properties`:

```json
"agentmesh": {
  "type": "object",
  "description": "AgentMesh coordination layer settings",
  "properties": {
    "enabled": { "type": "boolean" },
    "qa": {
      "type": "object",
      "properties": {
        "maxRetries": { "type": "integer", "minimum": 0 },
        "qaTimeout": { "type": "integer" },
        "reworkTimeout": { "type": "integer" },
        "autoRework": { "type": "boolean" },
        "escalateAfterRetries": { "type": "boolean" }
      }
    },
    "policy": {
      "type": "object",
      "properties": {
        "enabled": { "type": "boolean" },
        "blockOnPolicyViolation": { "type": "boolean" },
        "rules": { "type": "array", "items": { "type": "string" } }
      }
    },
    "roles": { "type": "object" },
    "messaging": { "type": "object" }
  }
}
```

**Verification:**

```bash
# Install a YAML linter and validate
npx yaml-language-server --validate examples/agentmesh-coordination.yaml
# Or manually: open examples/agentmesh-coordination.yaml in VS Code — no red squiggles on agentmesh: block
```

---

### [P1-5] Fix `better-sqlite3` crash risk on Windows — `LockManager` and `CostTracker`

**What broke:** `TaskManager` has a graceful fallback when `better-sqlite3` fails (`DatabaseAvailable` check). `LockManager` and `CostTracker` do NOT — they call `new Database(...)` unconditionally in the constructor. If `better-sqlite3` native binaries fail to build (common on Windows without build tools), the entire `CoordinationService` constructor throws, crashing the web server on startup.

**Files:**

- `packages/agentmesh-core/src/lock-manager.ts` — line 41: `this.db = new Database(...)`
- `packages/agentmesh-core/src/cost-tracker.ts` — line 50: `this.db = new Database(...)`

**Fix:** Apply the same `DatabaseAvailable` pattern as `task-manager.ts`:

```typescript
const DatabaseAvailable = (() => {
  try {
    return typeof Database === "function";
  } catch {
    return false;
  }
})();

// In constructor:
if (DatabaseAvailable) {
  this.db = new Database(join(storagePath, "locks.db"));
  this.initializeSchema();
} else {
  this.db = null;
  this.inMemoryLocks = new Map();
  console.warn("[LockManager] better-sqlite3 unavailable, using in-memory storage");
}
```

**Verification:**

```bash
# On Windows: confirm server starts even if sqlite fails
node -e "
  import('@aoagents/agentmesh-core').then(m => {
    const s = new m.AgentMeshStorage('test');
    const lm = new m.LockManager(s.getTasksPath());
    console.log('LockManager OK');
  }).catch(e => console.error('CRASH:', e.message))
"
```

---

## PART 2 — BUILD VERIFICATION

Every command below must complete with exit code 0 before launch.

### [BUILD-1] Clean install and full build

```bash
# From repo root
pnpm install
# Expected: no errors, postinstall (rebuild-node-pty.js) runs silently

pnpm build
# Expected: all packages build in order:
#   @aoagents/ao-core
#   @aoagents/agentmesh-core
#   @aoagents/agentmesh-adapters
#   all plugins (runtime-tmux, runtime-process, agent-*, notifier-*, etc.)
#   @aoagents/ao-cli
#   @aoagents/ao-web
#   @aoagents/agentmesh-cli
# Expected exit code: 0
# Must NOT print any TypeScript errors
```

### [BUILD-2] TypeScript check — zero errors

```bash
pnpm typecheck
# Expected: 0 errors across all packages
# Critical packages to verify individually if overall fails:
pnpm --filter @aoagents/agentmesh-core typecheck
pnpm --filter @aoagents/agentmesh-adapters typecheck
pnpm --filter @aoagents/ao-web typecheck
pnpm --filter @aoagents/ao-cli typecheck
```

### [BUILD-3] All tests pass

```bash
pnpm test
# Expected: 3,288+ test cases, 0 failures
# After adding TaskBoard/QALoopStatus tests, count will increase

pnpm --filter @aoagents/agentmesh-core test
# Must pass: coordination-service.test.ts, cost-parser.test.ts

pnpm --filter @aoagents/ao-web test
# Must pass: all 34+ component tests including new TaskBoard.test.tsx and QALoopStatus.test.tsx
```

### [BUILD-4] Lint — zero errors

```bash
pnpm lint
# Expected: 0 errors, 0 warnings
# After QALoopStatus inline style fix, no new ESLint violations
```

### [BUILD-5] Format check

```bash
pnpm format:check
# Expected: exit code 0, no files need reformatting
```

### [BUILD-6] Verify `better-sqlite3` native build

```bash
# Windows-specific
node -e "
const Database = require('./node_modules/.pnpm/better-sqlite3@11.0.0/node_modules/better-sqlite3');
const db = new Database(':memory:');
db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
console.log('better-sqlite3 OK');
"
# If this fails, rebuild:
cd node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3
npx node-gyp rebuild
```

### [BUILD-7] Verify `node-pty` native build

```bash
node -e "
const pty = require('./node_modules/.pnpm/node-pty@1.1.0/node_modules/node-pty');
console.log('node-pty version:', pty.version ?? 'loaded OK');
"
# If this fails on Windows:
cd node_modules/.pnpm/node-pty@1.1.0/node_modules/node-pty
npx node-gyp rebuild
```

---

## PART 3 — FIRST RUN CHECKLIST (what a new user must be able to do)

Run through this entire sequence before each public release. No developer help allowed — if you need to explain a step, it needs to be in the docs.

### [RUN-1] Prerequisites verification

```bash
node --version
# Must print v20.18.3 or higher

git --version
# Must print 2.25.0 or higher

gh --version
# Must be installed

gh auth status
# Must show: Logged in to github.com

# Windows only:
powershell -Command "$PSVersionTable.PSVersion"
# Must be 7.0+
```

### [RUN-2] Install from npm

```bash
npm install -g @aoagents/ao
ao --version
# Must print: 0.9.2 (or current version)
```

### [RUN-3] Run ao doctor

```bash
ao doctor
# Must show all PASS or WARN (no FAIL items)
# On Windows specifically:
# - runtime-process: PASS
# - PowerShell: PASS
# - GitHub CLI: PASS (if gh auth done)
# - tmux: NOT REQUIRED (should show as skipped on Windows, not FAIL)
```

### [RUN-4] Start from this repo (Windows-specific test)

```bash
cd "path/to/parallel-agents"
ao start
# Must NOT error with: "tmux: command not found"
# Must print: "Dashboard running at http://localhost:3000"
# Must open browser or print URL clearly

# Verify dashboard loads
curl -s http://localhost:3000 | grep -i "agentmesh"
# Must return HTML with AgentMesh content
```

### [RUN-5] Dashboard loads correctly

Open `http://localhost:3000` in browser.

- [ ] Page loads without blank screen or JS error in console
- [ ] AgentMesh logo/title visible
- [ ] Sessions column visible (may be empty — that's fine)
- [ ] Sidebar visible
- [ ] No "Failed to fetch" banners
- [ ] DevTools console: zero uncaught errors on initial load
- [ ] DevTools console: zero 404 errors in Network tab

### [RUN-6] Navigate to AgentMesh page

Open `http://localhost:3000/agentmesh`

- [ ] Page loads without blank screen
- [ ] TaskBoard renders (empty state is acceptable — must not show error)
- [ ] NO "TASK-1" hardcoded anywhere visible
- [ ] No console 404 error for `/api/agentmesh/tasks/TASK-1`
- [ ] "Create Task" button visible and clickable
- [ ] Create task modal opens
- [ ] Form fields work (title, description, priority, role, branch)
- [ ] Submit with empty title: button must remain disabled
- [ ] Submit with title: task appears in "Created" column
- [ ] Refresh page: task persists (SQLite persistence confirmed)

### [RUN-7] Spawn an agent (requires Claude Code installed)

```bash
# Verify claude is available
claude --version

# From repo root with valid agent-orchestrator.yaml
ao spawn agentmesh 1
# (Replace 1 with a real GitHub issue number from ch1kim0n1/parallel-agents)
# Expected: prints session name, opens tmux/PTY, agent starts

ao status
# Expected: shows spawned session with status "working" or "spawning"
```

### [RUN-8] Session appears in dashboard

- [ ] Open `http://localhost:3000`
- [ ] Spawned session appears in kanban board
- [ ] Session card shows: name, status badge, branch name
- [ ] Click session card: session detail opens
- [ ] Terminal panel shows agent output (live)
- [ ] No terminal blank screen for >30s without content

### [RUN-9] Stop and restore

```bash
ao stop
# Expected: all sessions killed, dashboard stops
# Expected: prints "last-stop state written"

ao start --restore
# Expected: offers to restore previous sessions
# Expected: dashboard comes back up at http://localhost:3000
```

---

## PART 4 — QA CHECKLIST (functional correctness)

### [QA-1] AgentMesh TaskBoard functional tests

| Test                         | Steps                                        | Expected                                       |
| ---------------------------- | -------------------------------------------- | ---------------------------------------------- |
| Create task with all fields  | Fill title/desc/priority/role/branch, submit | Task in "Created" column with correct metadata |
| Create task — title required | Submit with empty title                      | Button disabled, no API call                   |
| Task persistence             | Create task, hard-refresh page               | Task still in "Created" column                 |
| Task polling                 | Create task via API (curl), wait 5s          | Task appears without page refresh              |
| Load error display           | Kill API server mid-load                     | Error message shown, not silent blank          |
| Multiple tasks               | Create 5 tasks across 3 priorities           | All appear in correct columns                  |

```bash
# API-level task creation test
curl -X POST http://localhost:3000/api/agentmesh/tasks \
  -H "Content-Type: application/json" \
  -d '{"title":"Test task","description":"desc","role":"builder","priority":"high","branch":"main"}'
# Expected: 200 with task JSON including id, status: "created"

curl http://localhost:3000/api/agentmesh/tasks
# Expected: 200 with tasks array containing the created task
```

### [QA-2] QA loop API tests

```bash
# Get QA state for task (replace TASK_ID with real id from above)
curl http://localhost:3000/api/agentmesh/tasks/TASK_ID/qa
# Expected: 200 with qaState object (state: "idle")

# Submit QA result
curl -X POST http://localhost:3000/api/agentmesh/tasks/TASK_ID/qa \
  -H "Content-Type: application/json" \
  -d '{"verdict":"PASS","summary":"All checks passed","findings":[]}'
# Expected: 200 with decision object

# Submit QA FAIL — should trigger rework
curl -X POST http://localhost:3000/api/agentmesh/tasks/TASK_ID/qa \
  -H "Content-Type: application/json" \
  -d '{"verdict":"FAIL","summary":"Tests failed","findings":[{"severity":"major","category":"test","message":"3 tests failed"}]}'
# Expected: 200 with decision.action = "rework"

# After maxRetries FAILs, decision.action should = "escalate"
```

### [QA-3] Session management functional tests

| Test                                                        | Expected                                      |
| ----------------------------------------------------------- | --------------------------------------------- |
| `ao spawn` creates session file in `~/.agent-orchestrator/` | `ls ~/.agent-orchestrator/` shows session dir |
| `ao status` shows running sessions                          | Session list with status, branch, PR          |
| `ao open <session>` attaches terminal                       | Terminal output visible                       |
| `ao send <session> "message"` sends text                    | Agent receives and responds                   |
| `ao session kill <name>` removes session                    | Session gone from `ao status`                 |

### [QA-4] Dashboard real-time update tests

- [ ] Spawn session via CLI while dashboard is open — session appears in kanban without refresh (SSE, ≤5s)
- [ ] Kill session via CLI — card disappears from kanban without refresh (≤5s)
- [ ] PR opens — session card shows PR link within 1 poll cycle
- [ ] CI status changes — badge on session card updates within 1 poll cycle

### [QA-5] Error state tests

| Scenario                                | Expected                                                |
| --------------------------------------- | ------------------------------------------------------- |
| Dashboard open, `ao stop` kills backend | Connection bar shows "disconnected"                     |
| `ao start` again while dashboard open   | Dashboard reconnects automatically                      |
| GitHub API rate limit hit               | Session shows warning, not crash                        |
| Agent process dies mid-task             | Session transitions to `detecting` state, then resolves |
| Create task with no title (UI)          | Create button disabled                                  |
| POST task with no title (API)           | 400 error, not 500                                      |
| GET `/api/agentmesh/tasks/nonexistent`  | 404, not 500                                            |

### [QA-6] Mobile responsiveness tests

Open `http://localhost:3000` at 375×812 (iPhone viewport):

- [ ] Kanban board visible (may scroll horizontally — must be usable)
- [ ] Session cards readable
- [ ] Bottom navigation visible and tappable
- [ ] Session detail opens on card tap
- [ ] Terminal visible in session detail
- [ ] No horizontal overflow on main content
- [ ] AgentMesh page (`/agentmesh`) — TaskBoard usable on mobile

---

## PART 5 — QC CHECKLIST (code quality before merge)

### [QC-1] No inline styles in new components

```bash
grep -rn "style={" packages/web/src/components/TaskBoard.tsx
grep -rn "style={" packages/web/src/components/QALoopStatus.tsx
grep -rn "style={" packages/web/src/app/agentmesh/page.tsx
# Must return 0 results after P1-3 fix
```

### [QC-2] No raw Tailwind colors — use design tokens

```bash
# TaskBoard must not use raw color classes (breaks dark theme)
grep -n "bg-gray-\|bg-blue-\|bg-red-\|bg-green-\|text-gray-\|text-blue-" \
  packages/web/src/components/TaskBoard.tsx
# Ideally 0 results; each result is a dark-theme regression
# Replace with var(--color-*) classes from globals.css
```

### [QC-3] Component file length limits

```bash
wc -l packages/web/src/components/TaskBoard.tsx
# Must be ≤400 lines (currently 460 — extract CreateTaskModal)

wc -l packages/web/src/components/QALoopStatus.tsx
# Currently 254 — acceptable
```

### [QC-4] No `process.platform === "win32"` inline checks

```bash
grep -rn "process\.platform" packages/ --include="*.ts" --include="*.tsx" \
  | grep -v "node_modules\|__tests__\|platform.ts\|\.test\."
# Must return 0 results
# Any platform check must use isWindows() from @aoagents/ao-core
```

### [QC-5] No `any` types in new code

```bash
grep -rn ": any\b\|as any\b" \
  packages/agentmesh-core/src/ \
  packages/agentmesh-adapters/src/ \
  packages/web/src/components/TaskBoard.tsx \
  packages/web/src/components/QALoopStatus.tsx
# Must return 0 results
```

### [QC-6] No hardcoded secrets or tokens

```bash
# Run gitleaks
gitleaks detect --source . --no-git
# Must return: "No leaks found"

# Manual check: confirm no API keys, tokens, or passwords in source
grep -rn "lin_api_\|ghp_\|sk-\|AKIA" packages/ --include="*.ts" --include="*.tsx"
# Must return 0 results
```

### [QC-7] Shell injection safety

```bash
grep -rn "shellEscape" packages/agentmesh-adapters/src/ --include="*.ts"
# Every place that builds a shell command using user-supplied values must use shellEscape()
# Manually verify each adapter's getLaunchCommand() uses shellEscape for dynamic parts
```

### [QC-8] No unused imports in changed files

```bash
pnpm lint -- --rule "@typescript-eslint/no-unused-vars: error"
# Must pass for: TaskBoard.tsx, QALoopStatus.tsx, agentmesh/page.tsx, services.ts
```

### [QC-9] All new AgentMesh packages included in root build script

```bash
cat package.json | grep '"build"'
# Must include @aoagents/agentmesh-core, @aoagents/agentmesh-adapters, @aoagents/agentmesh-cli
# Current build script in package.json already includes these — verify nothing removed
```

### [QC-10] Unregistered adapters documented or wired

`packages/agentmesh-adapters/src/` exports 8 adapters. `services.ts` only registers 4 (claude-code, aider, cursor, codex). The following are exported but NOT registered in the CoordinationService:

- `DevinAdapter` — Devin is not a local agent, it's API-based. Document this or wire it.
- `GeminiAdapter` — Gemini CLI must be installed separately. Document or wire.
- `OpenCodeAdapter` — plugin exists (`agent-opencode`), should be registered.
- `KimiCodeAdapter` — plugin exists (`agent-kimicode`), should be registered.

```bash
# Minimum fix: add to services.ts
coordinationService.registerAdapter("opencode", new OpenCodeAdapter(sessionManager));
coordinationService.registerAdapter("kimicode", new KimiCodeAdapter(sessionManager));
# For Devin/Gemini: add a comment or README note explaining why they're not auto-registered
```

---

## PART 6 — DOCUMENTATION CHECKLIST

### [DOC-1] Fix all broken `docs/` links (see P0-1 above)

After renaming or re-referencing `absolute-docs/` → `docs/`:

```bash
# Verify no broken markdown links remain
find . -name "*.md" -not -path "*/node_modules/*" \
  -exec grep -l "docs/CLI.md\|docs/DEVELOPMENT.md\|docs/CROSS_PLATFORM.md\|docs/PLUGIN_SPEC.md" {} \;
# After fix: must return 0 files (or all files must have valid targets)
```

### [DOC-2] Remove phantom plugin alternatives

**README.md plugin table** — remove or mark as "planned":

- Runtime: `docker`, `kubernetes`, `ssh`, `e2b` — not in this repo
- Tracker: `jira`, `asana` — not in this repo
- Agent: `goose` — not in this repo

**SETUP.md plugin table** — same fix.

Acceptable replacement text: `"community plugins — see plugin registry"` with a link to `packages/cli/src/assets/plugin-registry.json`.

**Verification:**

```bash
grep -n "docker\|kubernetes\|jira\|asana\|goose" README.md SETUP.md
# Each result must either reference a real plugin or be labeled "planned"/"community"
```

### [DOC-3] Fix inconsistent plugin slot count

All three must say the same thing:

- `CLAUDE.md` line: "Plugin System (8 Slots)"
- `README.md`: "Seven plugin slots. Lifecycle stays in core."
- `SETUP.md` table: 8 rows including Lifecycle

Correct statement: **"Eight plugin slots — seven swappable (Runtime, Agent, Workspace, Tracker, SCM, Notifier, Terminal) plus Lifecycle which is managed by core and not pluggable."**

### [DOC-4] AgentMesh coordination layer — add to SETUP.md

`agentmesh-coordination.yaml` example exists but there is no setup guide section in SETUP.md explaining:

- What AgentMesh coordination layer is
- When to enable it
- What `agentmesh.qa.maxRetries` does
- What `agentmesh.policy.rules` accepts
- What roles mean (`builder`, `qa`, `planner`)

Add a "AgentMesh Coordination Layer" section to SETUP.md.

### [DOC-5] Add AgentMesh page to user-facing navigation

`/agentmesh` is only reachable via direct URL. No documentation mentions it. Add to:

1. SETUP.md — "Dashboard pages" section
2. README.md — "How It Works" section
3. A comment in Dashboard.tsx near the nav link explaining how to reach it

### [DOC-6] packages/ao/README.md badge consistency

`packages/ao/README.md` references the upstream `ComposioHQ/agent-orchestrator` repo. This fork is `ch1kim0n1/parallel-agents`. Either:

- Update badges and links to point to the fork, OR
- Document that this is a fork and link upstream for issues

### [DOC-7] Verify agent-orchestrator.yaml.example is accurate

```bash
# Every field in the example must be in config.schema.json
# Every plugin listed must exist in packages/plugins/
# No phantom runtimes/trackers
```

---

## PART 7 — SECURITY CHECKLIST

### [SEC-1] gitleaks scan — zero leaks

```bash
gitleaks detect --source . --no-git --config .gitleaks.toml
# Must output: "No leaks found"
```

### [SEC-2] Input validation on AgentMesh API routes

```bash
# Test POST /api/agentmesh/tasks with injected inputs:
curl -X POST http://localhost:3000/api/agentmesh/tasks \
  -H "Content-Type: application/json" \
  -d '{"title":"'; DROP TABLE tasks; --","description":"","role":"builder","priority":"medium","branch":"main"}'
# Expected: 200 (SQLite parameterized queries prevent injection)
# Must NOT crash the server
# Must NOT corrupt the database

curl -X POST http://localhost:3000/api/agentmesh/tasks \
  -H "Content-Type: application/json" \
  -d '{"title":"<script>alert(1)</script>","description":"","role":"builder","priority":"medium","branch":"main"}'
# Expected: 200, title stored as literal string (Next.js auto-escapes in JSX)
# Verify: when rendered in TaskBoard, <script> does NOT execute
```

### [SEC-3] No unauthenticated destructive API actions

```bash
# All state-changing API endpoints should require local authentication or
# be bound to localhost only (not exposed to network)

# Verify dashboard is bound to localhost by default
grep -n "hostname\|host.*0\.0\.0\.0\|NEXT_PUBLIC_URL" packages/web/src/server.ts 2>/dev/null | head -5
# Must NOT bind to 0.0.0.0 unless user explicitly configured AO_PUBLIC_URL
```

### [SEC-4] Session ID validation before shell use

```bash
grep -n "validateSessionId" packages/web/src/ -r --include="*.ts"
# Must be called before any session ID is used in tmux commands or pipe paths
```

### [SEC-5] No eval or dynamic code execution

```bash
grep -rn "eval(\|new Function(\|Function(" packages/ --include="*.ts" --include="*.tsx" \
  | grep -v "node_modules\|\.test\.\|eslint"
# Must return 0 results
```

---

## PART 8 — PERFORMANCE CHECKLIST

### [PERF-1] Eliminate duplicate polling

Currently: TaskBoard polls `/api/agentmesh/tasks` every 5s AND the SSE hook polls sessions every 5s. Two concurrent 5s timers when `/agentmesh` page is open.

**Fix option:** Route TaskBoard updates through the SSE stream instead of a separate `setInterval`. Or accept the duplication but document it.

**Verification:**

- Open DevTools Network tab on `/agentmesh` page
- Count outgoing requests over 30 seconds — should be ≤6 unique endpoint requests (not 12+)

### [PERF-2] Loading states use Skeleton component

TaskBoard shows plain text "Loading task board..." but the rest of the app uses `<Skeleton />` from `components/Skeleton.tsx`.

```bash
grep -n "Skeleton" packages/web/src/components/TaskBoard.tsx
# Must show Skeleton import and usage
```

### [PERF-3] Next.js build output — no size regressions

```bash
pnpm --filter @aoagents/ao-web build
# Check output for First Load JS size
# Must be under 500KB for the main bundle
# Flag if any single chunk is >200KB uncompressed
```

---

## PART 9 — CONSISTENCY CHECKLIST

### [CONS-1] Plugin slot count — standardize to 8 everywhere

Files to update: CLAUDE.md, README.md, SETUP.md, CONTRIBUTING.md, ARCHITECTURE.md (if it exists).

### [CONS-2] TaskBoard role options must match RoleManager

`TaskBoard.tsx` create modal has only `builder` and `qa` roles in the select dropdown. `RoleManager` in `agentmesh-core` supports: `builder`, `qa`, `planner`, `reviewer`, `architect` (verify exact set).

```bash
grep -n "AgentRole\|role.*:" packages/agentmesh-core/src/types.ts | head -20
# Get the full list of supported roles
# Then verify TaskBoard select has ALL of them
```

### [CONS-3] `agent-orchestrator.yaml` in root must use `$schema` line

```bash
head -1 agent-orchestrator.yaml
# Must be: $schema: https://raw.githubusercontent.com/ComposioHQ/agent-orchestrator/main/schema/config.schema.json
```

### [CONS-4] Adapt imports in services.ts for all relevant adapters

`services.ts` imports `ClaudeCodeAdapter`, `AiderAdapter`, `CursorAdapter`, `CodexAdapter` from `@aoagents/agentmesh-adapters`. It does NOT import or register `OpenCodeAdapter` or `KimiCodeAdapter`, even though plugins for both exist in `packages/plugins/`. Users who set `agent: opencode` in config will get no AgentMesh coordination.

---

## PART 10 — INTEGRATION TEST CHECKLIST

### [INT-1] End-to-end smoke test (requires real GitHub repo and Claude)

This is the minimum viable demo path. Run on a test repo before any public demo:

```bash
# 1. Create a test GitHub issue
gh issue create --repo ch1kim0n1/parallel-agents \
  --title "[TEST] Add hello world function" \
  --body "Add a function that prints Hello World to the console"

# 2. Note the issue number (e.g. #42)

# 3. Start ao
ao start

# 4. Spawn an agent on the issue
ao spawn agentmesh 42

# 5. Check status
ao status
# Expected: session with status "working"

# 6. Wait and check dashboard
# Expected: session card appears in dashboard
# Expected: after agent finishes, PR appears on session card
# Expected: CI status badge shows on PR

# 7. Verify AgentMesh task was created (if coordination layer enabled)
curl http://localhost:3000/api/agentmesh/tasks
# Expected: task with issueId matching the spawned issue

# 8. Stop
ao stop
```

### [INT-2] Restore session test

```bash
ao start
ao spawn agentmesh 42
ao stop   # Sessions saved to last-stop.json
ao start --restore
# Expected: session restored, agent continues working
ao status
# Expected: restored session visible with previous status
```

### [INT-3] Multi-agent parallel test (2 agents)

```bash
# Create 2 issues, spawn both
ao spawn agentmesh 42
ao spawn agentmesh 43
ao status
# Expected: 2 sessions both in "working" state
# Expected: 2 separate worktrees in ~/.agent-orchestrator/
# Expected: 2 separate branches in git

# Dashboard: both sessions visible in kanban
# Expected: no cross-session interference
```

---

## PART 11 — RELEASE READINESS CHECKLIST

### [REL-1] Version is correct

```bash
cat packages/ao/package.json | grep '"version"'
# Must match the version you plan to release

ao --version
# Must match package.json version
```

### [REL-2] CHANGELOG is current

```bash
cat packages/ao/CHANGELOG.md | head -30
# Must mention AgentMesh coordination layer addition
# Must mention all P0/P1 fixes
# Must be dated correctly
```

### [REL-3] npm package publishes correctly

```bash
# Dry run — does not publish, just validates
npm pack --dry-run packages/ao/
# Expected: package size < 2MB
# Expected: no unexpected files included (no .env, no secrets)
# Expected: bin/ao.js included
```

### [REL-4] GitHub repo state

- [ ] `docs/` directory exists with all assets and markdown files
- [ ] No broken images on the GitHub README page
- [ ] All badges (stars, npm version, tests) resolve
- [ ] License file present
- [ ] SECURITY.md contact email is monitored
- [ ] Open issues triaged — no P0 issues open

### [REL-5] Discord / community link works

```bash
curl -I https://discord.gg/UZv7JjxbwG
# Must return 200 or 301/302 (not 404)
# Verify the Discord server is active and welcoming
```

---

## KNOWN BUGS LEDGER

Prioritized list of every confirmed defect found during this audit:

| #   | Severity | Status   | Description                                                                                                       | File                                                        |
| --- | -------- | -------- | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| 1   | P0       | ✅ Fixed | `docs/` directory missing — renamed `absolute-docs/`→`docs/`; all references resolve                              | README, SETUP, CONTRIBUTING, DESIGN                         |
| 2   | P0       | ✅ Fixed | `agent-orchestrator.yaml` hardcoded `runtime: tmux` — removed; `$schema`+`repo` added                             | agent-orchestrator.yaml                                     |
| 3   | P1       | ✅ Fixed | AgentMesh page hardcoded `taskId="TASK-1"` — removed QALoopStatus from page                                       | packages/web/src/app/agentmesh/page.tsx                     |
| 4   | P1       | ✅ Fixed | TaskBoard tests added (7 cases, passing)                                                                          | packages/web/src/components/**tests**/TaskBoard.test.tsx    |
| 5   | P1       | ✅ Fixed | QALoopStatus tests added (6 cases, passing)                                                                       | packages/web/src/components/**tests**/QALoopStatus.test.tsx |
| 6   | P1       | ✅ Fixed | QALoopStatus inline `style=` → `--progress` CSS var + `.qa-progress-bar__fill`                                    | packages/web/src/components/QALoopStatus.tsx                |
| 7   | P1       | ✅ Fixed | `agentmesh:` block added to config.schema.json                                                                    | schema/config.schema.json                                   |
| 8   | P1       | ✅ Fixed | LockManager now has graceful in-memory fallback (+ timer unref/clear)                                             | packages/agentmesh-core/src/lock-manager.ts                 |
| 9   | P1       | ✅ Fixed | CostTracker now has graceful in-memory fallback                                                                   | packages/agentmesh-core/src/cost-tracker.ts                 |
| 10  | P1       | ✅ Fixed | root `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, and `pnpm build` all pass on Node `20.18.3` | all packages                                                |
| 11  | P2       | ✅ Fixed | Phantom Docker/K8s/SSH/e2b/Jira/goose removed or marked "planned"                                                 | README, SETUP, packages/ao/README.md                        |
| 12  | P2       | ✅ Fixed | OpenCode + KimiCode adapters registered in services.ts                                                            | packages/web/src/lib/services.ts                            |
| 13  | P2       | ✅ Fixed | agentmesh-core now has lock-manager + cost-tracker tests; agentmesh-adapters now has adapter-registry coverage    | packages/agentmesh-adapters/src/                            |
| 14  | P2       | ✅ Fixed | TaskBoard 331 lines; CreateTaskModal extracted (180 lines)                                                        | packages/web/src/components/TaskBoard.tsx                   |
| 15  | P2       | ✅ Fixed | TaskBoard now uses design tokens (no raw Tailwind colors)                                                         | packages/web/src/components/TaskBoard.tsx                   |
| 16  | P2       | ✅ Fixed | Slot count standardized to "8 (7 swappable + Lifecycle)"                                                          | CLAUDE.md, README, SETUP, packages/ao/README.md             |
| 17  | P2       | ✅ Fixed | QALoopStatus already shows an error message on fetch failure (test added)                                         | packages/web/src/components/QALoopStatus.tsx                |
| 18  | P2       | ✅ Fixed | Duplicate polling documented; QALoopStatus 3s poll removed from page                                              | packages/web/src/components/TaskBoard.tsx                   |
| 19  | P2       | ✅ Fixed | `/agentmesh` reachable from top-nav switch (verified + comment added)                                             | packages/web/src/components/Dashboard.tsx                   |
| 20  | P3       | ✅ Fixed | TaskBoard loading state uses new `<Skeleton />` primitive                                                         | packages/web/src/components/TaskBoard.tsx, Skeleton.tsx     |
| 21  | P3       | ✅ Fixed | Role select now lists all 6 RoleManager roles                                                                     | packages/web/src/components/CreateTaskModal.tsx             |
| 22  | P3       | ✅ Fixed | packages/ao/README.md notes the fork + links upstream                                                             | packages/ao/README.md                                       |
| 23  | P3       | ✅ Fixed | Devin/Gemini documented as intentionally manual in services.ts                                                    | packages/web/src/lib/services.ts                            |
| 24  | —        | ✅ Fixed | Pre-existing typecheck errors in coordination-service.ts (optional `warnings`, invalid `data` field)              | packages/agentmesh-core/src/coordination-service.ts         |

---

## RECOMMENDED FIX ORDER

1. **P0-1** — Fix `docs/` (30 min) — unblocks all user-facing trust issues
2. **P0-2** — Fix `agent-orchestrator.yaml` runtime (5 min) — unblocks Windows users
3. **P1-5** — Fix sqlite fallbacks in LockManager/CostTracker (1 hour) — unblocks Windows build
4. **[BUILD-1]** — Run full `pnpm build` and fix any compile errors (unknown time)
5. **P1-1** — Fix TASK-1 hardcode (30 min) — unblocks AgentMesh page
6. **P1-3** — Fix QALoopStatus inline styles (30 min)
7. **P1-4** — Add agentmesh: to schema (1 hour)
8. **P1-2** — Add TaskBoard and QALoopStatus tests (3-4 hours)
9. **QC-10** + **CONS-4** — Register OpenCode/KimiCode adapters (30 min)
10. **DOC-2** — Remove phantom plugins from docs (30 min)
11. Run full first-run checklist [RUN-1 through RUN-9]
12. Run full QA checklist [QA-1 through QA-6]
13. Run integration test [INT-1]

**Estimated total fix time before launch: 2-3 days**

After all items above are ✅ green, re-run `/user-run` for final verdict.
