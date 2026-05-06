# Migration Guide: Hash-Based Architecture

**Date**: 2026-02-17
**Breaking Change**: Yes
**Affects**: All users with existing sessions

## What Changed

Agent Orchestrator has migrated from flat, configurable directories (`dataDir` and `worktreeDir`) to a **hash-based project isolation** architecture. This change eliminates configuration overhead and prevents collisions when running multiple orchestrator instances from different directories.

### Before (Flat Architecture)

```yaml
# agent-orchestrator.yaml
dataDir: ~/.ao-sessions
worktreeDir: ~/.ao-worktrees

projects:
  my-app:
    path: ~/repos/my-app
```

**Problems**:

- Multiple configs sharing same `dataDir` caused session collisions
- Manual path configuration required
- No isolation between orchestrator instances
- Backwards compatibility code added complexity

### After (Hash-Based Architecture)

```yaml
# agent-orchestrator.yaml
# No dataDir or worktreeDir needed!

projects:
  my-app:
    path: ~/repos/my-app
```

**Benefits**:

- Zero configuration — paths auto-derived from config location
- Complete isolation — each config gets unique namespace
- Collision-free — SHA256 hash prevents conflicts
- Clean codebase — no backwards compatibility code

## Architecture Details

### Directory Structure

All orchestrator data now lives under `~/.agent-orchestrator/`:

```
~/.agent-orchestrator/
├── {hash}-{projectId}/        # Unique per config+project
│   ├── .origin                # Stores config path (collision detection)
│   ├── sessions/              # Session metadata
│   │   ├── int-1              # Metadata for session int-1
│   │   ├── int-2
│   │   └── archive/           # Archived metadata
│   └── worktrees/             # Git worktrees
│       ├── int-1/             # Worktree for session int-1
│       └── int-2/
```

### Hash Generation

The hash is the first 12 characters of `SHA256(realpath(dirname(configPath)))`:

```typescript
// Config at: ~/projects/acme/agent-orchestrator.yaml
// Hash of:   /Users/you/projects/acme
// Result:    a3b4c5d6e7f8

// Final path: ~/.agent-orchestrator/a3b4c5d6e7f8-my-app/
```

**Why 12 chars?** Balance between uniqueness (collision probability ~1 in 16 billion) and path length.

### Session Naming Layers

Three levels of naming for compatibility:

1. **User-facing**: `int-1`, `ao-42` (short, clean)
2. **Tmux**: `a3b4c5d6e7f8-int-1` (globally unique across all configs)
3. **Metadata file**: `int-1` (within project-specific `sessions/` directory)

## Breaking Changes

### 1. Config File Changes

**REMOVED fields** (will cause validation errors if present):

- `dataDir`
- `worktreeDir`

**REQUIRED field**:

- `configPath` (automatically set by `loadConfig()`)

**Migration**:

```diff
# agent-orchestrator.yaml
- dataDir: ~/.ao-sessions
- worktreeDir: ~/.ao-worktrees

projects:
  my-app:
    path: ~/repos/my-app
```

### 2. Metadata File Locations

**Before**:

```
~/.ao-sessions/
├── int-1          # Flat directory, all projects mixed
├── int-2
├── ao-1
└── ao-2
```

**After**:

```
~/.agent-orchestrator/
├── a3b4c5d6e7f8-integrator/sessions/
│   ├── int-1      # Integrator project sessions
│   └── int-2
└── f9e8d7c6b5a4-my-app/sessions/
    ├── ao-1       # My-app project sessions
    └── ao-2
```

**Impact**: Existing metadata files **will not be automatically migrated**. See migration steps below.

### 3. Worktree Locations

**Before**:

```
~/.ao-worktrees/
├── integrator/
│   ├── int-1
│   └── int-2
└── my-app/
    ├── ao-1
    └── ao-2
```

**After**:

```
~/.agent-orchestrator/
├── a3b4c5d6e7f8-integrator/worktrees/
│   ├── int-1
│   └── int-2
└── f9e8d7c6b5a4-my-app/worktrees/
    ├── ao-1
    └── ao-2
```

**Impact**: Existing worktrees **will not be automatically migrated**. Git will report them as "missing" and they must be manually removed.

### 4. Environment Variables

**Before**:

