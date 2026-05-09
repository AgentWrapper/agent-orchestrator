# @agent-orchestrator/plugin-runtime-tmux

Runtime plugin for executing agent sessions in tmux.

## What This Does

Creates isolated tmux sessions for each agent. Each session runs in a separate tmux session with:

- Working directory set to workspace path
- Environment variables from config
- Agent launch command executed automatically

## How It Works

### Creating a Session

```typescript
const handle = await runtime.create({
  sessionId: "my-app-3",
  workspacePath: "/Users/dev/.worktrees/my-app/my-app-3",
  launchCommand: "claude -p 'Fix bug in auth module'",
  environment: {
    AO_SESSION_ID: "my-app-3",
    AO_PROJECT_ID: "my-app",
  },
});
```

**What happens:**

1. Validates `sessionId` (only alphanumeric, dash, underscore allowed)
2. Creates detached tmux session: `tmux new-session -d -s my-app-3 -c /path/to/workspace`
3. Sets environment variables: `tmux ... -e KEY=VALUE`
4. Sends launch command: `tmux send-keys -t my-app-3 "claude -p '...'" Enter`
5. Returns RuntimeHandle with tmux session name

### Sending Messages

```typescript
await runtime.sendMessage(handle, "Fix the test failure in auth.test.ts");
```

**What happens:**

1. Clears partial input: `tmux send-keys -t my-app-3 C-u`
2. For short messages (<200 chars, no newlines): sends directly with `-l` flag (literal mode)
3. For long/multiline messages: writes to temp file → `tmux load-buffer` → `tmux paste-buffer`
4. Waits 300ms (let tmux process the text)
5. Sends Enter: `tmux send-keys -t my-app-3 Enter`

**Why the complexity?**

- `send-keys` without `-l` interprets special strings ("Enter", "Space") as key names
- Long strings can overflow tmux's command buffer
- Multiline strings need special handling

### Getting Output

```typescript
const output = await runtime.getOutput(handle, 50); // last 50 lines
```

Uses `tmux capture-pane -t my-app-3 -p -S -50` to capture terminal buffer.

### Checking if Alive

```typescript
const alive = await runtime.isAlive(handle);
```

Uses `tmux has-session -t my-app-3` (exit code 0 = exists, 1 = doesn't exist).

### Destroying

```typescript
await runtime.destroy(handle);
```

Kills tmux session: `tmux kill-session -t my-app-3` (ignores errors if already dead).

## Attaching to Sessions

For Terminal plugins (iTerm2, web):

```typescript
const attachInfo = await runtime.getAttachInfo(handle);
// Returns: { type: "tmux", target: "my-app-3", command: "tmux attach -t my-app-3" }
```

## Security

**Session ID validation:**

```typescript
const SAFE_SESSION_ID = /^[a-zA-Z0-9_-]+$/;
```

Only allows safe characters. Prevents shell injection via session name (used in tmux commands).

## Error Handling

- **Session creation fails** → cleans up (kills session) before throwing
- **Message send fails** → throws (caller should handle)
- **Session already dead** → `destroy()` silently succeeds (idempotent)

## Metrics

```typescript
const metrics = await runtime.getMetrics(handle);
// Returns: { uptimeMs: 123456 }
```

Tracks uptime (stored in RuntimeHandle.data.createdAt).

## Testing

This plugin is tested indirectly via `packages/core/src/__tests__/tmux.test.ts` (utility functions) and integration tests.

To test manually:

```bash
# Start a test session
tmux new-session -d -s test-session -c /tmp
tmux send-keys -t test-session "echo hello" Enter

# Capture output
tmux capture-pane -t test-session -p

# Kill session
tmux kill-session -t test-session
```

## Common Issues

### tmux not installed

If tmux is not in PATH, all operations fail. Install via:

- macOS: `brew install tmux`
- Linux: `apt-get install tmux` or `yum install tmux`

### Session name conflicts

If a session with the same ID already exists, `create()` fails. The orchestrator should ensure unique session IDs.

### Detached sessions persist after orchestrator crashes

tmux sessions keep running even if the orchestrator dies. Use `tmux list-sessions` to find orphans, `tmux kill-session -t <name>` to clean up.

## Limitations

- **macOS/Linux only** — tmux is not available natively on Windows. On Windows, use the `runtime-process` plugin (the default there); it provides native PTY support via ConPTY and `node-pty`. WSL is not required.
- **Terminal buffer size** — `getOutput()` limited by tmux buffer size (default 2000 lines)
- **No resource limits** — agents can consume unlimited CPU/memory (use docker/k8s runtimes for isolation)

## Architecture Notes

**Why tmux over raw processes?**

- Sessions persist across orchestrator restarts
- Easy to attach for debugging: `tmux attach -t session-name`
- Terminal emulation (colors, ANSI codes work)
- Works well with interactive AI tools (Claude Code, Aider)

**Why detached mode?**

- Orchestrator doesn't block waiting for agent
- Multiple agents can run in parallel
- Humans can attach later without interrupting agent
