# Worked First-Target Recommendation: Amp

Amp is a good first target after this skill lands because it is likely to exercise the normal "new coding-agent CLI" path without requiring the special Claude/Codex/OpenCode-native integrations up front. Treat this as a recommendation, not a substitute for CLI research.

## Before coding Amp support

Verify these facts from the real Amp CLI/docs in the implementation session:

1. Binary name and vendor-identifying `--help`/`--version` output.
2. Interactive launch command that keeps the session alive.
3. Prompt-delivery mechanism and whether any prompt flag causes one-shot exit.
4. Model flag, if any.
5. Approval/permission flags, if any.
6. Workdir/cwd flag, if any.
7. Resume/session ID support, if any.
8. Native logs/session store, if any.
9. Safe install command for `ao start` install prompt, if any.

Do not assume these from another CLI. If a flag is unclear, inspect help output before using it.

## Likely template choice

Start from `agent-kimicode` if Amp has:

- a dedicated binary (`amp` or similar),
- interactive prompt delivery,
- optional model/approval flags,
- a native session store or cwd-derived session files,
- no need for post-launch prompt delivery.

Start from `agent-cursor` instead if Amp has no useful native session store yet and activity/session info must initially be terminal-derived.

Use `agent-claude-code` only if Amp's prompt flag exits one-shot and AO must send the prompt after launch. Use `agent-codex` or `agent-opencode` only if Amp exposes comparable native JSONL/session-list semantics.

## Expected Amp PR shape

A minimal first Amp PR should usually touch:

- `packages/plugins/agent-amp/package.json`
- `packages/plugins/agent-amp/tsconfig.json`
- `packages/plugins/agent-amp/src/index.ts`
- `packages/plugins/agent-amp/src/index.test.ts`
- `packages/cli/package.json`
- `packages/core/src/plugin-registry.ts`
- `packages/cli/src/lib/detect-agent.ts`
- `packages/cli/src/commands/start.ts` only if install command is verified
- `packages/web/src/lib/services.ts`
- `packages/cli/src/assets/plugin-registry.json` only if marketplace-visible
- tests/docs/changeset as justified by the actual diff

Do not scaffold Amp plus Gemini/Qwen/Copilot/etc. in the same PR.
