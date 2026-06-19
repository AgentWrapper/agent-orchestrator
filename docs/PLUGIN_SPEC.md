# AgentMesh Plugin Spec

This document defines the runtime contract and packaging requirements for AgentMesh plugins.

## Runtime Contract

Plugins are standard Node.js modules that export a `PluginModule`:

```ts
export interface PluginModule<T = unknown> {
  manifest: PluginManifest;
  create(config?: Record<string, unknown>): T;
  detect?(): boolean;
}
```

Minimum manifest shape:

```ts
export interface PluginManifest {
  name: string;
  slot: PluginSlot;
  description: string;
  version: string;
}
```

AO accepts either a direct named export or a default export that satisfies this shape.

## Supported Slots

Current core slot types:

- `runtime`
- `agent`
- `workspace`
- `tracker`
- `scm`
- `notifier`
- `terminal`

The manifest `slot` determines where AO registers the plugin and which config surface can reference it.

## Packaging Requirements

Published plugins should:

- ship built JavaScript, not raw TypeScript-only entrypoints
- export an ESM entrypoint through `exports` or `main`
- declare a semver dependency on `@aoagents/ao-core`
- keep side effects out of module top-level code where possible

Recommended package shape:

```json
{
  "name": "@aoagents/ao-plugin-example",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/index.js",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    }
  },
  "files": ["dist"]
}
```

## Config Descriptors

Project config enables plugins through `plugins:` entries:

```yaml
plugins:
  - name: openclaw
    source: registry
    package: "@aoagents/ao-plugin-notifier-openclaw"
    version: "0.1.1"
```

Descriptor fields:

- `name`: logical plugin name shown in CLI UX
- `source`: one of `registry`, `npm`, or `local`
- `package`: package name for registry/npm-backed plugins
- `version`: requested or installed version for store-backed plugins
- `path`: local filesystem path for `source: local`
- `enabled`: optional flag, defaults to `true`

## Marketplace Registry

AO’s bundled marketplace catalog lives at:

- `packages/cli/src/assets/plugin-registry.json`

Registry entries provide AO-specific metadata on top of the runtime contract:

- `id`
- `package`
- `slot`
- `description`
- `source`
- `latestVersion`
- `setupAction` when post-install guidance is needed

## Installation Model

Registry and npm plugins install into the AO-managed store:

- `~/.agent-orchestrator/plugins/`

That store is shared across projects. `agent-orchestrator.yaml` remains the source of truth for whether a plugin is enabled in a given repo.

---

# AgentMesh Adapter Spec

AgentMesh adds a second plugin surface on top of AO's 8 slots: the **agent adapter**. An adapter is not an AO plugin — it does not register in AO's plugin registry or satisfy a slot interface. It is an AgentMesh-specific module that wraps an AI coding tool for use in the coordination layer (builder/QA roles, message routing, output capture, verdict parsing).

## Adapter vs AO agent plugin

|                      | AO agent plugin                                           | AgentMesh agent adapter                                    |
| -------------------- | --------------------------------------------------------- | ---------------------------------------------------------- |
| Registered in        | AO plugin registry (8 slots)                              | AgentMesh adapter registry                                 |
| Interface satisfies  | `Agent` from `@aoagents/ao-core`                          | `AgentMeshAgentAdapter`                                    |
| Lifecycle managed by | AO session manager + lifecycle manager                    | AgentMesh QA loop engine                                   |
| Purpose              | Start an agent process, detect activity, get session info | Start, send messages, read output, parse QA verdicts, stop |
| Config file          | `agent-orchestrator.yaml`                                 | `agentmesh.yaml`                                           |

The two layers coexist. AgentMesh adapters call AO's `SessionManager.spawn()` internally, which in turn uses the AO agent plugin for the actual process launch.

## Adapter interface

