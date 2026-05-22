# Implementation Plan — Parallel Agent Work Breakdown

## Dependency Graph

```
                        ┌─────────────────────┐
                        │  Phase 0: Foundation │ (sequential, orchestrator does this)
                        │                      │
                        │  1. Monorepo scaffold │
                        │  2. types.ts          │
                        │  3. config.ts + Zod   │
                        │  4. plugin-registry   │
                        │  5. All package.json  │
                        └──────────┬────────────┘
                                   │
              All Phase 1 agents work against the interfaces defined in types.ts
                                   │
         ┌──────────┬──────────┬───┴────┬──────────┬──────────┬──────────┐
         ▼          ▼          ▼        ▼          ▼          ▼          ▼
      Agent 1    Agent 2    Agent 3  Agent 4    Agent 5    Agent 6    Agent 7
      Core       Runtime    Agent    SCM +      CLI        Web        Notifier
      Services   Plugins    Plugins  Tracker               Dashboard  + Terminal
         │                                                    │
         │          All plugins are independent of            │
         │          each other — pure interface impls         │
         │                                                    │
         └──────── CLI + Web depend on core services ─────────┘
                   (can code against interfaces, wire up later)
```

## Phase 0: Foundation (Sequential — Orchestrator Does This)

**Must be done first. Everything else depends on it.**

Creates the monorepo scaffold and ALL type definitions. After this, every agent has:

- A package to work in (with package.json, tsconfig)
- All interfaces defined (they just implement them)
- No ambiguity about what to build

### Deliverables

1. `pnpm-workspace.yaml` + root `package.json` + `tsconfig.base.json`
2. `packages/core/src/types.ts` — ALL interfaces (Runtime, Agent, Workspace, Tracker, SCM, Notifier, Terminal, Session, Event, Config, etc.)
3. `packages/core/src/config.ts` — Zod schemas for YAML config validation
4. `packages/core/src/plugin-registry.ts` — Plugin discovery + loading skeleton
5. `packages/core/package.json` + `tsconfig.json`
6. All plugin package scaffolds (package.json + tsconfig + src/index.ts stub)
7. `packages/cli/package.json` + `packages/web/package.json` scaffolds
8. `agent-orchestrator.yaml.example`

**Estimated effort**: Medium. ~500-800 lines of types + config.

---

## Phase 1: Parallel Implementation (7 Agents)

### Agent 1: Core Services

**Package**: `packages/core/src/`
**Branch**: `feat/core-services`
**Depends on**: Phase 0 types
**Blocked by**: Nothing after Phase 0

| File                   | What                                                             | Reference Script                                |
| ---------------------- | ---------------------------------------------------------------- | ----------------------------------------------- |
| `metadata.ts`          | Flat-file metadata read/write (key=value)                        | Metadata parsing in all session managers        |
| `event-bus.ts`         | In-process pub/sub + JSONL persistence                           | New (inspired by OpenHands event stream)        |
| `tmux.ts`              | tmux command wrappers (list, new, send-keys, capture-pane, kill) | All scripts that call tmux                      |
| `session-manager.ts`   | Session CRUD: spawn, list, kill, cleanup, send message           | `claude-ao-session`                             |
| `lifecycle-manager.ts` | State machine per session + reaction engine                      | `claude-review-check` + `claude-session-status` |

**Key complexity**: session-manager.ts orchestrates Runtime + Agent + Workspace plugins together. lifecycle-manager.ts runs the polling loop and triggers reactions.

**Estimated effort**: Large (~1000-1500 lines)

---

### Agent 2: Runtime + Workspace Plugins

**Packages**: `packages/plugins/runtime-tmux/`, `runtime-process/`, `workspace-worktree/`, `workspace-clone/`
**Branch**: `feat/runtime-workspace-plugins`
**Depends on**: Phase 0 types only
**Blocked by**: Nothing after Phase 0

| Plugin               | What                                                               | Reference                          |
| -------------------- | ------------------------------------------------------------------ | ---------------------------------- |
| `runtime-tmux`       | Create/destroy tmux sessions, send-keys, capture-pane, alive check | `claude-ao-session` new/kill       |
| `runtime-process`    | Spawn child processes, stdin/stdout, signal handling               | New (for headless `claude -p`)     |
| `workspace-worktree` | `git worktree add/remove/list`, branch naming, symlinks            | `claude-ao-session` worktree logic |
| `workspace-clone`    | `git clone`, cleanup                                               | New (for Docker/cloud runtimes)    |

