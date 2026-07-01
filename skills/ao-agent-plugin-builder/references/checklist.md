# AO Agent Plugin Implementation Checklist

Use this checklist for each new agent plugin. Keep it scoped to one target CLI.

## 1. Target CLI research

- [ ] Record target name, binary name, expected global install command, and vendor.
- [ ] Run or inspect `--help` for launch, prompt, model, permission/approval, cwd/workdir, resume/session, and JSON/log flags.
- [ ] Determine whether initial prompt delivery is inline or post-launch. Inline is default; use `promptDelivery: "post-launch"` when inline flags cause one-shot exit.
- [ ] Find native activity/session data, if any: JSONL, SQLite, config dir, session list, title, summary, token/cost, timestamps.
- [ ] Identify terminal prompts that should be `waiting_input` and hard agent errors that should be `blocked`.

## 2. Naming and package setup

- [ ] Choose lowercase hyphen slug: `{slug}`.
- [ ] Create `packages/plugins/agent-{slug}` by copying the closest existing agent plugin.
- [ ] Set package name to `@aoagents/ao-plugin-agent-{slug}`.
- [ ] Set `manifest.name` to `{slug}`, `manifest.slot` to `"agent" as const`, and `displayName` to the human product name.
- [ ] Keep `tsconfig.json` aligned with existing agent packages.
- [ ] Keep package scripts: `build`, `typecheck`, `test`, `clean`.

## 3. Launch command

- [ ] Start with the verified binary name.
- [ ] Map `config.permissions` through `normalizeAgentPermissionMode()` to the target's real approval flag, if any.
- [ ] Map `config.model` to the target's real model flag.
- [ ] Prefer `config.systemPromptFile` for long system prompts. Only inline `config.systemPrompt` when the target supports it safely.
- [ ] Pass `config.prompt` through the target's verified prompt mechanism, or rely on post-launch delivery.
- [ ] Use `config.workspacePath ?? config.projectConfig.path` when the CLI needs an explicit cwd/workdir.
- [ ] Escape every shell argument with `shellEscape()`.

## 4. Environment and hooks

- [ ] Return `AO_SESSION_ID` and optional `AO_ISSUE_ID` from `getEnvironment()`.
- [ ] Add target-specific env vars only when verified.
- [ ] Implement `setupWorkspaceHooks()`. Use `setupPathWrapperWorkspace(workspacePath)` for PATH-wrapper agents unless native hooks are required.
- [ ] Add `preLaunchSetup()` if matching native session files requires a before-start baseline.
- [ ] Add `postLaunchSetup()` only for real after-start work.

## 5. Activity and process state

- [ ] Implement `detectActivity()` as a pure function. Check waiting-input patterns before idle prompts.
- [ ] Implement `recordActivity()` with `recordTerminalActivity()` if terminal prompts/errors are needed by `getActivityState()`.
- [ ] Implement `getActivityState()` with process liveness first, then actionable AO activity JSONL, then native activity signal, then decay/fallback.
- [ ] Implement `isProcessRunning()` for tmux TTY and PID handles. Avoid global process-name checks.
- [ ] Use bounded reads/streams for native logs.

## 6. Session info and restore

- [ ] Return `{ summary, summaryIsFallback?, agentSessionId, metadata?, cost? }` from `getSessionInfo()`.
- [ ] Persist native session IDs through `metadata` when useful for restore.
- [ ] Implement `getRestoreCommand()` if the target can resume a known session.
- [ ] Return `null` for missing native data; throw only for unexpected failures that should surface.

## 7. Wiring

- [ ] Add dependency in `packages/cli/package.json`.
- [ ] Add built-in entry in `packages/core/src/plugin-registry.ts`.
- [ ] Add CLI detection entry in `packages/cli/src/lib/detect-agent.ts`.
- [ ] Add `AGENT_INSTALL_OPTIONS` entry in `packages/cli/src/commands/start.ts` only when the install command is known and safe.
- [ ] Add static import and `registry.register(...)` in `packages/web/src/lib/services.ts`.
- [ ] Add marketplace entry in `packages/cli/src/assets/plugin-registry.json` only when `ao plugin search/install` should show it.
- [ ] Update user-facing supported-agent docs only when they contain an explicit list.
- [ ] Add a changeset if the package/wiring change needs release metadata.

## 8. Tests

- [ ] Unit-test manifest and `create()` shape.
- [ ] Unit-test launch command for permissions/model/prompt/system-prompt/workdir/session/resume flags.
- [ ] Unit-test `detect()` success/failure without requiring the real CLI.
- [ ] Unit-test `detectActivity()` for idle, active, waiting_input, and blocked patterns.
- [ ] Unit-test `getActivityState()` decay and fallback behavior.
- [ ] Unit-test `isProcessRunning()` tmux and PID paths.
- [ ] Unit-test `getSessionInfo()` native parsing and missing-data returns.
- [ ] Unit-test hooks/preflight/restore when implemented.
- [ ] Add or update core/CLI tests if registry/detection behavior changes.

## 9. Validation commands

Run the tightest checks first:

```bash
python3 skills/ao-agent-plugin-builder/scripts/check_agent_plugin_wiring.py {slug}
pnpm --filter @aoagents/ao-plugin-agent-{slug} typecheck
pnpm --filter @aoagents/ao-plugin-agent-{slug} test
pnpm --filter @aoagents/ao-plugin-agent-{slug} build
```

Then validate affected central packages:

```bash
pnpm --filter @aoagents/ao-core test -- plugin-registry
pnpm --filter @aoagents/ao-cli test -- detect-agent plugin
pnpm --filter @aoagents/ao-web typecheck
```

If package dependencies or lockfile changed, run `pnpm install --lockfile-only` or the repo's expected install workflow before final validation.
