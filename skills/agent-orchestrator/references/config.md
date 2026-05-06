# Agent Orchestrator Config Reference

File: `agent-orchestrator.yaml` (in project root)

## Top-level settings

```yaml
port: 3000                    # Dashboard port (auto-finds free port if busy)
terminalPort: 3001            # Terminal WebSocket port
readyThresholdMs: 300000      # Ms before "ready" session becomes "idle" (5 min)
```

## Default plugins

```yaml
defaults:
  runtime: tmux               # tmux | process
  agent: claude-code          # claude-code | aider | codex | cursor | kimicode | opencode
  workspace: worktree         # worktree | clone
  notifiers:                  # Active notifier plugins
    - desktop                 # desktop | slack | webhook | composio | openclaw
  orchestrator:
    agent: claude-code        # Override agent for orchestrator sessions
  worker:
    agent: claude-code        # Override agent for worker sessions
```

## Projects

```yaml
projects:
  my-app:
    name: My App              # Display name
    repo: owner/repo          # GitHub "owner/repo"
    path: ~/code/my-app       # Local repo path
    defaultBranch: main       # main | master | develop
    sessionPrefix: myapp      # Session name prefix (myapp-1, myapp-2)

    # Per-project plugin overrides (optional)
    runtime: tmux
    agent: claude-code
    workspace: worktree

    # Agent configuration (optional)
    agentConfig:
      permissions: auto       # auto | manual
      model: claude-sonnet-4-20250514

    # Rules passed to every agent prompt (optional)
    agentRules: |
      Always run tests before committing.
      Use conventional commits.
    agentRulesFile: .ao-rules  # Or point to a file
    orchestratorRules: |       # Rules for the orchestrator agent

    # Orchestrator session strategy (optional)
    orchestratorSessionStrategy: reuse
    # Options: reuse | delete | ignore | delete-new | ignore-new | kill-previous

    # Workspace setup (optional)
    symlinks:                  # Symlink into worktrees (avoid .env or secret files)
      - node_modules
    postCreate:                # Run after workspace creation
      - pnpm install

    # Issue tracker (optional)
    tracker:
      plugin: github           # github | linear | gitlab

    # SCM (optional, usually auto-detected)
    scm:
      plugin: github           # github | gitlab
```

## Notifier channels

These are **optional** — only configure notifiers you actually use. None are required for core AO functionality. See the [AO documentation](https://github.com/ComposioHQ/agent-orchestrator) for notifier setup details.

```yaml
notifiers:
  desktop:
    plugin: desktop            # No credentials needed — default notifier
```

## Notification routing

```yaml
notificationRouting:
  critical:
    - desktop
    - slack
    - openclaw
  high:
    - desktop
    - openclaw
  low:
    - desktop
```
