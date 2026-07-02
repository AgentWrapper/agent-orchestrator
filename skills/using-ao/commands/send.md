# ao send

Send a message to a running agent session. Use this to correct or direct a live agent mid-stream without killing and respawning it.

## Syntax

```
ao send [flags]
```

## Flags

| Flag | Meaning | Default / Required |
|---|---|---|
| `--message string` | Message body | Required |
| `--session string` | Session id | Required |

## Examples

```bash
# Send a correction to a running session
ao send --session mer-3 --message "Focus only on the backend; ignore frontend files."
```

```bash
# Give the agent new instructions mid-task
ao send --session mer-3 --message "The issue is in session_manager.go line 142, not in the CLI. Investigate there."
```
