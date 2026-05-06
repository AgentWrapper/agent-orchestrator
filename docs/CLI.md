# AO CLI Reference

The `ao` CLI is the control interface for Agent Orchestrator. Most commands are used by the **orchestrator agent itself** to manage sessions, not by humans directly. Humans typically only need `ao start` and the web dashboard.

## Commands humans use

```bash
ao start                               # Auto-detect, generate config, start dashboard + orchestrator
ao start <url>                         # Clone repo, auto-configure, and start
ao start ~/other-repo                  # Add a new project and start
ao stop                                # Stop everything (dashboard, orchestrator, lifecycle worker)
ao status                              # Overview of all sessions
ao status --watch                      # Live-updating terminal status view
ao dashboard                           # Open web dashboard in browser
ao completion zsh                      # Print the zsh completion script
```

## Commands the orchestrator agent uses

These are primarily invoked by the orchestrator agent running inside a tmux session. You can use them manually if needed, but the orchestrator handles this automatically.

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

`ao doctor` checks PATH and launcher resolution, required binaries, configured plugin resolution, tmux and GitHub CLI health, config support directories, stale AO temp files, and core build/runtime sanity.

`ao update` fast-forwards the local install on `main`, reinstalls dependencies, clean-rebuilds core packages, refreshes the launcher, and runs smoke tests. Use `ao update --skip-smoke` to stop after rebuild, or `ao update --smoke-only` to rerun just the smoke checks.

## Multi-Project Rollout

Portfolio mode is enabled by default. Users do not need to set `AO_ENABLE_PORTFOLIO` unless they explicitly want to disable portfolio/project-management flows.
