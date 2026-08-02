package codexappserver

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// Translation from Codex app-server notifications into AO's provider-neutral
// Chat events.
//
// The rule here is conservative: a notification this build does not model
// produces no event at all. Guessing semantics for an unrecognized provider
// event is how a timeline starts lying. A trivial three-turn session emits
// around fifteen distinct notification methods, most of which are provider
// bookkeeping (MCP startup, rate limits, hook lifecycle, remote-control status)
// with no place in a conversation.

// Codex thread item types, from the ThreadItem discriminator in the generated
// schema. Only the ones AO renders are listed; the rest fall through to nothing.
const (
	itemUserMessage      = "userMessage"
	itemAgentMessage     = "agentMessage"
	itemReasoning        = "reasoning"
	itemPlan             = "plan"
	itemCommandExecution = "commandExecution"
	itemFileChange       = "fileChange"
	itemMcpToolCall      = "mcpToolCall"
	itemWebSearch        = "webSearch"
	itemError            = "error"
)

// threadItem is the subset of Codex's ThreadItem that AO reads. Fields absent
// for a given type stay zero.
type threadItem struct {
	ID   string `json:"id"`
	Type string `json:"type"`

	// agentMessage / userMessage / plan
	Text string `json:"text"`

	// commandExecution
	Command string `json:"command"`
	Cwd     string `json:"cwd"`
	// AggregatedOutput is best-effort: observed to omit leading output even on
	// small commands, so it is display data and never an authoritative record.
	AggregatedOutput string `json:"aggregatedOutput"`
	ExitCode         *int   `json:"exitCode"`
	DurationMs       *int64 `json:"durationMs"`

	// fileChange
	Changes json.RawMessage `json:"changes"`

	// mcpToolCall
	ToolName string `json:"toolName"`
	Server   string `json:"server"`

	// error
	Message string `json:"message"`
}

// itemEnvelope is the params shape of item/started and item/completed.
type itemEnvelope struct {
	ThreadID string     `json:"threadId"`
	TurnID   string     `json:"turnId"`
	Item     threadItem `json:"item"`
}

// deltaEnvelope is the params shape of item/agentMessage/delta.
type deltaEnvelope struct {
	ThreadID string `json:"threadId"`
	TurnID   string `json:"turnId"`
	ItemID   string `json:"itemId"`
	Delta    string `json:"delta"`
}

// turnEnvelope is the params shape of turn/started and turn/completed.
type turnEnvelope struct {
	ThreadID string `json:"threadId"`
	Turn     struct {
		ID     string `json:"id"`
		Status string `json:"status"`
		Error  *struct {
			Message string `json:"message"`
		} `json:"error"`
	} `json:"turn"`
	// turn/started reports the id at the top level in some builds.
	TurnID string `json:"turnId"`
}

// usageEnvelope is the params shape of thread/tokenUsage/updated.
type usageEnvelope struct {
	ThreadID string          `json:"threadId"`
	Usage    json.RawMessage `json:"usage"`
	Info     json.RawMessage `json:"info"`
}

// nameEnvelope is the params shape of thread/name/updated. threadName is
// nullable: the provider uses the absent form to say the thread no longer has a
// name, which is a different fact from "it was renamed to something blank".
type nameEnvelope struct {
	ThreadID   string  `json:"threadId"`
	ThreadName *string `json:"threadName"`
}

// resolvedEnvelope is the params shape of serverRequest/resolved, which the
// provider broadcasts once a request has been answered. It is how a second
// client learns an approval is no longer actionable.
//
// requestId is the JSON-RPC id of the original server->client request and arrives
// as a number (observed: 0, 1, 2), so it is decoded raw and stringified. The
// approval payloads themselves carry no separate request identifier — the
// JSON-RPC id is the only correlation key.
type resolvedEnvelope struct {
	ThreadID  string          `json:"threadId"`
	RequestID json.RawMessage `json:"requestId"`
	ID        json.RawMessage `json:"id"`
}

