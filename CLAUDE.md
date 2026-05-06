# CLAUDE.md

## What is this project?

Agent Orchestrator (AO) is a platform for spawning and managing parallel AI coding agents across distributed systems. It runs multiple agents (Claude Code, Codex, Aider, OpenCode) simultaneously — each in an isolated git worktree with its own PR — and provides a single dashboard to supervise them all. Agents autonomously fix CI failures, address review comments, and manage PRs.

**Org:** ComposioHQ
**Repo:** `github.com/ComposioHQ/agent-orchestrator`
**License:** MIT

## Monorepo Structure

pnpm workspace (v9.15.4) with ~30 packages:

```
packages/
  core/           # Engine: types, config, session manager, lifecycle, plugin registry
  cli/            # CLI tool (`ao` command) — depends on all plugins
  web/            # Next.js 15 dashboard (App Router, React 19, Tailwind v4)
  ao/             # Global CLI wrapper (thin shim around cli)
  plugins/
    agent-claude-code/    agent-aider/    agent-codex/    agent-opencode/
    runtime-tmux/         runtime-process/
    workspace-worktree/   workspace-clone/
    tracker-github/       tracker-linear/   tracker-gitlab/
    scm-github/           scm-gitlab/
    notifier-desktop/     notifier-slack/   notifier-webhook/
    notifier-composio/    notifier-openclaw/
    terminal-iterm2/      terminal-web/
  integration-tests/      # E2E tests
```

**Build order:** core -> plugins -> cli/web (parallel). `pnpm build` at root handles this.

## Tech Stack

| Layer | Stack |
|-------|-------|
| Language | TypeScript (strict mode, ES2022, Node16 modules) |
| Runtime | Node.js 20+ |
| Package Manager | pnpm 9.15.4 (`workspace:*` protocol) |
| Web | Next.js 15 (App Router) + React 19 |
| Styling | Tailwind CSS v4 + CSS custom properties (`@theme` block in `globals.css`) |
| Terminal UI | xterm.js 5.3.0 + WebSocket to tmux PTYs |
| Validation | Zod |
| Testing | Vitest + @testing-library/react |
| Linting | ESLint 10 (flat config) + Prettier 3.8 |
| CI/CD | GitHub Actions (lint, typecheck, test, release) |
| Versioning | Changesets |
| Git hooks | Husky + gitleaks (secret scanning) |
| Container | OCI via Containerfile (Podman/Docker) |

## Commands

```bash
# Install & build
pnpm install
pnpm build

# Development
pnpm dev                                    # Web dashboard (Next.js + 2 WS servers)

# Type checking
pnpm typecheck                              # All packages
pnpm --filter @aoagents/ao-web typecheck    # Web only

# Testing
pnpm test                                   # All packages (excludes web)
pnpm --filter @aoagents/ao-web test         # Web tests
pnpm --filter @aoagents/ao-web test:watch   # Web watch mode
pnpm test:integration                       # Integration tests

# Lint & format
pnpm lint
pnpm lint:fix
pnpm format
pnpm format:check
```

## Architecture

### Plugin System (8 Slots)

Every abstraction is a pluggable interface defined in `packages/core/src/types.ts`:

| Slot | Default | Purpose |
|------|---------|---------|
| Runtime | tmux | Where agents execute |
| Agent | claude-code | Which AI tool to use |
| Workspace | worktree | Code isolation (worktree vs clone) |
| Tracker | github | Issue tracking (GitHub, Linear, GitLab) |
| SCM | github | PR, CI, reviews |
| Notifier | desktop | Notification delivery |
| Terminal | iterm2 | Human attachment UI |
| Lifecycle | core (non-pluggable) | State machine + polling |

### Session Lifecycle

Sessions have a **canonical lifecycle** (in `lifecycle-state.ts`) with separate `state` and `reason` fields, and a **legacy status** derived from them for display.

**Canonical session states:** `not_started`, `working`, `idle`, `needs_input`, `stuck`, `detecting`, `done`, `terminated`

**Terminal reasons:** `manually_killed`, `runtime_lost`, `agent_process_exited`, `probe_failure`, `error_in_process`, `auto_cleanup`, `pr_merged`

**Legacy status flow (derived via `deriveLegacyStatus`):**
```
spawning -> working -> pr_open -> ci_failed / review_pending
                                      |              |
                              changes_requested   approved
                                      |              |
                                      +-> mergeable -> merged -> cleanup -> done
```

