/**
 * Returns the complete AO config schema as formatted text.
 * Used by `ao config-help` and injected into orchestrator system prompts.
 */
import { CONFIG_SCHEMA_URL } from "@aoagents/ao-core";

export function getConfigInstruction(): string {
  return `
# Agent Orchestrator Config Reference
# File: agent-orchestrator.yaml

$schema: ${CONFIG_SCHEMA_URL}

# ── Top-level settings ──────────────────────────────────────────────
# Runtime data paths are auto-derived from the config location under:
#   ~/.agent-orchestrator/{hash}-{projectId}/

port: 3000                    # Dashboard port
terminalPort: 14800           # Optional terminal WebSocket port override
directTerminalPort: 14801     # Optional direct terminal WebSocket port override
readyThresholdMs: 300000      # Ms before "ready" becomes "idle" (default: 5 min)

observability:
  logLevel: warn              # debug | info | warn | error
  stderr: false               # Mirror structured logs to stderr

# ── Default plugins ─────────────────────────────────────────────────
# These apply to all projects unless overridden per-project.

defaults:
  runtime: tmux               # tmux | process
  agent: claude-code          # claude-code | aider | codex | cursor | kimicode | opencode
  workspace: worktree         # worktree | clone
  notifiers:
    - desktop                 # desktop | discord | slack | webhook | composio | openclaw
  orchestrator:
    agent: claude-code        # Optional override for orchestrator sessions
  worker:
    agent: claude-code        # Optional override for worker sessions

# ── Installer-managed marketplace plugins (optional) ───────────────
# External plugins are declared here. Built-ins do not need entries.

plugins:
  - name: owasp-auditor
    source: registry          # registry | npm | local
    package: "@ao-plugins/owasp-auditor"
    version: "^0.1.0"
    enabled: true
  - name: local-dev-plugin
    source: local
    path: ./plugins/local-dev-plugin
    enabled: true

# ── Projects ────────────────────────────────────────────────────────
# Each key is a project ID (typically the repo directory name).

projects:
  my-app:
    name: My App              # Display name
    repo: owner/repo          # GitHub "owner/repo" format
    path: ~/code/my-app       # Local path to the repo
    defaultBranch: main       # main | master | next | develop
    sessionPrefix: myapp      # Prefix for session names (e.g. myapp-1, myapp-2)

    # ── Per-project plugin overrides (optional) ───────────────────
    runtime: tmux             # Override default runtime
    agent: claude-code        # Override default agent
    workspace: worktree       # Override default workspace

    # ── Agent configuration (optional) ────────────────────────────
    agentConfig:
      permissions: permissionless   # permissionless | default | auto-edit | suggest
      model: claude-sonnet-4-20250514

    # ── Agent rules (optional) ────────────────────────────────────
    agentRules: |             # Inline rules passed to every agent prompt
      Always run tests before committing.
      Use conventional commits.
    agentRulesFile: .ao-rules # Or point to a file (relative to project path)
    orchestratorRules: |      # Rules for the orchestrator agent

    # ── Orchestrator session strategy (optional) ──────────────────
    # Controls what happens to the orchestrator session on restart.
    orchestratorSessionStrategy: reuse
    # Options: reuse | delete | ignore | delete-new | ignore-new | kill-previous

    # ── Workspace setup (optional) ────────────────────────────────
    symlinks:                 # Files/dirs to symlink into workspaces
      - .env
      - node_modules
    postCreate:               # Commands to run after workspace creation
      - pnpm install

    # ── Issue tracker (optional) ──────────────────────────────────
    tracker:
      plugin: github          # github | linear | gitlab
      # Linear-specific:
      # teamId: TEAM-123
      # projectId: PROJECT-456

    # ── SCM configuration (optional, usually auto-detected) ───────
    scm:
      plugin: github          # github | gitlab

    # ── Per-project reaction overrides (optional) ─────────────────
    # reactions:
    #   ci-failed:
    #     auto: true
    #     retries: 2

# ── Notification channels (optional) ────────────────────────────────

notifiers:
  desktop:
    plugin: desktop
    # Run 'ao setup desktop' on macOS to use AO Notifier.app
    # backend: ao-app
  dashboard:
    plugin: dashboard
    # Run 'ao setup dashboard' to retain notifications in the web dashboard
    # limit: 50
  slack:
    plugin: slack
    # Requires SLACK_WEBHOOK_URL env var
  webhook:
    plugin: webhook
    # url: https://example.com/hook
  openclaw:
    plugin: openclaw
    # url: http://127.0.0.1:18789/hooks/agent
    # openclawConfigPath: ~/.openclaw/openclaw.json
    # OpenClaw owns hooks.token in openclaw.json
    # Run 'ao setup openclaw' for guided configuration
  composio:
    plugin: composio
    # Run 'ao setup composio' to connect Slack through Composio
    # userId: aoagent
    # connectedAccountId: ca_...
    # channelName: "#agents"
    # composioApiKey: ak_... # optional; otherwise uses COMPOSIO_API_KEY
    # toolVersion: "20260508_00" # optional Slack override
  composio-discord:
    plugin: composio
    # Run 'ao setup composio-discord' for Discord webhook mode through Composio
    # defaultApp: discord
    # mode: webhook
    # webhookUrl: https://discord.com/api/webhooks/...
    # userId: aoagent
    # composioApiKey: ak_... # optional; otherwise uses COMPOSIO_API_KEY
  composio-discord-bot:
    plugin: composio
    # Run 'ao setup composio-discord-bot' for Discord bot mode through Composio
    # defaultApp: discord
    # mode: bot
    # channelId: "1234567890"
    # userId: aoagent
    # connectedAccountId: ca_...
    # composioApiKey: ak_... # optional; otherwise uses COMPOSIO_API_KEY
  composio-mail:
    plugin: composio
    # Run 'ao setup composio-mail' to connect Gmail through Composio
    # defaultApp: gmail
    # emailTo: alerts@example.com
    # userId: aoagent
    # connectedAccountId: ca_...
    # composioApiKey: ak_... # optional; otherwise uses COMPOSIO_API_KEY

# ── Notification routing (optional) ─────────────────────────────────
# Route notifications by priority level.

notificationRouting:
  urgent:
    - desktop
    - slack
  action:
    - desktop
  warning:
    - slack
  info:
    - composio

# ── Available plugins ───────────────────────────────────────────────
#
# Agent:     claude-code, aider, codex, cursor, kimicode, opencode
# Runtime:   tmux, process
# Workspace: worktree, clone
# SCM:       github, gitlab
# Tracker:   github, linear, gitlab
# Notifier:  dashboard, desktop, discord, slack, webhook, composio, openclaw
# Terminal:  iterm2, web
`.trim();
}
