# agent-orchestrator rewrite docs

The agent-orchestrator is being rebuilt as a long-running Go backend daemon
(`backend/`) plus an Electron + TypeScript frontend (`frontend/`). The backend
supervises coding-agent sessions and exposes daemon control, project/session
state, terminal streaming, and CDC/event infrastructure.

Start with [architecture.md](architecture.md) for the current backend model and
[cli/README.md](cli/README.md) for the CLI surface.

## Reference docs

| Doc                                                          | What it covers                                                                                                        |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| [architecture.md](architecture.md)                           | Current backend model, package layout, status derivation, persistence/CDC, and load-bearing rules.                    |
| [backend-code-structure.md](backend-code-structure.md)       | Package ownership rules for the Go backend: domain, services, ports, adapters, storage, HTTP, CLI, and daemon wiring. |
| [cli/README.md](cli/README.md)                               | CLI commands and daemon control surface.                                                                              |
| [development.md](development.md)                             | Prerequisites, build steps, running tests, and troubleshooting for local development.                                 |
| [STATUS.md](STATUS.md)                                       | What is shipped on `main` today and what is still in flight.                                                          |
| [stack.md](stack.md)                                         | Accepted library/runtime choices, pending stack decisions, and dependencies explicitly avoided for V1.                |
| [telemetry.md](telemetry.md)                                 | Telemetry collection, privacy safeguards, configuration, and PostHog dashboard guidance.                              |
| [Cloud Agent Plan Nihal.md](Cloud%20Agent%20Plan%20Nihal.md) | Cloud-agent decisions, self-hosted AWS topology, competitive research, and unresolved design questions.               |
| [Cloud Agent V1 Plan.md](Cloud%20Agent%20V1%20Plan.md)       | Implementation scope, shared contracts, local regression baseline, cloud acceptance gates, and required credentials.  |
| [TODO-CLOUD.md](TODO-CLOUD.md)                               | Deferred organization, provider, synchronization, enterprise, automation, and billing work for AO Cloud.              |

## Mental model

Persist durable facts, derive display status:

- session table: `activity_state`, `is_terminated`, identity, metadata
- PR tables: PR/CI/review facts
- derived read model: `service.Session` computes display status from session + PR facts
