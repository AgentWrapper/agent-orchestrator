# AO Agent Plugin Patterns

Use this reference after opening the real current files. It captures the patterns found in this repo, but code truth wins when files drift.

## Implemented agent plugins

| Plugin | Package | Binary/process | Best template when target CLI... | Notable pattern |
|---|---|---|---|---|
| `agent-cursor` | `@aoagents/ao-plugin-agent-cursor` | `agent` | Is a simple interactive terminal CLI with prompt/model/permission flags and no proven native log API | Smallest terminal-derived implementation; careful `detect()` to avoid false positives for a generic binary name. |
| `agent-kimicode` | `@aoagents/ao-plugin-agent-kimicode` | `kimi` | Needs explicit workdir, PATH wrappers, terminal-derived waiting/error states, and native session-file matching | Most modern general template; uses `workspacePath`, `setupPathWrapperWorkspace`, bounded JSONL scan, pre-launch baseline, and session discovery helper. |
| `agent-aider` | `@aoagents/ao-plugin-agent-aider` | `aider` | Has chat history files and auto-commit behavior | Uses `.aider.chat.history.md` mtime plus recent commits as activity/session summary fallback. |
| `agent-codex` | `@aoagents/ao-plugin-agent-codex` | `codex` | Has native JSONL sessions under a home-dir store and supports resume/cost parsing | Native JSONL parser, bounded session matching, restore command, model/permission mapping. |
| `agent-claude-code` | `@aoagents/ao-plugin-agent-claude-code` | `claude` | Needs post-launch prompt delivery or agent-native hook configuration | `promptDelivery: "post-launch"`, native `.claude/settings.json` PostToolUse hooks, JSONL summary/cost parsing. |
| `agent-opencode` | `@aoagents/ao-plugin-agent-opencode` | `opencode` | Requires creating/discovering a named session then resuming it | Uses `opencode run --format json`, title `AO:{sessionId}`, shared OpenCode cache/helpers from core. |

Default recommendation for new catalog CLIs: start from `agent-kimicode` if the CLI has a dedicated binary and supports interactive prompt delivery; start from `agent-cursor` if there is no native session store yet and the launch command is straightforward.

## Monorepo package shape

Built-in agent plugins live at:

```text
packages/plugins/agent-{slug}/
├── package.json
├── tsconfig.json
└── src/
    ├── index.ts
    └── index.test.ts
```

Use the existing `package.json` shape:

- `name`: `@aoagents/ao-plugin-agent-{slug}`
- `version`: match repo release flow for current packages when copying
- `type`: `module`
- `main`: `dist/index.js`
- `types`: `dist/index.d.ts`
- `exports["."].import`: `./dist/index.js`
- `files`: `["dist"]`
- scripts: `build`, `typecheck`, `test`, `clean`
- dependency: `@aoagents/ao-core: "workspace:*"`
- dev dependencies: `@types/node`, `typescript`, `vitest`

Use the existing `tsconfig.json` shape:

```json
{
  "extends": "../../../tsconfig.node.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src"],
  "exclude": ["src/**/*.test.ts"]
}
```

`pnpm-workspace.yaml` already includes `packages/plugins/*`; do not edit it for a normal new plugin.

## Required `src/index.ts` shape

Every built-in agent package exports:

```ts
export const manifest = {
  name: "{slug}",
  slot: "agent" as const,
  description: "Agent plugin: ...",
  version: "0.1.0",
  displayName: "...",
};

export function create(): Agent { ... }
export function detect(): boolean { ... }
export default { manifest, create, detect } satisfies PluginModule<Agent>;
```

The returned `Agent` must include:

- `name` and `processName`
- `getLaunchCommand(config)`
- `getEnvironment(config)` with `AO_SESSION_ID` and optional `AO_ISSUE_ID`; the current session manager injects `PATH: buildAgentPath(...)`, `GH_PATH`, `AO_SESSION`, `AO_DATA_DIR`, `AO_PROJECT_ID`, and `AO_CONFIG_PATH` around this environment
- `detectActivity(output)` even when native activity is preferred
- `getActivityState(session, readyThresholdMs?)`
- `isProcessRunning(handle)`
- `getSessionInfo(session)`
- `setupWorkspaceHooks(...)` even if it only delegates to shared PATH wrappers or intentionally no-ops because session-manager handles wrappers

Optional but common:

