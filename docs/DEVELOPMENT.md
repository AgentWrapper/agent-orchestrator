# Development Guide

Architecture overview, code conventions, and patterns for contributors and AI agents working on this codebase.

## Architecture Overview

Agent Orchestrator is a monorepo with four main packages:

```
packages/
├── core/          # Types, services, config — the engine
├── cli/           # `ao` command (depends on core + all plugins)
├── web/           # Next.js dashboard (depends on core)
└── plugins/       # 21 plugin packages across 8 slots
```

**Build order matters**: core must be built before cli, web, or plugins.

### Eight Plugin Slots

Every abstraction is a swappable plugin. All interfaces are defined in [`packages/core/src/types.ts`](../packages/core/src/types.ts).

| Slot      | Interface   | Default       | Alternatives                             |
| --------- | ----------- | ------------- | ---------------------------------------- |
| Runtime   | `Runtime`   | `tmux`        | `process`, `docker`, `k8s`, `ssh`, `e2b` |
| Agent     | `Agent`     | `claude-code` | `codex`, `aider`, `cursor`, `kimicode`, `opencode` |
| Workspace | `Workspace` | `worktree`    | `clone`                                  |
| Tracker   | `Tracker`   | `github`      | `linear`                                 |
| SCM       | `SCM`       | `github`      | —                                        |
| Notifier  | `Notifier`  | `desktop`     | `slack`, `webhook`, `composio`           |
| Terminal  | `Terminal`  | `iterm2`      | `web`                                    |
| Lifecycle | —           | (core)        | Non-pluggable                            |

### Hash-Based Namespacing

All runtime data paths are derived from a SHA-256 hash of the config file directory:

```typescript
const hash = sha256(path.dirname(configPath)).slice(0, 12); // e.g. "a3b4c5d6e7f8"
const instanceId = `${hash}-${projectId}`; // e.g. "a3b4c5d6e7f8-myapp"
const dataDir = `~/.agent-orchestrator/${instanceId}`;
```

This means:

- Multiple orchestrator checkouts on the same machine never collide
- Session names are globally unique in tmux: `{hash}-{prefix}-{num}`
- User-facing names stay clean: `ao-1`, `myapp-2`

### Session Lifecycle

```
spawning → working → pr_open → ci_failed
                             → review_pending → changes_requested
                             → approved → mergeable → merged
                                                    ↓
                             cleanup → done (or killed/terminated)
```

Activity states (orthogonal to lifecycle): `active`, `ready`, `idle`, `waiting_input`, `blocked`, `exited`.

### Key Services

| File                                     | Purpose                                         |
| ---------------------------------------- | ----------------------------------------------- |
| `packages/core/src/session-manager.ts`   | Session CRUD: spawn, list, kill, send, restore  |
| `packages/core/src/lifecycle-manager.ts` | State machine, polling loop, reactions engine   |
| `packages/core/src/prompt-builder.ts`    | Layered worker prompt assembly (system + task)  |
| `packages/core/src/config.ts`            | Config loading and Zod validation               |
| `packages/core/src/plugin-registry.ts`   | Plugin discovery, loading, resolution           |
| `packages/core/src/agent-selection.ts`   | Resolves worker vs orchestrator agent roles     |
| `packages/core/src/observability.ts`     | Correlation IDs, structured logging, metrics    |
| `packages/core/src/paths.ts`             | Hash-based path and session name generation     |

### Working Principles

These apply to both human contributors and AI agents:

1. **Think before coding.** If a task is ambiguous, ask for clarification. If multiple approaches exist, present the tradeoff.
2. **Minimum code.** No speculative features. No abstractions for code used once. Plugin slots exist for extensibility - use them instead of config proliferation.
3. **Surgical diffs.** Don't touch files outside your change scope. Don't reformat adjacent code. Match existing patterns even if you prefer differently. Every changed line should trace to a specific requirement.
4. **Verifiable goals.** Before implementing, state what "done" looks like and how to verify it. For bug fixes: write a test that reproduces the bug first.

For AI agent-specific guidance (including high-risk files like `types.ts`, `lifecycle-manager.ts`, `globals.css`), see CLAUDE.md -> Working Principles.

---

## Getting Started

**Prerequisites**: Node.js 20+, pnpm 9.15+, Git 2.25+

```bash
git clone https://github.com/ComposioHQ/agent-orchestrator.git
cd agent-orchestrator
pnpm install
pnpm build
cp agent-orchestrator.yaml.example agent-orchestrator.yaml
$EDITOR agent-orchestrator.yaml
```

### Running the dev server

**Always build before starting the web dev server** — it depends on built packages:

```bash
pnpm build
cd packages/web && pnpm dev
# Open http://localhost:3000
```

### Project structure

```
agent-orchestrator/
├── packages/
│   ├── core/              # Core types, services, config
│   ├── cli/               # CLI tool (ao command)
│   ├── web/               # Next.js dashboard
│   ├── plugins/           # All plugin packages
│   │   ├── runtime-*/     # Runtime plugins (tmux, docker, k8s)
│   │   ├── agent-*/       # Agent adapters (claude-code, codex, aider)
│   │   ├── workspace-*/   # Workspace providers (worktree, clone)
│   │   ├── tracker-*/     # Issue trackers (github, linear)
│   │   ├── scm-github/    # SCM adapter
│   │   ├── notifier-*/    # Notification channels
│   │   └── terminal-*/    # Terminal UIs
│   └── integration-tests/ # Integration tests
├── agent-orchestrator.yaml.example
└── docs/                  # Documentation
```

