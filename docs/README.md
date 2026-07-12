# Agent Orchestrator docs

Agent Orchestrator is a long-running Go daemon (`backend/`) with Electron,
browser, CLI, mobile, and host-ops clients. The daemon supervises coding-agent
sessions and exposes project/session state, terminal streaming, operator
attention, notifications, and CDC/event infrastructure.

Start with [architecture.md](architecture.md) for the current backend model and
[cli/README.md](cli/README.md) for the CLI surface.

## Reference docs

| Doc                                                  | What it covers                                                                                                             |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| [architecture.md](architecture.md)                   | Current topology, ownership, lifecycle, dispatch, attention, health, persistence/CDC, and load-bearing rules.              |
| [cli/README.md](cli/README.md)                       | CLI commands and daemon control surface.                                                                                   |
| [stack.md](stack.md)                                 | Accepted library/runtime choices, pending stack decisions, and dependencies explicitly avoided for V1.                     |
| [codex-foreground-only.md](codex-foreground-only.md) | Operator rule that codex/codex-fugu always run in the foreground, why, and the audit of every codex exec path in the repo. |

## Mental model

Persist durable facts, derive display status:

- session table: `activity_state`, `is_terminated`, identity, metadata
- PR tables: PR/CI/review facts
- derived read model: `service.Session` computes display status from session + PR facts