**Stale runtime reconciliation:** `sm.list()` detects dead runtimes (tmux/process gone) during enrichment and persists `runtime_lost` reason to disk. This maps to legacy status `killed`. Without this, sessions with dead runtimes would show stale "active" status indefinitely.

### Data Flow

```
agent-orchestrator.yaml -> Config Loader (Zod) -> Plugin Registry
  -> Session Manager -> Lifecycle Manager (polling loop, state machine)
  -> Events -> Notifiers
  -> Web API Routes (Next.js) -> SSE (5s interval) + WebSocket (terminal)
  -> Dashboard (React + xterm.js)
```

### Storage

No database. Flat files + memory:

- **Config:** `agent-orchestrator.yaml` (Zod-validated)
- **Global config:** `~/.agent-orchestrator/config.yaml` (all registered projects)
- **Session metadata:** `~/.agent-orchestrator/{hash}-{projectId}/sessions/{sessionId}` (key-value pairs)
- **Worktrees:** `~/.agent-orchestrator/{hash}-{projectId}/worktrees/{sessionId}/`
- **Archives:** `~/.agent-orchestrator/{hash}-{projectId}/archive/{sessionId}_{timestamp}`
- **Running state:** `~/.agent-orchestrator/running.json` (current ao start PID, port, projects)
- **Last-stop state:** `~/.agent-orchestrator/last-stop.json` (sessions killed by ao stop / Ctrl+C, includes `otherProjects` for cross-project sessions — used by ao start to offer session restore)

Hash = SHA-256 of config directory (first 12 chars). Prevents collision across multiple checkouts.

**Config resolution:** `loadConfig()` searches up from cwd and finds the nearest `agent-orchestrator.yaml` (typically 1 project). The global config at `~/.agent-orchestrator/config.yaml` contains all registered projects. CLI commands that need cross-project visibility (ao stop, tab completions) fall back to the global config.

### Prompt Assembly (3 Layers)

1. Base prompt (system instructions in core)
2. Config prompt (project-specific rules from YAML)
3. Rules files (optional `.agent-rules.md` from repo)

## Working Principles

These behavioral guidelines apply to every agent working on this codebase. They are not optional - they prevent the most common causes of PR rejection and rewrite.

### Think Before Coding

Don't assume. Don't hide confusion. Surface tradeoffs.

- State assumptions explicitly. If uncertain, ask.
- If multiple interpretations of a task exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.
- When editing `lifecycle-manager.ts` or `session-manager.ts`: state which invariants your change preserves. These files have subtle state dependencies.

### Simplicity First

Minimum code that solves the problem. Nothing speculative.

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- Plugin slots are the extension point. Don't add configuration surface when a new plugin is the right answer.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

### Surgical Changes

Touch only what you must. Clean up only your own mess.

- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If your changes create orphans (unused imports, dead variables), remove them.
- Don't remove pre-existing dead code unless asked.
- Every changed line should trace directly to the task description.

This is especially critical in:
- `types.ts` - changing an interface breaks every plugin. Minimize surface changes.
- `globals.css` - tokens are consumed across 50+ components. Don't rename casually.
- `lifecycle-manager.ts` - state transitions have implicit dependencies. Document why a transition is safe.

### Goal-Driven Execution

Define success criteria. Loop until verified.

Transform tasks into verifiable goals:
- "Add a new status" -> "Add to enum, update `isTerminalSession`, add to dashboard column mapping, write tests for all three"
- "Fix the bug" -> "Write a test that reproduces it, then make it pass"
- "Refactor X" -> "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:

[Step] -> verify: [check]
[Step] -> verify: [check]
[Step] -> verify: [check]

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

## CLI Behavior (ao start / ao stop)

### ao start
- Registers in `running.json` (PID, port, projects)
- Offers to restore sessions from `last-stop.json` — includes cross-project sessions via `otherProjects` field
- **Ctrl+C performs full graceful shutdown** (same as ao stop): kills all sessions, writes last-stop state, unregisters from running.json. 10s hard timeout guarantees exit.

### ao stop
- `ao stop` (no args): kills ALL sessions across ALL projects, sends SIGTERM to parent ao start process, stops dashboard, unregisters
- `ao stop <project>`: kills only that project's sessions, does NOT kill parent process or dashboard (they serve all projects)
- Always loads global config (`~/.agent-orchestrator/config.yaml`) to see all projects — local config only has the cwd project
- Records `LastStopState` with `otherProjects` field for cross-project session restore

