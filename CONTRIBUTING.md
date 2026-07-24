# Contributing

We love contributions — code, docs, triage, examples, and tests.
Start on Discord so scope is clear before you invest time.

## Join us on Discord

[![Discord](https://img.shields.io/badge/Discord-join%20the%20community-5865F2?style=for-the-badge&logo=discord&logoColor=white&logoSize=auto)](https://discord.com/invite/UZv7JjxbwG)

**Daily contributor sync:** every day at **10:00 PM IST**

- **Discord** → questions, mentoring, sync, realtime unblocking
- **GitHub** → bugs, proposals, design threads, review

Non-trivial work? Comment on the issue or ping Discord first. Get a thumbs-up, then build.

## Ways to contribute

| Type             | Examples                                       |
| ---------------- | ---------------------------------------------- |
| Code             | Fixes, features, adapters, performance         |
| Docs             | README, `docs/`, architecture notes            |
| Triage           | Repro bugs, tighten reports, label suggestions |
| Examples / tests | Recipes, edge cases, flaky-test hunts          |

## Quick start

1. **Join Discord** — say hi and get guidance
2. **Read the contract** — [AGENTS.md](AGENTS.md) (layout, commands, hard rules, PR hygiene)
3. **Pick something focused** — [open issues](https://github.com/AgentWrapper/agent-orchestrator/issues); prefer `good-first-issue` / `help wanted`
4. **Claim it** — comment `I'd like to work on this` and wait for assignment
5. **Open a clear PR** — narrow change, link the issue, user-visible impact, tests
6. **Iterate** — address review; maintainers merge

Need the product/run overview first? Start with [README.md](README.md) and [docs/architecture.md](docs/architecture.md).

### Run from source

The desktop app lives in `frontend/`. For renderer-only UI work, run the web
preview from the source checkout:

```bash
cd frontend
npm install
npm run dev:web
```

`dev:web` sets `VITE_NO_ELECTRON=1` through a Node launcher so it works on
macOS, Linux, and Windows. On Windows, if PowerShell blocks `npm.ps1` with a
script execution policy error, use the command shim directly:

```powershell
cd frontend
npm.cmd install
npm.cmd run dev:web
```

The command prints a local Vite URL, usually `http://127.0.0.1:5173/`. Use
`npm run dev` from `frontend/` when you need the full Electron desktop shell.

### Bugs and features

Use the GitHub issue forms (**Bug report** / **Feature request**) so reports stay reproducible.
Bug reports should include AO version, environment, repro steps, and expected vs actual behavior.

### Pull requests

New PRs are prefilled from [`.github/pull_request_template.md`](.github/pull_request_template.md).
Also follow **PR hygiene** in [AGENTS.md](AGENTS.md): branch from `main`, one issue per PR, conventional commits, explain intentional omissions, and keep CI green for the area you touched.

## Code of Conduct

Be respectful, constructive, and assume good intent. Report problems to maintainers via Discord DM.

Thanks for making agent-orchestrator better for the next person who shows up.
