# Backup and restore AO state (`~/.ao`)

## Reinstall does not wipe projects

All durable app state lives under `~/.ao` (overridable via `AO_RUN_FILE` /
`AO_DATA_DIR`), **outside** the desktop install directory. Uninstalling or
reinstalling the app binary removes only the program files (for example
`D:\e\agent-orchestrator` or `%LOCALAPPDATA%\Programs\Agent Orchestrator`).

On the next launch, the app and daemon reopen the existing `~/.ao` tree —
including `data/ao.db` (projects, sessions, PRs), settings, and worktrees —
without any backup step.

| Action | What happens to projects |
| ------ | ------------------------ |
| Uninstall desktop app | **Kept** under `~/.ao` |
| Reinstall / open a new build | **Kept**; same `~/.ao` is reopened |
| Delete `~/.ao` yourself | **Lost** (use backup first) |
| Move to another machine | Use `ao backup` (below) |

Do **not** treat `ao backup` as a required step for ordinary reinstall. Manual
backup is an advanced recovery tool.

## When to use `ao backup`

Use `ao backup` when you need durable AO data to survive:

- **Machine migration** (new laptop / new user profile)
- **Disaster recovery** (disk failure, accidental `rm -rf ~/.ao`)
- **Intentional state reset** (you plan to delete `~/.ao` and may want it back)

This is distinct from `ao import`, which only ports the **legacy** flat-file
store (`~/.agent-orchestrator`).

The backup root is the directory that holds `running.json` (normally `~/.ao`).

## Quick recovery (migration or accidental wipe)

```bash
# 1. On the source machine (or before deleting ~/.ao): stop the daemon, then backup.
ao stop
ao backup create ~/ao-backup.zip

# 2. On the target machine: install the desktop app if needed.

# 3. Stop the daemon if it started, then restore.
ao stop
ao backup restore ~/ao-backup.zip --yes

# 4. Open the desktop app (or `ao start`).
```

Dry-run a restore without writing:

```bash
ao backup restore ~/ao-backup.zip --dry-run
```

## Commands

| Command | Purpose |
| ------- | ------- |
| `ao backup create [path]` | Write a zip of durable state. Default path: `ao-backup-YYYYMMDD-HHMMSS.zip` in the current directory. Fails if the path already exists. |
| `ao backup restore <path>` | Restore from a zip produced by `create`. |
| `ao backup restore <path> --dry-run` | Validate and report planned replaces only. |
| `ao backup create\|restore --json` | Machine-readable report. |

Both create and restore **refuse while the daemon is running**. Stop it first
with `ao stop` so SQLite (`ao.db` + WAL) and other on-disk state are consistent.

## What is included

Everything under the state directory **except** the excludes below, including:

| Path | Role |
| ---- | ---- |
| `app-state.json` | Desktop install marker (path/version/migration). |
| `ui-settings.json` | UI preferences. |
| `update-settings.json` | Update channel preferences. |
| `data/ao.db`, `ao.db-wal`, `ao.db-shm` | Projects, sessions, PRs, notifications, and other SQLite state. |
| `data/worktrees/` | Session git worktrees and scratch workspaces. |
| `data/skills/` | Installed skills (e.g. using-ao). |
| `data/mobile/` | Connect Mobile config (when present under the data dir). |
| `data/scratch/`, `data/prompts/`, other `data/*` | Other durable daemon data. |

## What is excluded

| Path / pattern | Why |
| -------------- | --- |
| `running.json` | Live daemon handshake (PID/port); always ephemeral. |
| `windows-pty-hosts.json` | Live Windows PTY host registry. |
| `electron/` | Chromium `userData` (cache, cookies, renderer storage); large and regenerable. |
| `staging/` | Temporary download staging used by `ao start`. |
| `daemon.log` | Log file; not required for restore. |
| `*.tmp`, `*.lock`, `*.swp` | Locks and temps at any depth. |
| `.running-*`, `.app-state-*`, `.config-*` | Atomic-write scratch files. |
| `.ao-pre-restore-*`, `.ao-restore-staging-*` | Leftovers from a prior restore. |

After restore, any **local** ephemeral files that were not in the archive
(for example a new `running.json` or `electron/` tree) are left alone.

## Safety

- **Create** writes the zip via a temp file + rename. It never overwrites an
  existing archive path.
- **Restore** fully extracts into a temporary staging directory **before**
  modifying the state dir. If extraction fails, the state dir is untouched.
- When restore would overwrite durable top-level names (`data`,
  `app-state.json`, …), those items are moved first to
  `~/.ao/.ao-pre-restore-<timestamp>/`. The command prints that path on success.
- Archive entries with `..` or absolute paths are rejected (zip-slip).

## Installer / uninstaller guarantees (Windows)

The NSIS uninstaller removes only the application install directory. It does
**not** delete `~/.ao`. `deleteAppDataOnUninstall` is forced off, and the
installer include script documents that user data under `$PROFILE\.ao` is kept.

## Notes

- Restoring `app-state.json` may point `appPath` at a previous install location.
  If the desktop app fails to resolve itself, open the newly installed app once
  so it rewrites the marker, or remove only that field/file and relaunch.
- Worktrees are restored as on-disk directories. Dirty worktrees are never
  force-deleted by this flow; cleanup remains the normal session cleanup path.
- If `AO_DATA_DIR` is set **outside** the state directory (parent of
  `running.json`), this backup only covers the state directory tree. Keep the
  default layout (`~/.ao/data`) for a single-archive restore, or copy the
  external data dir separately.
- Install history beyond what already lives in `app-state.json` is not extended
  by this feature (possible follow-up).
- **Complete wipe:** only delete `~/.ao` when you intentionally want to erase
  all projects and sessions. Uninstalling the app alone is not enough and is
  not required for a clean reinstall of the binary.

## Related

- CLI overview: [cli/README.md](cli/README.md)
- Architecture / state rules: [architecture.md](architecture.md)
- Legacy store import: `ao import` (not a full `~/.ao` backup)
