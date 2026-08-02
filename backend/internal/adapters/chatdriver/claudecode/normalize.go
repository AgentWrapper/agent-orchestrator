package claudecode

import (
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// Translation from Claude Code stream-json frames into AO's provider-neutral
// Chat events.
//
// The rule is the same conservative one the Codex normalizer follows: a frame
// this build does not model produces no event at all. Guessing semantics for an
// unrecognized frame is how a timeline starts lying. That matters more here than
// it does for Codex, because the CLI is noisy in a way an app-server is not: one
// trivial turn in the capture this package's fixtures come from emitted three
// `system/hook_started` frames, three `system/hook_response`, two
// `system/thinking_tokens`, and a `system/status`, none of which are anything a
// person reading a conversation wants to see.
//
// Two structural facts about this protocol shape everything below.
//
// First, THE CLI HAS NO TURN IDENTITY. No frame carries a turn id, and sending a
// user message is fire-and-forget: there is no acknowledgement to read one out
// of. So AO mints the id in SendTurn and this normalizer stamps it on every event
// until the turn's `result` arrives. The id is AO's own correlation handle, and
// nothing is ever sent back to the CLI under it.
//
// Second, ASSISTANT TEXT ARRIVES TWICE: once as `stream_event` deltas (only with
// --include-partial-messages) and once whole in the settled `assistant` frame.
// Both are used, keyed on the same synthetic item id, so a delta stream and its
// settled text fold into one timeline row rather than two.

// Frame types AO reads. Everything else falls through to nothing.
const (
	frameSystem        = "system"
	frameAssistant     = "assistant"
	frameUser          = "user"
	frameStreamEvent   = "stream_event"
	frameResult        = "result"
	frameRateLimit     = "rate_limit_event"
	frameToolProgress  = "tool_progress"
	frameSystemInit    = "init"
	frameSystemCompact = "compact_boundary"
	frameSystemDenied  = "permission_denied"
)

// contentBlock is one entry of an Anthropic message's content array.
type contentBlock struct {
	Type string `json:"type"`
	// text / thinking
	Text     string `json:"text"`
	Thinking string `json:"thinking"`
	// tool_use
	ID    string          `json:"id"`
	Name  string          `json:"name"`
	Input json.RawMessage `json:"input"`
	// tool_result, on the echoed `user` frame
	ToolUseID string          `json:"tool_use_id"`
	Content   json.RawMessage `json:"content"`
	IsError   bool            `json:"is_error"`
}

// messageEnvelope is the shape of both the `assistant` and `user` frames: a full
// Anthropic message plus AO-irrelevant routing fields.
type messageEnvelope struct {
	Message struct {
		ID      string         `json:"id"`
		Role    string         `json:"role"`
		Content []contentBlock `json:"content"`
		Usage   *tokenUsage    `json:"usage"`
	} `json:"message"`
	// ParentToolUseID is set when the message came from a subagent the main agent
	// spawned. Read so a subagent's chatter can be told apart from the main
	// thread's, which is the difference between one conversation and several
	// interleaved ones.
	//
	// The frame also carries truncated_by_interrupt for a message the CLI cut off
	// mid-stream. It is not read: the neutral event has nowhere to say "this text
	// may end mid-word", and the interrupted turn state already tells a reader the
	// answer was cut short.
	ParentToolUseID string `json:"parent_tool_use_id"`
}

// tokenUsage is the Anthropic usage block, present on assistant messages and on
// the turn result.
type tokenUsage struct {
	InputTokens              int64 `json:"input_tokens"`
	OutputTokens             int64 `json:"output_tokens"`
	CacheReadInputTokens     int64 `json:"cache_read_input_tokens"`
	CacheCreationInputTokens int64 `json:"cache_creation_input_tokens"`
}

// contextTokens is the conversation's position in the model's context window.
//
// A request re-sends the whole conversation, so what occupies the window is the
// sum of everything that went into the last request: the fresh input, plus the
// prefix read from cache, plus the prefix written to it. Measured across two
// consecutive turns of one capture: 2 + 17207 + 52437 = 69646, and the next
// turn's cache read was 69644 — the same conversation, one turn later.
func (u *tokenUsage) contextTokens() int64 {
	if u == nil {
		return 0
	}
	return u.InputTokens + u.CacheReadInputTokens + u.CacheCreationInputTokens
}

// resultEnvelope is the terminal frame of a turn.
//
// The frame also carries num_turns, stop_reason, total_cost_usd, ttft timings and
// a per-iteration token breakdown. None is read: they describe the request rather
// than the conversation, and AO has nowhere neutral to put them.
type resultEnvelope struct {
	Subtype string `json:"subtype"`
	IsError bool   `json:"is_error"`
	// TerminalReason is the CLI's own account of why the turn ended, and is the
	// only place an interrupt is distinguishable from a failure.
	TerminalReason string      `json:"terminal_reason"`
	Errors         []string    `json:"errors"`
	Usage          *tokenUsage `json:"usage"`
	// ModelUsage is keyed by model id and is the only place the CLI states the
	// context window, which the used-token figure is meaningless without.
	ModelUsage map[string]struct {
		ContextWindow int64 `json:"contextWindow"`
	} `json:"modelUsage"`
	// PermissionDenials lists tool calls that never ran. They are reported so a
	// user is not left wondering why the agent said it would do something and then
	// did not.
	PermissionDenials []struct {
		ToolName  string `json:"tool_name"`
		ToolUseID string `json:"tool_use_id"`
	} `json:"permission_denials"`
}

// streamEnvelope is a `stream_event`: one raw Anthropic streaming event.
type streamEnvelope struct {
	Event struct {
		Type    string `json:"type"`
		Index   int    `json:"index"`
		Message struct {
			ID string `json:"id"`
		} `json:"message"`
		ContentBlock struct {
			Type string `json:"type"`
		} `json:"content_block"`
		Delta struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"delta"`
	} `json:"event"`
}

// rateLimitEnvelope is a `rate_limit_event`.
//
// utilization is optional and was absent on every frame in the capture (a Team
// account), which is why the neutral shape has to tolerate a rate-limit report
// with no percentage in it. resetsAt is an absolute unix instant in seconds — note
// that get_usage reports the same idea as an RFC3339 string, so the two paths
// cannot share a converter.
//
// The frame also carries status (allowed / allowed_warning / rejected),
// rateLimitType, and an overage block. They are not read: ChatRateLimits has
// nowhere to say "warning" that is not a percentage, and turning a status into one
// would be AO inventing a figure the CLI declined to give.
type rateLimitEnvelope struct {
	Info struct {
		ResetsAt    *int64   `json:"resetsAt"`
		Utilization *float64 `json:"utilization"`
	} `json:"rate_limit_info"`
}

// compactEnvelope is a `system/compact_boundary`. Unlike Codex, the CLI states
// both sides of the reclaim outright, so nothing has to be bracketed.
type compactEnvelope struct {
	Meta struct {
		Trigger    string `json:"trigger"`
		PreTokens  int64  `json:"pre_tokens"`
		PostTokens int64  `json:"post_tokens"`
	} `json:"compact_metadata"`
}

// deniedEnvelope is a `system/permission_denied`: a tool call auto-denied with no
// prompt, by a deny rule or by auto mode's classifier. It is a different path
// from the can_use_tool ask, and without it the user sees the agent silently fail
// to act.
type deniedEnvelope struct {
	ToolName  string          `json:"tool_name"`
	ToolUseID string          `json:"tool_use_id"`
	Reason    string          `json:"reason"`
	ToolInput json.RawMessage `json:"tool_input"`
}

// normalizer converts one conversation's frames into neutral events.
//
// It holds the state the protocol does not carry: the id AO minted for the turn
// in flight, and the identity of the assistant message currently streaming.
type normalizer struct {
	// mu guards turnID only. Everything else is touched solely by the pump
	// goroutine; the turn id is also written by SendTurn.
	mu     sync.Mutex
	turnID string

	// streamMessageID is the Anthropic message id of the partial message being
	// streamed, and streamText records which of its content blocks are text. A
	// content_block_delta names only its index, so without these a thinking delta
	// and a text delta are indistinguishable.
	streamMessageID string
	streamText      map[int]bool

	// contextWindow is remembered across turns: the CLI states it on the result's
	// modelUsage, and a usage report with no window is a number with no scale.
	contextWindow int64
}

func newNormalizer() *normalizer {
	return &normalizer{streamText: map[int]bool{}}
}

// beginTurn records the id AO minted for a turn it is about to dispatch.
func (n *normalizer) beginTurn(id string) {
	n.mu.Lock()
	defer n.mu.Unlock()
	n.turnID = id
}

// currentTurn is the turn every event is stamped with.
func (n *normalizer) currentTurn() string {
	n.mu.Lock()
	defer n.mu.Unlock()
	return n.turnID
}

// endTurn clears and returns the turn id, so a result settles exactly the turn it
// belongs to even if the next one is dispatched immediately.
func (n *normalizer) endTurn() string {
	n.mu.Lock()
	defer n.mu.Unlock()
	id := n.turnID
	n.turnID = ""
	return id
}

// normalize converts one inbound frame into zero or more neutral events.
// Returning nil means "not conversation-relevant".
//
// now is passed rather than read from the clock so a rate-limit reset instant can
// become a remaining duration deterministically. The CLI reports an absolute
// timestamp; a duration is what a reader can act on without having to trust that
// AO's clock and the CLI's agree.
func (n *normalizer) normalize(f notification, now time.Time) []ports.ChatEvent {
	switch f.Type {
	case frameSystem:
		return n.system(f, now)
	case frameAssistant:
		return n.assistant(f)
	case frameUser:
		return n.userFrame(f)
	case frameStreamEvent:
		return n.streamEvent(f)
	case frameResult:
		return n.result(f)
	case frameRateLimit:
		return n.rateLimit(f, now)

	case frameToolProgress:
		// A heartbeat: tool_use_id plus elapsed seconds, and no output bytes at
		// all. Dropped deliberately, and worth naming because it is the frame a
		// reader would expect to carry streamed command output. Nothing in this
		// protocol does — a command's output arrives whole in the tool_result on
		// the echoed `user` frame — which is why this driver never emits
		// ChatEventCommandOutputDelta.
		return nil

	default:
		// Frames the CLI emits that are not conversation events:
		// task_started/task_updated/task_progress/task_notification (background
		// task bookkeeping), api_retry, tool_use_summary, memory_recall,
		// files_persisted, notification, informational, plugin_install,
		// session_state_changed, worker_shutting_down, commands_changed,
		// elicitation_complete, prompt_suggestion, mirror_error,
		// conversation_reset, and anything a newer CLI adds.
		return nil
	}
}

func (n *normalizer) system(f notification, _ time.Time) []ports.ChatEvent {
	switch f.Subtype {
	case frameSystemInit:
		// The CLI has taken the turn. This is the acknowledgement an interrupt
		// needs: before it, there is nothing for the CLI to cancel.
		//
		// It is emitted once per TURN, not once per process — the capture shows one
		// before each of two turns on the same child, carrying the same session_id
		// both times. None of its payload is read: the session id is AO's own (passed
		// in with --session-id), and its tools, skills, agents, and capabilities
		// lists describe the install rather than the conversation.
		turn := n.currentTurn()
		if turn == "" {
			// A turn AO did not dispatch. There is no id to correlate its events
			// under, and minting one here would create a timeline row nothing else
			// ever refers to.
			return nil
		}
		return []ports.ChatEvent{{Kind: ports.ChatEventTurnStarted, ProviderTurnID: turn}}

	case frameSystemCompact:
		var p compactEnvelope
		if err := json.Unmarshal(f.Raw, &p); err != nil {
			return nil
		}
		return []ports.ChatEvent{compactionEvent(p)}

	case frameSystemDenied:
		var p deniedEnvelope
		if err := json.Unmarshal(f.Raw, &p); err != nil {
			return nil
		}
		detail := map[string]any{"toolName": p.ToolName}
		if p.Reason != "" {
			detail["reason"] = p.Reason
		}
		if len(p.ToolInput) > 0 {
			detail["input"] = p.ToolInput
		}
		return []ports.ChatEvent{{
			Kind:           ports.ChatEventActivityCompleted,
			ProviderTurnID: n.currentTurn(),
			// Keyed on the tool use so the denial lands on the activity the
			// tool_use already created rather than adding a second row for the
			// same call.
			ProviderItemID: p.ToolUseID,
			ActivityKind:   domain.ActivityKindApproval,
			ActivityStatus: domain.ActivityStatusFailed,
			Summary:        deniedSummary(p),
			Detail:         encodeDetail(detail),
		}}

	default:
		// hook_started, hook_response, hook_progress, status, thinking_tokens,
		// commands_changed, task_*, background_tasks_changed, mcp status noise.
		// One trivial turn produced eleven of these; none of them is something a
		// person reading a conversation needs to see.
		return nil
	}
}

// assistant maps a settled assistant message. One frame can carry several content
// blocks, and each becomes its own timeline entry.
func (n *normalizer) assistant(f notification) []ports.ChatEvent {
	var p messageEnvelope
	if err := json.Unmarshal(f.Raw, &p); err != nil {
		return nil
	}
	turn := n.currentTurn()

	events := make([]ports.ChatEvent, 0, len(p.Message.Content))
	for i, block := range p.Message.Content {
		switch block.Type {
		case "text":
			if strings.TrimSpace(block.Text) == "" {
				continue
			}
			events = append(events, ports.ChatEvent{
				Kind:           ports.ChatEventMessageCompleted,
				ProviderTurnID: turn,
				ProviderItemID: blockItemID(p.Message.ID, i),
				Text:           block.Text,
			})

		case "thinking":
			text := firstNonEmpty(block.Thinking, block.Text)
			if strings.TrimSpace(text) == "" {
				continue
			}
			// Reasoning is its own activity kind precisely so a client can hide it
			// without parsing message text. It is never a message: presenting the
			// model's scratchpad as an answer is the wrong reading of it.
			events = append(events, ports.ChatEvent{
				Kind:           ports.ChatEventActivityCompleted,
				ProviderTurnID: turn,
				ProviderItemID: blockItemID(p.Message.ID, i),
				ActivityKind:   domain.ActivityKindReasoning,
				ActivityStatus: domain.ActivityStatusCompleted,
				Summary:        "Thinking",
				Detail:         encodeDetail(map[string]any{"text": text}),
			})

		case "tool_use":
			kind, summary := toolActivity(block.Name, block.Input)
			events = append(events, ports.ChatEvent{
				Kind:           ports.ChatEventActivityStarted,
				ProviderTurnID: turn,
				// The tool_use id, so the tool_result that arrives later settles
				// this exact row.
				ProviderItemID: block.ID,
				ActivityKind:   kind,
				ActivityStatus: domain.ActivityStatusRunning,
				Summary:        summary,
				Detail:         toolDetail(block.Name, block.Input, p.ParentToolUseID),
			})

		default:
			// server_tool_use, web_search_tool_result, document, image, and
			// whatever the API adds next. Not modelled rather than guessed at.
		}
	}

	if p.Message.Usage != nil {
		// Every assistant message restates the accounting, which is what keeps a
		// context readout live during a long tool-using turn instead of only
		// updating when the turn ends.
		events = append(events, n.usageEvent(turn, p.Message.Usage, 0))
	}
	return events
}

// userFrame maps the tool results the CLI echoes back. The user's own prompt also
// arrives on this frame type and is deliberately not re-emitted: AO recorded it
// when the send was accepted, so echoing it would duplicate the timeline entry.
func (n *normalizer) userFrame(f notification) []ports.ChatEvent {
	var p messageEnvelope
	if err := json.Unmarshal(f.Raw, &p); err != nil {
		return nil
	}
	turn := n.currentTurn()

	var events []ports.ChatEvent
	for _, block := range p.Message.Content {
		if block.Type != "tool_result" || block.ToolUseID == "" {
			continue
		}
		status := domain.ActivityStatusCompleted
		if block.IsError {
			status = domain.ActivityStatusFailed
		}
		detail := map[string]any{}
		if output := toolResultText(block.Content); output != "" {
			detail["output"] = output
		}
		if block.IsError {
			detail["isError"] = true
		}
		events = append(events, ports.ChatEvent{
			Kind:           ports.ChatEventActivityCompleted,
			ProviderTurnID: turn,
			ProviderItemID: block.ToolUseID,
			ActivityStatus: status,
			// Kind and Summary are deliberately left empty: the row already exists
			// from the tool_use, and the upsert must not overwrite a real label with
			// a generic one derived from a result that does not name the tool.
			Detail: encodeDetail(detail),
		})
	}
	return events
}

// streamEvent maps partial assistant output. Only text deltas produce anything:
// they are the whole reason --include-partial-messages is passed, and everything
// else on this channel duplicates a settled frame that arrives moments later.
func (n *normalizer) streamEvent(f notification) []ports.ChatEvent {
	var p streamEnvelope
	if err := json.Unmarshal(f.Raw, &p); err != nil {
		return nil
	}
	ev := p.Event

	switch ev.Type {
	case "message_start":
		// The only place a partial message states its id. A delta names just an
		// index, so without this there is nothing to key the accumulating row on.
		n.streamMessageID = ev.Message.ID
		n.streamText = map[int]bool{}
		return nil

	case "content_block_start":
		if ev.ContentBlock.Type == "text" {
			n.streamText[ev.Index] = true
		}
		return nil

	case "content_block_delta":
		// text_delta only. thinking_delta and input_json_delta are dropped: the
		// first belongs to an activity that has no streaming form, and the second
		// is a half-built tool argument that would render as broken JSON.
		if ev.Delta.Type != "text_delta" || ev.Delta.Text == "" {
			return nil
		}
		if !n.streamText[ev.Index] || n.streamMessageID == "" {
			return nil
		}
		return []ports.ChatEvent{{
			Kind:           ports.ChatEventMessageDelta,
			ProviderTurnID: n.currentTurn(),
			// The same key the settled `assistant` frame will use, so the deltas and
			// the final text are one row and not two.
			ProviderItemID: blockItemID(n.streamMessageID, ev.Index),
			Delta:          ev.Delta.Text,
		}}

	default:
		// content_block_stop, message_delta, message_stop. The settled `assistant`
		// frame reports all of it, and a stop event carries nothing AO records.
		return nil
	}
}

// result settles the turn. It is the only terminal frame: the CLI emits exactly
// one per turn and then waits for the next message on the same process.
func (n *normalizer) result(f notification) []ports.ChatEvent {
	var p resultEnvelope
	if err := json.Unmarshal(f.Raw, &p); err != nil {
		return nil
	}
	turn := n.endTurn()

	var events []ports.ChatEvent

	// A denial the user never saw a prompt for. Emitted before the completion so
	// the timeline explains the outcome before reporting it.
	for _, denial := range p.PermissionDenials {
		events = append(events, ports.ChatEvent{
			Kind:           ports.ChatEventActivityCompleted,
			ProviderTurnID: turn,
			ProviderItemID: denial.ToolUseID,
			ActivityKind:   domain.ActivityKindApproval,
			ActivityStatus: domain.ActivityStatusFailed,
			Summary:        "Denied " + firstNonEmpty(denial.ToolName, "a tool call"),
			Detail:         encodeDetail(map[string]any{"toolName": denial.ToolName}),
		})
	}

	if p.Usage != nil {
		var window int64
		for _, usage := range p.ModelUsage {
			if usage.ContextWindow > 0 {
				window = usage.ContextWindow
				break
			}
		}
		events = append(events, n.usageEvent(turn, p.Usage, window))
	}

	ev := ports.ChatEvent{
		Kind:           ports.ChatEventTurnCompleted,
		ProviderTurnID: turn,
		TurnState:      turnStateFrom(p),
	}
	if message := resultError(p); message != "" {
		ev.Err = fmt.Errorf("%s", message)
	}
	return append(events, ev)
}

// rateLimit maps the account's quota position.
func (n *normalizer) rateLimit(f notification, now time.Time) []ports.ChatEvent {
	var p rateLimitEnvelope
	if err := json.Unmarshal(f.Raw, &p); err != nil {
		return nil
	}
	// Only one window is pushed, so the secondary stays unreported rather than
	// being filled in with the primary's figures. The on-demand read
	// (ChatUsageReporter) is where both windows come from.
	limits := ports.ChatRateLimits{
		PrimaryUsedPercent:   -1,
		SecondaryUsedPercent: -1,
	}
	if p.Info.Utilization != nil {
		limits.PrimaryUsedPercent = *p.Info.Utilization
	}
	limits.PrimaryResetsInSeconds = resetsIn(p.Info.ResetsAt, now)
	return []ports.ChatEvent{{Kind: ports.ChatEventRateLimits, RateLimits: &limits}}
}

// usageEvent builds a token accounting update, remembering the context window
// across reports that omit it.
func (n *normalizer) usageEvent(turn string, usage *tokenUsage, window int64) ports.ChatEvent {
	if window > 0 {
		n.contextWindow = window
	}
	return ports.ChatEvent{
		Kind:           ports.ChatEventUsage,
		ProviderTurnID: turn,
		Usage: &ports.ChatUsage{
			InputTokens:  usage.InputTokens,
			OutputTokens: usage.OutputTokens,
			CachedTokens: usage.CacheReadInputTokens,
			TotalTokens:  usage.InputTokens + usage.OutputTokens,
			ContextUsed:  usage.contextTokens(),
			// Only the result frame states the window, so an assistant-message
			// update reuses the last one seen. Reporting zero instead would blank
			// the meter's scale every few seconds.
			ContextWindow: n.contextWindow,
		},
	}
}

// compactionEvent reports a history summarization with both sides of the reclaim.
func compactionEvent(p compactEnvelope) ports.ChatEvent {
	before, after := p.Meta.PreTokens, p.Meta.PostTokens
	detail := map[string]any{}
	if p.Meta.Trigger != "" {
		// auto or manual. Worth keeping: a compaction the user did not ask for is a
		// different thing to read about than one they pressed a button for.
		detail["trigger"] = p.Meta.Trigger
	}
	if before > 0 {
		detail["tokensBefore"] = before
	}
	if after > 0 {
		detail["tokensAfter"] = after
	}
	if before > after && after > 0 {
		detail["tokensReclaimed"] = before - after
	}
	return ports.ChatEvent{
		Kind:    ports.ChatEventCompacted,
		Summary: compactionSummary(before, after),
		Detail:  encodeDetail(detail),
	}
}

// compactionSummary labels the reclaim, claiming only a number it actually has.
// post_tokens is optional in the CLI's own type declaration, so a compaction that
// does not state its result must not be reported as having freed zero.
func compactionSummary(before, after int64) string {
	if before <= 0 || after <= 0 || after >= before {
		return "Compacted the conversation history"
	}
	return fmt.Sprintf("Compacted history, freeing %s of context", formatTokens(before-after))
}

// formatTokens renders a token count the way a reader scans it. Exact below a
// thousand, because that is where the digits still mean something.
func formatTokens(tokens int64) string {
	if tokens < 1000 {
		return fmt.Sprintf("%d tokens", tokens)
	}
	return fmt.Sprintf("%.1fk tokens", float64(tokens)/1000)
}

// turnStateFrom maps a result onto AO's turn state.
//
// terminal_reason is load-bearing and is read before is_error: an interrupted
// turn arrives as subtype "error_during_execution" with is_error true, and
// recording the user pressing stop as a failure would put a red row in the
// timeline every time somebody changed their mind. Measured: interrupting a
// counting turn produced terminal_reason "aborted_streaming".
func turnStateFrom(p resultEnvelope) domain.TurnState {
	switch p.TerminalReason {
	case "aborted_streaming", "aborted_tools":
		return domain.TurnStateInterrupted
	case "completed":
		if p.IsError {
			// Reached in the odd case of a turn the CLI considers finished but
			// still flags. Believing terminal_reason over is_error here would claim
			// a success AO did not observe.
			return domain.TurnStateFailed
		}
		return domain.TurnStateCompleted
	case "":
		// An older CLI, or a frame that omits it. is_error is then the only signal.
		if p.IsError {
			return domain.TurnStateFailed
		}
		return domain.TurnStateCompleted
	default:
		// max_turns, prompt_too_long, api_error, budget_exhausted, hook_stopped and
		// the rest of a union that grows. All of them ended the turn short of what
		// was asked, so none is a success.
		return domain.TurnStateFailed
	}
}

// resultError is the message to attach to a failed turn, or "" for one that
// needs none. An interrupt is not an error: the user asked for it.
func resultError(p resultEnvelope) string {
	switch p.TerminalReason {
	case "aborted_streaming", "aborted_tools":
		return ""
	}
	if !p.IsError && p.Subtype == "success" {
		return ""
	}
	if len(p.Errors) > 0 {
		return strings.Join(p.Errors, "; ")
	}
	return firstNonEmpty(p.TerminalReason, p.Subtype, "the turn failed")
}

// toolActivity maps a tool call onto an activity kind and a one-line label.
//
// The names are Claude Code's built-in tools, checked against the `tools` list in
// a captured system/init. An unrecognized name — an MCP tool, a plugin's, or one
// a newer CLI ships — still produces a command activity rather than nothing: a
// tool call the user cannot see is worse than one labelled generically.
func toolActivity(name string, input json.RawMessage) (domain.ActivityKind, string) {
	args := decodeToolInput(input)

	switch name {
	case "Bash", "BashOutput", "KillShell":
		if command := stringArg(args, "command"); command != "" {
			return domain.ActivityKindCommand, truncateLabel(command)
		}
		return domain.ActivityKindCommand, "Ran a command"

	case "Edit", "Write", "NotebookEdit", "MultiEdit":
		if path := stringArg(args, "file_path", "notebook_path"); path != "" {
			return domain.ActivityKindFileChange, verbFor(name) + " " + shortPath(path)
		}
		return domain.ActivityKindFileChange, verbFor(name) + " a file"

	case "Read":
		if path := stringArg(args, "file_path"); path != "" {
			return domain.ActivityKindCommand, "Read " + shortPath(path)
		}
		return domain.ActivityKindCommand, "Read a file"

	case "Glob", "Grep":
		if pattern := stringArg(args, "pattern"); pattern != "" {
			return domain.ActivityKindCommand, "Searched for " + truncateLabel(pattern)
		}
		return domain.ActivityKindCommand, "Searched the workspace"

	case "WebSearch":
		if query := stringArg(args, "query"); query != "" {
			return domain.ActivityKindCommand, "Searched the web for " + truncateLabel(query)
		}
		return domain.ActivityKindCommand, "Searched the web"

	case "WebFetch":
		if url := stringArg(args, "url"); url != "" {
			return domain.ActivityKindCommand, "Fetched " + truncateLabel(url)
		}
		return domain.ActivityKindCommand, "Fetched a page"

	case "TodoWrite", "ExitPlanMode":
		// The agent's own statement of what it intends to do. Its own kind so a
		// client can render it as a plan rather than as one more tool call.
		return domain.ActivityKindPlan, "Updated plan"

	case "Task":
		if desc := stringArg(args, "description"); desc != "" {
			return domain.ActivityKindCommand, "Delegated: " + truncateLabel(desc)
		}
		return domain.ActivityKindCommand, "Delegated to a subagent"

	case "AskUserQuestion":
		// Reported as an activity, not as an approval: the CLI answers this one
		// itself unless the host declared it can render dialogs, and AO does not.
		// Calling it an approval would put a card on screen that nothing resolves.
		return domain.ActivityKindApproval, "Asked a question"

	case "Skill":
		if skill := stringArg(args, "command", "skill"); skill != "" {
			return domain.ActivityKindCommand, "Used skill " + truncateLabel(skill)
		}
		return domain.ActivityKindCommand, "Used a skill"

	default:
		if name == "" {
			return domain.ActivityKindCommand, "Called a tool"
		}
		return domain.ActivityKindCommand, "Called " + name
	}
}

func verbFor(tool string) string {
	if tool == "Write" {
		return "Wrote"
	}
	return "Edited"
}

// toolDetail is the provider-neutral payload AO persists for a tool call.
//
// The whole input is kept: unlike Codex's typed items, a tool's arguments are the
// only description of what it is about to do, and picking a field per tool would
// silently lose everything about the tools this build does not enumerate.
func toolDetail(name string, input json.RawMessage, parentToolUseID string) []byte {
	detail := map[string]any{}
	if name != "" {
		detail["toolName"] = name
	}
	if len(input) > 0 && string(input) != "null" {
		detail["input"] = input
	}
	if parentToolUseID != "" {
		// The call came from a subagent. Recorded so a reader can tell the main
		// thread's work from a delegate's.
		detail["parentToolUseId"] = parentToolUseID
	}
	return encodeDetail(detail)
}

// toolResultText renders a tool_result's content, which the API allows to be
// either a plain string or an array of typed blocks.
func toolResultText(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var asString string
	if err := json.Unmarshal(raw, &asString); err == nil {
		return asString
	}
	var blocks []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if err := json.Unmarshal(raw, &blocks); err != nil {
		return ""
	}
	var parts []string
	for _, block := range blocks {
		if block.Text != "" {
			parts = append(parts, block.Text)
		}
	}
	return strings.Join(parts, "\n")
}

// deniedSummary labels an auto-denied tool call.
func deniedSummary(p deniedEnvelope) string {
	name := firstNonEmpty(p.ToolName, "a tool call")
	if p.Reason != "" {
		return "Denied " + name + ": " + truncateLabel(p.Reason)
	}
	return "Denied " + name
}

// blockItemID is the timeline key for one content block of one message.
//
// Per block rather than per message because a single assistant message routinely
// carries a thinking block and a text block, and keying both on the message id
// would fold the model's scratchpad into its answer.
func blockItemID(messageID string, index int) string {
	if messageID == "" {
		return ""
	}
	return messageID + "#" + strconv.Itoa(index)
}

// decodeToolInput reads a tool's arguments as a loose map. A tool whose input is
// not an object yields nil, and every caller tolerates that.
func decodeToolInput(raw json.RawMessage) map[string]any {
	if len(raw) == 0 {
		return nil
	}
	var args map[string]any
	if err := json.Unmarshal(raw, &args); err != nil {
		return nil
	}
	return args
}

// stringArg returns the first named argument present as a non-empty string.
func stringArg(args map[string]any, names ...string) string {
	for _, name := range names {
		if value, ok := args[name].(string); ok && strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

// shortPath trims a label down to the last two path segments, which is what a
// reader recognizes. The full path stays in the activity's detail.
func shortPath(path string) string {
	parts := strings.Split(strings.TrimSuffix(path, "/"), "/")
	if len(parts) <= 2 {
		return path
	}
	return strings.Join(parts[len(parts)-2:], "/")
}

// truncateLabel keeps a one-line summary to one line.
func truncateLabel(s string) string {
	s = strings.TrimSpace(strings.ReplaceAll(s, "\n", " "))
	const maxLen = 120
	if len(s) > maxLen {
		return s[:maxLen] + "…"
	}
	return s
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

func encodeDetail(detail map[string]any) []byte {
	if len(detail) == 0 {
		return nil
	}
	encoded, err := json.Marshal(detail)
	if err != nil {
		return nil
	}
	return encoded
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}