```typescript
interface AgentMeshAgentAdapter {
  /** Unique identifier, e.g. "claude-code", "codex", "devin" */
  name: string;

  /** Human-readable name for UI display */
  displayName: string;

  /**
   * Check that the agent binary/API is available before starting.
   * Throw with a descriptive message if not.
   */
  preflight(context: PreflightContext): Promise<PreflightResult>;

  /**
   * Start an agent session for a given task and role.
   * Internally calls AO SessionManager.spawn() with role context injected
   * into the system prompt.
   */
  start(config: AgentStartConfig): Promise<AgentSession>;

  /**
   * Deliver a prompt to a running agent session.
   * Internally calls AO SessionManager.send().
   */
  sendMessage(session: AgentSession, message: AgentMessage): Promise<void>;

  /**
   * Read current output from an agent session.
   * Used by the QA loop engine to detect completion and parse verdicts.
   */
  getOutput(session: AgentSession, options?: OutputOptions): Promise<AgentOutput>;

  /**
   * Get the current status of an agent session.
   * Must return one of: active | ready | idle | waiting_input | blocked | exited
   */
  getStatus(session: AgentSession): Promise<AgentStatus>;

  /** Stop the agent session. Internally calls AO SessionManager.kill(). */
  stop(session: AgentSession): Promise<void>;

  /** Resume a previously stopped session, if the agent supports it. */
  resume?(session: AgentSession): Promise<void>;

  /**
   * Extract cost, token count, and session summary from agent-native data.
   * Return null if the agent has no introspection capability.
   */
  getSessionInfo?(session: AgentSession): Promise<AgentSessionInfo | null>;
}
```

### Supporting types

```typescript
interface PreflightContext {
  role: AgentRole; // "builder" | "qa" | "planner" | …
  workspacePath: string;
  agentConfig?: Record<string, unknown>;
}

interface PreflightResult {
  ok: boolean;
  version?: string;
  warnings?: string[];
}

interface AgentStartConfig {
  taskId: string;
  role: AgentRole;
  prompt: string; // Fully assembled prompt from role-manager
  workspacePath: string;
  branch: string;
  environment?: Record<string, string>;
}

interface AgentSession {
  aoSessionId: string; // The AO session ID — all AO APIs use this
  taskId: string;
  role: AgentRole;
  startedAt: Date;
}

interface AgentMessage {
  type: MessageType; // see AGENTMESH.md for full type list
  body: string;
  attachments?: Record<string, string>; // path references
}

interface AgentOutput {
  text: string;
  capturedAt: Date;
  linesRead: number;
}

type AgentStatus = "active" | "ready" | "idle" | "waiting_input" | "blocked" | "exited";

interface AgentSessionInfo {
  summary?: string;
  costUsd?: number;
  tokensUsed?: number;
  turnsCompleted?: number;
}
```

## Adapter package layout

```
packages/agentmesh-adapters/src/
├── index.ts              # Registry: name → adapter factory
├── claude-code.ts        # Claude Code adapter (builder role)
├── codex.ts              # Codex adapter (QA role)
├── devin.ts              # Devin adapter (GitHub-native, external)
└── __tests__/
    ├── claude-code.test.ts
    ├── codex.test.ts
    └── devin.test.ts
```

## Required tests for every adapter

1. `preflight()` returns `ok: true` when binary/API is available
2. `preflight()` throws with a descriptive message when binary is missing
3. `start()` calls AO `SessionManager.spawn()` with the correct role context in the prompt
4. `sendMessage()` calls AO `SessionManager.send()` with the correct payload
5. `getStatus()` returns `exited` when the AO session is not running
6. `getStatus()` returns `active` when the session has recent activity
7. `stop()` calls AO `SessionManager.kill()`

Use vitest. Mock all AO calls — do not call real tmux, real GitHub, or real agent binaries in unit tests.

## Devin adapter — special rules

Devin is not a local terminal agent. Its adapter must never call `SessionManager.spawn()`. Instead:

- `start()` creates a GitHub issue and assigns it to Devin
- `sendMessage()` posts a comment on the issue or PR
- `getOutput()` reads Devin's PR description and review comments via the GitHub API
- `getStatus()` polls the PR or issue state to derive activity
- `stop()` closes the issue or unassigns Devin

Devin roles in AgentMesh: `external_reviewer`, `async_builder`, `pr_fixer`, `regression_checker`.

## Adapter common pitfalls

| Pitfall                                     | Fix                                                                                  |
| ------------------------------------------- | ------------------------------------------------------------------------------------ |
| Calling real agent binary in tests          | Mock `SessionManager.spawn()` and return a fixture session                           |
| Parsing QA verdict from free-form text      | Require the QA prompt to end with a structured JSON block; parse that, not prose     |
| Not checking `preflight()` before `start()` | The QA loop engine calls `preflight()` first; adapters should still guard internally |
| Shell injection in command construction     | Use `shellEscape()` from `@aoagents/ao-core` for all arguments                       |
| Ignoring EPERM on process probes            | Treat EPERM as "process alive" — see CROSS_PLATFORM.md for the pattern               |

---

# Available Agent Plugins

AgentMesh supports multiple AI coding agents through the agent plugin slot. Each agent plugin implements the `Agent` interface from `@aoagents/ao-core`.

## Built-in Agent Plugins

### Claude Code (`agent-claude-code`)

