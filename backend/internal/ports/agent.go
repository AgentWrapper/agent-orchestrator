package ports

import (
	"context"
	"errors"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

// ErrAgentBinaryNotFound is returned by agent adapters when neither PATH nor
// any well-known install location holds the agent's binary. The session
// manager surfaces this BEFORE creating the runtime so a missing CLI doesn't
// silently launch into an empty tmux pane that the reaper later mistakes
// for a live session.
var ErrAgentBinaryNotFound = errors.New("agent: binary not found on PATH")

// Agent is the contract every CLI coding agent adapter (claude-code, codex, …)
// must satisfy. It supplies the argv and process configuration the Session
// Manager needs to launch, restore, and read back a native agent session.
type Agent interface {
	// GetConfigSpec describes the agent-specific config keys AO can
	// expose to users in the AO config.
	GetConfigSpec(ctx context.Context) (ConfigSpec, error)

	// GetLaunchCommand builds the argv AO should run to start this agent.
	GetLaunchCommand(ctx context.Context, cfg LaunchConfig) (cmd []string, err error)

	// GetPromptDeliveryStrategy tells AO whether the prompt is included in
	// the launch command or must be sent after the agent process starts.
	GetPromptDeliveryStrategy(ctx context.Context, cfg LaunchConfig) (PromptDeliveryStrategy, error)

	// GetAgentHooks installs or merges AO hooks into the agent's
	// native workspace-local hook config. It must preserve user-defined hooks.
	GetAgentHooks(ctx context.Context, cfg WorkspaceHookConfig) error

	// GetRestoreCommand builds an argv that continues an existing native agent
	// session. ok=false means no existing native session can be continued.
	GetRestoreCommand(ctx context.Context, cfg RestoreConfig) (cmd []string, ok bool, err error)

	// SessionInfo reads agent-owned session metadata such as native session id,
	// display title, or summary. ok=false means no info is available.
	SessionInfo(ctx context.Context, session SessionRef) (info SessionInfo, ok bool, err error)
}

// AgentResolver maps a session's harness onto the Agent adapter that drives it,
// so the Session Manager can spawn (and restore) a different agent per session
// without depending on the concrete adapter registry. ok=false means no adapter
// is registered for that harness.
type AgentResolver interface {
	Agent(harness domain.AgentHarness) (Agent, bool)
}

// ActivitySignaler is an OPTIONAL capability an Agent adapter may implement to
// describe which durable activity signals its harness actually produces under
// AO's headless launch. The Session Manager gates best-effort post-send
// confirmation on it — see the two methods.
//
// EmitsSubmitActivity reports whether the harness emits a prompt-submit signal
// (one that flips Activity.State to active). Without it the confirm loop could
// never observe active and would only burn its budget on spurious Enter nudges.
//
// EmitsBlockedActivity reports whether the harness emits a decision-pause
// signal (a permission/approval prompt that flips Activity.State to blocked).
// The Enter-only nudge is only SAFE when this is true: a harness that submits
// but cannot report blocked leaves the confirm loop unable to tell an
// unsubmitted draft from a pending permission dialog, so an Enter meant to
// resubmit the draft could instead answer the dialog. confirmActive therefore
// requires BOTH signals before it will nudge.
//
// copilot maps the submit hook but its CLI does not fire prompt-style hooks in
// -p mode, so it must NOT implement this at all (it would otherwise pay the
// full confirmation budget on every send). Harnesses that submit but install no
// permission/blocked hook (goose, opencode, agy) return true from
// EmitsSubmitActivity and false from EmitsBlockedActivity, opting out of the
// nudge until they can report blocked.
type ActivitySignaler interface {
	EmitsSubmitActivity() bool
	EmitsBlockedActivity() bool
}

// MetadataKeyAgentSessionID is the SessionRef.Metadata key that carries an
// agent's native session id. It matches the json tag on
// domain.SessionMetadata.AgentSessionID and the key the adapters read, so the
// Session Manager can bridge its typed metadata onto a SessionRef without
// either side hard-coding the other's vocabulary.
const MetadataKeyAgentSessionID = "agentSessionId"

// MetadataKeyTitle and MetadataKeySummary are the SessionRef.Metadata keys
// carrying a session's human title and one-line summary. They are the shared
// vocabulary every adapter reports under, so the dashboard renders agents
// uniformly.
const (
	MetadataKeyTitle   = "title"
	MetadataKeySummary = "summary"
)

// AgentConfig is the typed per-project agent config handed to adapters at
// launch. It aliases domain.AgentConfig so storage, services, and adapters
// share one definition without a translation layer.
type AgentConfig = domain.AgentConfig

// ConfigSpec describes the agent-specific config keys AO can expose to users.
type ConfigSpec struct {
	Fields []ConfigField
}

// ConfigField describes one user-facing agent config key.
type ConfigField struct {
	Key         string
	Type        ConfigFieldType
	Description string
	Required    bool
	Default     any
	Enum        []string
}

// ConfigFieldType is the primitive value kind AO expects for a field.
type ConfigFieldType string

// The primitive value kinds a ConfigField can declare.
const (
	ConfigFieldString     ConfigFieldType = "string"
	ConfigFieldBool       ConfigFieldType = "bool"
	ConfigFieldNumber     ConfigFieldType = "number"
	ConfigFieldStringList ConfigFieldType = "string_list"
	ConfigFieldEnum       ConfigFieldType = "enum"
)

// LaunchConfig carries inputs needed to build a new agent launch command.
type LaunchConfig struct {
	Config      AgentConfig
	IssueID     string
	Permissions PermissionMode
	Prompt      string
	SessionID   string
	// AllowedTools and DisallowedTools scope the agent to a tool allowlist when
	// it runs in a non-bypass permission mode (allow rules auto-approve, deny
	// rules auto-reject). They are the enforced read-only guarantee the reviewer
	// relies on: bypassPermissions ignores both lists, so a restricted launch
	// must leave Permissions off bypass. Empty means no restriction, so worker
	// sessions are unaffected.
	AllowedTools     []string
	DisallowedTools  []string
	SystemPrompt     string
	SystemPromptFile string
	WorkspacePath    string
}

// WorkspaceHookConfig carries inputs needed to install workspace-local agent hooks.
type WorkspaceHookConfig struct {
	Config        AgentConfig
	DataDir       string
	SessionID     string
	WorkspacePath string
}

// RestoreConfig carries inputs needed to continue an existing native agent session.
type RestoreConfig struct {
	Config      AgentConfig
	Permissions PermissionMode
	Session     SessionRef
	// SystemPrompt carries the session's standing instructions (e.g. the
	// orchestrator role). Agent CLIs rebuild their system prompt from flags on
	// resume — it is not part of the transcript — so adapters whose CLI has a
	// system-prompt flag should re-apply this in their resume command.
	SystemPrompt string
}

// SessionRef identifies an AO session whose agent-owned metadata may be read.
type SessionRef struct {
	ID            string
	Metadata      map[string]string
	WorkspacePath string
}

// SessionInfo contains agent-owned session metadata.
type SessionInfo struct {
	AgentSessionID string
	Metadata       map[string]string
	Title          string
	Summary        string
}

// PermissionMode controls how much review an agent requires before acting. It
// is a type alias for domain.PermissionMode so adapters keep using
// ports.PermissionMode while the typed AgentConfig (in domain) reuses the same
// type.
type PermissionMode = domain.PermissionMode

// The permission modes adapters map onto their agent's native approval flags.
// These re-export the domain constants so existing adapter code is unchanged.
const (
	PermissionModeDefault           = domain.PermissionModeDefault
	PermissionModeAcceptEdits       = domain.PermissionModeAcceptEdits
	PermissionModeAuto              = domain.PermissionModeAuto
	PermissionModeBypassPermissions = domain.PermissionModeBypassPermissions
)

// PromptDeliveryStrategy describes how AO should deliver the initial prompt.
type PromptDeliveryStrategy string

// How the orchestrator hands the initial prompt to a freshly launched agent.
const (
	PromptDeliveryInCommand  PromptDeliveryStrategy = "in_command"
	PromptDeliveryAfterStart PromptDeliveryStrategy = "after_start"
)