// normalizeNotification converts one provider notification into zero or more
// neutral events. Returning nil means "not conversation-relevant".
func normalizeNotification(n notification) []ports.ChatEvent {
	switch n.Method {
	case "turn/started":
		var p turnEnvelope
		if err := json.Unmarshal(n.Params, &p); err != nil {
			return nil
		}
		return []ports.ChatEvent{{
			Kind:           ports.ChatEventTurnStarted,
			ProviderTurnID: firstNonEmpty(p.Turn.ID, p.TurnID),
		}}

	case "turn/completed":
		var p turnEnvelope
		if err := json.Unmarshal(n.Params, &p); err != nil {
			return nil
		}
		ev := ports.ChatEvent{
			Kind:           ports.ChatEventTurnCompleted,
			ProviderTurnID: firstNonEmpty(p.Turn.ID, p.TurnID),
			TurnState:      turnStateFrom(p.Turn.Status),
		}
		if p.Turn.Error != nil && p.Turn.Error.Message != "" {
			ev.Err = fmt.Errorf("%s", p.Turn.Error.Message)
		}
		return []ports.ChatEvent{ev}

	case "item/agentMessage/delta":
		var p deltaEnvelope
		if err := json.Unmarshal(n.Params, &p); err != nil || p.Delta == "" {
			return nil
		}
		return []ports.ChatEvent{{
			Kind:           ports.ChatEventMessageDelta,
			ProviderTurnID: p.TurnID,
			ProviderItemID: p.ItemID,
			Delta:          p.Delta,
		}}

	case "item/started":
		return normalizeItem(n.Params, false)

	case "item/completed":
		return normalizeItem(n.Params, true)

	case "thread/tokenUsage/updated":
		var p usageEnvelope
		if err := json.Unmarshal(n.Params, &p); err != nil {
			return nil
		}
		detail := p.Usage
		if len(detail) == 0 {
			detail = p.Info
		}
		return []ports.ChatEvent{{
			Kind:           ports.ChatEventActivityCompleted,
			ActivityKind:   domain.ActivityKindUsage,
			ActivityStatus: domain.ActivityStatusCompleted,
			Summary:        "Token usage updated",
			Detail:         detail,
		}}

	case "thread/name/updated":
		var p nameEnvelope
		if err := json.Unmarshal(n.Params, &p); err != nil {
			return nil
		}
		// A cleared name is reported too, as an empty title. It is a real change to
		// the conversation and the projection needs to see it; what the projection
		// must not do is blank out a label on the strength of it.
		title := ""
		if p.ThreadName != nil {
			title = strings.TrimSpace(*p.ThreadName)
		}
		return []ports.ChatEvent{{
			Kind:  ports.ChatEventThreadRenamed,
			Title: title,
		}}

	case "serverRequest/resolved":
		var p resolvedEnvelope
		if err := json.Unmarshal(n.Params, &p); err != nil {
			return nil
		}
		id := rawID(p.RequestID)
		if id == "" {
			id = rawID(p.ID)
		}
		if id == "" {
			return nil
		}
		return []ports.ChatEvent{{
			Kind:      ports.ChatEventApprovalResolved,
			RequestID: id,
		}}

	case "error":
		return []ports.ChatEvent{{
			Kind: ports.ChatEventError,
			Err:  fmt.Errorf("provider error: %s", truncateForLog(n.Params)),
		}}

	default:
		// Provider bookkeeping: mcpServer/startupStatus/updated, hook/started,
		// hook/completed, account/rateLimits/updated, thread/status/changed,
		// remoteControl/status/changed, deprecationNotice, thread/goal/*, and
		// anything added by a newer provider build. Deliberately not conversation
		// events.
		return nil
	}
}

// normalizeItem maps an item lifecycle notification. Assistant text is a message;
// everything else is an activity with a typed payload.
func normalizeItem(params json.RawMessage, completed bool) []ports.ChatEvent {
	var p itemEnvelope
	if err := json.Unmarshal(params, &p); err != nil {
		return nil
	}
	it := p.Item

	// The user's own message comes back from the provider as an item. AO already
	// persisted it when the send was accepted, so re-emitting it would duplicate
	// the timeline entry.
	if it.Type == itemUserMessage {
		return nil
	}

	if it.Type == itemAgentMessage {
		if !completed {
			// The message row is created by the first delta; a started event
			// with no text adds nothing.
			return nil
		}
		return []ports.ChatEvent{{
			Kind:           ports.ChatEventMessageCompleted,
			ProviderTurnID: p.TurnID,
			ProviderItemID: it.ID,
			Text:           it.Text,
		}}
	}

	kind, summary, ok := activityFor(it)
	if !ok {
		return nil
	}

	ev := ports.ChatEvent{
		ProviderTurnID: p.TurnID,
		ProviderItemID: it.ID,
		ActivityKind:   kind,
		Summary:        summary,
		Detail:         activityDetail(it),
	}
	if completed {
		ev.Kind = ports.ChatEventActivityCompleted
		ev.ActivityStatus = domain.ActivityStatusCompleted
		if it.ExitCode != nil && *it.ExitCode != 0 {
			ev.ActivityStatus = domain.ActivityStatusFailed
		}
		if it.Type == itemError {
			ev.ActivityStatus = domain.ActivityStatusFailed
		}
	} else {
		ev.Kind = ports.ChatEventActivityStarted
		ev.ActivityStatus = domain.ActivityStatusRunning
	}
	return []ports.ChatEvent{ev}
}

