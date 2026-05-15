<h1 align="center">Agent Orchestrator — The Orchestration Layer for Parallel AI Agents</h1>

<p align="center">
<a href="https://github.com/ComposioHQ/agent-orchestrator">
  <img width="800" alt="Agent Orchestrator banner" src="docs/assets/agent_orchestrator_banner.png">
</a>
</p>

<div align="center">

Spawn parallel AI coding agents, each in its own git worktree. Agents autonomously fix CI failures, address review comments, and open PRs — you supervise from one dashboard.

[![GitHub stars](https://img.shields.io/github/stars/ComposioHQ/agent-orchestrator?style=flat-square)](https://github.com/ComposioHQ/agent-orchestrator/stargazers)
[![npm version](https://img.shields.io/npm/v/%40aoagents%2Fao?style=flat-square)](https://www.npmjs.com/package/@aoagents/ao)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)
[![PRs merged](https://img.shields.io/badge/PRs_merged-61-brightgreen?style=flat-square)](https://github.com/ComposioHQ/agent-orchestrator/pulls?q=is%3Amerged)
[![Tests](https://img.shields.io/badge/test_cases-3%2C288-blue?style=flat-square)](https://github.com/ComposioHQ/agent-orchestrator/releases/tag/metrics-v1)
[![Discord](https://img.shields.io/badge/Discord-Join%20Community-5865F2?style=flat-square&logo=discord&logoColor=white)](https://discord.gg/UZv7JjxbwG)

</div>

---

Agent Orchestrator manages fleets of AI coding agents working in parallel on your codebase. Each agent gets its own git worktree, its own branch, and its own PR. When CI fails, the agent fixes it. When reviewers leave comments, the agent addresses them. You only get pulled in when human judgment is needed.

**Agent-agnostic** (Claude Code, Codex, Aider) · **Runtime-agnostic** (tmux, Docker) · **Tracker-agnostic** (GitHub, Linear)

<div align="center">

## See it in action

<a href="https://x.com/agent_wrapper/status/2026329204405723180">
  <img src="docs/assets/demo-video-tweet.png" alt="Agent Orchestrator demo — AI agents building their own orchestrator" width="560">
</a>
<br><br>
<a href="https://x.com/agent_wrapper/status/2026329204405723180"><img src="docs/assets/btn-watch-demo.png" alt="Watch the Demo on X" height="48"></a>
<br><br><br>
<a href="https://x.com/agent_wrapper/status/2025986105485733945">
  <img src="docs/assets/article-tweet.png" alt="The Self-Improving AI System That Built Itself" width="560">
</a>
<br><br>
<a href="https://x.com/agent_wrapper/status/2025986105485733945"><img src="docs/assets/btn-read-article.png" alt="Read the Full Article on X" height="48"></a>

</div>

## Quick Start

> **Prerequisites:** [Node.js 20+](https://nodejs.org), [Git 2.25+](https://git-scm.com), [tmux](https://github.com/tmux/tmux/wiki/Installing), [`gh` CLI](https://cli.github.com). Install tmux via `brew install tmux` (macOS) or `sudo apt install tmux` (Linux).

### Install

```bash
npm install -g @aoagents/ao
```

<details>
<summary>Permission denied? Install from source?</summary>

If `npm install -g` fails with EACCES, prefix with `sudo` or [fix your npm permissions](https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally).

To install from source (for contributors):

```bash
git clone https://github.com/ComposioHQ/agent-orchestrator.git
cd agent-orchestrator && bash scripts/setup.sh
```
</details>

### Start

Point it at any repo — it clones, configures, and launches the dashboard in one command:

```bash
ao start https://github.com/your-org/your-repo
```

Or from inside an existing local repo:

```bash
cd ~/your-project && ao start
```

That's it. The dashboard opens at `http://localhost:3000` and the orchestrator agent starts managing your project.

### Add more projects

```bash
ao start ~/path/to/another-repo
```

## How It Works

1. **You start** — `ao start` launches the dashboard and an orchestrator agent
2. **Orchestrator spawns workers** — each issue gets its own agent in an isolated git worktree
3. **Agents work autonomously** — they read code, write tests, create PRs
4. **Reactions handle feedback** — CI failures and review comments are automatically routed back to the agent
5. **You review and merge** — you only get pulled in when human judgment is needed

The orchestrator agent uses the [AO CLI](docs/CLI.md) internally to manage sessions. You don't need to learn or use the CLI — the dashboard and orchestrator handle everything.

## Configuration

`ao start` auto-generates `agent-orchestrator.yaml` with sensible defaults. You can edit it afterwards to customize behavior:

```yaml
# agent-orchestrator.yaml
# Runtime data is auto-derived under ~/.agent-orchestrator/{hash}-{projectId}/
port: 3000

defaults:
  runtime: tmux
  agent: claude-code
  workspace: worktree
  notifiers: [desktop]

projects:
  my-app:
    repo: owner/my-app
    path: ~/my-app
    defaultBranch: main
    sessionPrefix: app
    # Optional: run orchestrator in the repo root instead of a fresh worktree
    # orchestratorWorkspaceMode: project

reactions:
  ci-failed:
    auto: true
    action: send-to-agent
    retries: 2
  changes-requested:
    auto: true
    action: send-to-agent
    escalateAfter: 30m
  approved-and-green:
    auto: false # flip to true for auto-merge
    action: notify
```

CI fails → agent gets the logs and fixes it. Reviewer requests changes → agent addresses them. PR approved with green CI → you get a notification to merge.

See [`agent-orchestrator.yaml.example`](agent-orchestrator.yaml.example) for the full reference, or run `ao config-help` for the complete schema.

## Plugin Architecture

Seven plugin slots. Lifecycle stays in core.

| Slot      | Default     | Alternatives             |
| --------- | ----------- | ------------------------ |
| Runtime   | tmux        | process                  |
| Agent     | claude-code | codex, aider, cursor, opencode   |
| Workspace | worktree    | clone                    |
| Tracker   | github      | linear, gitlab           |
| SCM       | github      | gitlab                   |
| Notifier  | desktop     | slack, discord, composio, webhook, openclaw |
| Terminal  | iterm2      | web                      |

All interfaces defined in [`packages/core/src/types.ts`](packages/core/src/types.ts). A plugin implements one interface and exports a `PluginModule`. That's it.

## Why Agent Orchestrator?

Running one AI agent in a terminal is easy. Running 30 across different issues, branches, and PRs is a coordination problem.

**Without orchestration**, you manually: create branches, start agents, check if they're stuck, read CI failures, forward review comments, track which PRs are ready to merge, clean up when done.

**With Agent Orchestrator**, you: `ao start` and walk away. The system handles isolation, feedback routing, and status tracking. You review PRs and make decisions — the rest is automated.

## Documentation

| Doc                                      | What it covers                                               |
| ---------------------------------------- | ------------------------------------------------------------ |
| [Setup Guide](SETUP.md)                  | Detailed installation, configuration, and troubleshooting    |
| [CLI Reference](docs/CLI.md)             | All `ao` commands (mostly used by the orchestrator agent)    |
| [Examples](examples/)                    | Config templates (GitHub, Linear, multi-project, auto-merge) |
| [Development Guide](docs/DEVELOPMENT.md) | Architecture, conventions, plugin pattern                    |
| [Contributing](CONTRIBUTING.md)          | How to contribute, build plugins, PR process                 |

## Development

```bash
pnpm install && pnpm build    # Install and build all packages
pnpm test                      # Run tests (3,288 test cases)
pnpm dev                       # Start web dashboard dev server
```

See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for code conventions and architecture details.

## Contributing

Contributions welcome. The plugin system makes it straightforward to add support for new agents, runtimes, trackers, and notification channels. Every plugin is an implementation of a TypeScript interface — see [CONTRIBUTING.md](CONTRIBUTING.md) and the [Development Guide](docs/DEVELOPMENT.md) for the pattern.

## License

MIT
