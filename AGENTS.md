# AGENTS.md

> Full project context, architecture, conventions, and plugin standards are in **CLAUDE.md**.

## Commands

```bash
pnpm install                            # Install dependencies
pnpm build                              # Build all packages
pnpm dev                                # Web dashboard dev server (Next.js + 2 WS servers)
pnpm typecheck                          # Type check all packages
pnpm test                               # All tests (excludes web)
pnpm --filter @aoagents/ao-web test     # Web tests
pnpm lint                               # ESLint check
pnpm lint:fix                           # ESLint fix
pnpm format                             # Prettier format
```

## Architecture TL;DR

Monorepo (pnpm) with packages: `core`, `cli`, `web`, and `plugins/*`. The web dashboard is a Next.js 15 app (App Router) with React 19 and Tailwind CSS v4. Data flows from `agent-orchestrator.yaml` through core's `loadConfig()` to API routes, served via SSR and a 5s-interval SSE stream. Terminal sessions use WebSocket connections to tmux PTYs. See CLAUDE.md for the full plugin architecture (8 slots), session lifecycle, and data flow.

## Working Principles

- **Think before coding.** State assumptions. Ask when unclear. Push back when a simpler approach exists.
- **Simplicity first.** No speculative features. No abstractions for single-use code. Plugin slots are the extension point.
- **Surgical changes.** Touch only what you must. Match existing style. Don't refactor things that aren't broken. Every changed line traces to the task.
- **Goal-driven.** Define verifiable success criteria before implementing. Write tests that reproduce bugs before fixing them.

Full guidelines with AO-specific context: see "Working Principles" in CLAUDE.md.

## Skills

Agents working on this repo should use these checked-in skills:

### Bug Triage (`skills/bug-triage/`)

**When to use:** Any time a bug is reported — in chat, issues, or live observation.

**What it covers:**
- Full triage workflow: gather context → search duplicates → file/update GitHub issues → push fix PRs
- Root cause analysis with `git log -S` archaeology and upstream dependency research
- GitHub API-based file editing (no local checkout needed) via `scripts/push_fix_to_github.py`
- NPM package regression diffing
- Remote code inspection when the repo isn't cloned locally

**How to load:** Read `skills/bug-triage/SKILL.md` and follow its step-by-step workflow. The `scripts/` directory contains executable tools:
- `push_fix_to_github.py` — Push a single-file fix and create a PR entirely via GitHub API

**Always pull latest main before triaging.** Stale code = bad triage. No exceptions.

## Key Files

- `packages/core/src/types.ts` — All plugin interfaces (Agent, Runtime, Workspace, etc.)
- `packages/core/src/session-manager.ts` — Session CRUD + stale runtime reconciliation (detects dead runtimes, persists `runtime_lost`)
- `packages/core/src/lifecycle-manager.ts` — State machine + polling loop
- `packages/core/src/lifecycle-state.ts` — Canonical lifecycle → legacy status mapping (`deriveLegacyStatus`)
- `packages/cli/src/commands/start.ts` — ao start/stop commands + Ctrl+C graceful shutdown
- `packages/cli/src/lib/running-state.ts` — RunningState + LastStopState management
- `packages/web/src/components/Dashboard.tsx` — Main dashboard view (sidebar uses unscoped sessions, kanban filters by project)
- `packages/web/src/components/SessionDetail.tsx` — Session detail view
- `packages/web/src/app/globals.css` — Design tokens

## CLI Behavior Notes

- `ao stop` loads global config to see all projects; `ao stop <project>` only kills that project's sessions
- Ctrl+C on `ao start` performs full graceful shutdown (same as `ao stop`)
- `LastStopState` includes `otherProjects` for cross-project session restore on next `ao start`
- Dashboard sidebar always shows ALL projects' sessions regardless of active project view

## Cross-Platform (Windows) Compatibility

AO ships on macOS, Linux, **and Windows**. All three are first-class.

**Golden Rule:** Never write `process.platform === "win32"` in new code. Use `isWindows()` from `@aoagents/ao-core`. If you need branching the helpers don't cover, add it to `packages/core/src/platform.ts` — never inline at the call site. Inline checks bypass the central platform-mock test pattern and become silent regressions.

**Read `docs/CROSS_PLATFORM.md` before merging any change that touches:** process spawning/killing/signalling, file paths, shell commands, network binding, POSIX shell-outs (`tmux`, `lsof`, etc.), runtime/agent/workspace plugins, agent-plugin internals (`setupPathWrapperWorkspace`, `getActivityState`, `formatLaunchCommand`, `isProcessRunning`, `detect()`), the Windows pty-host pipe protocol or registry, or any new `process.platform === "win32"` check.

That doc has the **full helper inventory** (every import path), the EPERM-vs-ESRCH gotcha when probing processes, path case-insensitivity rules, PowerShell-vs-bash differences (`& ` call-operator, `$env:VAR`, no `/dev/null`, no `$(cat …)`, `.cmd` shim resolution via `shell: isWindows()`), IPv6 `localhost` stalls on Windows, agent-plugin Windows specifics, the test pattern for mocking `process.platform`, and a 10-point pre-merge checklist. CLAUDE.md has the quick-reference helper table; CROSS_PLATFORM.md has the depth.