### Dashboard sidebar
- Sidebar always shows sessions from ALL projects regardless of which project page is active
- `useSessionEvents` in Dashboard.tsx is called without project filter — sidebar gets unscoped sessions
- Kanban board filters client-side via `projectSessions` memo

### Key invariants
- `sm.list()` persists `runtime_lost` lifecycle to disk when enrichment detects dead runtimes — this is the only place stale runtime state gets reconciled
- `deriveLegacyStatus()` maps canonical lifecycle to legacy status — new terminal reasons must be added here
- Tab completions merge local config + global config to show all projects

## Conventions

### Code Style

- **TypeScript strict mode** — no `any` types (`@typescript-eslint/no-explicit-any: error`)
- **Consistent type imports** — `import type { Foo }` enforced by ESLint
- **Immutable patterns** — spread operator, never mutate in place
- **Prefer const** — `no-var`, `prefer-const`
- **No eval** — `no-eval`, `no-implied-eval`, `no-new-func`
- **Unused vars** — prefix with `_` (`argsIgnorePattern: "^_"`)

### File Organization

- Components in flat `components/` directory (no nesting)
- Hooks in `hooks/` with `use` prefix
- Tests in `__tests__/` subdirectories
- No barrel files except `core/src/index.ts`
- Max 400 lines per component file

### Naming

- PascalCase for components/classes
- camelCase for functions/variables
- `use*` for hooks, `is*`/`has*` for booleans

### Imports

- `@/` alias -> `packages/web/src/`
- `@aoagents/ao-core` for core imports
- `workspace:*` for cross-package

### Web / Styling

- Tailwind utility classes only — **no inline `style=` attributes**
- CSS custom properties via `var(--color-*)` from `globals.css` `@theme` block
- Dark theme must always be preserved
- **No external UI component libraries** (no Radix, shadcn, etc.)
- Client components marked `"use client"`; server components for pages
- State: React hooks only (no Redux/Zustand)
- Real-time updates: SSE via `useSessionEvents` hook (5s interval, do not change)

### Testing

- Vitest + @testing-library/react
- Test files: `{Module}.test.ts` or `{Component}.test.tsx` in `__tests__/`
- Test files for all new components
- Relaxed lint in tests: `any` and `console.log` allowed

### Commits

- Conventional commits: `feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`, `perf:`, `ci:`
- Changesets for version management
- gitleaks pre-commit hook — never commit secrets

## Key Files

| File | Purpose |
|------|---------|
| `packages/core/src/types.ts` | Central type definitions (all 8 plugin interfaces) |
| `packages/core/src/session-manager.ts` | Session CRUD + stale runtime reconciliation (persists runtime_lost on dead runtimes) |
| `packages/core/src/lifecycle-manager.ts` | State machine + polling loop + reactions |
| `packages/core/src/lifecycle-state.ts` | Canonical lifecycle → legacy status mapping (deriveLegacyStatus) |
| `packages/core/src/config.ts` | YAML config loading with Zod validation |
| `packages/core/src/plugin-registry.ts` | Plugin discovery and resolution |
| `packages/core/src/index.ts` | Core public API (stable, do not break) |
| `packages/web/src/components/Dashboard.tsx` | Main dashboard view |
| `packages/web/src/components/SessionDetail.tsx` | Session detail view |
| `packages/web/src/components/DirectTerminal.tsx` | xterm.js terminal with WebSocket |
| `packages/web/src/components/SessionCard.tsx` | Kanban session card |
| `packages/web/src/hooks/useSessionEvents.ts` | SSE consumer hook (project filter optional — sidebar uses unscoped) |
| `packages/web/src/lib/types.ts` | Dashboard types |
| `packages/web/src/app/globals.css` | Design tokens and base styles (full token definitions) |
| `DESIGN.md` | **Design system reference** — design principles, token mapping, component patterns, anti-patterns (read this before writing any web UI) |
| `agent-orchestrator.yaml` | Project-level config (user-created) |
| `eslint.config.js` | ESLint flat config |
| `tsconfig.base.json` | Shared TypeScript base config |
| `packages/cli/src/commands/start.ts` | ao start/stop commands + Ctrl+C graceful shutdown |
| `packages/cli/src/lib/running-state.ts` | RunningState + LastStopState management (register/unregister, last-stop read/write) |
| `packages/web/src/components/ProjectSidebar.tsx` | Sidebar — always shows all projects' sessions |

