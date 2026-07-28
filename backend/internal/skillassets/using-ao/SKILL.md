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
| `session` | Manage agent sessions (list, kill, rename, restore, etc.) | Inspecting or controlling running/terminated sessions | [commands/session.md](commands/session.md) |
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

## Cloud sessions

When you are running **inside a cloud session** (an AO sandbox), coordination
works exactly as it does locally — the same commands — but across sandboxes:

- `ao spawn` provisions each worker in **its own cloud sandbox** automatically
  (no extra flag needed) and prints the new session id. Spawn workers exactly as
  you would locally.
- `ao send <session-id> --message "..."` reaches a worker **wherever it lives**;
  you address it by session id, not by location.
- `ao fleet` lists every session you own **across all sandboxes** (use this to
  see your workers; the plain `ao session ls` only shows this sandbox).
- Workers report back to you automatically when they go idle.

You never manage sandboxes or URLs — address everything by session id.

## Conventions

- Most read commands accept `--json` for machine-readable output.
- `-p / --project` scopes session subcommand lookups to one project.
- Session and project ids are shown by `ao session ls` and `ao project ls`.
- `--agent` is an alias for `--harness` on `ao spawn`.
- Every command accepts `-h / --help` for the full flag list.

See [references.md](references.md) for natural-language-to-command mappings.
