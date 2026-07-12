# Contributing

We love contributions! Join our community on Discord to get started.

## Join us on Discord

[![Discord](https://img.shields.io/badge/Discord-join%20the%20community-5865F2?style=for-the-badge&logo=discord&logoColor=white&logoSize=auto)](https://discord.com/invite/UZv7JjxbwG)

**Daily contributor sync:** Every day at **10:00 PM IST**

Get your issues verified by core contributors, ask questions, share progress, and learn from the community. New contributors are always welcome!

## Ways to contribute

- **Code** - Fix a bug, add a feature, or improve performance. Browse [open issues](https://github.com/AgentWrapper/agent-orchestrator/issues) to find something to work on.
- **Docs** - Improve README, architecture docs, or inline documentation. Clear docs help every contributor.
- **Bug reports** - Found a bug? Open an issue using the Bug Report template and include reproduction steps.
- **Feature requests** - Have an idea? Open an issue using the Feature Request template.
- **Reviews** - Review open PRs. Testing and feedback on others' work is valuable.
- **Community** - Help answer questions on Discord, share workflows, and welcome new contributors.

## Before you start

1. **Read [AGENTS.md](AGENTS.md)** - It covers repo layout, daemon/API boundaries, coding conventions, and hard rules.
2. **Check [docs/architecture.md](docs/architecture.md)** - Backend mental model, lifecycle, and persistence.
3. **Read [docs/STATUS.md](docs/STATUS.md)** - What ships on `main` today and what is in flight.
4. **Build and test locally** - `cd backend && go build ./... && go test ./...`

## Claiming work

To avoid duplicate effort:

1. Find an issue you want to work on.
2. Leave a comment on the issue saying you are picking it up.
3. If no one has claimed it, start working. If someone already claimed it, coordinate with them on Discord.
4. If you cannot finish, leave a comment so someone else can pick it up.

## Opening a pull request

1. Keep changes small and focused. One concern per PR.
2. Use the pull request template (it will appear automatically when you create a PR).
3. Run `cd backend && go build ./... && go test ./...` before pushing.
4. For frontend changes, also run `cd frontend && npm run typecheck`.
5. Link the issue your PR addresses using `Closes #NNN` syntax.
6. Explain the **what**, **why**, and **how** in the PR description.
7. Do not include unrelated changes or formatting churn.

## Code of conduct

Be respectful. Be patient. Be helpful. We are all here because we care about building something useful together. If you experience or witness behavior that makes the community unwelcoming, reach out to a maintainer on Discord.