## Plugin Standards

### Package Layout

```
packages/plugins/{slot}-{name}/
├── package.json          # @aoagents/ao-plugin-{slot}-{name}
├── tsconfig.json         # extends ../../../tsconfig.base.json
├── src/
│   ├── index.ts          # manifest + create + detect (default export)
│   └── __tests__/        # vitest tests
```

### Naming

- Package: `@aoagents/ao-plugin-{slot}-{name}` (lowercase, hyphenated)
- `manifest.name` must match the `{name}` suffix (e.g. package `...-runtime-tmux` -> name: `"tmux"`)
- `manifest.slot` must use `as const` to preserve the literal type

### Export Contract

Every plugin default-exports a `PluginModule<T>`:

```typescript
import type { PluginModule, Runtime } from "@aoagents/ao-core";

export const manifest = {
  name: "tmux",
  slot: "runtime" as const,
  description: "tmux session runtime",
  version: "0.1.0",
};

export function create(config?: Record<string, unknown>): Runtime {
  // Validate config here, not in individual methods
  // Use closure to capture validated config
  return { ... };
}

// Optional: check if binary/dependency is available on system
export function detect(): boolean { ... }

export default { manifest, create, detect } satisfies PluginModule<Runtime>;
```

### Config Handling

- Plugin-level config comes via `create(config)` from the YAML notifier/tracker blocks
- Project-level config (e.g. `agentConfig`, `trackerConfig`) is passed to individual methods
- Validate in `create()`, store via closure — don't re-validate per call
- Warn (don't throw) for missing optional config during plugin load
- Throw with descriptive message when a required config is missing at method call time

### Error Handling

- Wrap errors with `cause` for debugging: `throw new Error("msg", { cause: err })`
- Return `null` for "not found" (e.g. tracker issue lookup), throw for unexpected errors
- Never silently swallow errors
- Use `shellEscape()` from core for all command arguments (prevent injection)

### Interface Implementation

- All I/O methods return `Promise<T>` (async-first)
- Plugins are loosely coupled — communicate through Session object and Lifecycle Manager, never call other plugins directly
- Implement `destroy()` / cleanup with best-effort semantics

### Core Utilities Available to Plugins

```typescript
import {
  shellEscape,                  // Safe command argument escaping
  validateUrl,                  // Webhook URL validation
  readLastJsonlEntry,           // Efficient JSONL log tail (native agent JSONL)
  readLastActivityEntry,        // Read last AO activity JSONL entry
  checkActivityLogState,        // Extract waiting_input/blocked from AO JSONL (with staleness cap)
  getActivityFallbackState,     // Last-resort fallback: entry state + age-based decay
  recordTerminalActivity,       // Shared recordActivity impl (classify + dedup + append)
  classifyTerminalActivity,     // Classify terminal output via detectActivity
  appendActivityEntry,          // Low-level JSONL append
  setupPathWrapperWorkspace,    // Install ~/.ao/bin wrappers + .ao/AGENTS.md
  buildAgentPath,               // Prepend ~/.ao/bin to PATH
  normalizeAgentPermissionMode, // Normalize permission mode strings
  DEFAULT_READY_THRESHOLD_MS,   // 5 min — ready→idle threshold
  DEFAULT_ACTIVE_WINDOW_MS,     // 30s — active→ready window
  ACTIVITY_INPUT_STALENESS_MS,  // 5 min — waiting_input/blocked expiry
  PREFERRED_GH_PATH,            // /usr/local/bin/gh
  CI_STATUS, ACTIVITY_STATE, SESSION_STATUS,  // Constants
  type Session, type ProjectConfig, type RuntimeHandle,
} from "@aoagents/ao-core";
```

### Testing

- Vitest in `src/__tests__/index.test.ts`
- Mock external CLIs, file I/O, HTTP calls
- Test manifest values, `create()` return shape, all public methods, and error paths
- Use `beforeEach` to reset mocks

### Common Pitfalls

- Hardcoded secrets -> use `process.env`, throw if missing
- Shell injection -> use `shellEscape()` for all arguments
- Large file reads -> use streaming or `readLastJsonlEntry()`
- Config validation in methods -> validate once in `create()`, closure the rest

### Agent Plugin Implementation Standards

All agent plugins (claude-code, codex, aider, opencode, etc.) must implement the full `Agent` interface. The dashboard depends on these methods for PR tracking, cost display, and session resume.

**Required methods (all agents):**

| Method | Purpose | Return `null` OK? |
|--------|---------|-------------------|
| `getLaunchCommand` | Shell command to start the agent | No |
| `getEnvironment` | Env vars for agent process (must include `~/.ao/bin` in PATH) | No |
| `detectActivity` | Terminal output classification (deprecated, but required) | No |
| `getActivityState` | JSONL/API-based activity detection (min 3 states: active/ready/idle) | Yes (if no data) |
| `isProcessRunning` | Check process alive via tmux TTY or PID | No |
| `getSessionInfo` | Extract summary, cost, session ID from agent's data | Yes (if agent has no introspection) |

**Optional methods (implement when the agent supports it):**

| Method | Purpose | When to skip |
|--------|---------|-------------|
| `getRestoreCommand` | Resume a previous session | Agent has no resume capability (return `null`) |
| `setupWorkspaceHooks` | Install metadata-update hooks (PATH wrappers or agent-native) | Never — required for dashboard PR tracking |
| `postLaunchSetup` | Post-launch config (re-ensure hooks, resolve binary) | Only if no post-launch work needed |
| `recordActivity` | Write terminal-derived activity to JSONL for `getActivityState` | Agent has native JSONL with full state coverage (Claude Code). Codex implements it as a safety net for when its native JSONL is missing/unparseable. |

**Metadata hooks are critical.** Without `setupWorkspaceHooks`, PRs created by agents won't appear in the dashboard. Two patterns exist:
- **Agent-native hooks** (Claude Code): PostToolUse hooks in `.claude/settings.json`
- **PATH wrappers** (Codex, Aider, OpenCode): `~/.ao/bin/gh` and `~/.ao/bin/git` intercept commands. Call `setupPathWrapperWorkspace(workspacePath)` — it installs wrappers to `~/.ao/bin/` and writes session context to `.ao/AGENTS.md` (gitignored, does not modify tracked files).

**Environment requirements:**
- All agents must set `AO_SESSION_ID` and optionally `AO_ISSUE_ID`
- All agents using PATH wrappers must prepend `~/.ao/bin` to PATH
- Use `normalizeAgentPermissionMode` from `@aoagents/ao-core` (not a local duplicate)

**Activity detection architecture:**

`getActivityState` is the most critical method in the agent plugin. The dashboard, lifecycle manager, and stuck-detection all depend on it returning correct states. **Every agent plugin must produce all 6 states over its lifetime:**

```
spawning → active ↔ ready → idle → exited
                ↘ waiting_input / blocked ↗
```

| State | Meaning | When |
|-------|---------|------|
| `active` | Agent is working right now | Activity within last 30s |
| `ready` | Agent finished recently, may resume | 30s–5min since last activity |
| `idle` | Agent has been quiet for a while | >5min since last activity |
| `waiting_input` | Agent is blocked on user approval | Permission prompt visible |
| `blocked` | Agent hit an error it can't recover from | Error state detected |
| `exited` | Process is dead | `isProcessRunning` returns false |

**The `getActivityState` contract — implement exactly this cascade:**

```typescript
async getActivityState(session, readyThresholdMs?): Promise<ActivityDetection | null> {
  // 1. PROCESS CHECK — always first
  if (!running) return { state: "exited", timestamp };

  // 2. ACTIONABLE STATES — check for waiting_input/blocked
  //    Source: native JSONL (Claude Code, Codex) OR AO activity JSONL (others)
  //    These are the only states checkActivityLogState() surfaces.
  //    If found, return immediately.

  // 3. NATIVE SIGNAL — agent-specific API for timestamp (preferred)
  //    Source: agent's session list API, native JSONL timestamps, etc.
  //    Classify by age: active (<30s) / ready (30s–threshold) / idle (>threshold)

  // 4. JSONL ENTRY FALLBACK — always implement this
  //    Source: getActivityFallbackState(activityResult, activeWindowMs, threshold)
  //    Uses the entry's detected state + entry.ts for age-based decay.
  //    Decay only demotes (active→ready→idle), never promotes.
  //    This is the SAFETY NET when the native signal is unavailable.
  //    Without this, getActivityState returns null and the dashboard shows
  //    no activity for the entire session lifetime.

  // 5. Return null only if there is genuinely no data at all.
}
```

**Step 4 is mandatory.** If you skip the JSONL entry fallback, `getActivityState` will return `null` whenever the native API fails (binary not in PATH, API changed, session not found, timeout). The dashboard will show no activity state and stuck-detection breaks. This was a real bug in the OpenCode plugin — `findOpenCodeSession` returned null due to a session creation issue, and without the fallback, the entire active/ready/idle flow was dead. Use `getActivityFallbackState()` from core — it handles age-based decay and staleness caps correctly.

**Two activity detection patterns exist:**

| Pattern | Used by | How it works |
|---------|---------|-------------|
| **Native JSONL** | Claude Code, Codex | Agent writes its own JSONL with rich state (`permission_request`, `tool_call`, `error`, etc.). `getActivityState` reads the last entry and maps it to activity states. |
| **AO Activity JSONL** | Aider, OpenCode, new agents | Agent implements `recordActivity`. Lifecycle manager calls it each poll cycle with terminal output. It calls `classifyTerminalActivity()` → `appendActivityEntry()` to write to `{workspacePath}/.ao/activity.jsonl`. `getActivityState` reads from this file. |

**For agents using AO Activity JSONL (the common case for new plugins):**

1. Implement `recordActivity` — delegate to the shared `recordTerminalActivity()`:
```typescript
async recordActivity(session: Session, terminalOutput: string): Promise<void> {
  if (!session.workspacePath) return;
  await recordTerminalActivity(session.workspacePath, terminalOutput, (output) =>
    this.detectActivity(output),
  );
}
```

`recordTerminalActivity` handles classification, deduplication (20s window for non-actionable states), and appending. You don't need to implement dedup yourself.

2. Implement `detectActivity` with patterns specific to the agent's terminal output:
```typescript
detectActivity(terminalOutput: string): ActivityState {
  // Match the ACTUAL prompts/patterns the agent emits.
  // Test with real terminal output — don't guess patterns.
  // Return: "idle" | "active" | "waiting_input" | "blocked"
}
```

3. In `getActivityState`, use `checkActivityLogState()` for waiting_input/blocked, then fall back to `getActivityFallbackState()`:
```typescript
// checkActivityLogState returns non-null ONLY for waiting_input/blocked.
// active/idle/ready intentionally return null — use the fallback for those.
const activityResult = await readLastActivityEntry(session.workspacePath);
const activityState = checkActivityLogState(activityResult);
if (activityState) return activityState;

// ... try native signal first (session list API, git commits, etc.) ...

// JSONL entry fallback (REQUIRED — do not skip)
const activeWindowMs = Math.min(DEFAULT_ACTIVE_WINDOW_MS, threshold);
const fallback = getActivityFallbackState(activityResult, activeWindowMs, threshold);
if (fallback) return fallback;
```

`getActivityFallbackState` uses the entry's detected state with age-based decay (active→ready→idle) and respects the entry state as a ceiling (never promotes idle to active). Stale waiting_input/blocked entries (>5min) decay to idle.

**Required tests for `getActivityState` — all agent plugins must have these:**

1. Returns `exited` when process is not running
2. Returns `waiting_input` from JSONL when agent is at a permission prompt
3. Returns `blocked` from JSONL when agent hit an error
4. Returns `active` from native signal when agent was recently active
5. Returns `active` from JSONL entry fallback when native signal fails (fresh entry)
6. Returns `idle` from JSONL entry fallback when native signal fails (old entry with age decay)
7. Returns `null` when both native signal and JSONL are unavailable

**`isProcessRunning` must:**
- Support tmux runtime (TTY-based `ps` lookup with process name regex)
- Support process runtime (PID signal-0 check with EPERM handling)
- Match BOTH the node wrapper name AND the actual binary name (some agents install as `.agentname` with a dot prefix — the regex must handle this)
- Return `false` (not `null`) on error

## Constraints

- C-01: No new UI component libraries
- C-02: No inline styles in new/modified code
- C-04: Component files max 400 lines
- C-05: Dark theme preserved (no redesign)
- C-06: Next.js App Router only
- C-07: No animation libraries
- C-12: Test files for all new components
- C-13: pnpm `workspace:*` protocol for cross-package deps
- C-14: SSE 5s interval unchanged
