# Storage Versions

AgentMesh has evolved through multiple storage architectures. This document explains the differences between V1 (hash-based) and V2 (projects-based) storage layouts.

## Current Version: V2 (Projects-Based)

The current storage layout uses a clean `projects/{projectId}/` structure with JSON metadata files.

### V2 Directory Structure

```
~/.agent-orchestrator/
├── projects/                          # All projects organized by ID
│   ├── my-app/                        # Project-specific directory
│   │   ├── sessions/                  # Session metadata (JSON files)
│   │   │   ├── app-1.json            # Session metadata
│   │   │   ├── app-2.json
│   │   │   └── archive/              # Archived sessions (optional)
│   │   ├── worktrees/                 # Git worktrees
│   │   │   ├── app-1/                 # Worktree for session app-1
│   │   │   └── app-2/
│   │   └── feedback-reports/          # QA feedback reports
│   │       ├── report_123.kv
│   │       └── report_456.kv
│   ├── another-project/
│   │   └── ...
│   └── config.yaml                    # Global config (all registered projects)
├── running.json                       # Current ao start state
├── last-stop.json                     # Last stop state (for session restore)
└── bin/                               # Agent PATH wrappers
```

### V2 Metadata Format

Session metadata is stored as JSON files:

```json
{
  "id": "app-1",
  "projectId": "my-app",
  "status": "working",
  "activity": "active",
  "branch": "feat/new-feature",
  "issueId": "ISSUE-123",
  "workspacePath": "/home/user/.agent-orchestrator/projects/my-app/worktrees/app-1",
  "createdAt": "2026-06-16T20:00:00.000Z",
  "startedAt": "2026-06-16T20:00:05.000Z",
  "lastActivityAt": "2026-06-16T20:15:30.000Z",
  "attentionLevel": "normal",
  "metadata": {
    "parentSessionId": "app-0",
    "role": "builder"
  },
  "lifecycle": {
    "version": 2,
    "session": {
      "kind": "worker",
      "state": "working",
      "reason": null
    },
    "runtime": {
      "state": "running",
      "reason": null
    },
    "pr": {
      "state": "unknown"
    }
  }
}
```

### V2 Benefits

- **Clean organization**: All project data under `projects/{projectId}/`
- **JSON metadata**: Structured, parseable, supports complex nested data
- **No hash prefixes**: Direct project IDs in directory names
- **Better tooling**: JSON files are easier to read and manipulate
- **Archive handling**: Terminated sessions stay in place with `state: "terminated"`
- **Cross-platform**: Consistent path handling across macOS, Linux, Windows

## Previous Version: V1 (Hash-Based)

The previous storage layout used hash-based directory names with key=value metadata files.

### V1 Directory Structure

```
~/.agent-orchestrator/
├── a3b4c5d6e7f8-my-app/              # Hash + project ID
│   ├── .origin                        # Config path for collision detection
│   ├── sessions/                      # Session metadata (key=value files)
│   │   ├── app-1                      # Key=value metadata
│   │   ├── app-2
│   │   └── archive/                   # Archived sessions
│   │       ├── app-3_20260420T100000Z
│   │       └── app-4_20260419T160000Z
│   └── worktrees/                     # Git worktrees
│       ├── app-1/
│       └── app-2/
├── f9e8d7c6b5a4-another-project/
│   └── ...
├── config.yaml                        # Global config
├── running.json
└── last-stop.json
```

### V1 Metadata Format

Session metadata was stored as key=value files:

```
project=my-app
agent=claude-code
branch=feat/new-feature
issueId=ISSUE-123
workspacePath=/home/user/.agent-orchestrator/a3b4c5d6e7f8-my-app/worktrees/app-1
createdAt=2026-06-16T20:00:00.000Z
startedAt=2026-06-16T20:00:05.000Z
lastActivityAt=2026-06-16T20:15:30.000Z
statePayload={"version":2,"session":{"kind":"worker","state":"working"},"runtime":{"state":"running"},"pr":{"state":"unknown"}}
stateVersion=2
```

### V1 Hash Generation

The hash was the first 12 characters of `SHA256(realpath(dirname(configPath)))`:

```typescript
// Config at: ~/projects/acme/agent-orchestrator.yaml
// Hash of:   /Users/you/projects/acme
// Result:    a3b4c5d6e7f8
// Final path: ~/.agent-orchestrator/a3b4c5d6e7f8-my-app/
```

### V1 Archive Handling

Terminated sessions were moved to `sessions/archive/{sessionId}_{timestamp}`:

```
sessions/
├── app-1              # Active session
├── app-2              # Active session
└── archive/
    ├── app-3_20260420T100000Z    # Terminated session
    └── app-4_20260419T160000Z    # Terminated session
```

## Migration from V1 to V2

The migration is handled automatically by the `migrateStorage()` function in `packages/core/src/migration/storage-v2.ts`.

### Migration Process

