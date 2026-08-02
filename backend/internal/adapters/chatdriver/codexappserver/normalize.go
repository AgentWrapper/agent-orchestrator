package codexappserver

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"

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
	// itemContextCompaction is how a current app-server reports that it summarized
	// earlier history to reclaim context. The schema also declares a
	// `thread/compacted` notification for the same thing and marks it "Deprecated:
	// use the ContextCompaction item type instead" — and 0.146.0 emits ONLY the
	// item, never the notification. Reading the notification alone would mean AO
	// silently never noticed a compaction on any current provider.
	itemContextCompaction = "contextCompaction"
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

// deltaEnvelope is the params shape of item/agentMessage/delta, and of
// item/commandExecution/outputDelta, which is byte-for-byte the same shape.
type deltaEnvelope struct {
	ThreadID string `json:"threadId"`
	TurnID   string `json:"turnId"`
	ItemID   string `json:"itemId"`
	Delta    string `json:"delta"`
}

// turnDiffEnvelope is the params shape of turn/diff/updated. The diff is one
// aggregated git unified diff string for the whole turn, not a per-file list.
type turnDiffEnvelope struct {
	ThreadID string `json:"threadId"`
	TurnID   string `json:"turnId"`
	Diff     string `json:"diff"`
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

// tokenBreakdown is one Codex TokenUsageBreakdown.
type tokenBreakdown struct {
	InputTokens           int64 `json:"inputTokens"`
	CachedInputTokens     int64 `json:"cachedInputTokens"`
	CacheWriteInputTokens int64 `json:"cacheWriteInputTokens"`
	OutputTokens          int64 `json:"outputTokens"`
	ReasoningOutputTokens int64 `json:"reasoningOutputTokens"`
	TotalTokens           int64 `json:"totalTokens"`
}

// usageEnvelope is the params shape of thread/tokenUsage/updated.
//
// The payload field is `tokenUsage`, not `usage`. An earlier build read `usage`
// and so recorded an empty payload on every update: the readout it fed could only
// ever have been blank. Verified against a captured frame from codex-cli 0.146.0.
type usageEnvelope struct {
	ThreadID   string `json:"threadId"`
	TurnID     string `json:"turnId"`
	TokenUsage struct {
		// Last is the most recent request's accounting. It is the conversation's
		// position in the context window, because a turn resends the whole
		// conversation: the last request's input IS the context currently in use.
		Last tokenBreakdown `json:"last"`
		// Total is the cumulative spend across the thread. It grows without bound
		// and says nothing about how full the conversation is.
		Total tokenBreakdown `json:"total"`
		// ModelContextWindow is absent for models the provider will not state a
		// window for, which is why the meter has to tolerate a missing scale.
		ModelContextWindow int64 `json:"modelContextWindow"`
	} `json:"tokenUsage"`
}

// rateLimitWindow is one Codex RateLimitWindow.
//
// UsedPercent is a percentage in 0..100, not a token count, and ResetsAt is an
// absolute unix timestamp in seconds rather than a duration. Both were confirmed
// against a live account: `{"usedPercent":71,"windowDurationMins":10080,
// "resetsAt":1786159947}`.
type rateLimitWindow struct {
	UsedPercent        *float64 `json:"usedPercent"`
	WindowDurationMins *int64   `json:"windowDurationMins"`
	ResetsAt           *int64   `json:"resetsAt"`
}

// rateLimitsEnvelope is the params shape of account/rateLimits/updated and the
// result shape of account/rateLimits/read.
type rateLimitsEnvelope struct {
	RateLimits struct {
		Primary   *rateLimitWindow `json:"primary"`
		Secondary *rateLimitWindow `json:"secondary"`
		PlanType  string           `json:"planType"`
	} `json:"rateLimits"`
}

// contextEnvelope reads the conversation's position in the model's context out of
// a thread/tokenUsage/updated notification.
//
// `last` and `total` are different questions and only one of them answers "how
// full is this conversation". Measured across a compaction: total stayed at 15650
// (cumulative spend, which compaction cannot undo) while last fell from 15650 to
// 4632. So last.totalTokens is the context position, and it is the only figure
// from which a reclaim can be computed.
type contextEnvelope struct {
	TokenUsage struct {
		Last struct {
			TotalTokens int64 `json:"totalTokens"`
		} `json:"last"`
		ModelContextWindow *int64 `json:"modelContextWindow"`
	} `json:"tokenUsage"`
}

// compactedEnvelope is the params shape of the deprecated thread/compacted
// notification. It carries no token figures at all, which is why the reclaim has
// to be bracketed from token-usage reports rather than read off the event.
type compactedEnvelope struct {
	ThreadID string `json:"threadId"`
	TurnID   string `json:"turnId"`
}

// contextPositionFrom reports the conversation's context position, or ok=false for
// a notification that is not a token-usage report.
func contextPositionFrom(n notification) (used, window int64, ok bool) {
	if n.Method != "thread/tokenUsage/updated" {
		return 0, 0, false
	}
	var p contextEnvelope
	if err := json.Unmarshal(n.Params, &p); err != nil {
		return 0, 0, false
	}
	if p.TokenUsage.ModelContextWindow != nil {
		window = *p.TokenUsage.ModelContextWindow
	}
	return p.TokenUsage.Last.TotalTokens, window, true
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
//
// now is passed rather than read from the clock so the rate-limit reset instant
// can be expressed as a duration deterministically. The provider reports an
// absolute timestamp; a duration is what a reader can act on without knowing
// whether AO's clock agrees with the provider's.
func normalizeNotification(n notification, now time.Time) []ports.ChatEvent {
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

	case "item/commandExecution/outputDelta":
		// Streamed stdout/stderr from a running command. Two things make this worth
		// accumulating rather than waiting for aggregatedOutput on item/completed:
		// the aggregate does not exist until the command ends, so a long command
		// shows nothing while it runs; and a commandExecution that never completes
		// (three starts producing one completion has been observed) has no
		// aggregate at all, only these.
		//
		// It does NOT make the record complete. Measured on codex-cli 0.146.0: a
		// command printing tick-1..tick-8 one per second produced 7 deltas starting
		// at tick-2, and an aggregate of exactly those same 7 lines. The first
		// chunk is lost upstream of both channels, so a reader still has to say the
		// output may be partial.
		var p deltaEnvelope
		if err := json.Unmarshal(n.Params, &p); err != nil || p.Delta == "" {
			return nil
		}
		return []ports.ChatEvent{{
			Kind:           ports.ChatEventCommandOutputDelta,
			ProviderTurnID: p.TurnID,
			ProviderItemID: p.ItemID,
			Delta:          p.Delta,
		}}

	case "turn/diff/updated":
		// The turn's running diff. Re-sent whole on every update (observed three
		// times with byte-identical payloads in one turn), so a projector must
		// overwrite per-turn state and must not append a timeline entry per update.
		var p turnDiffEnvelope
		if err := json.Unmarshal(n.Params, &p); err != nil {
			return nil
		}
		files, truncated := parseTurnDiff(p.Diff)
		if len(files) == 0 {
			// An empty diff is a real state: the turn has changed nothing on disk
			// yet. Reporting it keeps a stale file list from surviving an undo.
			return []ports.ChatEvent{{
				Kind:           ports.ChatEventTurnDiff,
				ProviderTurnID: p.TurnID,
				Diff:           &ports.ChatTurnDiff{},
			}}
		}
		ev := ports.ChatEvent{
			Kind:           ports.ChatEventTurnDiff,
			ProviderTurnID: p.TurnID,
			Diff:           &ports.ChatTurnDiff{Files: files},
		}
		if truncated {
			// Carried in Summary because ChatTurnDiff has nowhere to say it, and a
			// cut list presented as a whole one would understate the change.
			ev.Summary = domain.ChatDiffTruncatedSummary
		}
		return []ports.ChatEvent{ev}

	case "item/started":
		return normalizeItem(n.Params, false)

	case "item/completed":
		return normalizeItem(n.Params, true)

	case "thread/tokenUsage/updated":
		var p usageEnvelope
		if err := json.Unmarshal(n.Params, &p); err != nil {
			return nil
		}
		// A typed usage event rather than an activity. The provider emits one of
		// these after every tool call, so a timeline row per report is what buried
		// the conversation; this is current state, and the projection overwrites.
		return []ports.ChatEvent{{
			Kind:           ports.ChatEventUsage,
			ProviderTurnID: p.TurnID,
			Usage: &ports.ChatUsage{
				InputTokens:  p.TokenUsage.Total.InputTokens,
				OutputTokens: p.TokenUsage.Total.OutputTokens,
				CachedTokens: p.TokenUsage.Total.CachedInputTokens,
				TotalTokens:  p.TokenUsage.Total.TotalTokens,
				// Context fullness comes from the LAST request, not the cumulative
				// total: a turn resends the whole conversation, so the last
				// request's size is what is actually occupying the window. Using
				// the running total here would report a conversation as over
				// capacity long before it was.
				ContextUsed:   p.TokenUsage.Last.TotalTokens,
				ContextWindow: p.TokenUsage.ModelContextWindow,
			},
		}}

	case "account/rateLimits/updated":
		var p rateLimitsEnvelope
		if err := json.Unmarshal(n.Params, &p); err != nil {
			return nil
		}
		limits := rateLimitsFrom(p, now)
		return []ports.ChatEvent{{Kind: ports.ChatEventRateLimits, RateLimits: &limits}}
	case "thread/compacted":
		// The deprecated spelling, kept for a provider build old enough to send it.
		// A build that sends both this and the contextCompaction item would report
		// one compaction twice, so the conversation dedupes on the turn id.
		var p compactedEnvelope
		if err := json.Unmarshal(n.Params, &p); err != nil {
			return nil
		}
		return []ports.ChatEvent{{
			Kind:           ports.ChatEventCompacted,
			ProviderTurnID: p.TurnID,
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
		// hook/completed, thread/status/changed, remoteControl/status/changed,
		// thread/goal/*, model/safetyBuffering/updated, and anything added by a
		// newer provider build. Deliberately not conversation events.
		//
		// Two neighbours of the streaming methods above are also deliberately here:
		//
		//   - item/fileChange/outputDelta is documented in the generated schema as
		//     "Deprecated legacy notification for apply_patch textual output. The
		//     server no longer emits this notification." Handling it would be dead
		//     code that looks load-bearing.
		//   - item/fileChange/patchUpdated carries one item's structured changes.
		//     turn/diff/updated already reports the turn's aggregate, and taking
		//     both would mean AO reconciling two accounts of the same edits.
		//
		//   - command/exec/outputDelta and process/outputDelta belong to the
		//     client-driven exec API, where the CLIENT asked the server to run
		//     something. AO does not use it, and an agent tool call never arrives
		//     on those methods.
		return nil
	}
}

// rateLimitsFrom converts a provider rate-limit snapshot into AO's neutral shape.
//
// Two conversions matter. A window the account does not have comes back as null,
// and is reported as a negative percent because the port's contract is that
// negative means "not reported" — zero would claim the quota is untouched, which
// is a different and much more reassuring statement than "no such window".
// Second, the absolute reset timestamp becomes a remaining duration: a client
// showing "resets in 4h" does not have to trust that AO's clock and the
// provider's agree, and a stale snapshot decays into 0 rather than into a time in
// the past that reads as if it already refilled.
func rateLimitsFrom(p rateLimitsEnvelope, now time.Time) ports.ChatRateLimits {
	limits := ports.ChatRateLimits{
		PrimaryUsedPercent:   -1,
		SecondaryUsedPercent: -1,
		PlanLabel:            p.RateLimits.PlanType,
	}
	if w := p.RateLimits.Primary; w != nil && w.UsedPercent != nil {
		limits.PrimaryUsedPercent = *w.UsedPercent
		limits.PrimaryResetsInSeconds = resetsIn(w.ResetsAt, now)
	}
	if w := p.RateLimits.Secondary; w != nil && w.UsedPercent != nil {
		limits.SecondaryUsedPercent = *w.UsedPercent
		limits.SecondaryResetsInSeconds = resetsIn(w.ResetsAt, now)
	}
	return limits
}

// resetsIn turns an absolute unix reset instant into seconds from now, floored at
// zero: a window whose reset has already passed has nothing left to wait for.
func resetsIn(resetsAt *int64, now time.Time) int64 {
	if resetsAt == nil || *resetsAt <= 0 {
		return 0
	}
	remaining := *resetsAt - now.Unix()
	if remaining < 0 {
		return 0
	}
	return remaining
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

	if it.Type == itemContextCompaction {
		if !completed {
			// A compaction in flight is not yet a fact about the conversation, and the
			// reclaim is unknown until it settles: the reduced token figure arrives
			// between the item starting and completing. Emitting on start would put a
			// row in the timeline that has to be rewritten with the real numbers.
			return nil
		}
		return []ports.ChatEvent{{
			Kind:           ports.ChatEventCompacted,
			ProviderTurnID: p.TurnID,
			ProviderItemID: it.ID,
		}}
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
		// Named so a reader can tell this from the accumulated delta stream. Only
		// the aggregate exists for a fast command, where the provider finishes
		// before it flushes a single delta; only the stream exists for a command
		// that never completes. Both are partial, for different reasons.
		detail["outputSource"] = "aggregate"
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
