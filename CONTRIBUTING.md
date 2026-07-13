# Contributing

We love contributions! Join our community on Discord to get started.

[![Discord](https://img.shields.io/badge/Discord-join%20the%20community-5865F2?style=for-the-badge&logo=discord&logoColor=white&logoSize=auto)](https://discord.com/invite/UZv7JjxbwG)

**Daily contributor sync:** Every day at **10:00 PM IST**

---

## Before you start

Read these first:

1. **[AGENTS.md](AGENTS.md)** - repo layout, daemon/API boundaries, coding conventions, and hard rules. Required reading before writing code.
2. **[Development Guide](docs/development.md)** - prerequisites, build steps, running tests, and troubleshooting.

## Picking an issue

Browse [open issues](https://github.com/AgentWrapper/agent-orchestrator/issues).

- **`good first issue`** - small, well-scoped, good for new contributors
- **`help wanted`** - the team would appreciate community help
- **No assignee** - check if someone is already working on it

If you want to work on something not in the issues, open a feature request
first to get feedback.

## Project structure at a glance

```text
backend/          # Go daemon - Cobra CLI, HTTP API, services, SQLite storage
frontend/         # Electron + React desktop app (TypeScript)
packages/
  mobile/         # React Native (Expo) mobile companion
  ao/             # Legacy npm CLI (frozen, no longer updated)
docs/             # Architecture, status, CLI docs, ADRs
```

### Where to find things

| Concern                 | Location                                             |
| ----------------------- | ---------------------------------------------------- |
| CLI commands            | `backend/internal/cli/*.go`                          |
| HTTP controllers        | `backend/internal/httpd/controllers/`                |
| Service/business logic  | `backend/internal/service/`                          |
| Domain types            | `backend/internal/domain/`                           |
| Port interfaces         | `backend/internal/ports/`                            |
| SQLite schema & queries | `backend/internal/storage/sqlite/`                   |
| Generated SQL code      | `backend/internal/storage/sqlite/gen/` (do not edit) |
| API DTOs                | `backend/internal/httpd/controllers/dto.go`          |
| OpenAPI spec generation | `backend/internal/httpd/apispec/`                    |
| Frontend renderer       | `frontend/src/`                                      |
| Frontend e2e tests      | `frontend/e2e/`                                      |

## Pull request checklist

Before submitting, make sure:

- `npm run lint` passes (backend lint + tests)
- `npm run frontend:typecheck` passes (frontend type check)
- New code has tests covering the happy path, validation errors, and
  daemon error envelopes
- API changes include regenerated spec and schema.ts (`npm run api`)
- No generated files (sqlc gen, OpenAPI) are hand-edited
- The PR targets `main` and follows conventional commits
- PRs are squash-merged - all commits in a PR are collapsed into a
  single message upon merge

## Testing philosophy

- Backend tests use `httptest`, fakes, and injected dependencies - no real
  daemon needed.
- Write tests at the user-visible boundary: CLI output, HTTP responses, session
  state transitions.
- Don't add network calls to tests unless the package already uses integration
  tests.
- Frontend tests use Vitest (unit) and Playwright (e2e).

## Getting help

- **Discord:** [Join the server](https://discord.com/invite/UZv7JjxbwG)
  - Get your issues and PRs verified by core contributors before investing time
  - Learn from experienced contributors in daily sync calls
  - Share your progress and get feedback
  - Get help troubleshooting in real-time
  - Stay updated on the latest developments and roadmap
- **Issues:** Use GitHub issues for bug reports and feature requests (see
  templates).

## License

By contributing, you agree that your contributions will be licensed under the
[Apache License 2.0](LICENSE).
