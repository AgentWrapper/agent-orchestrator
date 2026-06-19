# AO CLI Reference

The `ao` CLI is the control interface for Agent Orchestrator. Most commands are used by the **orchestrator agent itself** to manage sessions, not by humans directly. Humans typically only need `ao start` and the web dashboard.

## Commands humans use

```bash
ao start                               # Auto-detect, generate config, start dashboard + orchestrator
ao start <url>                         # Clone repo, auto-configure, and start
ao start ~/other-repo                  # Add a new project and start
ao daemon                              # Headless: supervise ALL projects, no dashboard (for native front-ends)
ao stop                                # Stop everything (dashboard, orchestrator, lifecycle worker)
ao status                              # Overview of all sessions
ao status --watch                      # Live-updating terminal status view
ao dashboard                           # Open web dashboard in browser (optional package, see note)
ao setup dashboard                     # Configure dashboard notification retention/routing
ao setup desktop                       # Install/configure native macOS desktop notifications
ao notify test --to desktop            # Send a manual notifier test without starting AO
ao completion zsh                      # Print the zsh completion script
```

### Headless multi-project mode (`ao daemon`)

`ao daemon` runs a long-lived **headless supervisor for every configured project
without the web dashboard**. It is the stable entry point for native front-ends
(e.g. the Maestro macOS app) that replace the dashboard entirely.

```bash
ao daemon                              # Supervise all projects headlessly (recommended for Maestro)
ao daemon --orchestrate-all            # Also ensure an orchestrator session for every project at startup
ao start --all                         # Equivalent flag form on `ao start` (implies --no-dashboard)
ao start --all --orchestrate-all       # ...with eager orchestrator spawn
```

Behavior:

- Reuses the global project supervisor (`reconcileProjectSupervisor`), which
  reconciles **all** configured projects and attaches a lifecycle worker to each
  one that has an active session.
- By default it does **not** auto-spawn orchestrators — parity with the dashboard
  server. Front-ends spawn orchestrators on demand via `ao start <projectId>`
  (which attaches to the running daemon); the supervisor picks up their lifecycle
  within ~60s. Pass `--orchestrate-all` to eagerly ensure an orchestrator session
  for every configured project at startup.
- Registers in `~/.agent-orchestrator/running.json`, so `ao stop` and
  `ao start <projectId>` work against it exactly as with `ao start`.
- Single-project `ao start [project]` (with or without `--no-dashboard`) is
  unchanged.

> **Dashboard is optional.** The CLI no longer depends on `@aoagents/ao-web`.
> `ao dashboard` and `ao start` (with a dashboard) only work when the web package
> is present/built (`pnpm build:dashboard` from a source checkout). The headless
> engine (`ao daemon`) never needs it.

## Commands the orchestrator agent uses

These are primarily invoked by the orchestrator agent running inside a runtime session (a tmux window on macOS/Linux; a ConPTY pty-host on Windows). You can use them manually if needed, but the orchestrator handles this automatically.

```bash
ao spawn [issue]                       # Spawn an agent (project auto-detected from cwd)
ao spawn 123 --agent codex             # Override agent for this session
ao batch-spawn 101 102 103             # Spawn agents for multiple issues at once
ao send <session> "Fix the tests"      # Send instructions to a running agent
ao session ls                          # List active sessions (terminated hidden)
ao session ls --include-terminated     # Include killed/done/merged/errored/cleanup sessions
ao session ls --json                   # Machine-readable session inventory (see note below)
ao session kill <session>              # Kill a session
ao session restore <session>           # Revive a crashed agent
```

> **JSON output:** `ao session ls --json` and `ao status --json` emit
> `{ "data": [...], "meta": { "hiddenTerminatedCount": N } }`. Terminated sessions
> (`killed`, `terminated`, `done`, `merged`, `errored`, `cleanup`) are filtered from
> `data` by default; `meta.hiddenTerminatedCount` reports how many were dropped.
> Pass `--include-terminated` to include them and reset the count to `0`.

## Maintenance commands

```bash
ao doctor                              # Check install, runtime, and stale temp issues
ao doctor --fix                        # Apply safe fixes automatically
ao setup openclaw                      # Connect AO notifications to OpenClaw
ao update                              # Update local AO install (source installs only)
ao config-help                         # Show full config schema reference
```

## Zsh completion

```bash
mkdir -p ~/.zsh/completions
ao completion zsh > ~/.zsh/completions/_ao
```

Add the directory to `fpath` before running `compinit`:

```zsh
fpath=(~/.zsh/completions $fpath)
autoload -Uz compinit
compinit
```

With Oh My Zsh, write the generated file to `${ZSH_CUSTOM:-~/.oh-my-zsh/custom}/plugins/ao/_ao`
and add `ao` to the `plugins=(...)` list in `~/.zshrc`.

`ao doctor` checks PATH and launcher resolution, required binaries, configured plugin resolution, terminal-runtime health (tmux on Unix; PowerShell / `runtime-process` on Windows), GitHub CLI health, config support directories, stale AO temp files, and core build/runtime sanity. Runs and is supported on macOS, Linux, and Windows.

`ao update` fast-forwards the local install on `main`, reinstalls dependencies, clean-rebuilds core packages, refreshes the launcher, and runs smoke tests. Works on macOS, Linux, and Windows (Windows uses the bundled `ao-update.ps1` script automatically). Use `ao update --skip-smoke` to stop after rebuild, or `ao update --smoke-only` to rerun just the smoke checks.

## Multi-Project Rollout

Portfolio mode is enabled by default. Users do not need to set `AO_ENABLE_PORTFOLIO` unless they explicitly want to disable portfolio/project-management flows.
