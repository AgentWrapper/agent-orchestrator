## What

Brief description of what this PR changes.

## Why

Why is this change needed? Link the issue it addresses (e.g., Closes #NNN).

## How

How does this change work? Keep it concise but enough for a reviewer to understand the approach.

## Testing

- [ ] `cd backend && go build ./...` passes
- [ ] `cd backend && go test ./...` passes
- [ ] `cd frontend && npm run typecheck` passes (if frontend changes)
- [ ] Tests cover the new or changed behavior
- [ ] No unrelated changes or formatting churn

## Checklist

- [ ] Changes are surgical and focused on one concern
- [ ] Follows coding conventions in [AGENTS.md](../AGENTS.md)
- [ ] No changes to daemon bind host or auth (see AGENTS.md hard rules)