**Key complexity**: runtime-tmux must handle send-keys with proper escaping, busy detection, and the wait-for-idle pattern from `send-to-session`.

**Estimated effort**: Medium (~600-800 lines)

---

### Agent 3: Agent Plugins

**Packages**: `packages/plugins/agent-claude-code/`, `agent-codex/`, `agent-aider/`
**Branch**: `feat/agent-plugins`
**Depends on**: Phase 0 types only
**Blocked by**: Nothing after Phase 0

| Plugin              | What                                                                   | Reference                                                           |
| ------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `agent-claude-code` | Launch cmd, JSONL activity detection, process tree walk, introspection | `claude-status`, `get-claude-session-info`, `claude-session-status` |
| `agent-codex`       | Launch cmd, process detection                                          | New                                                                 |
| `agent-aider`       | Launch cmd, process detection                                          | New                                                                 |

**Key complexity**: `agent-claude-code` has the richest activity detection — reading JSONL session files, extracting summaries, walking process trees from tmux pane PID to find `claude` process, detecting working/idle/stuck/blocked states.

**Estimated effort**: Medium (~500-700 lines)

---

### Agent 4: SCM + Tracker Plugins

**Packages**: `packages/plugins/scm-github/`, `tracker-github/`, `tracker-linear/`
**Branch**: `feat/scm-tracker-plugins`
**Depends on**: Phase 0 types only
**Blocked by**: Nothing after Phase 0

| Plugin           | What                                                                                 | Reference                                                         |
| ---------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| `scm-github`     | PR detection, CI checks, review comments, automated comments, merge readiness, merge | `claude-review-check`, `claude-bugbot-fix`, dashboard PR fetching |
| `tracker-github` | Issue fetch, completion check, branch naming, prompt generation                      | `claude-splitly-session` (GitHub Issues)                          |
| `tracker-linear` | Issue fetch via GraphQL, completion check, branch naming                             | `claude-ao-session` + `claude-integrator-session` Linear checks   |

**Key complexity**: `scm-github` is the largest — it covers PR state, CI checks (gh pr checks), review decision (gh pr view), inline review comments (gh api), automated bot comments (cursor[bot], bugbot), and merge readiness.

**Estimated effort**: Large (~800-1000 lines)

---

### Agent 5: CLI

**Package**: `packages/cli/`
**Branch**: `feat/cli`
**Depends on**: Phase 0 types + core interfaces (codes against interfaces, wires up when core is ready)
**Partially blocked by**: Agent 1 (core services) for runtime testing

| Command                                | What                                                 | Reference Script                    |
| -------------------------------------- | ---------------------------------------------------- | ----------------------------------- |
| `ao init`                              | Interactive setup wizard → `agent-orchestrator.yaml` | New                                 |
| `ao status`                            | Colored terminal table of all sessions               | `claude-status`                     |
| `ao spawn <project> [issue]`           | Spawn single session                                 | `claude-spawn`                      |
| `ao batch-spawn <project> <issues...>` | Batch spawn with dedup                               | `claude-batch-spawn`                |
| `ao session ls\|kill\|cleanup`         | Session management                                   | `claude-ao-session` ls/kill/cleanup |
| `ao send <session> <message>`          | Smart message delivery                               | `send-to-session`                   |
| `ao review-check [project]`            | Trigger PR review fixes                              | `claude-review-check`               |
| `ao dashboard`                         | Start web server                                     | `claude-dashboard`                  |
| `ao open [session\|all]`               | Open terminal tabs                                   | `claude-open-all`, `open-iterm-tab` |

**Key complexity**: `ao status` needs rich terminal output (colors, columns, live data). `ao batch-spawn` needs duplicate detection.

**Can start immediately** by coding against core interfaces. Wire up real implementations when Agent 1 finishes.

**Estimated effort**: Large (~800-1200 lines)

---

### Agent 6: Web Dashboard

**Package**: `packages/web/`
**Branch**: `feat/web-dashboard`
**Depends on**: Phase 0 types + core interfaces
**Partially blocked by**: Agent 1 (core services) for API routes