1. **Detection**: Detects V1 hash-based directories using regex `/^([0-9a-f]{12})-(.+)$/`
2. **Backup**: Renames old directories to `{hash}-{projectId}.migrated`
3. **Conversion**: Converts key=value metadata to JSON format
4. **Flattening**: Moves archived sessions from `sessions/archive/` to `sessions/` with `state: "terminated"`
5. **Worktree migration**: Moves worktrees to new paths
6. **Global config**: Creates `projects/config.yaml` with all registered projects

### Manual Migration

If automatic migration fails, you can manually migrate:

```bash
# 1. Stop all sessions
ao stop

# 2. Backup old data
cp -r ~/.agent-orchestrator ~/.agent-orchestrator-backup

# 3. Run migration script
node packages/core/dist/migration/storage-v2.js

# 4. Verify new structure
ls -la ~/.agent-orchestrator/projects/

# 5. Start fresh
ao start
```

### Rollback

If you need to rollback to V1:

```bash
# 1. Stop all sessions
ao stop

# 2. Remove V2 directories
rm -rf ~/.agent-orchestrator/projects/

# 3. Restore V1 directories
mv ~/.agent-orchestrator/*.migrated ~/.agent-orchestrator/
for dir in ~/.agent-orchestrator/*.migrated; do
  mv "$dir" "${dir%.migrated}"
done

# 4. Restore archive structure (if needed)
# You'll need to manually move terminated sessions back to archive/

# 5. Use old code version
git checkout <commit-before-v2-migration>
pnpm install && pnpm build
```

## Key Differences Summary

| Aspect               | V1 (Hash-Based)               | V2 (Projects-Based)                 |
| -------------------- | ----------------------------- | ----------------------------------- |
| **Directory naming** | `{12-hex}-{projectId}`        | `projects/{projectId}`              |
| **Metadata format**  | Key=value files               | JSON files                          |
| **Archive handling** | Separate `archive/` directory | In-place with `state: "terminated"` |
| **Path complexity**  | Hash prefixes required        | Direct project IDs                  |
| **Tooling support**  | Manual parsing needed         | Standard JSON tools                 |
| **Cross-platform**   | Hash generation issues        | Consistent paths                    |
| **Migration**        | Manual required               | Automatic migration available       |

## Compatibility

### Code Compatibility

- **V1 path functions**: Deprecated but available for migration only
- **V2 path functions**: Current standard, use these in new code
- **Legacy support**: V1 paths are detected and migrated automatically

### Session Compatibility

- **V1 sessions**: Cannot be used with V2 code without migration
- **V2 sessions**: Cannot be used with V1 code
- **Migration**: One-way process (V1 → V2), no rollback in production

### Plugin Compatibility

- **Plugins using path utilities**: Must use V2 functions
- **Plugins with hardcoded paths**: Will break with V2
- **Migration**: Update plugins to use `getProjectDir()`, `getProjectSessionsDir()`, etc.

## Best Practices

### For New Code

```typescript
// ✅ Use V2 path functions
import { getProjectDir, getProjectSessionsDir } from "@aoagents/ao-core";

const projectDir = getProjectDir(projectId);
const sessionsDir = getProjectSessionsDir(projectId);

// ❌ Don't use legacy hash functions
import { generateConfigHash, legacyProjectHash } from "@aoagents/ao-core";
```

### For Migration Scripts

```typescript
// ✅ Use the migration utility
import { migrateStorage } from "@aoagents/ao-core";

await migrateStorage(basePath);

// ❌ Don't manually copy files
```

### For Plugins

```typescript
// ✅ Use config-based paths
const workspacePath = config.worktreeDir || getProjectWorktreesDir(projectId);

// ❌ Don't hardcode paths
const workspacePath = "~/.agent-orchestrator/a3b4c5d6e7f8-my-app/worktrees/app-1";
```

## Troubleshooting

### Migration Fails

1. Check for file locks: `lsof ~/.agent-orchestrator/`
2. Stop all sessions: `ao stop`
3. Check disk space: `df -h ~/.agent-orchestrator/`
4. Review migration logs in terminal output

### Mixed V1/V2 State

If you see both hash-based and projects-based directories:

```bash
# Identify which is which
ls -la ~/.agent-orchestrator/

# Hash-based: a3b4c5d6e7f8-my-app/
# Projects-based: projects/my-app/

# Decide which to keep (usually V2)
# Remove V1 directories after verifying V2 works
rm -rf ~/.agent-orchestrator/[0-9a-f]*-*/
```

### Session Not Found After Migration

1. Check session ID format (V1 used hash prefixes in tmux)
2. Verify session file exists: `ls ~/.agent-orchestrator/projects/{projectId}/sessions/`
3. Check metadata format (should be JSON, not key=value)
4. Review migration logs for errors

## References

- Migration code: `packages/core/src/migration/storage-v2.ts`
- Migration tests: `packages/core/src/__tests__/migration-storage-v2.test.ts`
- Path utilities: `packages/core/src/paths.ts`
- Original migration guide: `changelog/hash-based-architecture-migration.md`