```bash
AO_DATA_DIR=~/.ao-sessions          # Flat path
```

**After**:

```bash
AO_DATA_DIR=~/.agent-orchestrator/a3b4c5d6e7f8-integrator/sessions/
```

**Impact**: Scripts or hooks relying on `AO_DATA_DIR` pointing to a flat directory will break.

### 5. API Changes (For Plugin Developers)

**Removed from `OrchestratorConfig`**:

```typescript
interface OrchestratorConfig {
  dataDir: string; // REMOVED
  worktreeDir: string; // REMOVED
  configPath: string; // NOW REQUIRED
}
```

**New Path Utilities** (use these instead):

```typescript
import {
  getSessionsDir,
  getWorktreesDir,
  getProjectBaseDir,
  generateConfigHash,
  generateInstanceId,
  validateAndStoreOrigin,
} from "@aoagents/ao-core";

// Calculate paths dynamically
const sessionsDir = getSessionsDir(configPath, projectPath);
const worktreesDir = getWorktreesDir(configPath, projectPath);
```

## Migration Steps

### Step 1: Clean Up Config File

Remove `dataDir` and `worktreeDir` from your config:

```bash
# Edit your agent-orchestrator.yaml
vim ~/path/to/agent-orchestrator.yaml
```

Remove these lines:

```yaml
dataDir: ~/.ao-sessions
worktreeDir: ~/.ao-worktrees
```

### Step 2: Kill Existing Sessions

**IMPORTANT**: Existing sessions will **not** automatically migrate. You must kill them first.

```bash
# List all tmux sessions
tmux ls

# Kill all orchestrator sessions (adjust prefix as needed)
tmux ls | grep -E '^(int|ao|app)-[0-9]+:' | cut -d: -f1 | xargs -I{} tmux kill-session -t {}

# Or kill all tmux sessions (nuclear option)
tmux kill-server
```

### Step 3: Clean Up Old Directories

**Worktrees** must be removed from git:

```bash
# For each project, remove old worktrees
cd ~/repos/integrator

# List worktrees
git worktree list

# Remove each old worktree
git worktree remove ~/.ao-worktrees/integrator/int-1 --force
git worktree remove ~/.ao-worktrees/integrator/int-2 --force
# ... repeat for all

# Prune stale references
git worktree prune
```

**Metadata** can be archived for reference:

```bash
# Archive old metadata (optional)
mv ~/.ao-sessions ~/.ao-sessions-backup-$(date +%Y%m%d)

# Or delete if you don't need it
rm -rf ~/.ao-sessions
```

**Worktree directory** can be removed after cleaning up git references:

```bash
# Remove old worktree directory (after git worktree remove)
rm -rf ~/.ao-worktrees
```

### Step 4: Update to Latest Version

```bash
# Pull latest code
git pull origin main

# Reinstall dependencies
pnpm install

# Rebuild packages
pnpm build
```

### Step 5: Start Fresh

```bash
# Start orchestrator (creates new directory structure)
ao start

# Spawn new sessions (uses hash-based paths)
ao spawn my-app INT-1234
```

### Step 6: Verify New Structure

```bash
# Check that new directories were created
ls -la ~/.agent-orchestrator/

# You should see directories like:
# a3b4c5d6e7f8-my-app/
#   .origin
#   sessions/
#   worktrees/

# Check tmux sessions have hash prefix
tmux ls
# Should show: a3b4c5d6e7f8-int-1, a3b4c5d6e7f8-int-2, etc.
```

## Rollback (If Needed)

If you need to rollback to the old architecture:

1. **Checkout previous commit** (before hash-based migration):

   ```bash
   git checkout <commit-before-migration>
   pnpm install
   pnpm build
   ```

2. **Restore old config**:

   ```bash
   # Add back to agent-orchestrator.yaml
   dataDir: ~/.ao-sessions
   worktreeDir: ~/.ao-worktrees
   ```

3. **Restore old metadata** (if archived):

   ```bash
   mv ~/.ao-sessions-backup-20260217 ~/.ao-sessions
   ```

4. **Kill new hash-based sessions**:
   ```bash
   tmux ls | grep -E '^[a-f0-9]{12}-' | cut -d: -f1 | xargs -I{} tmux kill-session -t {}
   ```

## FAQ

### Q: Why can't I use my old sessions?

