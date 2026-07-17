<div align="center">
  <img src="ao-logo.svg" alt="Agent Orchestrator" width="160" height="160" />

# Agent Orchestrator

**The orchestration layer for parallel AI coding agents**

[![Stars](https://img.shields.io/github/stars/AgentWrapper/agent-orchestrator)](https://github.com/AgentWrapper/agent-orchestrator/stargazers)
[![Contributors](https://img.shields.io/github/contributors/AgentWrapper/agent-orchestrator)](https://github.com/AgentWrapper/agent-orchestrator/graphs/contributors)
[![Twitter](https://img.shields.io/badge/Twitter-1DA1F2?logo=twitter&logoColor=white)](https://x.com/aoagents)
[![Discord](https://img.shields.io/badge/Discord-join%20the%20community-5865F2?logo=discord&logoColor=white)](https://discord.com/invite/UZv7JjxbwG)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)

An Agentic IDE that supervises parallel AI coding agents in isolated workspaces, with complete control and automatic feedback loops from CI failures, review comments, and merge conflicts.

<img src="docs/assets/readme/dashboard.png" alt="Agent Orchestrator dashboard showing parallel coding agent sessions" width="100%" />
</div>

---

## What is Agent Orchestrator?

Agent Orchestrator is a meta-harness agent IDE for running AI coding agents in parallel. It gives terminal-based agents like Claude Code, Codex, Cursor, Kimi Code, opencode, and others a shared workspace where their sessions, terminals, branches, pull requests, and feedback loops can be supervised from one place.

The agents still do the coding. AO provides the harness around them: isolated workspaces, live terminal access, session state, PR awareness, and automatic loops that send CI failures, review comments, and merge conflicts back to the right agent. Instead of manually coordinating a pile of agent terminals, AO turns parallel agent work into a managed workflow.

## Why Agent Orchestrator?

AI coding agents become much more useful when they can work in parallel, but parallel work gets messy quickly. Branches overlap, terminals get lost, CI failures need follow-up, review comments need replies, and merge conflicts have to reach the right worker.

Agent Orchestrator is built to keep that loop visible and manageable. It helps you:

- Start multiple agents from the same project without mixing their work
- Keep every session in a separate git worktree
- See which agents are working, waiting, finished, or blocked
- Route CI failures, review comments, and merge conflicts back to the right session
- Use different agent CLIs through one common supervisor

## How it works

At a high level, Agent Orchestrator follows a simple loop:

1. Add a project you want agents to work on.
2. Start one or more sessions from the desktop app or CLI.
3. AO creates an isolated git worktree for each session.
4. AO launches the selected coding agent in that session's terminal runtime.
5. The local daemon watches session state, terminal activity, pull requests, CI, and review feedback.
6. The desktop app and CLI show the current state and let you send follow-up instructions to the right session.

The result is a local control layer for agentic coding: agents still do the coding, while Agent Orchestrator keeps their workspaces, status, terminals, and feedback loops organized.

## Features

The desktop app is the main control surface: projects on the left, active sessions in the center, and the selected session's terminal, pull request state, review runs, and browser preview in the inspector.

<table>
  <tr>
    <td width="36%">
      <h3>Parallel agent sessions</h3>
      <p>Start multiple coding agents from the same project without mixing files, branches, terminals, or pull request state.</p>
    </td>
    <td width="64%">
      <img src="docs/assets/readme/dashboard.png" alt="Agent Orchestrator board with multiple parallel sessions" />
    </td>
  </tr>
  <tr>
    <td width="36%">
      <h3>Live terminal control</h3>
      <p>Open any session and attach to the worker terminal while keeping session summary, PR state, and follow-up actions in view.</p>
    </td>
    <td width="64%">
      <img src="docs/assets/readme/session-terminal.png" alt="Session terminal inside Agent Orchestrator" />
    </td>
  </tr>
  <tr>
    <td width="36%">
      <h3>Review feedback loop</h3>
      <p>Run reviewer agents, inspect review status, and route requested changes back to the right worker session.</p>
    </td>
    <td width="64%">
      <img src="docs/assets/readme/reviews-tab.png" alt="Reviews tab showing reviewer runs and actions" />
    </td>
  </tr>
  <tr>
    <td width="36%">
      <h3>In-app browser preview</h3>
      <p>Preview a session's local app beside the terminal so UI work, browser state, and agent output stay together.</p>
    </td>
    <td width="64%">
      <img src="docs/assets/readme/browser-preview.png" alt="Browser preview tab showing a local app preview" />
    </td>
  </tr>
</table>

## Supported Agents

AO ships adapters for 23 worker agent harnesses:

<p>
  <a href="https://ao-agents.com/docs/plugins/agents/claude-code"><img src="frontend/src/landing/public/docs/logos/claude-code.svg" alt="" width="16" height="16" valign="middle" /> <code>claude-code</code></a> ·
  <a href="https://ao-agents.com/docs/plugins/agents/codex"><img src="frontend/src/landing/public/docs/logos/codex.svg" alt="" width="16" height="16" valign="middle" /> <code>codex</code></a> ·
  <a href="https://ao-agents.com/docs/plugins/agents/aider"><img src="frontend/src/landing/public/docs/logos/aider.png" alt="" width="16" height="16" valign="middle" /> <code>aider</code></a> ·
  <a href="https://ao-agents.com/docs/plugins/agents/opencode"><img src="frontend/src/landing/public/docs/logos/opencode.svg" alt="" width="16" height="16" valign="middle" /> <code>opencode</code></a> ·
  <a href="https://ao-agents.com/docs/plugins/agents"><img src="frontend/src/landing/public/docs/logos/grok.png" alt="" width="16" height="16" valign="middle" /> <code>grok</code></a> ·
  <a href="https://ao-agents.com/docs/plugins/agents"><img src="frontend/src/landing/public/docs/logos/droid.png" alt="" width="16" height="16" valign="middle" /> <code>droid</code></a> ·
  <a href="https://ao-agents.com/docs/plugins/agents"><code>amp</code></a> ·
  <a href="https://ao-agents.com/docs/plugins/agents"><code>agy</code></a> ·
  <a href="https://ao-agents.com/docs/plugins/agents"><img src="frontend/src/landing/public/docs/logos/crush.png" alt="" width="16" height="16" valign="middle" /> <code>crush</code></a> ·
  <a href="https://ao-agents.com/docs/plugins/agents/cursor"><img src="frontend/src/landing/public/docs/logos/cursor.svg" alt="" width="16" height="16" valign="middle" /> <code>cursor</code></a> ·
  <a href="https://ao-agents.com/docs/plugins/agents"><img src="frontend/src/landing/public/docs/logos/qwen.png" alt="" width="16" height="16" valign="middle" /> <code>qwen</code></a> ·
  <a href="https://ao-agents.com/docs/plugins/agents"><img src="frontend/src/landing/public/docs/logos/copilot.png" alt="" width="16" height="16" valign="middle" /> <code>copilot</code></a> ·
  <a href="https://ao-agents.com/docs/plugins/agents"><img src="frontend/src/landing/public/docs/logos/goose.png" alt="" width="16" height="16" valign="middle" /> <code>goose</code></a> ·
  <a href="https://ao-agents.com/docs/plugins/agents"><code>auggie</code></a> ·
  <a href="https://ao-agents.com/docs/plugins/agents"><img src="frontend/src/landing/public/docs/logos/continue.png" alt="" width="16" height="16" valign="middle" /> <code>continue</code></a> ·
  <a href="https://ao-agents.com/docs/plugins/agents"><img src="frontend/src/landing/public/docs/logos/devin.png" alt="" width="16" height="16" valign="middle" /> <code>devin</code></a> ·
  <a href="https://ao-agents.com/docs/plugins/agents"><code>cline</code></a> ·
  <a href="https://ao-agents.com/docs/plugins/agents"><img src="frontend/src/landing/public/docs/logos/kimi.png" alt="" width="16" height="16" valign="middle" /> <code>kimi</code></a> ·
  <a href="https://ao-agents.com/docs/plugins/agents"><img src="frontend/src/landing/public/docs/logos/kiro.png" alt="" width="16" height="16" valign="middle" /> <code>kiro</code></a> ·
  <a href="https://ao-agents.com/docs/plugins/agents"><img src="frontend/src/landing/public/docs/logos/kilocode.png" alt="" width="16" height="16" valign="middle" /> <code>kilocode</code></a> ·
  <a href="https://ao-agents.com/docs/plugins/agents"><img src="frontend/src/landing/public/docs/logos/vibe.png" alt="" width="16" height="16" valign="middle" /> <code>vibe</code></a> ·
  <a href="https://ao-agents.com/docs/plugins/agents"><img src="frontend/src/landing/public/docs/logos/pi.png" alt="" width="16" height="16" valign="middle" /> <code>pi</code></a> ·
  <a href="https://ao-agents.com/docs/plugins/agents"><code>autohand</code></a>
</p>

Reviewer agents are configured separately. The current reviewer harnesses are:

<p>
  <a href="https://ao-agents.com/docs/plugins/agents/claude-code"><img src="frontend/src/landing/public/docs/logos/claude-code.svg" alt="" width="16" height="16" valign="middle" /> <code>claude-code</code></a> ·
  <a href="https://ao-agents.com/docs/plugins/agents/codex"><img src="frontend/src/landing/public/docs/logos/codex.svg" alt="" width="16" height="16" valign="middle" /> <code>codex</code></a> ·
  <a href="https://ao-agents.com/docs/plugins/agents/opencode"><img src="frontend/src/landing/public/docs/logos/opencode.svg" alt="" width="16" height="16" valign="middle" /> <code>opencode</code></a>
</p>

**If it runs in a terminal, it runs on Agent Orchestrator.**

## Install

Download the latest desktop build for your platform:

| Platform              | Download                                                                                                                      |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| macOS (Apple silicon) | [Download](https://github.com/AgentWrapper/agent-orchestrator/releases/latest/download/agent-orchestrator-darwin-arm64.zip)   |
| macOS (Intel)         | [Download](https://github.com/AgentWrapper/agent-orchestrator/releases/latest/download/agent-orchestrator-darwin-x64.zip)     |
| Windows               | [Download](https://github.com/AgentWrapper/agent-orchestrator/releases/latest/download/agent-orchestrator-win32-x64.exe)      |
| Linux                 | [Download](https://github.com/AgentWrapper/agent-orchestrator/releases/latest/download/agent-orchestrator-linux-x64.AppImage) |

After installing, open Agent Orchestrator and point it at the repository you want AO to manage. The desktop app runs the daemon for you, so no CLI is required. See the [installation guide](https://ao-agents.com/docs/installation) for agent CLI setup and troubleshooting.

<details>
<summary>Install via npm (legacy CLI, no longer recommended)</summary>

npm still works but is no longer recommended. `0.10.0` is the final version published to npm, and the `@aoagents/ao` package is frozen and will not receive further updates. It stays available for existing users who have the `ao` CLI on their PATH; `ao start` fetches and opens the same desktop build linked above. For any new setup, prefer the desktop download.

```bash
npm install -g @aoagents/ao
ao start
```

</details>

## Witness AO's Journey on X

<table>
  <tr>
    <td width="50%" align="center">
      <a href="https://x.com/agent_wrapper/status/2026329204405723180">
        <img src="screenshots/tweet2.png" height="330" alt="Agent Orchestrator journey screenshot one" />
      </a>
    </td>
    <td width="50%" align="center">
      <a href="https://x.com/agent_wrapper/status/2025986105485733945">
        <img src="screenshots/tweet1.png" height="330" alt="Agent Orchestrator journey screenshot two" />
      </a>
    </td>
  </tr>
</table>

## Documentation

| Document                                                         | Start here when you need                                                                     |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| [docs/architecture.md](docs/architecture.md)                     | Backend mental model, lifecycle, persistence, CDC, status derivation, and daemon boundaries. |
| [docs/backend-code-structure.md](docs/backend-code-structure.md) | Package ownership and where each backend concern belongs.                                    |
| [docs/cli/README.md](docs/cli/README.md)                         | CLI behavior and daemon route mapping.                                                       |
| [docs/STATUS.md](docs/STATUS.md)                                 | What currently ships on `main` and what remains in flight.                                   |
| [docs/stack.md](docs/stack.md)                                   | Library, runtime, and dependency decisions.                                                  |

## Telemetry

Agent Orchestrator's Electron renderer sends anonymous usage events to PostHog for reliability and product understanding, and PostHog session recording is enabled with local paths and local URLs redacted before transmission. Set `VITE_AO_POSTHOG_KEY` to an empty string before building to disable transmission. See [docs/telemetry.md](docs/telemetry.md).

## License

Apache License 2.0. See [LICENSE](LICENSE).
