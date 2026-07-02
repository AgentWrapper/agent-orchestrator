# Agent Adapter Contract

This document defines the contract between Agent Orchestrator and CLI-based coding agent adapters. Every agent must implement the contract defined in `backend/internal/ports/agent.go` to be usable by AO.

## Table of Contents

- [Overview](#overview)
- [Agent Contract](#agent-contract)
- [Hook System](#hook-system)
- [Session Metadata](#session-metadata)
- [Agent Lifecycle](#agent-lifecycle)
- [Implementation Guide](#implementation-guide)
- [Supported Agents](#supported-agents)
- [Testing](#testing)

---

## Overview

Agent adapters let AO run and observe different CLI coding agents without hardcoding agent-specific behavior into the spawn engine. The adapter contract provides:

- **Agent discovery** — Find and validate the agent binary
- **Launch configuration** — Build the native agent command
- **Session restoration** — Resume existing sessions
- **Hook integration** — Install and manage agent hooks
- **Metadata extraction** — Surface session title, summary, and native session ID

```mermaid
graph TB
    AO[Agent Orchestrator] -->|uses| Adapter[Agent Adapter]
    Adapter -->|implements| Contract[ports.Agent Contract]

    Contract --> Methods[Required Methods]
    Methods --> GetConfig[GetConfigSpec]
    Methods --> GetLaunch[GetLaunchCommand]
    Methods --> GetStrategy[GetPromptDeliveryStrategy]
    Methods --> GetHooks[GetAgentHooks]
    Methods --> GetRestore[GetRestoreCommand]
    Methods --> SessionInfo[SessionInfo]
    Methods --> Uninstall[UninstallHooks]

    Adapter --> Agent[Native CLI Agent]
    Adapter --> Hooks[Agent Hook Config]

```

---

## Agent Contract

### Port Interface

The `ports.Agent` interface (defined in `backend/internal/ports/agent.go`) specifies the required adapter methods:

```go
// Agent is the interface all coding agent adapters must implement.
type Agent interface {
    // GetConfigSpec describes user-facing agent configuration.
    GetConfigSpec() ConfigSpec

    // GetLaunchCommand builds the native agent command for spawning a new session.
    GetLaunchCommand(ctx context.Context, cfg LaunchConfig) ([]string, error)

    // GetPromptDeliveryStrategy reports how the prompt is delivered.
    GetPromptDeliveryStrategy() PromptDeliveryStrategy

    // GetAgentHooks installs or merges AO hooks into the agent's workspace-local config.
    GetAgentHooks(ctx context.Context, cfg WorkspaceHookConfig) error

    // GetRestoreCommand builds a command to resume an existing session.
    GetRestoreCommand(ctx context.Context, cfg RestoreConfig) ([]string, bool, error)

    // SessionInfo returns normalized session metadata from the session record.
    SessionInfo(ctx context.Context, session SessionRef) (SessionInfo, bool, error)

    // UninstallHooks removes AO hooks from the workspace.
    UninstallHooks(ctx context.Context, workspacePath string) error
}
```

### Method Details

#### GetConfigSpec()

Returns a specification of user-facing configuration options:

```go
type ConfigSpec struct {
    // Permissions is the permission mode the agent supports.
    Permissions PermissionMode

    // Model is the optional model identifier (e.g., "claude-3-5-sonnet-20241022").
    Model string

    // SupportsSystemPrompt indicates the agent accepts a system prompt.
    SupportsSystemPrompt bool

    // SupportsRestore indicates the agent supports session restoration.
    SupportsRestore bool
}
```

#### GetLaunchCommand()

Builds the native agent launch command:

```mermaid
flowchart LR
    Input[LaunchConfig] --> Validate[Validate Config]
    Validate --> Resolve[Resolve Binary]
    Resolve --> Build[Build Command]
    Build --> Apply[Apply Permissions]
    Apply --> Model[Add Model Flag]
    Model --> System[Add System Prompt]
    System --> Prompt[Add Prompt]
    Prompt --> Output[Launch Command]

```

**Input (`LaunchConfig`):**

- `SessionID` — AO session identifier
- `ProjectID` — AO project identifier
- `Prompt` — User prompt to send
- `Config` — Agent-specific configuration
- `Permissions` — Permission mode override
- `WorkspacePath` — Path to session worktree

**Output:** Executable command line as argv array

### Session Prompt and Rules Flow

AO splits prompt material into two channels before it reaches an adapter:

- **System prompt** — Derived standing instructions for the session role. This includes AO's hardcoded worker/orchestrator behavior, coordination rules, PR workflow guidance, project-specific `agentRules`/`agentRulesFile` for workers, project-specific `orchestratorRules` for orchestrators, and the confidentiality guard.
- **Task prompt** — The concrete work request. This includes the user's explicit prompt, issue fallback text, and any pre-fetched issue context. Issue facts are task context, not permanent standing rules.

Generated system prompts are not stored as canonical session state. On spawn and restore, the session manager re-derives them from hardcoded prompt text, project config, and current project/session state, then passes `SystemPrompt` and/or `SystemPromptFile` through `LaunchConfig` or `RestoreConfig`. Any prompt file under `AO_DATA_DIR/prompts/<session-id>/system.md` is a launch artifact only.

The hardcoded AO role and task prompt templates live in `backend/internal/session_manager/prompt.go`; the rest of `backend/internal/session_manager` gathers project/session state and delegates prompt assembly there.

Adapters should map `SystemPrompt`/`SystemPromptFile` to the strongest native system/developer-instruction mechanism they support. Adapter-specific compatibility gaps are handled inside adapters; the session manager owns composition, not per-agent flag details.

#### GetPromptDeliveryStrategy()

Reports how the prompt is delivered to the agent:

```go
type PromptDeliveryStrategy string

const (
    // StrategyArgv means the prompt is passed as a command-line argument.
    StrategyArgv PromptDeliveryStrategy = "argv"

    // StrategyStdin means the prompt is written to stdin after launch.
    StrategyStdin PromptDeliveryStrategy = "stdin"
)
```

#### GetAgentHooks()

Installs AO hooks into the agent's workspace-local configuration:

```mermaid
flowchart TD
    Input[WorkspaceHookConfig] --> Read[Read Existing Config]
    Read --> Merge[Merge AO Hooks]
    Merge --> Dedup[Deduplicate Entries]
    Dedupe --> Preserve[Preserve User Hooks]
    Preserve --> Write[Write Updated Config]
    Write --> Gitignore[Update .gitignore]

```

**Requirements:**

- Preserve all user hooks
- Deduplicate AO hook entries
- Make AO hooks machine-portable (use `ao hooks ...` command)
- Ensure all written files are covered by `.gitignore`

#### GetRestoreCommand()

Builds a command to resume an existing session:

**Input (`RestoreConfig`):**

- `Session` — Complete session record with metadata
- `Permissions` — Permission mode to apply
- `SystemPrompt` — System prompt to re-apply

**Output:**

- `cmd` — Restore command argv
- `ok` — True if restore is supported
- `err` — Error if restore fails

#### SessionInfo()

Returns normalized session metadata from the stored session record:

```go
type SessionInfo struct {
    // AgentSessionID is the native agent's session identifier.
    AgentSessionID string

    // Title is the display title derived from the first user prompt.
    Title string

    // Summary is the display summary derived from the final assistant message.
    Summary string

    // Metadata contains adapter-specific extra fields.
    Metadata map[string]any
}
```

**Important:** `SessionInfo` must read from the `session.Metadata` map (populated by hooks), not from scanning agent transcript/cache files.

#### UninstallHooks()

Removes AO hooks from the workspace while preserving user hooks.

---

## Hook System

### Hook Overview

AO uses agent hooks to receive activity signals and session metadata from running agents:

```mermaid
sequenceDiagram
    participant AO as AO Daemon
    participant Adapter as Agent Adapter
    participant Agent as Native Agent
    participant Hook as Hook Command

    Note over AO: Spawning session
    AO->>Adapter: GetAgentHooks(config)
    Adapter->>Hook: Write hook config
    Hook-->>Adapter: Config written

    AO->>Agent: Launch agent
    Agent->>Agent: Running in worktree

    Note over Agent: Agent triggers event
    Agent->>Hook: Execute hook callback
    Hook->>Hook: Read stdin payload
    Hook->>AO: POST /api/v1/sessions/{id}/activity
    AO->>AO: Update activity_state
    AO->>Hook: 200 OK
    Hook-->>Agent: Exit 0

    Agent->>Agent: Continue work
```

### Hook Events

AO supports hooks for these agent events:

| Event              | Purpose               | Activity State     |
| ------------------ | --------------------- | ------------------ |
| `SessionStart`     | Session initialized   | -                  |
| `UserPromptSubmit` | User submitted prompt | `active`           |
| `AssistantMessage` | Assistant response    | -                  |
| `ToolUse`          | Agent used a tool     | `active`           |
| `Stop`             | Session stopped       | `idle` or `exited` |

### Hook Contract

All hook callbacks follow this contract:

```bash
# Hook command format
ao hooks <agent-adapter> <event> <session-id>

# Input (stdin)
# JSON payload from agent (agent-specific format)

# Output (stdout)
# None (discarded)

# Exit code
# 0 = success (always, even on delivery failure)
```

### Hook Behavior

```mermaid
flowchart TD
    Trigger[Agent Event Triggered] --> Execute[Execute Hook Command]
    Execute --> ReadEnv[Read AO_SESSION_ID<br/>from environment]
    ReadEnv --> CheckSession{Is AO Session?}
    CheckSession -->|No| Exit[Exit 0 - ignore]
    CheckSession -->|Yes| ReadStdin[Read JSON Payload<br/>from stdin]
    ReadStdin --> Derive[Derive Activity State<br/>from event]
    Derive --> Post[POST to Daemon<br/>/api/v1/sessions/{id}/activity]
    Post --> Success{Success?}
    Success -->|Yes| Update[Daemon updates<br/>activity_state]
    Success -->|No| Log[Log to hooks.log<br/>under AO_DATA_DIR]
    Update --> Exit
    Log --> Exit

```

**Critical rules:**

1. **Always exit 0** — Hook failure must never break the user's agent
2. **Log failures** — Append to `hooks.log` under `AO_DATA_DIR`
3. **Best-effort delivery** — The daemon may be temporarily unavailable
4. **Idempotent** — Duplicate hook deliveries are safe

### Hook Installation Patterns

Different agents use different hook mechanisms:

#### Claude Code / Compatible Agents

```json
// .claude/hooks.json
{
	"SessionStart": ["ao hooks claude-code SessionStart"],
	"UserPromptSubmit": ["ao hooks claude-code UserPromptSubmit"],
	"Stop": ["ao hooks claude-code Stop"]
}
```

#### Factory Droid

```json
// .factory/hooks.json
{
	"hooks": [
		{
			"event": "agent:beforeThinking",
			"command": "ao hooks droid beforeThinking"
		},
		{
			"event": "agent:afterThinking",
			"command": "ao hooks droid afterThinking"
		}
	]
}
```

#### Codex (Session Flags)

```bash
# Codex passes hooks as session flags
codex -c 'hooks.SessionStart=["ao hooks codex SessionStart"]' \
       -c 'hooks.Stop=["ao hooks codex Stop"]' \
       --dangerously-bypass-hook-trust
```

---

## Session Metadata

### Metadata Keys

Hook callbacks persist normalized keys in the session metadata JSON blob:

```go
const (
    // MetadataKeyAgentSessionID is the native agent's session identifier.
    MetadataKeyAgentSessionID = "agentSessionId"

    // MetadataKeyTitle is the display title from the first user prompt.
    MetadataKeyTitle = "title"

    // MetadataKeySummary is the display summary from the final assistant message.
    MetadataKeySummary = "summary"
)
```

### Metadata Flow

```mermaid
sequenceDiagram
    participant Hook as Hook Callback
    participant Daemon as AO Daemon
    participant Store as SQLite Store
    participant UI as Dashboard

    Note over Hook: User submits first prompt
    Hook->>Daemon: POST /activity<br/>{state: "active", title: "..."}
    Daemon->>Store: Update session metadata<br/>metadata.title = "..."
    Store->>Store: CDC: session.updated
    Store->>UI: SSE: session.updated
    UI->>UI: Update session title

    Note over Hook: Agent finishes work
    Hook->>Daemon: POST /activity<br/>{state: "idle", summary: "..."}
    Daemon->>Store: Update session metadata<br/>metadata.summary = "..."
    Store->>Store: CDC: session.updated
    Store->>UI: SSE: session.updated
    UI->>UI: Update session summary
```

### Metadata Persistence

```mermaid
flowchart LR
    Hook[Hook Callback] --> POST[POST Activity]
    POST --> LCM[Lifecycle Manager]
    LCM --> Update[Update Session Record]
    Update --> Metadata[Set Metadata Fields]
    Metadata --> CDC[CDC Broadcast]
    CDC --> UI[Dashboard Updates]

```

---

## Agent Lifecycle

### Spawn Flow

```mermaid
sequenceDiagram
    participant User as User
    participant UI as Dashboard
    participant API as HTTP API
    participant Mgr as Session Manager
    participant Adapter as Agent Adapter
    participant Runtime as Runtime
    participant Agent as Agent Process

    User->>UI: Click "Spawn Session"
    UI->>API: POST /sessions
    API->>Mgr: Spawn(config)

    Note over Mgr: 1. Create session row
    Mgr->>Mgr: Insert session with empty metadata

    Note over Mgr: 2. Prepare workspace
    Mgr->>Adapter: GetAgentHooks(config)
    Adapter->>Adapter: Write hook config
    Adapter-->>Mgr: Hooks installed

    Note over Mgr: 3. Build launch command
    Mgr->>Adapter: GetLaunchCommand(config)
    Adapter-->>Mgr: Launch command argv

    Note over Mgr: 4. Execute in runtime
    Mgr->>Runtime: Execute(agent command)
    Runtime->>Agent: Spawn process

    Note over Agent: Agent starts
    Agent->>Agent: Execute SessionStart hook
    Agent->>API: POST /activity (agentSessionId)
    API->>API: Update metadata

    Agent-->>Runtime: Running
    Runtime-->>Mgr: Session active
    Mgr-->>API: Session response
    API-->>UI: Session created
```

### Restore Flow

```mermaid
sequenceDiagram
    participant User as User
    participant UI as Dashboard
    participant API as HTTP API
    participant Mgr as Session Manager
    participant Adapter as Agent Adapter
    participant Runtime as Runtime
    participant Agent as Agent Process

    User->>UI: Click "Restore Session"
    UI->>API: POST /sessions/{id}/restore
    API->>Mgr: Restore(session)

    Note over Mgr: Check adapter supports restore
    Mgr->>Adapter: GetRestoreCommand(config)

    alt Restore supported
        Adapter-->>Mgr: Restore command
        Mgr->>Runtime: Execute(restore command)
        Runtime->>Agent: Spawn process
        Agent-->>Mgr: Running
        Mgr-->>API: Session restored
    else Restore not supported
        Adapter-->>Mgr: (cmd, false, nil)
        Mgr->>Mgr: Fresh spawn instead
        Mgr-->>API: Session created (new)
    end

    API-->>UI: Session response
```

### Activity Flow

```mermaid
stateDiagram-v2
    [*] --> Spawning: Spawn()
    Spawning --> Idle: Agent starts
    Idle --> Active: User prompt
    Active --> Active: Agent working
    Active --> Waiting: Needs input
    Waiting --> Active: User responds
    Active --> Idle: Agent completes
    Idle --> Exited: Agent exits
    Active --> Exited: Agent crashes
    Exited --> [*]

    note right of Active
        Hook: UserPromptSubmit
        Hook: ToolUse
        activity_state = "active"
    end note

    note right of Waiting
        Hook: WaitingForInput
        activity_state = "waiting_input"
    end note

    note right of Idle
        Hook: Stop
        activity_state = "idle"
    end note

    note right of Exited
        Hook: Stop
        activity_state = "exited"
        is_terminated = true
    end note
```

---

## Implementation Guide

### Adapter Template

```go
package myagent

import (
    "context"
    "fmt"
)

// Plugin is the MyAgent adapter.
type Plugin struct {
    // Adapter state (e.g., resolved binary path)
}

// New returns a ready-to-register MyAgent adapter.
func New() *Plugin {
    return &Plugin{}
}

// GetConfigSpec describes the agent configuration.
func (p *Plugin) GetConfigSpec() ports.ConfigSpec {
    return ports.ConfigSpec{
        Permissions:        ports.PermissionReadWrite,  // or ReadOnly, WriteOnly
        SupportsSystemPrompt: true,
        SupportsRestore:     true,
    }
}

// GetLaunchCommand builds the native agent command.
func (p *Plugin) GetLaunchCommand(ctx context.Context, cfg ports.LaunchConfig) ([]string, error) {
    // 1. Validate config
    if err := cfg.Config.Validate(); err != nil {
        return nil, fmt.Errorf("myagent: %w", err)
    }

    // 2. Resolve binary
    binary, err := p.resolveBinary(ctx)
    if err != nil {
        return nil, err
    }

    // 3. Build command
    cmd := []string{binary}

    // Add flags (model, permissions, etc.)
    if cfg.Config.Model != "" {
        cmd = append(cmd, "--model", cfg.Config.Model)
    }

    // Add system prompt if supported
    if cfg.SystemPrompt != "" {
        cmd = append(cmd, "--system-prompt", cfg.SystemPrompt)
    }

    // Add prompt
    if cfg.Prompt != "" {
        cmd = append(cmd, "--prompt", cfg.Prompt)
    }

    return cmd, nil
}

// GetPromptDeliveryStrategy reports how the prompt is delivered.
func (p *Plugin) GetPromptDeliveryStrategy() ports.PromptDeliveryStrategy {
    return ports.StrategyArgv  // or StrategyStdin
}

// GetAgentHooks installs AO hooks.
func (p *Plugin) GetAgentHooks(ctx context.Context, cfg ports.WorkspaceHookConfig) error {
    // 1. Read existing config
    config, err := p.readConfig(cfg.WorkspacePath)
    if err != nil {
        return err
    }

    // 2. Add AO hooks (preserving user hooks)
    config = p.addHooks(config, cfg.SessionID)

    // 3. Write updated config
    if err := p.writeConfig(cfg.WorkspacePath, config); err != nil {
        return err
    }

    // 4. Ensure .gitignore coverage
    if err := p.ensureGitignore(cfg.WorkspacePath); err != nil {
        return err
    }

    return nil
}

// GetRestoreCommand builds a restore command.
func (p *Plugin) GetRestoreCommand(ctx context.Context, cfg ports.RestoreConfig) ([]string, bool, error) {
    // 1. Extract native session ID from metadata
    sessionID := cfg.Session.Metadata[ports.MetadataKeyAgentSessionID]
    if sessionID == "" {
        return nil, false, nil  // Restore not supported
    }

    // 2. Build restore command
    binary, err := p.resolveBinary(ctx)
    if err != nil {
        return nil, false, err
    }

    cmd := []string{
        binary,
        "--resume", sessionID,
        // Re-apply permissions and system prompt
    }

    return cmd, true, nil
}

// SessionInfo returns normalized metadata.
func (p *Plugin) SessionInfo(ctx context.Context, session ports.SessionRef) (ports.SessionInfo, bool, error) {
    info := ports.SessionInfo{
        AgentSessionID: session.Metadata[ports.MetadataKeyAgentSessionID],
        Title:          session.Metadata[ports.MetadataKeyTitle],
        Summary:        session.Metadata[ports.MetadataKeySummary],
    }

    // Return hasData=true if any field is populated
    hasData := info.AgentSessionID != "" || info.Title != "" || info.Summary != ""

    return info, hasData, nil
}

// UninstallHooks removes AO hooks.
func (p *Plugin) UninstallHooks(ctx context.Context, workspacePath string) error {
    // Remove AO hook entries while preserving user hooks
    config, err := p.readConfig(workspacePath)
    if err != nil {
        return err
    }

    config = p.removeHooks(config)

    return p.writeConfig(workspacePath, config)
}
```

### Hook Implementation

```go
// Add hooks to the agent's config
func (p *Plugin) addHooks(config map[string]any, sessionID string) map[string]any {
    // Define AO hook commands
    aoHooks := map[string]string{
        "SessionStart":      "ao hooks myagent SessionStart",
        "UserPromptSubmit":  "ao hooks myagent UserPromptSubmit",
        "Stop":              "ao hooks myagent Stop",
    }

    // Merge with existing config, preserving user hooks
    for event, command := range aoHooks {
        if config[event] == nil {
            config[event] = []string{command}
        } else {
            // Deduplicate: check if AO hook already exists
            hooks := config[event].([]string)
            found := false
            for _, h := range hooks {
                if strings.HasPrefix(h, "ao hooks myagent") {
                    found = true
                    break
                }
            }
            if !found {
                config[event] = append(hooks, command)
            }
        }
    }

    return config
}
```

### Gitignore Enforcement

```go
import "github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/hookutil"

func (p *Plugin) ensureGitignore(workspacePath string) error {
    // Every file the adapter writes must be gitignored
    filesToIgnore := []string{
        ".myagent/config.json",
        ".myagent/hooks.json",
    }

    return hookutil.EnsureWorkspaceGitignore(workspacePath, ".myagent/")
}
```

---

## Supported Agents

### Current Adapters

AO currently supports 23+ agent adapters:

```mermaid
mindmap
    root((Agent Adapters))
        Anthropic
            Claude Code
        OpenAI
            Codex
        Cursor
            Cursor
        OpenCode
            OpenCode
        Aider
            Aider
        Amp
            Amp Code
        Goose
            Goose
        GitHub
            Copilot
        xAI
            Grok
        Alibaba
            Qwen Code
        Moonshot
            Kimi Code
        Reverb
            Crush
        Cline
            Cline
        Factory
            Droid
            Devin
        Augment
            Auggie
        Continue
            Continue
        Kiro
            Kiro
        Kilo
            Kilo Code
        Agy
            Agy
        Roo
            Roo Code
        Windsurf
            Windsurf
```

### Adapter Locations

```
backend/internal/adapters/agent/
├── agy/
├── aider/
├── amp/
├── augie/
├── claudecode/
├── clone/
├── codex/
├── continue/
├── cursor/
├── devin/
├── droid/
├── grok/
├── goose/
├── kilo/
├── kimi/
├── kiro/
├── opencode/
├── qwen/
├── roo/
├── crush/
├── windsurf/
└── ...
```

### Adapter Capabilities

| Agent       | Permissions | System Prompt | Restore | Hooks             |
| ----------- | ----------- | ------------- | ------- | ----------------- |
| Claude Code | ✓           | ✓             | ✓       | ✓                 |
| Codex       | ✓           | ✓             | ✓       | ✓ (session flags) |
| Cursor      | ✓           | ✓             | ✗       | ✗                 |
| OpenCode    | ✓           | ✓             | ✗       | ✗                 |
| Aider       | ✓           | ✓             | ✓       | ✓                 |
| Amp         | ✓           | ✓             | ✓       | ✓                 |
| Grok        | ✓           | ✓             | ✓       | ✓ (Claude compat) |
| ...         | ...         | ...           | ...     | ...               |

---

## Testing

### Unit Tests

```go
func TestGetLaunchCommand(t *testing.T) {
    p := New()
    cfg := ports.LaunchConfig{
        SessionID: "test-session",
        Prompt:    "Write a function",
        Config: domain.AgentConfig{
            Model: "gpt-4",
        },
    }

    cmd, err := p.GetLaunchCommand(context.Background(), cfg)
    assert.NoError(t, err)
    assert.Contains(t, cmd, "myagent")
    assert.Contains(t, cmd, "--model", "gpt-4")
    assert.Contains(t, cmd, "Write a function")
}
```

### Integration Tests

```go
func TestAgentE2E(t *testing.T) {
    // Skip if agent not installed
    if !agentInstalled(t) {
        t.Skip("myagent not installed")
    }

    // Create test project
    ctx := context.Background()
    project := createTestProject(t)

    // Spawn session
    session := spawnSession(t, ctx, project.ID, "myagent", "Hello")

    // Wait for activity
    waitForActivity(t, ctx, session.ID, "active")

    // Verify metadata
    info := getSessionInfo(t, ctx, session.ID)
    assert.NotEmpty(t, info.AgentSessionID)
    assert.NotEmpty(t, info.Title)

    // Kill session
    killSession(t, ctx, session.ID)
}
```

### Conformance Tests

```go
// TestGetAgentHooksFootprintIsGitignored verifies all adapter-written
// files are covered by .gitignore.
func TestGetAgentHooksFootprintIsGitignored(t *testing.T) {
    registry := agentRegistry.New()
    for _, adapter := range registry.List() {
        t.Run(adapter, func(t *testing.T) {
            tmpDir := t.TempDir()
            cfg := ports.WorkspaceHookConfig{
                WorkspacePath: tmpDir,
                SessionID:    "test-session",
            }

            agent := registry.Get(adapter)
            err := agent.GetAgentHooks(context.Background(), cfg)
            assert.NoError(t, err)

            // Verify all written files are gitignored
            verifyGitignore(t, tmpDir)
        })
    }
}
```

### Hook Tests

```go
func TestHookDelivery(t *testing.T) {
    // Mock daemon endpoint
    server := mockActivityServer(t)
    defer server.Close()

    // Simulate hook callback
    payload := map[string]any{
        "state": "active",
        "title": "Test session",
    }

    cmd := exec.Command("ao", "hooks", "myagent", "UserPromptSubmit", "test-session")
    cmd.Env = append(cmd.Env,
        fmt.Sprintf("AO_SESSION_ID=%s", "test-session"),
        fmt.Sprintf("AO_DAEMON_URL=%s", server.URL),
    )

    stdin, _ := cmd.StdinPipe()
    json.NewEncoder(stdin).Encode(payload)
    stdin.Close()

    err := cmd.Run()
    assert.NoError(t, err)

    // Verify daemon received the activity
    assert.ActivityReceived(t, server, "active")
}
```

---

## Summary

**Key points:**

1. **Port contract** — All agents implement `ports.Agent`
2. **Hooks are critical** — Activity signals and metadata flow through hooks
3. **Always gitignore** — Every adapter-written file must be covered
4. **Metadata from hooks** — `SessionInfo` reads from metadata, not files
5. **Preserve user hooks** — Never delete user configuration
6. **Exit 0 always** — Hook failure must never break the agent

**Implementation checklist:**

- [ ] Implement `ports.Agent` interface
- [ ] Write hook installation/removal
- [ ] Ensure all files are gitignored
- [ ] Implement `SessionInfo` from metadata
- [ ] Add unit tests
- [ ] Add integration tests
- [ ] Add conformance tests
- [ ] Register in daemon wiring
