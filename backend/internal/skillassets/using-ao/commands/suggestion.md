# ao suggestion

Keep project ideas that matter to the grand workflow but should not interrupt current implementation. Suggestions remain in a project backlog until an orchestrator or user starts one with a dedicated worker.

## Commands

```bash
ao suggestion ls --project <project> [--json]
ao suggestion add --project <project> --title "<short title>" [--note "<context>"] [--priority later|normal|important]
ao suggestion start <suggestion-id> --project <project> [--json]
ao suggestion done <suggestion-id> --project <project>
ao suggestion dismiss <suggestion-id> --project <project>
```

Use `add` for non-blocking architecture, product, research, or workflow observations. Use `start` only when worker capacity is available; it creates a dedicated worker with framing that the suggestion is not a current blocker. Mark an item `done` after its recommendation or scoped improvement is complete, or `dismissed` when it no longer fits the broader plan.
