<div align="center">

# AgentMesh (`ao`)

**The orchestration layer for parallel AI coding agents.**

[![npm version](https://img.shields.io/npm/v/%40aoagents%2Fao?style=flat-square)](https://www.npmjs.com/package/@aoagents/ao)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](https://github.com/ComposioHQ/agent-orchestrator/blob/main/LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/ComposioHQ/agent-orchestrator?style=flat-square)](https://github.com/ComposioHQ/agent-orchestrator)
[![Discord](https://img.shields.io/badge/Discord-Join%20Community-5865F2?style=flat-square&logo=discord&logoColor=white)](https://discord.gg/UZv7JjxbwG)

<img width="800" alt="AgentMesh" src="https://raw.githubusercontent.com/ComposioHQ/agent-orchestrator/main/docs/assets/agent_orchestrator_banner.png">

</div>

Spawn parallel AI coding agents, each in its own git worktree, on a single machine. Agents autonomously fix CI failures, address review comments, and open PRs — you supervise the whole fleet from one dashboard.

**Agent-agnostic** (Claude Code, Codex, Aider, Cursor, OpenCode) · **Runtime-agnostic** (tmux, ConPTY/process) · **Tracker-agnostic** (GitHub, Linear, GitLab)

> **Note:** This package is maintained in the fork [`ch1kim0n1/parallel-agents`](https://github.com/ch1kim0n1/parallel-agents). Links and badges below point to the upstream [`ComposioHQ/agent-orchestrator`](https://github.com/ComposioHQ/agent-orchestrator); please file fork-specific issues on the fork.

## Install

```bash
npm install -g @aoagents/ao
```

> **Nightly builds** (latest `main`): `npm install -g @aoagents/ao@nightly` — back to stable with `@latest`.

**Prerequisites:** [Node.js 20.18.3+](https://nodejs.org), [Git 2.25+](https://git-scm.com), the [`gh` CLI](https://cli.github.com), and at least one coding-agent CLI (e.g. [Claude Code](https://www.anthropic.com/claude-code)).

- **macOS / Linux:** [tmux](https://github.com/tmux/tmux/wiki/Installing) — `brew install tmux` or `sudo apt install tmux`.
- **Windows:** PowerShell 7+ recommended; tmux is **not** required (AgentMesh uses native ConPTY via the `process` runtime).

## Quick start

Point it at any repo — it clones, configures, and launches the dashboard in one command:

```bash
ao start https://github.com/your-org/your-repo
```

Or from inside an existing local repo:

```bash
cd ~/your-project && ao start
```

The dashboard opens at `http://localhost:3000` and an orchestrator agent starts managing your project. Add more repos any time:

```bash
ao start ~/path/to/another-repo
```

If you are testing the repository itself instead of the published package, use the repo-level
[Quick-start.md](../../Quick-start.md) for the shortest local setup and smoke-test flow. On
Windows, make sure you are actually running Node `20.18.3+`.

You don't need to learn the CLI — the dashboard and the orchestrator agent drive everything. (Individual `ao` commands are documented in the [CLI Reference](https://github.com/ComposioHQ/agent-orchestrator/blob/main/docs/CLI.md) and used internally by the orchestrator.)

## How it works

1. **You start** — `ao start` launches the dashboard and an orchestrator agent.
2. **Orchestrator spawns workers** — each issue gets its own agent in an isolated git worktree and branch.
3. **Agents work autonomously** — they read code, write tests, and open PRs.
4. **Reactions handle feedback** — CI failures and review comments are routed back to the responsible agent automatically.
5. **You review and merge** — you're pulled in only when human judgment is needed.

## Pluggable by design

Eight plugin slots — seven swappable (below) plus Lifecycle, which is managed by core and not pluggable:

| Slot      | Default                                | Alternatives                                   |
| --------- | -------------------------------------- | ---------------------------------------------- |
| Runtime   | tmux (macOS/Linux) / process (Windows) | process                                        |
| Agent     | claude-code                            | codex, aider, cursor, opencode, kimicode, grok |
| Workspace | worktree                               | clone                                          |
| Tracker   | github                                 | linear, gitlab                                 |
| SCM       | github                                 | gitlab                                         |
| Notifier  | desktop                                | slack, discord, composio, webhook, openclaw    |
| Terminal  | iterm2                                 | web                                            |

## Why AgentMesh?

Running one AI agent in a terminal is easy. Running 30 across different issues, branches, and PRs is a coordination problem: creating branches, detecting stuck agents, reading CI failures, forwarding review comments, tracking which PRs are ready, and cleaning up afterward.

AgentMesh handles the isolation, feedback routing, and status tracking. You `ao start` and walk away — then review PRs and make decisions. The rest is automated.

## Documentation

- 📖 [Project README & overview](https://github.com/ComposioHQ/agent-orchestrator)
- 🛠️ [Setup guide](https://github.com/ComposioHQ/agent-orchestrator/blob/main/SETUP.md) — install, configuration, troubleshooting
- ⌨️ [CLI reference](https://github.com/ComposioHQ/agent-orchestrator/blob/main/docs/CLI.md)
- 🧩 [Development & plugin guide](https://github.com/ComposioHQ/agent-orchestrator/blob/main/docs/DEVELOPMENT.md)
- 💬 [Discord community](https://discord.gg/UZv7JjxbwG)

## License

MIT © [ComposioHQ](https://github.com/ComposioHQ/agent-orchestrator)
