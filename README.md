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

Agent Orchestrator is a meta-harness agent IDE for running AI coding agents in parallel. It gives terminal-based agents like Claude Code, Codex, Cursor, Aider, Goose, and others a shared workspace where their sessions, terminals, branches, pull requests, and feedback loops can be supervised from one place.

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

<img src="frontend/src/landing/public/docs/logos/claude-code.svg" width="16" valign="middle" /> `claude-code` · <img src="frontend/src/landing/public/docs/logos/codex.svg" width="16" valign="middle" /> `codex` · <img src="frontend/src/landing/public/docs/logos/aider.png" width="16" valign="middle" /> `aider` · <img src="frontend/src/landing/public/docs/logos/opencode.svg" width="16" valign="middle" /> `opencode` · <img src="frontend/src/landing/public/docs/logos/grok.png" width="16" valign="middle" /> `grok` · <img src="frontend/src/landing/public/docs/logos/droid.png" width="16" valign="middle" /> `droid` · `amp` · `agy` · <img src="frontend/src/landing/public/docs/logos/crush.png" width="16" valign="middle" /> `crush` · <img src="frontend/src/landing/public/docs/logos/cursor.svg" width="16" valign="middle" /> `cursor` · <img src="frontend/src/landing/public/docs/logos/qwen.png" width="16" valign="middle" /> `qwen` · <img src="frontend/src/landing/public/docs/logos/copilot.png" width="16" valign="middle" /> `copilot` · <img src="frontend/src/landing/public/docs/logos/goose.png" width="16" valign="middle" /> `goose` · `auggie` · <img src="frontend/src/landing/public/docs/logos/continue.png" width="16" valign="middle" /> `continue` · <img src="frontend/src/landing/public/docs/logos/devin.png" width="16" valign="middle" /> `devin` · `cline` · <img src="frontend/src/landing/public/docs/logos/kimi.png" width="16" valign="middle" /> `kimi` · <img src="frontend/src/landing/public/docs/logos/kiro.png" width="16" valign="middle" /> `kiro` · <img src="frontend/src/landing/public/docs/logos/kilocode.png" width="16" valign="middle" /> `kilocode` · <img src="frontend/src/landing/public/docs/logos/vibe.png" width="16" valign="middle" /> `vibe` · <img src="frontend/src/landing/public/docs/logos/pi.png" width="16" valign="middle" /> `pi` · `autohand`

Reviewer agents are configured separately. The current reviewer harnesses are:

<img src="frontend/src/landing/public/docs/logos/claude-code.svg" width="16" valign="middle" /> `claude-code` · <img src="frontend/src/landing/public/docs/logos/codex.svg" width="16" valign="middle" /> `codex` · <img src="frontend/src/landing/public/docs/logos/opencode.svg" width="16" valign="middle" /> `opencode`

**If it runs in a terminal, it runs on Agent Orchestrator.**

## Install

The fastest path is the same flow used by the installation docs:

```bash
npm install -g @aoagents/ao
ao start
```

Run `ao start` from the repository you want AO to manage. See the [installation guide](https://aoagents.dev/docs/installation) for pnpm, yarn, source installs, agent CLI setup, and troubleshooting.

You can also download the latest desktop build for your platform:

| Platform | Download                                                                                          |
| -------- | ------------------------------------------------------------------------------------------------- |
| Windows  | [Setup.exe](https://github.com/AgentWrapper/agent-orchestrator/releases/latest)                   |
| macOS    | [Agent Orchestrator.dmg](https://github.com/AgentWrapper/agent-orchestrator/releases/latest)      |
| Linux    | [Agent Orchestrator.AppImage](https://github.com/AgentWrapper/agent-orchestrator/releases/latest) |

## Witness AO's Journey on X

<table>
  <tr>
    <td width="33%" align="center">
      <a href="https://x.com/agent_wrapper/status/2026329204405723180">
        <img src="screenshots/tweet2.png" height="330" alt="Agent Orchestrator journey screenshot one" />
      </a>
    </td>
    <td width="37.5%" align="center">
      <a href="https://x.com/agent_wrapper/status/2025986105485733945">
        <img src="screenshots/tweet1.png" height="330" alt="Agent Orchestrator journey screenshot two" />
      </a>
    </td>
    <td width="29.5%" align="center">
      <a href="https://x.com/agent_wrapper/status/2024885035774738700">
        <img src="screenshots/tweet3.png" height="330" alt="Agent Orchestrator journey screenshot three" />
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
