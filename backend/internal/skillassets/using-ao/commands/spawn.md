# ao spawn

Spawn a worker agent session in a registered project. The session runs the chosen agent in a fresh git worktree. Register the project first with `ao project add`.

## Syntax

```
ao spawn [flags]
```

## Flags

| Flag | Meaning | Default / Required |
|---|---|---|
| `--branch string` | Branch for the session worktree | `ao/<session-id>/root` |
| `--claim-pr string` | Immediately claim an existing PR for the spawned session | - |
| `--harness string` | Agent harness to use (see list below) | Daemon `workerMix` selection when configured; otherwise project `worker.agent`; required if neither is configured |
| `--issue string` | Issue id to associate with the session; inferred for exact `/address-issue <id>` prompts | - |
| `--model string` | Model override for this session | Project/role agent config or agent default; when set without `--harness`, uses project `worker.agent` instead of `workerMix` selection |
| `--name string` | Display name shown in the sidebar (max 20 characters). Rarely needed — leave it unset and AO names the session `<repoKey> #<issue> <slug>` from the issue's own title, on both the dashboard and the agent's app title. An explicit name overrides that. | - |
| `--no-takeover` | Refuse if another active session owns the claimed PR (requires `--claim-pr`) | - |
| `--project string` | Project id to spawn the session in | Required |
| `--prompt string` | Initial prompt for the agent | - |

`--agent` is an alias for `--harness`.

Available harnesses: `claude-code`, `codex`, `codex-fugu`, `aider`, `opencode`, `grok`, `droid`, `amp`, `agy`, `crush`, `cursor`, `qwen`, `copilot`, `goose`, `auggie`, `continue`, `devin`, `cline`, `kimi`, `kiro`, `kilocode`, `vibe`, `pi`, `autohand`.

## Examples

```bash
# Spawn a worker for issue 142 in the agent-orchestrator project.
# No --name: AO names the session from the issue title, e.g. `ao #142 fix-session-leak`.
ao spawn --project agent-orchestrator --issue 142 --prompt "/address-issue 142"
```

```bash
# Spawn a worker and immediately claim an open PR
ao spawn --project agent-orchestrator --claim-pr 88 --harness claude-code
```
