package cli

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/activitydispatch"
)

// sessionIDPattern bounds the AO_SESSION_ID we will place in a request path to
// the id alphabet the daemon issues. Validating the externally-set env value
// before it reaches the loopback URL keeps it from steering the request.
var sessionIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)

const (
	// hooksLogName is the file under AO_DATA_DIR where hook delivery failures
	// are appended. Agent hook runners swallow stderr, so without a durable
	// sink a dead activity feed (e.g. an unreachable daemon) stays invisible.
	hooksLogName = "hooks.log"
	// maxHooksLogBytes caps hooks.log: an append against a file already past
	// the cap truncates it first, so a persistently failing hook cannot grow
	// the file without bound.
	maxHooksLogBytes = 1 << 20
)

// setActivityAPIRequest mirrors the daemon's SetActivityRequest body for
// POST /api/v1/sessions/{id}/activity. The CLI keeps its own copy so it need
// not import httpd. Event carries the AO hook sub-command that produced the
// state; ToolName/ToolUseID are the tool-use correlation facts lifted from the
// native payload when present. All three are optional: an old daemon decodes
// the body leniently and simply ignores them.
type setActivityAPIRequest struct {
	State        string              `json:"state"`
	Agent        string              `json:"agent,omitempty"`
	RuntimeToken string              `json:"runtimeToken,omitempty"`
	Event        string              `json:"event,omitempty"`
	ToolName     string              `json:"toolName,omitempty"`
	ToolUseID    string              `json:"toolUseId,omitempty"`
	Decision     *decisionAPIRequest `json:"decision,omitempty"`
}

type decisionAPIRequest struct {
	Kind     string   `json:"kind"`
	Question string   `json:"question,omitempty"`
	Options  []string `json:"options,omitempty"`
}

// maxActivityMetaLen caps the correlation fields lifted from a native hook
// payload before they go on the wire — they are ids/names, anything longer is
// garbage and gets dropped rather than truncated (a truncated id would never
// match its pre/post counterpart).
const maxActivityMetaLen = 256

// activityMeta extracts the tool-use correlation facts from a native hook
// payload. The field names are shared vocabulary across agent CLIs that emit
// them (claude-code's PreToolUse/PostToolUse/PostToolUseFailure and
// PermissionRequest payloads); adapters whose payloads lack them yield empty
// strings and the signal degrades to today's state-only form.
func activityMeta(payload []byte) (toolName, toolUseID string) {
	var p struct {
		ToolName  string `json:"tool_name"`
		ToolUseID string `json:"tool_use_id"`
	}
	_ = json.Unmarshal(payload, &p)
	if len(p.ToolName) > maxActivityMetaLen {
		p.ToolName = ""
	}
	if len(p.ToolUseID) > maxActivityMetaLen {
		p.ToolUseID = ""
	}
	return p.ToolName, p.ToolUseID
}

func decisionMeta(agent, event string, payload []byte, state, toolName string) *decisionAPIRequest {
	if state != "blocked" {
		return nil
	}
	if agent != "claude-code" {
		return nil
	}
	question, options := parseQuestionDecision(payload)
	if event == "permission-request" || (event == "notification" && notificationType(payload) == "permission_prompt") {
		if question == "" && toolName != "" {
			question = "Permission request: " + toolName
		}
		return &decisionAPIRequest{Kind: "permission", Question: question}
	}
	if event == "notification" && notificationType(payload) == "agent_needs_input" && question != "" {
		return &decisionAPIRequest{Kind: "question", Question: question, Options: options}
	}
	if len(options) > 0 {
		return &decisionAPIRequest{Kind: "question", Question: question, Options: options}
	}
	return &decisionAPIRequest{Kind: "permission", Question: question}
}

func notificationType(payload []byte) string {
	var p struct {
		NotificationType string `json:"notification_type"`
	}
	_ = json.Unmarshal(payload, &p)
	return p.NotificationType
}

func parseQuestionDecision(payload []byte) (string, []string) {
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(payload, &raw); err != nil {
		return "", nil
	}
	question := firstString(raw, "question", "message", "prompt", "text", "title")
	options := firstOptions(raw, "options", "choices", "answers")
	if len(options) == 0 {
		for _, key := range []string{"dialog", "decision", "elicitation"} {
			var nested map[string]json.RawMessage
			if v, ok := raw[key]; ok && json.Unmarshal(v, &nested) == nil {
				if question == "" {
					question = firstString(nested, "question", "message", "prompt", "text", "title")
				}
				options = firstOptions(nested, "options", "choices", "answers")
				if len(options) > 0 {
					break
				}
			}
		}
	}
	return trimMeta(question), options
}

func firstString(raw map[string]json.RawMessage, keys ...string) string {
	for _, key := range keys {
		var s string
		if v, ok := raw[key]; ok && json.Unmarshal(v, &s) == nil && strings.TrimSpace(s) != "" {
			return s
		}
	}
	return ""
}

func firstOptions(raw map[string]json.RawMessage, keys ...string) []string {
	for _, key := range keys {
		v, ok := raw[key]
		if !ok {
			continue
		}
		if opts := stringOptions(v); len(opts) > 0 {
			return opts
		}
		if opts := objectOptions(v); len(opts) > 0 {
			return opts
		}
	}
	return nil
}

func stringOptions(raw json.RawMessage) []string {
	var values []string
	if err := json.Unmarshal(raw, &values); err != nil {
		return nil
	}
	return cleanOptions(values)
}