---

## Development Workflow

1. **Create a feature branch**

   ```bash
   git checkout -b feat/your-feature
   ```

2. **Make your changes** — follow conventions below, add tests, update docs

3. **Build and test**

   ```bash
   pnpm build && pnpm test && pnpm lint && pnpm typecheck
   ```

4. **Commit** using [Conventional Commits](https://www.conventionalcommits.org/)

   ```bash
   git commit -m "feat: add your feature"
   ```

   Pre-commit hook scans for secrets automatically.

5. **Push and open a PR**

---

## Keeping the local AO install current

When you are developing Agent Orchestrator from a long-lived local checkout, refresh the local `ao` install before debugging launcher or packaging issues:

```bash
git switch main
git status --short --branch   # `ao update` expects a clean working tree on main
ao update
```

`ao update` is intentionally conservative: it fast-forwards the local install checkout from `origin/main`, runs `pnpm install`, clean-rebuilds `@aoagents/ao-core`, `@aoagents/ao-cli`, and `@aoagents/ao-web`, refreshes the global launcher with `npm link`, and ends with CLI smoke tests. Use `ao update --skip-smoke` to stop after the rebuild, or `ao update --smoke-only` to rerun the smoke checks without fetching or rebuilding.

If your branch has drift from `main`, update the install checkout first and then return to your feature worktree. That keeps CLI behavior and generated docs aligned with the version contributors are expected to run.

---

## Code Conventions

### TypeScript

```typescript
// ESM modules only — all packages use "type": "module"
// .js extension required on local imports
import { foo } from "./bar.js";
import type { Session } from "./types.js";

// node: prefix for builtins
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";

// No `any` — use `unknown` + type guards
function processInput(value: unknown): string {
  if (typeof value !== "string") throw new Error("Expected string");
  return value.trim();
}

// Type-only imports for type-only usage
import type { PluginModule, Runtime } from "@aoagents/ao-core";
```

Formatting: semicolons, double quotes, 2-space indent, strict mode.

### Shell Commands

These rules prevent command injection. Follow them exactly.

```typescript
// Always execFile (never exec — exec runs a shell, enabling injection)
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);

// Always pass arguments as an array (never interpolate into strings)
await execFileAsync("git", ["checkout", "-b", branchName]);

// Always add timeouts
await execFileAsync("gh", ["pr", "create", "--title", title], {
  timeout: 30_000,
});

// Never use JSON.stringify for shell escaping — use the array form
// ❌ Bad
await execFileAsync("sh", ["-c", `git commit -m "${message}"`]);
// ✅ Good
await execFileAsync("git", ["commit", "-m", message]);
```

---

## Plugin Pattern

A plugin exports a `manifest`, a `create()` factory, and a default `PluginModule` export.

```typescript
// packages/plugins/runtime-myplugin/src/index.ts
import type { PluginModule, Runtime } from "@aoagents/ao-core";

export const manifest = {
  name: "myplugin",
  slot: "runtime" as const,
  description: "My custom runtime",
  version: "0.1.0",
};

export function create(): Runtime {
  return {
    name: "myplugin",
    async create(config) {
      /* start session */
    },
    async destroy(sessionName) {
      /* tear down */
    },
    async send(sessionName, text) {
      /* send input */
    },
    async isRunning(sessionName) {
      return false;
    },
  };
}

export default { manifest, create } satisfies PluginModule<Runtime>;
```

**Plugin package setup** — `package.json`:

```json
{
  "name": "@aoagents/ao-runtime-myplugin",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc --noEmit",
    "test": "vitest"
  },
  "dependencies": {
    "@aoagents/ao-core": "workspace:*"
  }
}
```

After creating the package, add it to `packages/cli/package.json` and register it in `packages/core/src/plugin-registry.ts` inside `loadBuiltins()`.

---

## Spawn Flow

`session-manager.ts:spawn()` is the core path most features touch:

```
spawn(config)
  ├─ Validate issue (Tracker.getIssue) — fails fast, no resources created yet
  ├─ Reserve session ID
  ├─ Determine branch name
  ├─ Create workspace (Workspace.create)
  ├─ Generate issue prompt (Tracker.generatePrompt)
  ├─ Assemble layered prompt (prompt-builder.ts) → {systemPrompt, taskPrompt}
  ├─ Persist worker system prompt file
  ├─ For OpenCode workers: write OPENCODE_CONFIG pointing at that file
  ├─ Build agent launch command (Agent.getLaunchCommand)
  ├─ Create runtime session (Runtime.create)
  ├─ Post-launch setup (Agent.postLaunchSetup, optional)
  └─ Write metadata file → return Session
```

If issue validation fails, nothing is created — fail before allocating resources.

---

## Prompt Assembly

Worker prompts are built in three persistent layers (`packages/core/src/prompt-builder.ts`):

1. **Base agent guidance** — standard instructions for all sessions (git workflow, PR conventions, lifecycle hooks)
2. **Config context** — project-specific info (repo, branch, tracker, issue details, automated reactions)
3. **Project rules** — content from `agentRules` / `agentRulesFile`

The explicit user request is returned separately as `taskPrompt`. This lets session manager persist stable system instructions to disk while still sending only task-specific text to agents that need post-launch prompt delivery.

Orchestrator sessions use a separate prompt from `packages/core/src/orchestrator-prompt.ts`.

---

## Testing

```bash
# Run all tests
pnpm test

# Run tests for a specific package
pnpm --filter @aoagents/ao-core test

# Watch mode
pnpm --filter @aoagents/ao-core test -- --watch

# Integration tests
pnpm test:integration
```

Key test files in core (`src/__tests__/`):

- `session-manager.test.ts` — session CRUD and spawn flow
- `lifecycle-manager.test.ts` — state machine and reactions
- `plugin-registry.test.ts` — plugin loading and resolution
- `prompt-builder.test.ts` — prompt generation

Use mock plugins in tests — don't call real tmux or external services in unit tests.

---

## Common Development Tasks

### Add a field to Session

1. Edit `Session` interface in `packages/core/src/types.ts`
2. Initialize the field in `spawn()` in `session-manager.ts`
3. Rebuild: `pnpm --filter @aoagents/ao-core build`

### Add a new reaction

1. Add handler in `packages/core/src/lifecycle-manager.ts`
2. Wire it up in the polling loop
3. Add config schema in `packages/core/src/config.ts` if needed

### Add a new event type

1. Extend `EventType` union in `packages/core/src/types.ts`
2. Emit it via `eventEmitter.emit()` in the relevant service
3. Handle it in `lifecycle-manager.ts` if it should trigger a reaction

### Add a new CLI command

1. Add the command in `packages/cli/src/index.ts` using `commander`
2. Import from core services as needed
3. Update the CLI reference in `README.md`

### Debug a session

```bash
# Inspect raw metadata
cat ~/.agent-orchestrator/{hash}-{project}/sessions/{session-id}

# Check API state
curl http://localhost:3000/api/sessions/{session-id}

# Attach to tmux session directly
tmux attach -t {hash}-{prefix}-{num}

# Enable verbose logging
AO_LOG_LEVEL=debug ao start
```

---

## Working with Git Worktrees

This project uses itself to develop itself — agents work in git worktrees:

```bash
# Create a worktree for a feature branch
git worktree add ../ao-feature-x feat/feature-x
cd ../ao-feature-x

# Install and build in the worktree
pnpm install
pnpm build

# Copy config
cp ../agent-orchestrator/agent-orchestrator.yaml .

# Start dev server
cd packages/web && pnpm dev
```

---

## Security During Development

Pre-commit hooks scan for secrets automatically on every commit. If triggered:

1. Remove the secret from the file
2. Use environment variables: `${SECRET_NAME}`
3. Store real values in `.env.local` (gitignored)

To manually scan:

```bash
gitleaks detect --no-git   # scan current files
gitleaks protect --staged  # scan staged files (same as pre-commit)
```

To allow a false positive, add it to `.gitleaks.toml`:

```toml
[allowlist]
regexes = ['''your-pattern-here''']
```

---

## Environment Variables

```bash
# Mux WebSocket server port (web dashboard terminal + session updates)
DIRECT_TERMINAL_PORT=14801

# User integrations
GITHUB_TOKEN=ghp_...
LINEAR_API_KEY=lin_api_...
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...
ANTHROPIC_API_KEY=sk-ant-api03-...
```

Store in `.env.local` (gitignored). Never commit real values.

---

## Key Design Decisions

**Why flat metadata files instead of a database?**
Debuggability: `cat ~/.agent-orchestrator/a3b4-myapp/sessions/ao-1` shows full state. No database to spin up, no schema to migrate, survives crashes.

**Why polling instead of webhooks?**
Simpler local setup (no ngrok), survives orchestrator restarts, works offline. CI/review state is fetched, not pushed.

**Why plugin slots?**
Swappability: use tmux locally, Docker in CI, Kubernetes in prod — without changing application code. Testability: mock any plugin in unit tests. Extensibility: users add company-specific plugins without forking.

**Why hash-based namespacing?**
Multiple orchestrator checkouts on the same machine don't collide in tmux or on disk. Different checkouts get different hashes; projects within the same config share a hash.

**Why ESM with `.js` extensions?**
Node.js ESM requires explicit extensions on local imports. All packages use `"type": "module"`. Missing extensions cause runtime errors.

---

## Resources

- [`packages/core/README.md`](../packages/core/README.md) — Core service reference
- [`ARCHITECTURE.md`](../ARCHITECTURE.md) — Hash-based namespace design
- [`SETUP.md`](../SETUP.md) — Installation and configuration reference
- [`SECURITY.md`](../SECURITY.md) — Security practices
- [`agent-orchestrator.yaml.example`](../agent-orchestrator.yaml.example) — Full config reference