- **Package**: `@aoagents/ao-plugin-agent-claude-code`
- **Process Name**: `claude`
- **Prompt Delivery**: Inline via CLI arguments
- **Activity Detection**: Monitors activity log file for recent writes
- **Platform Support**: macOS, Linux, Windows
- **Best For**: General-purpose coding, feature implementation, bug fixing

### Codex (`agent-codex`)

- **Package**: `@aoagents/ao-plugin-agent-codex`
- **Process Name**: `codex`
- **Prompt Delivery**: Inline via CLI arguments
- **Activity Detection**: Monitors activity log file for recent writes
- **Platform Support**: macOS, Linux, Windows
- **Best For**: QA testing, code review, structured output parsing

### Aider (`agent-aider`)

- **Package**: `@aoagents/ao-plugin-agent-aider`
- **Process Name**: `aider`
- **Prompt Delivery**: Inline via CLI arguments
- **Activity Detection**: Monitors activity log file for recent writes
- **Platform Support**: macOS, Linux, Windows
- **Best For**: Git-aware coding, automated commit workflows

### Cursor (`agent-cursor`)

- **Package**: `@aoagents/ao-plugin-agent-cursor`
- **Process Name**: `cursor`
- **Prompt Delivery**: Inline via CLI arguments
- **Activity Detection**: Monitors `.cursor/chat.md` file for recent writes
- **Platform Support**: macOS, Linux, Windows
- **Best For**: Cursor IDE integration, AI-assisted development
- **Special Features**: Cursor-specific session file tracking, workspace-aware activity detection

### Grok (`agent-grok`)

- **Package**: `@aoagents/ao-plugin-agent-grok`
- **Process Name**: `grok`
- **Prompt Delivery**: Inline via CLI arguments
- **Activity Detection**: Monitors activity log file for recent writes
- **Platform Support**: macOS, Linux, Windows
- **Best For**: Grok AI coding, xAI integration

### KimiCode (`agent-kimicode`)

- **Package**: `@aoagents/ao-plugin-agent-kimicode`
- **Process Name**: `kimicode`
- **Prompt Delivery**: Inline via CLI arguments
- **Activity Detection**: Monitors activity log file for recent writes
- **Platform Support**: macOS, Linux, Windows
- **Best For**: Kimi AI coding, Moonshot AI integration

### OpenCode (`agent-opencode`)

- **Package**: `@aoagents/ao-plugin-agent-opencode`
- **Process Name**: `opencode`
- **Prompt Delivery**: Inline via CLI arguments
- **Activity Detection**: Monitors activity log file for recent writes
- **Platform Support**: macOS, Linux, Windows
- **Best For**: Open-source AI coding, multi-model support

---

# Available Notifier Plugins

AgentMesh supports multiple notification channels through the notifier plugin slot.

## Built-in Notifier Plugins

### Desktop (`notifier-desktop`)

- **Package**: `@aoagents/ao-plugin-notifier-desktop`
- **Platform Support**: macOS, Linux, Windows
- **Features**: Native desktop notifications, cross-platform
- **Best For**: Local development, immediate alerts

### Slack (`notifier-slack`)

- **Package**: `@aoagents/ao-plugin-notifier-slack`
- **Platform Support**: All platforms
- **Features**: Slack webhook integration, formatted messages
- **Best For**: Team notifications, project-wide alerts
- **Configuration**: Requires `SLACK_WEBHOOK_URL` environment variable

### Discord (`notifier-discord`)

- **Package**: `@aoagents/ao-plugin-notifier-discord`
- **Platform Support**: All platforms
- **Features**: Discord webhook integration, rich embeds
- **Best For**: Team notifications, developer communities
- **Configuration**: Requires `DISCORD_WEBHOOK_URL` environment variable

### Webhook (`notifier-webhook`)

- **Package**: `@aoagents/ao-plugin-notifier-webhook`
- **Platform Support**: All platforms
- **Features**: Generic HTTP webhook, custom payloads
- **Best For**: Custom integrations, third-party services
- **Configuration**: Requires webhook URL in config

### Composio (`notifier-composio`)

- **Package**: `@aoagents/ao-plugin-notifier-composio`
- **Platform Support**: All platforms
- **Features**: Composio integration, tool execution notifications
- **Best For**: Composio platform users, tool-specific alerts

### OpenClaw (`notifier-openclaw`)

- **Package**: `@aoagents/ao-plugin-notifier-openclaw`
- **Platform Support**: All platforms
- **Features**: OpenClaw integration, specialized notifications
- **Best For**: OpenClaw platform users
