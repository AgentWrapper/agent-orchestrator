# Final Architecture Plan

## Core Principles

1. **Convention over configuration** - Auto-derive everything possible
2. **Single source of truth** - Config file in repo, runtime data in `~/.agent-orchestrator/`
3. **Zero path configuration** - All paths determined automatically
4. **Global uniqueness** - Hash-based namespacing prevents collisions

---

## 1. Directory Structure

```
Repo (versioned):
~/any/path/to/agent-orchestrator/
  agent-orchestrator.yaml              ← Config file (only this matters)
  packages/
  ...

Runtime Data (not versioned):
~/.agent-orchestrator/                 ← Single parent directory
  a3b4c5d6e7f8-integrator/             ← {hash}-{projectId}
    sessions/
      int-1                            ← Session metadata files (no hash prefix)
      int-2
    worktrees/
      int-1/                           ← Git worktrees (no hash prefix)
      int-2/
    archive/
      int-3_2026-02-17T10-30-00
    .origin                            ← Config path reference

  a3b4c5d6e7f8-backend/                ← Same hash (same config!)
    sessions/
      be-1                             ← No hash prefix (already namespaced)
    worktrees/
      be-1/
    .origin
```

**Hash Derivation (from config location):**

```typescript
const configDir = path.dirname(configPath); // /Users/alice/code/agent-orchestrator
const hash = sha256(configDir).slice(0, 12); // a3b4c5d6e7f8

// Each project managed by this config gets a directory
// Format: {hash}-{projectId}
const projectId = path.basename(projectPath); // integrator, backend, etc.
const instanceId = `${hash}-${projectId}`; // a3b4c5d6e7f8-integrator

// Not configurable!
const projectBaseDir = `~/.agent-orchestrator/${instanceId}`;
const sessionsDir = `${projectBaseDir}/sessions`;
const worktreesDir = `${projectBaseDir}/worktrees`;
```

**Key insight:** All projects from the same config share the same hash prefix!

---

## 2. Config File (Minimal)

```yaml
# agent-orchestrator.yaml

projects:
  - path: ~/repos/integrator # Required: where is the repo?
    repo: ComposioHQ/integrator # Required: GitHub repo
    defaultBranch: next # Required: base branch

    # Optional overrides:
    name: Composio Integrator # Display name (default: folder name)
    sessionPrefix: int # Override auto-generated prefix
```

**Auto-derived:**

- Project ID: `basename(path)` → `integrator`
- Session prefix: `generatePrefix("integrator")` → `int`
- Worktree path: `{worktreeDir}/integrator/`

**That's it! No dataDir, no worktreeDir, no explicit IDs.**

---

## 3. Session Naming

### User-Facing Names (Elegant)

```
{sessionPrefix}-{num}

int-1, int-2    (integrator)
ao-1, ao-2      (agent-orchestrator)
ss-1, ss-2      (safe-split)
```

### Runtime Session Names (Globally Unique)

```
{hash}-{sessionPrefix}-{num}

a3b4c5d6e7f8-int-1
a3b4c5d6e7f8-ao-1
f1e2d3c4b5a6-int-1    (different checkout, no collision!)
```

On Unix this is the tmux session name. On Windows (where the default runtime is `process`, not `tmux`) the same string identifies the named pipe path `\\.\pipe\ao-pty-{sessionId}` and is recorded in `~/.agent-orchestrator/windows-pty-hosts.json`.

### Prefix Generation (Clean Heuristic)

```typescript
function generateSessionPrefix(projectId: string): string {
  if (projectId.length <= 4) return projectId.toLowerCase();

  // CamelCase: PyTorch → pt
  const uppercase = projectId.match(/[A-Z]/g);
  if (uppercase?.length > 1) {
    return uppercase.join("").toLowerCase();
  }

  // kebab-case: agent-orchestrator → ao
  if (projectId.includes("-") || projectId.includes("_")) {
    const sep = projectId.includes("-") ? "-" : "_";
    return projectId
      .split(sep)
      .map((w) => w[0])
      .join("")
      .toLowerCase();
  }

  // Single word: integrator → int
  return projectId.slice(0, 3).toLowerCase();
}
```

---

## 4. Metadata Storage

