<div align="center">

<img src="ao-logo.svg" alt="Agent Orchestrator" width="200" height="200" />

# Agent Orchestrator

**The orchestration layer for parallel AI coding agents**

[![Stars](https://img.shields.io/github/stars/AgentWrapper/agent-orchestrator)](https://github.com/AgentWrapper/agent-orchestrator/stargazers)
[![Contributors](https://img.shields.io/github/contributors/AgentWrapper/agent-orchestrator)](https://github.com/AgentWrapper/agent-orchestrator/graphs/contributors)
[![Twitter](https://img.shields.io/badge/Twitter-1DA1F2?logo=twitter&logoColor=white)](https://x.com/aoagents)
[![Discord](https://img.shields.io/badge/Discord-join%20the%20community-5865F2?logo=discord&logoColor=white)](https://discord.com/invite/UZv7JjxbwG)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](https://www.apache.org/licenses/LICENSE-2.0)

An Agentic IDE that supervises parallel AI coding agents in isolated workspaces, with complete control and automatic feedback loops from CI failures, review comments, and merge conflicts.

![Agent Orchestrator Dashboard](ao-dashboard-preview.png)

### See AO in Action (before the re-write)

<table border="1" style="border-collapse: collapse; width: 100%;">
<tr>
<td style="padding: 10px; text-align: center; border: 1px solid #ddd;">
<a href="https://x.com/agent_wrapper/status/2026329204405723180"><img src="BLOG IMAGES/first.png" alt="First" width="400"></a><br><br>
<a href="https://x.com/agent_wrapper/status/2026329204405723180">Visit</a>
</td>
<td style="padding: 10px; text-align: center; border: 1px solid #ddd;">
<a href="https://x.com/agent_wrapper/status/2025986105485733945"><img src="BLOG IMAGES/second.png" alt="Second" width="400"></a><br><br>
<a href="https://x.com/agent_wrapper/status/2025986105485733945">Visit</a>
</td>
</tr>
<tr>
<td style="padding: 10px; text-align: center; border: 1px solid #ddd;">
<a href="https://x.com/agent_wrapper/status/2064157228400341312"><img src="BLOG IMAGES/third.png" alt="Third" width="400"></a><br><br>
<a href="https://x.com/agent_wrapper/status/2064157228400341312">Visit</a>
</td>
<td style="padding: 10px; text-align: center; border: 1px solid #ddd;">
<a href="https://x.com/agent_wrapper/status/2024885035774738700?s=20"><img src="BLOG IMAGES/image.png" alt="Fourth" width="400"></a><br><br>
<a href="https://x.com/agent_wrapper/status/2024885035774738700?s=20">Visit</a>
</td>
</tr>
</table>

[Features](#features) • [Quick Start](#quick-start) • [Architecture](#architecture) • [Documentation](#documentation) • [Contributing](#contributing)

</div>

---

## Features

| Feature                        | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| :----------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Agent-Agnostic Platform**    | 23+ agent adapters including [Claude Code](https://code.claude.com/docs/en/overview), [OpenAI Codex](https://openai.com/), [Cursor](https://cursor.com/), [OpenCode](https://opencode.ai/), [Aider](https://aider.chat/), [Amp](https://ampcode.com/manual), [Goose](https://goose-docs.ai/), [GitHub Copilot](https://github.com/features/copilot), [Grok](https://x.ai/grok), [Qwen Code](https://github.com/QwenLM/qwen-code), [Kimi Code](https://www.kimi.com/code), [Cline](https://cline.bot/), [Continue](https://www.continue.dev/), [Kiro](https://kiro.dev/), and more |
| **Isolated Workspaces**        | Each session spawns into its own git worktree with dedicated runtime                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **Platform-Native Runtimes**   | tmux on Darwin/Linux, conpty on Windows for optimal performance                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **Live PR Observation**        | Provider-neutral SCM observer with automatic feedback routing                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **Automatic Feedback Routing** | CI failures, review comments, and merge conflicts routed to the owning agent                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **Durable Facts Storage**      | SQLite persists immutable facts with display status derived at read time                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **CDC Broadcasting**           | DB triggers append changes to change_log, broadcasted via SSE                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **Desktop Experience**         | Native Electron app with React UI and live terminal streaming                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **Loopback-Only Daemon**       | HTTP control over 127.0.0.1 with no auth, CORS, or TLS by design                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

### Supported Agents

Works with 23+ CLI-based coding agents including Claude Code, OpenAI Codex, Cursor, OpenCode, Aider, Amp, Goose, GitHub Copilot, Grok, Qwen Code, Kimi Code, Crush, Cline, Droid, Devin, Auggie, Continue, Kiro, and Kilo Code.

**If it runs in a terminal, it runs on Agent Orchestrator.**

---

## Quick Start

### Prerequisites

| Requirement | Minimum | Recommended |
| ----------- | ------- | ----------- |
| Go          | 1.25+   | Latest      |
| Node.js     | 20+     | Latest LTS  |
| Git         | Any     | Latest      |
| pnpm        | Any     | Latest      |

**Optional:**

- `tmux` (Darwin/Linux) - For Unix runtime
- `gh` (GitHub CLI) - For authenticated GitHub API calls

### Installation

Download the latest release for your platform:

| Platform    | Download                                                                                          |
| ----------- | ------------------------------------------------------------------------------------------------- |
| **Windows** | [Setup.exe](https://github.com/AgentWrapper/agent-orchestrator/releases/latest)                   |
| **macOS**   | [Agent Orchestrator.dmg](https://github.com/AgentWrapper/agent-orchestrator/releases/latest)      |
| **Linux**   | [Agent Orchestrator.AppImage](https://github.com/AgentWrapper/agent-orchestrator/releases/latest) |

**Direct Download:** [Latest Release](https://github.com/AgentWrapper/agent-orchestrator/releases/latest)

---

## Architecture

Agent Orchestrator is a long-running Go daemon built around **inbound/outbound port contracts** with swappable adapters.

**Core mental model:** OBSERVE external facts → UPDATE durable facts → DERIVE display status / ACT

**Key components:**

- **Frontend** - Electron + React UI with TanStack Router/Query and shadcn/ui
- **Backend Daemon** - Go-based HTTP server with controllers, services, and adapters
- **Runtime** - Platform-specific: `tmux` on Darwin/Linux, `conpty` on Windows
- **Storage** - SQLite with change-data-capture (CDC) for real-time updates
- **Adapters** - 23+ agent adapters, git worktree workspace, GitHub SCM integration

For detailed architecture diagrams, data flows, and load-bearing rules, see [architecture.md](docs/architecture.md).

---

## Documentation

| Document                                                 | Description                                             |
| -------------------------------------------------------- | ------------------------------------------------------- |
| [Architecture](docs/architecture.md)                     | System architecture, data flows, and load-bearing rules |
| [Backend Code Structure](docs/backend-code-structure.md) | Package-by-package ownership and dependency rules       |
| [AGENTS.md](AGENTS.md)                                   | Contributor and worker-agent contract                   |
| [Agent Adapter Contract](docs/agent/README.md)           | Agent adapter interface and hook behavior               |

---

## Testing

```bash
# Backend tests
cd backend
go test -race ./...

# Frontend tests
cd frontend
pnpm test

# Full CI validation locally
npx @redwoodjs/agent-ci run --all
```

---

## Configuration

All configuration is environment-driven. The daemon takes no config file.

| Variable              | Default              | Purpose                     |
| --------------------- | -------------------- | --------------------------- |
| `AO_PORT`             | `3001`               | HTTP bind port              |
| `AO_REQUEST_TIMEOUT`  | `60s`                | Per-request timeout         |
| `AO_SHUTDOWN_TIMEOUT` | `10s`                | Graceful shutdown cap       |
| `AO_RUN_FILE`         | `~/.ao/running.json` | PID/port handshake          |
| `AO_DATA_DIR`         | `~/.ao/data`         | SQLite data directory       |
| `AO_AGENT`            | `claude-code`        | Compatibility agent adapter |
| `GITHUB_TOKEN`        | -                    | GitHub auth token           |

### Health Checks

```bash
curl localhost:3001/healthz   # Liveness probe
curl localhost:3001/readyz    # Readiness probe
```

---

## Contributing

We love contributions! Join our community on Discord to get started.

### Join us on Discord

[![Discord](https://img.shields.io/badge/Discord-join%20the%20community-5865F2?style=for-the-badge&logo=discord&logoColor=white&logoSize=auto)](https://discord.com/invite/UZv7JjxbwG)

**Daily contributor sync:** Every day at **10:00 PM IST**

Get your issues verified by core contributors, ask questions, share progress, and learn from the community. New contributors are always welcome!

**Why join Discord?**

- Get your issues and PRs verified by core contributors before investing time
- Learn from experienced contributors in daily sync calls
- Share your progress and get feedback
- Get help troubleshooting in real-time
- Stay updated on the latest developments and roadmap

### Quick Start

1. **Join the Discord** - Connect with the community and get guidance
2. **Read the contributor contract** - See [AGENTS.md](AGENTS.md) for repo layout, daemon/API boundaries, and coding conventions
3. **Pick a focused problem** - Browse [open issues](https://github.com/AgentWrapper/agent-orchestrator/issues) and choose one small enough for a focused PR
4. **Open a clear PR** - Keep changes narrow, explain user-visible impact, link issues, include tests
5. **Iterate with contributors** - Use review feedback to tighten the PR until verified

---

## License

Apache License 2.0 - see [LICENSE](LICENSE) for details.

---

<div align="center">

**[Star us on GitHub](https://github.com/AgentWrapper/agent-orchestrator)** • **[Report Issues](https://github.com/AgentWrapper/agent-orchestrator/issues)** • **[Discussions](https://github.com/AgentWrapper/agent-orchestrator/discussions)**

Made with love by the Agent Orchestrator community

</div>
