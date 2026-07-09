---
name: wrapping-launchd-services
description: Use when setting up a script, dev server, or daemon to run persistently in the background on macOS - start at login, auto-restart on crash, simple start/stop/status without re-deriving launchctl flags each time. Also use when reviewing an existing launchd LaunchAgent/plist, when a background-service setup feels overbuilt for a personal dev machine, or when tempted to reach for cron @reboot, nohup, pm2, or systemd (doesn't exist) on macOS.
---

# Wrapping launchd Services

## Overview

launchd is macOS's only supported process supervisor. `cron @reboot` can't
restart on crash; `nohup`/`pm2`/`forever` either don't survive login or just
generate a launchd plist under the hood anyway. One plist (LaunchAgent) + one
thin wrapper script + one shell alias gets you "starts at login, restarts on
crash, dead-simple start/stop/status" — nothing more is needed for a personal
dev machine.

## When to Use

- A script/daemon needs to start at login and restart itself on crash.
- You want `myservice start|stop|status` instead of remembering `launchctl` flags.
- Reviewing/debugging an existing LaunchAgent that isn't starting or restarting.
- **Not this skill:** a service that must run before any user logs in (system-level, no GUI session) — that's a LaunchDaemon in `/Library/LaunchDaemons` targeting the `system` domain, owned by root. This skill covers per-user LaunchAgents.

## Core Pattern

**Plist** — `~/Library/LaunchAgents/com.example.myservice.plist`. Hardcode
absolute paths directly; don't template/sed-substitute for a single personal
machine.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.example.myservice</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/zsh</string>
        <string>-lc</string>
        <string>exec node "$HOME/myproject/daemon.js"</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/Users/you/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    </dict>
    <key>WorkingDirectory</key>
    <string>/Users/you/myproject</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/Users/you/myproject/service.out.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/you/myproject/service.err.log</string>
</dict>
</plist>
```

Pin `PATH` explicitly in `EnvironmentVariables` even though `-lc` already
re-sources `.zshrc` — see Common Mistakes for why you want both. Put the
actual start command directly in the `-lc` string (as above); only add a
separate run-wrapper script if startup genuinely needs more than one command.

**Wrapper script** — one file, handles every service in the project:

```zsh
#!/bin/zsh
# Start/stop/status for this project's launchd services. Reversible.
set -u
dom="gui/$(id -u)"
LA="$HOME/Library/LaunchAgents"
services=(com.example.myservice)   # add more labels here as needed
grep_key="example"                 # substring common to all labels above

case "${1:-status}" in
  down)
    for s in $services; do
      launchctl bootout "$dom/$s" 2>/dev/null && echo "down: $s" || echo "down: $s (not loaded)"
    done
    ;;
  up)
    for s in $services; do
      launchctl bootstrap "$dom" "$LA/$s.plist" 2>/dev/null && echo "up:   $s" || echo "up:   $s (already loaded / failed)"
    done
    ;;
  status)
    launchctl list | grep "$grep_key" || echo "(no jobs loaded)"
    ;;
  *)
    echo "usage: $0 {up|down|status}" >&2; exit 2
    ;;
esac
```

**Alias** — one line in `~/.zshrc`:

```sh
alias myservice="$HOME/bin/myservice-svc"
```

## Quick Reference

| Action                   | Command                                                                 |
| ------------------------ | ----------------------------------------------------------------------- |
| Start (register + run)   | `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/<label>.plist` |
| Stop (clean, no respawn) | `launchctl bootout gui/$(id -u)/<label>`                                |
| Restart a loaded job     | `launchctl kickstart -k gui/$(id -u)/<label>`                           |
| Check status             | `launchctl list \| grep <label-substring>`                              |

## Common Mistakes

| Mistake                                                           | Reality                                                                                                                                                                                                                                            |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `launchctl load -w` / `unload`                                    | Deprecated since 10.11. Use `bootstrap`/`bootout` targeting `gui/$(id -u)/<label>`.                                                                                                                                                                |
| Relying only on `zsh -lc` to fix `PATH`                           | Re-sourcing `.zshrc` on every restart is slow and fragile (interactive-only guards, slow rc files can break it silently). Pin `PATH` via `EnvironmentVariables` too — belt and suspenders.                                                         |
| Separate run.sh + control.sh + install.sh + uninstall.sh + README | Overbuilt for a personal dev machine. One ~20-line script with a `case` dispatch, looping over a `services=()` array, is enough. Hand-place the plist once; skip installer ceremony unless actually distributing this to other machines/users.     |
| Writing a run.sh just to hold one `exec` line                     | Unneeded — a single start command fits directly in the plist's `-lc "exec ..."` string. Only add a separate run script when startup needs more than one step (e.g. `cd` somewhere the plist's `WorkingDirectory` can't reach, or extra env setup). |
| `launchctl kickstart`/`enable` right after `bootstrap`            | Redundant — `bootstrap` + `RunAtLoad` already starts the job. Only reach for `kickstart -k` to force-restart an already-loaded job.                                                                                                                |
| Hand-parsing `launchctl list` PID/exit-status columns             | `launchctl list \| grep <label>` is enough for a personal tool; only parse columns if something downstream needs the exit code programmatically.                                                                                                   |
| LaunchDaemon for a personal dev tool                              | Needs root + `/Library/LaunchDaemons` + `sudo`. Use a LaunchAgent (`~/Library/LaunchAgents`, `gui/<uid>` domain) unless the job truly must run before any login.                                                                                   |