### File Structure (One Directory Per Project)

```
~/.agent-orchestrator/a3b4c5d6e7f8-integrator/
  sessions/
    int-1      ← Metadata file (user-facing session name)
    int-2
  worktrees/
    int-1/
    int-2/
  archive/
    int-3_2026-02-17T10-30-00
```

### Metadata File Format (key=value)

```
project=integrator
issue=INT-100
branch=feat/INT-100
status=working
tmuxName=a3b4c5d6e7f8-int-1            # Unix; on Windows the runtime handle is `pipePath=\\.\pipe\ao-pty-<sessionId>` plus `ptyHostPid`
worktree=/Users/alice/.agent-orchestrator/a3b4c5d6e7f8-integrator/worktrees/int-1
createdAt=2026-02-17T10:30:00Z
pr=https://github.com/ComposioHQ/integrator/pull/123
```

**Key fields:**

- `project` - Which project this session belongs to (for filtering)
- `issue` - Linear/GitHub issue ID
- `branch` - Git branch name
- `worktree` - Path to git worktree
- `status` - working/idle/pr_open/merged

---

## 5. User Commands (Simple)

```bash
# List all sessions
ao list

# List sessions for specific project
ao list integrator

# Spawn new session
ao spawn integrator INT-100

# Attach to session (orchestrator finds the runtime handle: tmux name on Unix, named pipe on Windows)
ao attach int-1

# Kill session
ao kill int-1

# Show instance info
ao info
```

**No config paths in commands! Everything auto-discovered.**

---

## 6. Multi-Instance Support

### Same Config → Same Hash

```yaml
# ~/code/my-orchestrator/agent-orchestrator.yaml
projects:
  - path: ~/repos/integrator
  - path: ~/repos/backend
```

Results in:

```
~/.agent-orchestrator/
  a3b4c5d6e7f8-integrator/        ← Same hash (same config)
  a3b4c5d6e7f8-backend/           ← Same hash (same config)
```

### Different Config Locations → Different Hashes

```
~/code/orchestrator/              → hash: a3b4c5d6e7f8
~/code/orchestrator-v2/           → hash: f1e2d3c4b5a6
~/splitly-orchestrator/           → hash: 9876abcd5432
```

Results in:

```
~/.agent-orchestrator/
  a3b4c5d6e7f8-integrator/        ← From ~/code/orchestrator
  f1e2d3c4b5a6-integrator/        ← From ~/code/orchestrator-v2 (different checkout!)
  9876abcd5432-safesplit/         ← From ~/splitly-orchestrator

# Sessions (no collisions):
a3b4c5d6e7f8-int-1    (main checkout)
f1e2d3c4b5a6-int-1    (v2 checkout)
9876abcd5432-ss-1     (splitly)
```

**Each orchestrator checkout gets unique hash. Projects within same config share that hash.**

---

## 7. Complete Example

```yaml
# ~/code/my-orchestrator/agent-orchestrator.yaml
projects:
  - path: ~/repos/integrator
    repo: ComposioHQ/integrator
    defaultBranch: next

  - path: ~/repos/backend
    repo: ComposioHQ/backend
    defaultBranch: main
    sessionPrefix: be # Override auto-generated "bac"
```

**Results in:**

```
Config location:
  ~/code/my-orchestrator/
  → Hash: a3b4c5d6e7f8

Runtime data:
  ~/.agent-orchestrator/
    a3b4c5d6e7f8-integrator/      ← Project 1
      sessions/
        int-1
      worktrees/
        int-1/

    a3b4c5d6e7f8-backend/         ← Project 2 (same hash!)
      sessions/
        be-1
      worktrees/
        be-1/

Session names:
  User-facing: int-1, be-1
  Tmux: a3b4c5d6e7f8-int-1, a3b4c5d6e7f8-be-1

Commands:
  ao spawn integrator INT-100
  ao attach int-1
```

---

## Summary: What Users Configure

**Required (3 fields per project):**

1. `path` - Where is the repo?
2. `repo` - GitHub owner/repo
3. `defaultBranch` - Base branch name

**Optional:**

- `sessionPrefix` - Override auto-generated prefix
- `name` - Display name

**That's it! Everything else is automatic.**
