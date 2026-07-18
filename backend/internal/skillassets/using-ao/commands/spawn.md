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
| `--harness string` | Agent harness to use (see list below) | Project `worker.agent`; required if the project has none |
| `--issue string` | Issue id to associate with the session | - |
| `--name string` | Display name shown in the sidebar (max 20 characters) | Required |
| `--no-takeover` | Refuse if another active session owns the claimed PR (requires `--claim-pr`) | - |
| `--project string` | Project id to spawn the session in | Required |
| `--prompt string` | Initial prompt for the agent | - |

`--agent` is an alias for `--harness`.

Available harnesses: `claude-code`, `codex`, `aider`, `opencode`, `grok`, `droid`, `amp`, `agy`, `crush`, `cursor`, `qwen`, `copilot`, `goose`, `auggie`, `continue`, `devin`, `cline`, `kimi`, `kiro`, `kilocode`, `vibe`, `pi`, `autohand`.

## Examples

```bash
# Spawn a worker for issue 142 in the agent-orchestrator project
ao spawn --project agent-orchestrator --issue 142 --name "fix-session-leak" --prompt "Fix the session leak described in issue 142. Branch off upstream/main."
```

```bash
# Spawn a worker and immediately claim an open PR
ao spawn --project agent-orchestrator --name "review-pr-88" --claim-pr 88 --harness claude-code
```

## Reporting back to the user

When telling the user a session was spawned, lead with the `--name` you gave it, not the generated session id (e.g. "spawned `review-pr-88`" rather than "spawned `agent-orchestrator-15`"). The id is only useful when it's needed for a command (`ao session get <id>`, `ao send --session <id>`) — it's not meaningful on its own to a human reading your summary. `ao spawn`'s own confirmation output still leads with the id, not the name; don't just repeat it verbatim in your own prose.
