---
name: ao-agent-plugin-builder
description: Build new Agent Orchestrator agent plugin packages in this repository. Use when Codex needs to add support for a coding-agent CLI (for example Amp, GitHub Copilot, Gemini, Qwen Code, Auggie, Goose, Kiro, Cline), choose the closest existing `packages/plugins/agent-*` template, wire AO registry/CLI/web surfaces, implement launch/activity/session behavior, and validate the plugin without mass-scaffolding unrelated agents.
---

# AO Agent Plugin Builder

Use this skill to add one AO `agent` plugin at a time by copying the closest implemented agent pattern and proving it with tests. Do not implement multiple target agents in one pass unless the user explicitly asks.

## Source-truth files to inspect first

Always ground the work in the current checkout before editing:

- Agent examples: `packages/plugins/agent-{aider,claude-code,codex,cursor,kimicode,opencode}/`
- Interface: `packages/core/src/types.ts` (`Agent`, `AgentLaunchConfig`, `AgentSessionInfo`, `ActivityState`)
- Built-ins: `packages/core/src/plugin-registry.ts`
- CLI detection/install UX: `packages/cli/src/lib/detect-agent.ts`, `packages/cli/src/commands/start.ts`
- CLI package deps: `packages/cli/package.json`
- Dashboard static registration: `packages/web/src/lib/services.ts`
- Marketplace catalog: `packages/cli/src/assets/plugin-registry.json` when the plugin should be installer-visible
- Scaffold support: `packages/cli/src/lib/plugin-scaffold.ts` and `ao plugin create --help`
- Architecture docs: `CLAUDE.md`, `docs/DEVELOPMENT.md`, `docs/PLUGIN_SPEC.md`

If you do not know what a target agent CLI flag does, run that CLI's `--help` or docs lookup before using the flag.

## Workflow

1. **Classify the target agent.** Identify binary name, install command, interactive vs one-shot mode, prompt flag, model flag, permission/approval flags, workspace/cwd flag, resume/session support, and native session logs. Prefer real `--help` output over catalog names.
2. **Choose names.** Use `packages/plugins/agent-{slug}` for the directory, `@aoagents/ao-plugin-agent-{slug}` for the package, `manifest.name = "{slug}"`, `manifest.slot = "agent" as const`, and a human `displayName`.
3. **Choose the closest template.** Read `references/patterns.md` for the template matrix. Default to `agent-kimicode` or `agent-cursor` for a normal interactive terminal CLI; use `agent-claude-code`, `agent-codex`, or `agent-opencode` only when the target matches their native-hook/session-log/session-list behavior.
4. **Create the package surgically.** Copy the chosen `packages/plugins/agent-*` package, then rename only what must change. Use `ao plugin create` only as a generic external-plugin scaffold reference; built-in repo plugins need the established monorepo package shape.
5. **Implement the full `Agent` contract.** Cover launch command, environment, process liveness, activity detection, session info, workspace hooks, optional pre/post launch setup, optional restore, and optional preflight. Use `shellEscape()` for command args and shared activity/workspace helpers from `@aoagents/ao-core`.
6. **Wire AO surfaces.** Update built-in registry, CLI dependencies/detection/install prompt when appropriate, dashboard static imports/registration, marketplace catalog if installer-visible, package docs/changelog/changeset only if the package change needs release metadata.
7. **Test the plugin behavior.** Unit-test manifest, `detect()`, launch command quoting/flags, activity states, liveness, session info, hooks, restore/preflight paths, and all fallback behavior. Mock external CLIs and filesystem state.
8. **Validate wiring.** Run this skill's helper script plus repo checks:
   ```bash
   python3 skills/ao-agent-plugin-builder/scripts/check_agent_plugin_wiring.py {slug}
   pnpm --filter @aoagents/ao-plugin-agent-{slug} typecheck
   pnpm --filter @aoagents/ao-plugin-agent-{slug} test
   pnpm --filter @aoagents/ao-core test -- plugin-registry
   pnpm --filter @aoagents/ao-cli test -- detect-agent plugin
   ```

## Bundled references

- `references/patterns.md` — current implemented-agent patterns, template selection, wiring facts, and repo-specific pitfalls.
- `references/checklist.md` — implementation checklist from target CLI research through validation.
- `references/amp-example.md` — worked first-target recommendation for Amp, including what to verify before coding.
- `scripts/check_agent_plugin_wiring.py` — deterministic smoke checker for built-in agent package wiring.

## Repo-specific guardrails

- Keep the PR to one agent plugin plus directly required wiring/tests/docs. Do not add every catalog agent.
- Do not change the `Agent` interface unless the target cannot be represented by existing optional methods; that is a separate architecture task.
- Do not parse huge native logs by slurping whole files; stream or tail bounded bytes.
- Do not rely only on terminal text when the target exposes native JSONL/SQLite/session APIs.
- Do not add cross-plugin imports. Agent plugins communicate through core `Session` data and shared core utilities only.