- `promptDelivery: "post-launch"` when inline prompt flags trigger one-shot exit
- `preLaunchSetup(workspacePath)` for baseline snapshots before the CLI writes session files
- `postLaunchSetup(session)` for after-start config or binary resolution
- `getRestoreCommand(session, project)` when native resume exists
- `recordActivity(session, terminalOutput)` when native logs do not cover waiting/blocked states
- `preflight(context)` for actionable prerequisite errors before spawn

## Activity-state pattern

Good `getActivityState()` implementations use this order:

1. Check runtime/process liveness first. Return `exited` if dead.
2. Prefer fresh actionable AO activity JSONL (`readLastActivityEntry` + `checkActivityLogState`) for `waiting_input`/`blocked` when terminal classification is the only source.
3. Read the best native signal: JSONL mtime, session list updated time, SQLite row timestamp, chat-history mtime, etc.
4. Decay by `DEFAULT_ACTIVE_WINDOW_MS` and `DEFAULT_READY_THRESHOLD_MS`: active -> ready -> idle.
5. Use `getActivityFallbackState()` only as a last resort.

Implement `recordActivity()` with `recordTerminalActivity()` when relying on terminal-derived prompts/errors. Do not mark compiler/test output as `blocked` unless the target agent exposes a reliable unrecoverable error signal; terminal text alone often contains expected failures while the agent is still working.

## Process liveness pattern

For tmux handles, inspect the pane TTY and then `ps -eo pid,tty,args` for the target process. For process runtime handles, use `process.kill(pid, 0)` and treat `EPERM` as running. Avoid plain `pgrep {binary}` because it can match another user's unrelated session.

## Hook and metadata pattern

AO dashboard PR tracking depends on metadata updates when agents run `git` and `gh` commands.

- Claude Code uses native PostToolUse hooks in `.claude/settings.json`.
- Most other agents rely on shared PATH wrappers from `@aoagents/ao-core` (`setupPathWrapperWorkspace`, `buildAgentPath`, `PREFERRED_GH_PATH`).
- Current `session-manager.ts` also calls `setupPathWrapperWorkspace()` for non-Claude agents, but plugins still keep `setupWorkspaceHooks()` because older paths and docs expect the method.

Do not write secrets into generated hook/config files. `.ao/AGENTS.md` and wrapper state are AO-owned workspace artifacts.

## Built-in wiring surfaces

For a built-in agent plugin, update all relevant surfaces:

1. `packages/core/src/plugin-registry.ts` — add `{ slot: "agent", name: "{slug}", pkg: "@aoagents/ao-plugin-agent-{slug}" }`.
2. `packages/cli/package.json` — add a workspace dependency.
3. `packages/cli/src/lib/detect-agent.ts` — add to `AGENT_PLUGINS` so `ao start` can detect it.
4. `packages/cli/src/commands/start.ts` — add an install option only when there is a safe, known global install command.
5. `packages/web/src/lib/services.ts` — static import and `registry.register(...)`; Next.js cannot rely on core dynamic import for built-ins.
6. `packages/cli/src/assets/plugin-registry.json` — add only if the plugin should appear in `ao plugin search/install` as a registry-backed package.
7. Tests/docs — update docs/examples only when user-facing supported-agent lists would otherwise be stale.

## Scaffold support in this repo

`ao plugin create` and `packages/cli/src/lib/plugin-scaffold.ts` generate a generic plugin package with placeholder implementation, `README.md`, and external config examples. That is useful for local/external plugins, but built-in agent packages in this repo should be copied from `packages/plugins/agent-*` because they need the full `Agent` implementation, package metadata, tests, and monorepo wiring.

## Common repo-specific mistakes

- Copying generic scaffold output and leaving a placeholder `create()` object instead of a real `Agent`.
- Updating `plugin-registry.ts` but forgetting `detect-agent.ts` or `web/src/lib/services.ts`.
- Assuming `-p`, `--prompt`, or `--print` behavior from another CLI. Verify target CLI help; some flags exit after one shot.
- Passing `projectConfig.path` when the target needs the isolated worktree cwd. Prefer `config.workspacePath ?? config.projectConfig.path`.
- Omitting `shellEscape()` for prompt/model/system-prompt/workdir/session args.
- Reading a whole JSONL/session file to get one summary or timestamp.
- Matching a generic binary name without checking vendor/help output (`agent`, `code`, `cli`, etc.).
- Adding all catalog agents at once. Keep one plugin per PR unless asked otherwise.