**A**: The metadata file structure changed. Old sessions point to flat directories (`~/.ao-sessions/int-1`) but the new code expects hash-based paths (`~/.agent-orchestrator/a3b4c5d6e7f8-integrator/sessions/int-1`). You must kill old sessions and spawn new ones.

### Q: Will my PRs be lost?

**A**: No! PRs are on GitHub, not in local sessions. You can:

1. Check `gh pr list` to see all open PRs
2. Spawn new sessions for PRs that need work: `ao spawn integrator --branch feat/existing-branch`

### Q: What about in-progress work?

**A**: Git worktrees contain your code changes. Before killing sessions:

1. Commit or stash changes in each worktree
2. Note which issues/branches were being worked on
3. After migration, spawn new sessions and continue work

### Q: Can I migrate metadata files manually?

**A**: Yes, but **not recommended**. The manual process:

```bash
# For each project
OLD_DIR=~/.ao-sessions
NEW_DIR=~/.agent-orchestrator/$(python3 -c "import hashlib; print(hashlib.sha256(b'/Users/you/path/to/config/dir').hexdigest()[:12])")-integrator/sessions

mkdir -p "$NEW_DIR"

# Copy metadata files
cp "$OLD_DIR"/int-* "$NEW_DIR/"

# Update worktree paths in each file (required!)
for file in "$NEW_DIR"/*; do
  sed -i '' 's|worktree=~/.ao-worktrees/integrator/|worktree=~/.agent-orchestrator/HASH-integrator/worktrees/|g' "$file"
done
```

This is error-prone. **Recommended**: Kill old sessions and spawn fresh ones.

### Q: What happens if I have multiple config files?

**A**: Each config gets a unique hash! This is the **main benefit** of the new architecture:

```bash
# Config 1: ~/projects/acme/agent-orchestrator.yaml
# Hash: a3b4c5d6e7f8
# Sessions: ~/.agent-orchestrator/a3b4c5d6e7f8-my-app/

# Config 2: ~/experiments/test/agent-orchestrator.yaml
# Hash: 1f2e3d4c5b6a
# Sessions: ~/.agent-orchestrator/1f2e3d4c5b6a-my-app/
```

No conflicts, complete isolation!

### Q: How do I find the hash for my config?

**A**:

```bash
# Calculate hash for your config directory
echo -n "/path/to/your/config/dir" | sha256sum | cut -c1-12

# Or let ao print it
ao status
# Output shows: Config: /path/to/config.yaml
# Hash will be in directory names: ~/.agent-orchestrator/{hash}-{project}/
```

### Q: What if two configs have the same hash (collision)?

**A**: The `.origin` file detects this and throws an error with instructions:

```
Hash collision detected!
Directory: ~/.agent-orchestrator/a3b4c5d6e7f8-my-app
Expected config: /Users/you/config1/agent-orchestrator.yaml
Actual config: /Users/you/config2/agent-orchestrator.yaml
This is a rare hash collision. Please move one of the configs to a different directory.
```

**Solution**: Move one config to a different directory. Collision probability is ~1 in 16 billion with 12-character hashes.

## Support

If you encounter issues during migration:

1. Check existing sessions: `tmux ls`
2. Check new directory structure: `ls -la ~/.agent-orchestrator/`
3. Check config validation: `ao status`
4. Review git worktrees: `git worktree list` (from project directory)
5. Check logs: `journalctl -u ao-orchestrator` or tmux session output

For bugs or questions, file an issue: https://github.com/composiohq/agent-orchestrator/issues

## Summary

**Action Required**:

1. ✅ Remove `dataDir` and `worktreeDir` from config
2. ✅ Kill all existing sessions (`tmux kill-server`)
3. ✅ Clean up old git worktrees (`git worktree remove --force`)
4. ✅ Remove old directories (`~/.ao-sessions`, `~/.ao-worktrees`)
5. ✅ Update to latest version (`pnpm install && pnpm build`)
6. ✅ Start fresh (`ao start`, `ao spawn`)

**Expected Downtime**: ~10 minutes (time to kill sessions, clean worktrees, respawn)

**Risk Level**: Low (PRs are safe, code is in git, only local sessions affected)

**Benefit**: Cleaner architecture, zero config, collision-free multi-instance support