| Component                     | What                                          | Reference                        |
| ----------------------------- | --------------------------------------------- | -------------------------------- |
| Next.js setup                 | App Router, Tailwind, dark theme              | New                              |
| `GET /api/sessions`           | List all sessions with full state             | `claude-dashboard` /api/sessions |
| `POST /api/spawn`             | Spawn new session                             | New                              |
| `POST /api/sessions/:id/send` | Send message to session                       | New                              |
| `POST /api/sessions/:id/kill` | Kill session                                  | New                              |
| `POST /api/prs/:id/merge`     | Merge PR                                      | New                              |
| `GET /api/events`             | SSE stream for real-time updates              | New (replaces polling)           |
| Dashboard page                | Attention-prioritized session cards           | `claude-dashboard` HTML          |
| Session detail page           | Full session info + terminal embed            | New                              |
| Components                    | SessionCard, PRStatus, CIBadge, AttentionZone | `claude-dashboard` HTML          |

**Key complexity**: SSE endpoint that streams lifecycle events in real-time. Attention-zone layout. xterm.js terminal embed.

**Can start immediately** with mock data, wire up real API when Agent 1 finishes.

**Estimated effort**: Large (~1500-2000 lines)

---

### Agent 7: Notifier + Terminal Plugins

**Packages**: `packages/plugins/notifier-desktop/`, `notifier-slack/`, `notifier-webhook/`, `terminal-iterm2/`, `terminal-web/`
**Branch**: `feat/notifier-terminal-plugins`
**Depends on**: Phase 0 types only
**Blocked by**: Nothing after Phase 0

| Plugin             | What                                                             | Reference                           |
| ------------------ | ---------------------------------------------------------------- | ----------------------------------- |
| `notifier-desktop` | OS notifications (node-notifier), click → deep link to dashboard | `notify-session`                    |
| `notifier-slack`   | Slack webhook messages with action buttons                       | New                                 |
| `notifier-webhook` | Generic HTTP POST                                                | New                                 |
| `terminal-iterm2`  | AppleScript tab management, reuse existing tabs                  | `open-iterm-tab`, `claude-open-all` |
| `terminal-web`     | xterm.js config for web-based terminal                           | New                                 |

**Key complexity**: `notifier-desktop` needs to be cross-platform (macOS/Linux/Windows). `terminal-iterm2` has AppleScript quirks (string length limits, tab detection).

**Estimated effort**: Medium (~500-700 lines)

---

## Parallelism Summary

```
Time ──────────────────────────────────────────────────►

Phase 0 (orchestrator):
████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░

Phase 1 (7 parallel agents):
         Agent 1 (core):     ████████████████████████░░
         Agent 2 (runtime):  ██████████████░░░░░░░░░░░░
         Agent 3 (agent):    ██████████████░░░░░░░░░░░░
         Agent 4 (scm):      ████████████████████░░░░░░
         Agent 5 (cli):      ████████████████████████░░  ← can start on interfaces, wire later
         Agent 6 (web):      ██████████████████████████  ← can start on UI, wire later
         Agent 7 (notifier): ██████████░░░░░░░░░░░░░░░░

Phase 2 (integration):       after all agents done
                                                  ████  ← wire everything together, test
```

### True Independence

These agents are **truly independent** after Phase 0:

- Agents 2, 3, 4, 7 implement plugin interfaces → zero inter-dependency
- Agent 1 (core) is the critical path
- Agents 5, 6 can start with mock/interface-only imports, wire later

### Risk: Agent 1 (Core) Is the Bottleneck

If core services are delayed, CLI and Web can't fully test. Mitigations:

- Agent 1 gets the most experienced agent
- Phase 0 writes enough core scaffolding (types, config, plugin-registry) that other agents aren't waiting
- CLI and Web start with mock implementations

---

## Linear Tickets (for spawning)

| Ticket | Title                                                                                 | Agent |
| ------ | ------------------------------------------------------------------------------------- | ----- |
| AO-10  | Implement core services (metadata, event-bus, session-manager, lifecycle-manager)     | 1     |
| AO-11  | Implement runtime + workspace plugins (tmux, process, worktree, clone)                | 2     |
| AO-12  | Implement agent plugins (claude-code, codex, aider)                                   | 3     |
| AO-13  | Implement SCM + tracker plugins (github SCM, github tracker, linear tracker)          | 4     |
| AO-14  | Implement CLI (ao init, status, spawn, session, send, review-check, dashboard, open)  | 5     |
| AO-15  | Implement web dashboard (Next.js, API routes, SSE, attention-zone UI, session detail) | 6     |
| AO-16  | Implement notifier + terminal plugins (desktop, slack, webhook, iterm2, web)          | 7     |

## Spawning Command

After Phase 0 is committed to `main`:

```bash
~/claude-batch-spawn ao AO-10 AO-11 AO-12 AO-13 AO-14 AO-15 AO-16
```

Each agent gets its own worktree branched from main (which contains the scaffold + types).
