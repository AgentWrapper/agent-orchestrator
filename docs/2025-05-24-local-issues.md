# Local Issue Tracker Plugin (`tracker-local`)

**Date:** 2025-05-24
**Branch:** `feat/local-issues`
**Commit:** `4e36dcec`

## Problem

Users wanted to create and manage issues without depending on GitHub Issues,
Linear, GitLab, or any external service. The `Tracker` plugin interface already
existed but had no local-only implementation.

## Architecture

A new built-in plugin (`@aoagents/ao-plugin-tracker-local`) implements the
`Tracker` interface from `packages/core/src/types.ts:713`. It stores issues as
individual JSON files on disk — no database, no external API calls.

### Storage

- **Directory:** `.ao/issues/` inside the project path (gitignored by convention)
- **Format:** One JSON file per issue: `.ao/issues/<id>.json`
- **File contents:** Full `Issue` shape (`id`, `title`, `description`, `url`,
  `state`, `labels`, `assignee`, `priority`)
- **IDs:** Sequential prefixed IDs — `LOCAL-1`, `LOCAL-2`, … (prefix
  configurable via `issuePrefix` in config)
- **ID generation:** Scans the directory for existing IDs matching the prefix and
  picks `max + 1`. Safe under concurrent access (no single counter file).
- **Writes:** Uses `atomicWriteFileSync` from `@aoagents/ao-core` (write to temp
  file, then atomic rename) to prevent torn data.

### Dashboard enrichment pipeline

The dashboard enrichment chain in `packages/web/src/lib/serialize.ts` assumes
issue URLs are `http://` or `https://`. The `isAbsoluteUrl` check at line 36
uses `new URL(value)` and verifies `protocol === "http:" || protocol === "https:"`.

For local issues, `issueUrl()` returns `http://local/<id>` (e.g.,
`http://local/LOCAL-1`). This passes the `isAbsoluteUrl` check, which enables
the full enrichment pipeline:

1. `enrichSessionIssue` — sets `issueUrl` and `issueLabel`
2. `enrichSessionIssueTitle` — calls `getIssue()` to fetch the title

The `http://local/` host does not resolve (DNS error), but the label and title
display correctly in the dashboard session card.

### Design decisions from second review

| Decision | Rationale |
|---|---|
| Individual files, not a monolithic index | No single-file corruption; concurrent safe |
| Prefixed IDs (`LOCAL-N`) | Avoids collision with GitHub/Linear IDs |
| `http://local/` URL scheme | Passes `isAbsoluteUrl` enrichment check |
| Opt-in via config, not default | Would break existing projects with no tracker config |
| `preflight` checks directory writable | Catches permission errors early |
| `.ao/issues/` under project path | Consistent with existing `.ao/` conventions |

## Files Created

| File | Lines | Purpose |
|---|---|---|
| `packages/plugins/tracker-local/package.json` | 48 | Plugin package manifest |
| `packages/plugins/tracker-local/tsconfig.json` | 8 | TypeScript config |
| `packages/plugins/tracker-local/src/index.ts` | 347 | Full `Tracker` implementation |
| `packages/plugins/tracker-local/test/index.test.ts` | 458 | 43 unit tests |

## Files Modified

| File | Change |
|---|---|
| `packages/core/src/plugin-registry.ts` | Added to `BUILTIN_PLUGINS` array (line 57) |
| `packages/web/package.json` | Added workspace dependency |
| `packages/web/src/lib/services.ts` | Added static import + `registry.register()` call |

## Tracker Interface Methods Implemented

| Method | Implementation |
|---|---|
| `getIssue(id, project)` | Reads `.ao/issues/<id>.json`, throws `"not found"` error |
| `isCompleted(id, project)` | Returns `true` if state is `"closed"` or `"cancelled"` |
| `issueUrl(id, project)` | Returns `http://local/<id>` (for enrichment pipeline) |
| `issueLabel(url, project)` | Extracts last path segment from URL |
| `branchName(id, project)` | Returns `feat/<id-lowercase>` |
| `generatePrompt(id, project)` | Formats title, description, labels, priority into prompt |
| `listIssues(filters, project)` | Reads all `.json` files, applies state/label/assignee/limit filters |
| `updateIssue(id, update, project)` | Reads file, applies state/label/assignee/comment changes, writes back |
| `createIssue(input, project)` | Scans for next ID, writes new JSON file |
| `preflight(context)` | Verifies storage directory exists and is writable |

## Usage

```yaml
# agent-orchestrator.yaml
projects:
  my-project:
    name: My Project
    path: /path/to/project
    tracker:
      plugin: local
      # Optional:
      storageDir: .ao/issues   # default
      issuePrefix: LOCAL        # default
```

### Creating an issue

```bash
curl -X POST http://localhost:3000/api/issues \
  -H 'Content-Type: application/json' \
  -d '{
    "projectId": "my-project",
    "title": "Fix login bug",
    "description": "Users cannot log in with SSO",
    "addToBacklog": true
  }'
```

### Spawning a session on a local issue

```bash
curl -X POST http://localhost:3000/api/spawn \
  -H 'Content-Type: application/json' \
  -d '{
    "projectId": "my-project",
    "issueId": "LOCAL-1"
  }'
```

## Verification

- Build: `pnpm --filter @aoagents/ao-plugin-tracker-local run build` ✅
- Typecheck: `pnpm --filter @aoagents/ao-plugin-tracker-local run typecheck` ✅
- Tests: `pnpm --filter @aoagents/ao-plugin-tracker-local run test` — **43/43 pass** ✅
- E2E: Node.js module test verifying all Tracker methods ✅
