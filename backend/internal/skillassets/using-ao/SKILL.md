---
name: using-ao
description: "Catalog of the AO (Agent Orchestrator) `ao` CLI: spawning workers, managing sessions and projects, sending messages, previewing pages, and daemon control. Use when using the ao CLI, spawning workers, or managing AO sessions in an AO workspace."
trigger: "Using the ao CLI in an AO workspace: spawning workers, managing sessions/projects, sending messages, previewing pages."
---

# AO CLI Catalog

`ao` is a thin CLI over the local AO daemon. Every command is `ao <command> --help` for the authoritative flag list.

| Command | What it does | When to use | Details |
|---|---|---|---|
| `spawn` | Spawn a worker agent in a fresh git worktree | Starting a new task or issue | [commands/spawn.md](commands/spawn.md) |
| `session` | Manage agent sessions (list, kill, rename, restore, etc.) — LOCAL only | Inspecting or controlling this daemon's sessions | [commands/session.md](commands/session.md) |
| `fleet` | List agent sessions across ALL locations (local + cloud) with status | Seeing every worker you own and what it's doing — use this, not `session ls`, when any agent may be in the cloud | - |
| `project` | Register, inspect, configure, or remove projects | Setting up or managing repos AO knows about | [commands/project.md](commands/project.md) |
| `orchestrator` | List orchestrator sessions | Viewing which sessions are orchestrators | [commands/orchestrator.md](commands/orchestrator.md) |
| `review` | Submit a reviewer result for a worker's PR | Completing a code review loop | [commands/review.md](commands/review.md) |
| `send` | Send a message to a running agent session | Correcting or directing a live agent | [commands/send.md](commands/send.md) |
| `preview` | Open a URL in the desktop browser panel | Demoing a local server or file from inside a session | [commands/preview.md](commands/preview.md) |
| `start` | Fetch (if needed) and open the AO desktop app | Launching the app | [commands/start.md](commands/start.md) |
| `stop` | Stop the AO daemon | Shutting down AO | [commands/stop.md](commands/stop.md) |
| `status` | Show daemon status | Verifying the daemon is up and healthy | [commands/status.md](commands/status.md) |
| `doctor` | Run local health checks | Diagnosing AO setup problems | [commands/doctor.md](commands/doctor.md) |
| `import` | Import projects from a legacy AO install | Migrating from the old flat-file store | [commands/import.md](commands/import.md) |
| `version` | Print version information | Checking installed version | - |
| `completion` | Generate shell completion scripts | Setting up tab completion | - |

## Seeing your agents across local + cloud

Workers can run **locally** (this daemon) or in **cloud sandboxes**. A cloud
worker is invisible to `ao session ls` — that only lists the local daemon. To see
**every** agent you own and what it's doing, wherever it runs, use:

```
ao fleet
```

It lists each session with its LOCATION (local / cloud:<sandbox>), KIND, STATUS,
and PROJECT — merging local and cloud. **Always use `ao fleet` (not `ao session
ls`) when any of your workers might be in the cloud** — including when you (the
orchestrator) are running locally but spawned cloud workers. This works the same
whether you run locally or inside a sandbox.

Coordination is location-agnostic — you address agents by session id:

- `ao spawn` starts a worker; in a cloud context it provisions a **cloud
  sandbox** automatically (no extra flag) and prints the new session id.
- `ao send --session <id> --message "..."` reaches a worker **wherever it
  lives** — the id from `ao fleet` routes to the right location.
- Cloud workers report back to you automatically when they go idle.

You never manage sandboxes or URLs — discover with `ao fleet`, address by id.

## Conventions

- Most read commands accept `--json` for machine-readable output.
- `-p / --project` scopes session subcommand lookups to one project.
- Session and project ids are shown by `ao session ls` and `ao project ls`.
- `--agent` is an alias for `--harness` on `ao spawn`.
- Every command accepts `-h / --help` for the full flag list.

See [references.md](references.md) for natural-language-to-command mappings.