// activityFor maps a provider item type onto an activity kind and label.
func activityFor(it threadItem) (domain.ActivityKind, string, bool) {
	switch it.Type {
	case itemCommandExecution:
		return domain.ActivityKindCommand, commandSummary(it.Command), true
	case itemFileChange:
		return domain.ActivityKindFileChange, "Edited files", true
	case itemPlan:
		return domain.ActivityKindPlan, "Updated plan", true
	case itemReasoning:
		return domain.ActivityKindReasoning, "Reasoning", true
	case itemMcpToolCall:
		name := firstNonEmpty(it.ToolName, "tool")
		return domain.ActivityKindCommand, "Called " + name, true
	case itemWebSearch:
		return domain.ActivityKindCommand, "Searched the web", true
	case itemError:
		return domain.ActivityKindError, firstNonEmpty(it.Message, "Provider error"), true
	default:
		return "", "", false
	}
}

// commandSummary produces a one-line label. Codex wraps commands in a shell
// invocation (`/bin/zsh -lc '…'`); the wrapper is noise in a timeline.
func commandSummary(command string) string {
	cmd := unwrapShell(strings.TrimSpace(command))
	if cmd == "" {
		return "Ran a command"
	}
	const max = 120
	if len(cmd) > max {
		return cmd[:max] + "…"
	}
	return cmd
}

// unwrapShell strips a leading `<shell> -lc '<cmd>'` wrapper when present.
func unwrapShell(command string) string {
	for _, flag := range []string{" -lc ", " -c "} {
		if idx := strings.Index(command, flag); idx > 0 && looksLikeShell(command[:idx]) {
			inner := strings.TrimSpace(command[idx+len(flag):])
			return strings.Trim(inner, `"'`)
		}
	}
	return command
}

func looksLikeShell(prefix string) bool {
	base := prefix
	if idx := strings.LastIndex(prefix, "/"); idx >= 0 {
		base = prefix[idx+1:]
	}
	switch base {
	case "sh", "bash", "zsh", "dash", "fish":
		return true
	default:
		return false
	}
}

// activityDetail is the provider-neutral payload AO persists for an activity.
// Provider DTOs are not passed through: only named fields AO renders.
func activityDetail(it threadItem) []byte {
	detail := map[string]any{}
	if it.Command != "" {
		detail["command"] = unwrapShell(it.Command)
		detail["rawCommand"] = it.Command
	}
	if it.Cwd != "" {
		detail["cwd"] = it.Cwd
	}
	if it.AggregatedOutput != "" {
		// Marked partial because the provider's own aggregation was observed to
		// drop leading output. A reader must not present it as the full record.
		detail["output"] = it.AggregatedOutput
		detail["outputMayBePartial"] = true
	}
	if it.ExitCode != nil {
		detail["exitCode"] = *it.ExitCode
	}
	if it.DurationMs != nil {
		detail["durationMs"] = *it.DurationMs
	}
	if it.Text != "" {
		detail["text"] = it.Text
	}
	if len(it.Changes) > 0 {
		detail["changes"] = json.RawMessage(it.Changes)
	}
	if it.ToolName != "" {
		detail["toolName"] = it.ToolName
	}
	if it.Server != "" {
		detail["server"] = it.Server
	}
	if it.Message != "" {
		detail["message"] = it.Message
	}
	if len(detail) == 0 {
		return nil
	}
	encoded, err := json.Marshal(detail)
	if err != nil {
		return nil
	}
	return encoded
}

// turnStateFrom maps a provider turn status onto AO's turn state. An unknown
// status is failed rather than completed: claiming success AO did not observe is
// worse than reporting an honest unknown failure.
func turnStateFrom(status string) domain.TurnState {
	switch status {
	case "completed":
		return domain.TurnStateCompleted
	case "interrupted", "cancelled", "canceled":
		return domain.TurnStateInterrupted
	case "inProgress", "in_progress", "running", "active":
		return domain.TurnStateRunning
	case "queued", "pending":
		return domain.TurnStateQueued
	default:
		return domain.TurnStateFailed
	}
}

// rawID stringifies a JSON-RPC id, which the protocol allows to be either a
// number or a string. `null`, absent, and empty all yield "".
func rawID(raw json.RawMessage) string {
	s := strings.TrimSpace(string(raw))
	if s == "" || s == "null" {
		return ""
	}
	return strings.Trim(s, `"`)
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}

func truncateForLog(raw []byte) string {
	const max = 400
	s := string(raw)
	if len(s) > max {
		return s[:max] + "…"
	}
	return s
}