func objectOptions(raw json.RawMessage) []string {
	var values []map[string]string
	if err := json.Unmarshal(raw, &values); err != nil {
		return nil
	}
	opts := make([]string, 0, len(values))
	for i, value := range values {
		label := ""
		for _, key := range []string{"label", "text", "value", "title"} {
			if opt := strings.TrimSpace(value[key]); opt != "" {
				label = opt
				break
			}
		}
		opts = append(opts, optionLabel(label, i))
	}
	return opts
}

func cleanOptions(values []string) []string {
	opts := make([]string, 0, len(values))
	for i, value := range values {
		opts = append(opts, optionLabel(value, i))
	}
	return opts
}

func optionLabel(v string, index int) string {
	v = strings.TrimSpace(v)
	if v == "" {
		return fmt.Sprintf("Option %d", index+1)
	}
	if len(v) > maxActivityMetaLen {
		return truncateRunes(v, maxActivityMetaLen)
	}
	return v
}

func trimMeta(v string) string {
	v = strings.TrimSpace(v)
	if len(v) > maxActivityMetaLen {
		return ""
	}
	return v
}

func truncateRunes(v string, maxBytes int) string {
	lastSafe := 0
	for i := range v {
		if i > maxBytes {
			return strings.TrimSpace(v[:lastSafe])
		}
		lastSafe = i
	}
	if len(v) > maxBytes {
		return strings.TrimSpace(v[:lastSafe])
	}
	return v
}

// newHooksCommand builds the hidden `ao hooks <agent> <event>` command that
// agent CLIs invoke from their workspace-local hook config. It reads the native
// hook payload from stdin and the AO session id from AO_SESSION_ID, derives an
// activity state for the event, and reports it to the daemon.
//
// It is best-effort by design: a hook must never break the user's agent, so a
// non-AO session (no AO_SESSION_ID), an event that carries no activity signal,
// or an unreachable daemon all exit 0 rather than erroring.
func newHooksCommand(ctx *commandContext) *cobra.Command {
	return &cobra.Command{
		Use:    "hooks <agent> <event>",
		Short:  "Receive an agent hook callback (internal)",
		Hidden: true,
		Args:   cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			return ctx.runHook(cmd.Context(), args[0], args[1])
		},
	}
}

func (c *commandContext) runHook(ctx context.Context, agent, event string) error {
	sessionID := strings.TrimSpace(os.Getenv("AO_SESSION_ID"))
	if !sessionIDPattern.MatchString(sessionID) {
		// Not an AO-managed session (unset/empty), or an id we won't put in a
		// request path. Return before reading stdin so a manual invocation
		// without a piped payload can't block on EOF.
		return nil
	}
	payload, err := io.ReadAll(c.deps.In)
	if err != nil {
		// Surface read errors for parity with the daemon-error path, but keep
		// the empty payload and exit 0: a failed hook must not break the
		// agent. The deriver tolerates an empty payload.
		c.reportHookFailure(agent, event, sessionID, fmt.Errorf("read stdin: %w", err))
	}

	state, ok := activitydispatch.Derive(agent, event, payload)
	if !ok {
		// Unknown agent, or an event that carries no activity signal: report nothing.
		return nil
	}

	toolName, toolUseID := activityMeta(payload)
	stateText := string(state)
	decision := decisionMeta(agent, event, payload, stateText, toolName)
	path := "sessions/" + url.PathEscape(sessionID) + "/activity"
	runtimeToken := strings.TrimSpace(os.Getenv("AO_RUNTIME_TOKEN"))
	if err := c.postJSON(ctx, path, setActivityAPIRequest{State: stateText, Agent: agent, RuntimeToken: runtimeToken, Event: event, ToolName: toolName, ToolUseID: toolUseID, Decision: decision}, nil); err != nil {
		// Surface the failure for diagnosis, but exit 0: a failed activity
		// report must not disrupt the agent.
		c.reportHookFailure(agent, event, sessionID, err)
	}
	return nil
}

// reportHookFailure surfaces a hook delivery failure without breaking the
// agent: stderr for the agent's hook runner, plus a best-effort append to
// $AO_DATA_DIR/hooks.log so the failure can be diagnosed after the fact.
func (c *commandContext) reportHookFailure(agent, event, sessionID string, cause error) {
	msg := fmt.Sprintf("ao hooks %s %s: %v", agent, event, cause)
	_, _ = fmt.Fprintln(c.deps.Err, msg)
	dataDir := strings.TrimSpace(os.Getenv("AO_DATA_DIR"))
	if dataDir == "" {
		return
	}
	line := fmt.Sprintf("%s session=%s %s\n", time.Now().UTC().Format(time.RFC3339), sessionID, msg)
	appendHooksLog(dataDir, line)
}

// appendHooksLog appends one line to the hooks log, truncating first when the
// file has outgrown maxHooksLogBytes. Errors are dropped: this sink is itself
// best-effort and has nowhere better to report.
func appendHooksLog(dataDir, line string) {
	if err := os.MkdirAll(dataDir, 0o750); err != nil {
		return
	}
	path := filepath.Join(dataDir, hooksLogName)
	flags := os.O_APPEND | os.O_CREATE | os.O_WRONLY
	if info, err := os.Stat(path); err == nil && info.Size() > maxHooksLogBytes {
		flags = os.O_TRUNC | os.O_CREATE | os.O_WRONLY
	}
	f, err := os.OpenFile(path, flags, 0o600) //nolint:gosec // path is rooted in AO's own data dir
	if err != nil {
		return
	}
	defer func() { _ = f.Close() }()
	_, _ = f.WriteString(line)
}
