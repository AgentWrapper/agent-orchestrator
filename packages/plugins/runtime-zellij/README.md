# @aoagents/ao-plugin-runtime-zellij

Runtime plugin for executing agent sessions in Zellij.

## What This Does

Creates one detached Zellij session per AO session and runs the agent in a named pane.

## Requirements

- Zellij must be installed and available on `PATH`
- macOS or Linux

## Configuration

```yaml
defaults:
  runtime: zellij
  agent: codex
  workspace: worktree
```

## How It Works

Creating a session:

1. Validates `sessionId` with the same safe character set as the tmux runtime.
2. Maps long AO session IDs to short deterministic Zellij session names when needed.
3. Creates a detached Zellij session with `zellij attach --create-background <session>`.
4. Writes a temporary launch script containing environment exports and the launch command.
5. Starts the launch script in a named Zellij pane with `zellij --session <session> run`.
6. Returns a handle containing the session name and pane ID.

Sending a message:

1. Sends `Ctrl u` to clear partial input.
2. Pastes the message into the agent pane with `zellij action paste`.
3. Sends `Enter`.

Capturing output:

Uses `zellij action dump-screen --full --pane-id <pane>`.

Destroying:

Kills the Zellij session with `zellij kill-session <session>`.

## Attaching

```bash
zellij attach <session-id>
```

For long AO session IDs, use the `getAttachInfo()` command because the runtime stores a shorter Zellij session name in the handle.

## Limitations

- Zellij does not currently expose tmux-style per-command environment flags, so the runtime writes environment variables into a temporary launch script.
- `getOutput()` depends on Zellij scrollback availability.
