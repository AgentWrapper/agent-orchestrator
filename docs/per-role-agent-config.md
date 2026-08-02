# Per-role agent model and reasoning configuration

Workers and orchestrators can be pointed at different models and different
reasoning efforts within one project — for example a stronger, higher-reasoning
model orchestrating while cheaper, faster workers do the runs.

This document describes the shape that ships for Codex, the resolution rules,
and the behaviour worth knowing before changing or extending it. Everything
below was verified against Codex; treat the provider-specific parts as Codex
facts, not as a cross-provider contract.

## Configuration shape

Role blocks carry an `agentConfig` alongside the project-wide default:

```yaml
agentConfig:
  model: gpt-5.5
  reasoningEffort: low

orchestrator:
  agent: codex
  agentConfig:
    model: gpt-5.6-sol
    reasoningEffort: high

worker:
  agent: codex
  agentConfig:
    model: gpt-5.6-terra
    reasoningEffort: medium
```

Set it from the desktop settings form, the project API, or the CLI:

```bash
ao project set-config <id> --config-json '<JSON object>'
```

## Resolution rules

`effectiveAgentConfig(kind, cfg)` in `backend/internal/session_manager/manager.go`
copies the project-wide `agentConfig` first, then layers **only non-empty** role
values over it. The same resolved value is used for new sessions and for native
resume.

| Role value                  | Result                          |
| --------------------------- | ------------------------------- |
| set                         | overrides the project default   |
| absent or empty             | inherits the project default    |
| whitespace only (`" \t "`)  | inherits the project default    |

The whitespace case is deliberate: a blank role field in the settings form must
read as "inherit", not as "override with nothing". Reasoning effort is validated
in `domain.AgentConfig.Validate` against `low`, `medium`, `high`, and `xhigh`.

## Data flow

```text
Project settings UI / project API / CLI
        ↓
ProjectConfig.agentConfig + worker.agentConfig + orchestrator.agentConfig
        ↓
session_manager.effectiveAgentConfig(kind, config)
        ↓
Codex adapter
        ↓
launch or restore argv
```

## Codex mapping

The Codex adapter (`backend/internal/adapters/agent/codex/codex.go`) emits model
and reasoning as separate arguments, on both the launch and the restore path:

```text
--model gpt-5.6-sol
-c model_reasoning_effort="high"
```

Values are trimmed before use, and an empty value emits no argument at all. The
global `~/.codex/config.toml` is never written to, and no database migration is
involved — this rides on the existing project configuration.

The desktop picker offers `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, and
`gpt-5.5`, plus a free-text custom model ID. Keep the custom escape hatch: a
hard-coded list alone goes stale as soon as a provider ships a new model.

## Session lifecycle: configuration binds at process start

Model and reasoning are fixed into argv when the agent process starts. Saving
new project values does **not** mutate a session that is already running.

- New worker and orchestrator sessions pick up the new values.
- Restore/resume picks them up, because that starts a new process.
- An already-running orchestrator keeps reporting its original model and effort.
- The settings form only replaces a running orchestrator when the agent/provider
  changes — not when only the model or reasoning effort changes.

This is the single most confusing part in practice: the project API can already
report Sol/high and Terra/medium while a long-lived orchestrator process still
shows its old values. That is expected, not a bug.

## Verifying a change end to end

Evidence quality, strongest first:

1. **Process argv** of the running agent — definitive.
2. **Codex terminal header** — a good smoke test.
3. **Answer quality** — not evidence of anything; never conclude from it.

Notes that save time:

- Running `/model` by hand mutates the session and invalidates a startup test.
- Test the real user path. "New Task" creates a worker through the session API
  and takes its model/reasoning from project configuration even though the
  dialog does not show those fields; the desktop orchestrator goes through the
  orchestrator API. An isolated CLI spawn does not cover the desktop lifecycle.
- Matching a daemon binary hash does not prove which arguments an
  already-running process was started with. Check process age and argv too.

## Windows notes

- PowerShell 5.1 can quote inline JSON differently than expected when calling
  native CLIs. Prefer the UI/API, or quote defensively.
- Stop stale desktop and daemon processes before a real end-to-end test; several
  can be alive at once and serve old configuration.
- `go test ./...` is not fully green on Windows for reasons unrelated to this
  feature (Unix paths, `.sock` files, POSIX file modes, missing `sh`, CRLF
  expectations, ConPTY registry access, directory locks). Run the packages you
  touched, and let CI cover the rest.

## Extending to other providers

The shape transfers; the provider facts do not. Re-derive each of these from the
provider's real CLI and official documentation before implementing:

- the model list and model ID format
- valid reasoning values — `low|medium|high|xhigh` is a Codex vocabulary
- the flag or config mechanism — `model_reasoning_effort` is Codex-specific
- whether launch and resume accept configuration the same way

The reusable pattern:

1. Express provider capabilities as an agent config spec.
2. Merge the project-wide base with per-role overrides.
3. Treat empty overrides as inheritance.
4. Assert exact argv for the launch and resume paths separately.
5. Cover domain, API, CLI, and UI round trips.
6. Offer known models in a picker, but keep a custom ID escape hatch.
7. Show the resolved effective values before saving.
8. Keep running processes conceptually distinct from newly started ones.
