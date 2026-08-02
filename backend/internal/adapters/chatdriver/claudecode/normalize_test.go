package claudecode

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// Every fixture below is a frame captured verbatim from claude 2.1.220 driven
// over `--print --output-format stream-json --input-format stream-json --verbose
// --permission-prompt-tool stdio`. Nothing here is hand-written from a doc: two
// real bugs in this feature were caught by fixtures that turned out not to match
// what the provider actually sends.

// testNow is a fixed clock so the rate-limit arithmetic is deterministic. It is
// half an hour before the resetsAt in the captured rate_limit_event below.
var testNow = time.Unix(1785683400, 0)

func feed(t *testing.T, n *normalizer, raw string) []ports.ChatEvent {
	t.Helper()
	var head struct {
		Type    string `json:"type"`
		Subtype string `json:"subtype"`
	}
	if err := json.Unmarshal([]byte(raw), &head); err != nil {
		t.Fatalf("fixture is not JSON: %v", err)
	}
	return n.normalize(notification{
		Type:    head.Type,
		Subtype: head.Subtype,
		Raw:     json.RawMessage(raw),
	}, testNow)
}

func feedOne(t *testing.T, n *normalizer, raw string) ports.ChatEvent {
	t.Helper()
	events := feed(t, n, raw)
	if len(events) != 1 {
		t.Fatalf("frame produced %d events, want 1: %+v", len(events), events)
	}
	return events[0]
}

func feedNone(t *testing.T, n *normalizer, raw string) {
	t.Helper()
	if events := feed(t, n, raw); len(events) != 0 {
		t.Fatalf("frame produced %d events, want none: %+v", len(events), events)
	}
}

// Captured frames.
const (
	fixtureInit = `{"type":"system","subtype":"init","cwd":"/tmp/aoprobe","session_id":"922d9ba5-34fb-420e-b51d-3348c22624a0","tools":["Task","Bash","Read"],"mcp_servers":[],"model":"claude-opus-5[1m]","permissionMode":"acceptEdits","slash_commands":["compact"],"apiKeySource":"none","claude_code_version":"2.1.220","output_style":"default","agents":["Explore"],"skills":["qa"],"capabilities":["interrupt_receipt_v1","interrupt_cancel_queued_v1","msg_lifecycle_v1"],"uuid":"70f10d3e-2404-48d8-b913-28dd942aa06f"}`

	fixtureAssistantText = `{"type":"assistant","message":{"model":"claude-opus-5","id":"msg_011CddxqtrFHGkTBMmyGSYKr","type":"message","role":"assistant","content":[{"type":"text","text":"acknowledged"}],"stop_reason":null,"stop_sequence":null,"stop_details":null,"usage":{"input_tokens":2,"cache_creation_input_tokens":52437,"cache_read_input_tokens":17207,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":52437},"output_tokens":1,"service_tier":"standard","inference_geo":"not_available"},"diagnostics":null,"context_management":null},"parent_tool_use_id":null,"session_id":"922d9ba5-34fb-420e-b51d-3348c22624a0","uuid":"fb60ea2f-6384-4e9c-bed9-c8fe60e0089b","timestamp":"2026-08-02T13:00:14.248Z","request_id":"req_011CddxqrUcyVoLRYZDYMHXK"}`

	fixtureAssistantToolUse = `{"type":"assistant","message":{"model":"claude-opus-5","id":"msg_011Cddy6AZwsLcGvTyDpCUoT","type":"message","role":"assistant","content":[{"type":"tool_use","id":"toolu_014VHv13tXWVbZmCNhbkYib3","name":"Write","input":{"file_path":"/private/var/folders/rl/T/aoprobe-rd0od5oi/notes.txt","content":"hello\n"},"caller":{"type":"direct"}}],"stop_reason":null,"stop_sequence":null,"stop_details":null,"usage":{"input_tokens":2,"cache_creation_input_tokens":52464,"cache_read_input_tokens":17207,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":52464},"output_tokens":2,"service_tier":"standard","inference_geo":"not_available"},"diagnostics":null,"context_management":null},"parent_tool_use_id":null,"session_id":"5053c59b-bd86-41c0-9cbf-acaf81279376","uuid":"a624879d-dd7c-4b57-a33e-f28e14d0557d","timestamp":"2026-08-02T13:03:33.782Z","request_id":"req_011Cddy692fzpL3Ri9a9TaYv"}`

	fixtureToolResult = `{"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_014VHv13tXWVbZmCNhbkYib3","type":"tool_result","content":"File created successfully at: /private/var/folders/rl/T/aoprobe-rd0od5oi/notes.txt"}]},"parent_tool_use_id":null,"session_id":"5053c59b-bd86-41c0-9cbf-acaf81279376","uuid":"d62b9d7b-311b-461d-8caf-8abcaba1bc7e","timestamp":"2026-08-02T13:03:33.821Z","tool_use_result":{"type":"create","filePath":"/private/var/folders/rl/T/aoprobe-rd0od5oi/notes.txt","content":"hello\n","structuredPatch":[],"originalFile":null,"userModified":false}}`

	fixtureResultSuccess = `{"is_error":false,"duration_api_ms":3324,"num_turns":1,"stop_reason":"end_turn","session_id":"922d9ba5-34fb-420e-b51d-3348c22624a0","total_cost_usd":0.5331585,"usage":{"input_tokens":2,"cache_creation_input_tokens":52437,"cache_read_input_tokens":17207,"output_tokens":7,"server_tool_use":{"web_search_requests":0,"web_fetch_requests":0},"service_tier":"standard","inference_geo":"not_available","speed":"standard"},"modelUsage":{"claude-opus-5[1m]":{"inputTokens":2,"outputTokens":7,"cacheReadInputTokens":17207,"cacheCreationInputTokens":52437,"webSearchRequests":0,"costUSD":0.5331585,"contextWindow":1000000,"maxOutputTokens":64000,"canonicalModel":"claude-opus-5","provider":"firstParty"}},"permission_denials":[],"terminal_reason":"completed","fast_mode_state":"off","subtype":"success","api_error_status":null,"result":"acknowledged","ttft_ms":3755,"type":"result","duration_ms":4321,"uuid":"e097a2a5-951c-4f9a-bffe-a83acc9bdbea"}`

	fixtureResultInterrupted = `{"is_error":true,"duration_api_ms":0,"num_turns":2,"stop_reason":null,"session_id":"9a782a6a-f825-487a-8f14-eeadc1f2203d","total_cost_usd":0,"usage":{"input_tokens":0,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":0,"server_tool_use":{"web_search_requests":0,"web_fetch_requests":0},"service_tier":"standard","inference_geo":"","iterations":[],"speed":"standard"},"modelUsage":{},"permission_denials":[],"terminal_reason":"aborted_streaming","fast_mode_state":"off","subtype":"error_during_execution","errors":["[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null"],"type":"result","duration_ms":7674,"uuid":"706c4a10-9fab-4d11-b9bc-a6feafabacf9"}`

	fixtureRateLimit = `{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1785685200,"rateLimitType":"five_hour","overageStatus":"allowed","overageResetsAt":1785675600,"isUsingOverage":false},"uuid":"5c3fb1cb-b63c-4a99-8976-8a4cec758b3e","session_id":"922d9ba5-34fb-420e-b51d-3348c22624a0"}`

	fixtureStreamMessageStart = `{"type":"stream_event","event":{"type":"message_start","message":{"model":"claude-opus-5","id":"msg_011CddxqtrFHGkTBMmyGSYKr","type":"message","role":"assistant","content":[],"stop_reason":null,"usage":{"input_tokens":2,"output_tokens":1}}},"parent_tool_use_id":null,"uuid":"3e6f0c8a-0000-0000-0000-000000000001","session_id":"922d9ba5-34fb-420e-b51d-3348c22624a0"}`

	fixtureStreamBlockStart = `{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}},"parent_tool_use_id":null,"uuid":"3e6f0c8a-0000-0000-0000-000000000002","session_id":"922d9ba5-34fb-420e-b51d-3348c22624a0"}`

	fixtureStreamTextDelta = `{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ac"}},"parent_tool_use_id":null,"uuid":"3e6f0c8a-0000-0000-0000-000000000003","session_id":"922d9ba5-34fb-420e-b51d-3348c22624a0"}`

	fixtureStreamStop = `{"type":"stream_event","event":{"type":"content_block_stop","index":0},"parent_tool_use_id":null,"uuid":"3e6f0c8a-0000-0000-0000-000000000004","session_id":"922d9ba5-34fb-420e-b51d-3348c22624a0"}`
)

// Provider bookkeeping. A trivial turn emitted every one of these; none of them
// belongs in a conversation, and a driver that guessed at them would bury the
// timeline under hook lifecycle noise.
var noiseFixtures = []string{
	`{"type":"system","subtype":"hook_started","hook_id":"777a05e8","hook_name":"SessionStart:startup","hook_event":"SessionStart","uuid":"c3a84469","session_id":"922d9ba5"}`,
	`{"type":"system","subtype":"hook_response","hook_id":"777a05e8","hook_name":"SessionStart:startup","hook_event":"SessionStart","output":"","stdout":"","stderr":"","exit_code":0,"outcome":"success","uuid":"fc2def77","session_id":"922d9ba5"}`,
	`{"type":"system","subtype":"status","status":"requesting","uuid":"27206cef","session_id":"922d9ba5"}`,
	`{"type":"system","subtype":"thinking_tokens","uuid":"27206cf0","session_id":"922d9ba5"}`,
	`{"type":"tool_progress","tool_use_id":"toolu_01","tool_name":"Bash","parent_tool_use_id":null,"elapsed_time_seconds":3,"uuid":"27206cf1","session_id":"922d9ba5"}`,
	`{"type":"system","subtype":"commands_changed","commands":[],"uuid":"27206cf2","session_id":"922d9ba5"}`,
}

func TestNormalizeDropsProviderBookkeeping(t *testing.T) {
	n := newNormalizer()
	n.beginTurn("ao-turn-1")
	for _, fixture := range noiseFixtures {
		feedNone(t, n, fixture)
	}
}

// system/init is the CLI taking the turn. It is the only acknowledgement on this
// wire, and an interrupt sent before it has nothing to cancel.
func TestNormalizeInitIsTheTurnAcknowledgement(t *testing.T) {
	n := newNormalizer()
	n.beginTurn("ao-turn-1")

	ev := feedOne(t, n, fixtureInit)
	if ev.Kind != ports.ChatEventTurnStarted || ev.ProviderTurnID != "ao-turn-1" {
		t.Fatalf("init -> %+v", ev)
	}
}

// An init with no turn in flight belongs to work AO did not dispatch. Minting an
// id here would put a turn on the timeline that nothing else ever refers to.
func TestNormalizeInitWithoutADispatchedTurnIsIgnored(t *testing.T) {
	feedNone(t, newNormalizer(), fixtureInit)
}

func TestNormalizeAssistantText(t *testing.T) {
	n := newNormalizer()
	n.beginTurn("ao-turn-1")

	events := feed(t, n, fixtureAssistantText)
	if len(events) != 2 {
		t.Fatalf("assistant text produced %d events, want message + usage: %+v", len(events), events)
	}

	msg := events[0]
	if msg.Kind != ports.ChatEventMessageCompleted || msg.Text != "acknowledged" {
		t.Fatalf("message -> %+v", msg)
	}
	// Keyed per content block, not per message: one assistant frame routinely
	// carries a thinking block and a text block, and a shared key would fold the
	// model's scratchpad into its answer.
	if msg.ProviderItemID != "msg_011CddxqtrFHGkTBMmyGSYKr#0" {
		t.Fatalf("message item id = %q", msg.ProviderItemID)
	}

	usage := events[1]
	if usage.Kind != ports.ChatEventUsage || usage.Usage == nil {
		t.Fatalf("usage -> %+v", usage)
	}
	// input + cache read + cache write is what actually occupies the window: a
	// request re-sends the whole conversation, so the cached prefix is part of it.
	if got, want := usage.Usage.ContextUsed, int64(2+17207+52437); got != want {
		t.Errorf("context used = %d, want %d", got, want)
	}
}

// A tool_use is an activity and its echoed tool_result settles that same row. The
// key is the tool_use id, so a result never opens a second entry for one call.
func TestNormalizeToolCallAndItsResultShareOneRow(t *testing.T) {
	n := newNormalizer()
	n.beginTurn("ao-turn-1")

	events := feed(t, n, fixtureAssistantToolUse)
	if len(events) != 2 {
		t.Fatalf("tool_use produced %d events, want activity + usage: %+v", len(events), events)
	}
	started := events[0]
	if started.Kind != ports.ChatEventActivityStarted {
		t.Fatalf("tool_use -> %+v", started)
	}
	if started.ProviderItemID != "toolu_014VHv13tXWVbZmCNhbkYib3" {
		t.Fatalf("activity item id = %q", started.ProviderItemID)
	}
	if started.ActivityKind != domain.ActivityKindFileChange {
		t.Errorf("Write mapped to kind %q, want file_change", started.ActivityKind)
	}
	if started.ActivityStatus != domain.ActivityStatusRunning {
		t.Errorf("status = %q, want running", started.ActivityStatus)
	}
	if !strings.Contains(started.Summary, "notes.txt") {
		t.Errorf("summary = %q, want it to name the file", started.Summary)
	}
	if !strings.Contains(string(started.Detail), `"toolName":"Write"`) {
		t.Errorf("detail = %s, want the tool name", started.Detail)
	}

	done := feedOne(t, n, fixtureToolResult)
	if done.Kind != ports.ChatEventActivityCompleted {
		t.Fatalf("tool_result -> %+v", done)
	}
	if done.ProviderItemID != started.ProviderItemID {
		t.Fatalf("result item id %q does not match the tool_use %q", done.ProviderItemID, started.ProviderItemID)
	}
	if done.ActivityStatus != domain.ActivityStatusCompleted {
		t.Errorf("status = %q, want completed", done.ActivityStatus)
	}
	// Kind and Summary stay empty so the upsert cannot overwrite the real label
	// with one derived from a result that never names the tool.
	if done.ActivityKind != "" || done.Summary != "" {
		t.Errorf("result overwrote the activity's label: kind=%q summary=%q", done.ActivityKind, done.Summary)
	}
	if !strings.Contains(string(done.Detail), "File created successfully") {
		t.Errorf("detail = %s, want the tool output", done.Detail)
	}
}

// The user's own prompt comes back on the same frame type as a tool result. AO
// recorded it when the send was accepted, so echoing it would duplicate the row.
func TestNormalizeDoesNotEchoTheUsersOwnMessage(t *testing.T) {
	n := newNormalizer()
	n.beginTurn("ao-turn-1")
	feedNone(t, n, `{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Reply with exactly the word: acknowledged"}]},"parent_tool_use_id":null,"session_id":"922d9ba5","uuid":"1"}`)
}

// Deltas and the settled text must land on the same row, or a streamed answer
// appears twice: once as it typed itself out and once complete.
func TestNormalizeStreamingSharesTheSettledMessagesKey(t *testing.T) {
	n := newNormalizer()
	n.beginTurn("ao-turn-1")

	feedNone(t, n, fixtureStreamMessageStart)
	feedNone(t, n, fixtureStreamBlockStart)

	delta := feedOne(t, n, fixtureStreamTextDelta)
	if delta.Kind != ports.ChatEventMessageDelta || delta.Delta != "ac" {
		t.Fatalf("delta -> %+v", delta)
	}
	if delta.ProviderItemID != "msg_011CddxqtrFHGkTBMmyGSYKr#0" {
		t.Fatalf("delta item id = %q", delta.ProviderItemID)
	}

	feedNone(t, n, fixtureStreamStop)

	settled := feed(t, n, fixtureAssistantText)[0]
	if settled.ProviderItemID != delta.ProviderItemID {
		t.Fatalf("settled item id %q does not match the delta's %q", settled.ProviderItemID, delta.ProviderItemID)
	}
}

// A delta for a block that never announced itself as text is a thinking or
// tool-argument delta arriving out of order. Rendering it as an answer would show
// the model's scratchpad, or half-built JSON, as prose.
func TestNormalizeIgnoresDeltasForUnannouncedBlocks(t *testing.T) {
	n := newNormalizer()
	n.beginTurn("ao-turn-1")
	feedNone(t, n, fixtureStreamMessageStart)
	feedNone(t, n, fixtureStreamTextDelta)

	feedNone(t, n, `{"type":"stream_event","event":{"type":"content_block_start","index":1,"content_block":{"type":"thinking","thinking":""}},"uuid":"5","session_id":"922d9ba5"}`)
	feedNone(t, n, `{"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"thinking_delta","thinking":"hmm"}},"uuid":"6","session_id":"922d9ba5"}`)
}

func TestNormalizeResultSettlesTheTurn(t *testing.T) {
	n := newNormalizer()
	n.beginTurn("ao-turn-7")

	events := feed(t, n, fixtureResultSuccess)
	if len(events) != 2 {
		t.Fatalf("result produced %d events, want usage + completion: %+v", len(events), events)
	}

	usage := events[0]
	if usage.Kind != ports.ChatEventUsage || usage.Usage == nil {
		t.Fatalf("usage -> %+v", usage)
	}
	// modelUsage is the only place the CLI states the window, and a used-token
	// figure with no scale is a number nobody can act on.
	if usage.Usage.ContextWindow != 1_000_000 {
		t.Errorf("context window = %d, want 1000000", usage.Usage.ContextWindow)
	}

	done := events[1]
	if done.Kind != ports.ChatEventTurnCompleted || done.ProviderTurnID != "ao-turn-7" {
		t.Fatalf("completion -> %+v", done)
	}
	if done.TurnState != domain.TurnStateCompleted || done.Err != nil {
		t.Fatalf("state = %q err = %v", done.TurnState, done.Err)
	}

	// The turn is over, so a later frame must not still be stamped with it.
	if turn := n.currentTurn(); turn != "" {
		t.Errorf("turn id %q survived its own result", turn)
	}
}

// An interrupted turn arrives as is_error true with subtype error_during_execution.
// Reading that as a failure would put a red row in the timeline every time
// somebody changed their mind, so terminal_reason is believed over is_error.
func TestNormalizeInterruptedTurnIsNotAFailure(t *testing.T) {
	n := newNormalizer()
	n.beginTurn("ao-turn-2")

	events := feed(t, n, fixtureResultInterrupted)
	done := events[len(events)-1]
	if done.Kind != ports.ChatEventTurnCompleted {
		t.Fatalf("last event -> %+v", done)
	}
	if done.TurnState != domain.TurnStateInterrupted {
		t.Fatalf("state = %q, want interrupted", done.TurnState)
	}
	if done.Err != nil {
		t.Fatalf("interrupted turn carried an error: %v", done.Err)
	}
}

// A terminal reason this build does not know ended the turn short of what was
// asked. Claiming a success AO did not observe is the worse failure.
func TestNormalizeUnknownTerminalReasonFailsClosed(t *testing.T) {
	n := newNormalizer()
	n.beginTurn("ao-turn-3")
	events := feed(t, n, `{"type":"result","subtype":"error_during_execution","is_error":true,"num_turns":1,"session_id":"s","terminal_reason":"some_future_reason","errors":["boom"],"usage":null,"modelUsage":{},"permission_denials":[],"uuid":"u"}`)
	done := events[len(events)-1]
	if done.TurnState != domain.TurnStateFailed {
		t.Fatalf("state = %q, want failed", done.TurnState)
	}
	if done.Err == nil || !strings.Contains(done.Err.Error(), "boom") {
		t.Fatalf("err = %v, want the CLI's own message", done.Err)
	}
}

// A denial the user never saw a prompt for. Without it the agent says it will do
// something, does not, and nothing on screen explains why.
func TestNormalizeReportsSilentPermissionDenials(t *testing.T) {
	n := newNormalizer()
	n.beginTurn("ao-turn-4")
	events := feed(t, n, `{"type":"result","subtype":"success","is_error":false,"num_turns":1,"session_id":"s","terminal_reason":"completed","result":"done","usage":null,"modelUsage":{},"permission_denials":[{"tool_name":"Bash","tool_use_id":"toolu_09","tool_input":{"command":"rm -rf /"}}],"uuid":"u"}`)
	if len(events) != 2 {
		t.Fatalf("want denial + completion, got %+v", events)
	}
	denial := events[0]
	if denial.Kind != ports.ChatEventActivityCompleted || denial.ActivityStatus != domain.ActivityStatusFailed {
		t.Fatalf("denial -> %+v", denial)
	}
	if denial.ProviderItemID != "toolu_09" {
		t.Errorf("denial item id = %q, want the tool use it belongs to", denial.ProviderItemID)
	}
}

// The pushed rate-limit frame carried no percentage at all on the account this
// was measured against. Reporting zero would say the quota is untouched, which is
// a much more reassuring claim than "not reported".
func TestNormalizeRateLimitWithoutUtilization(t *testing.T) {
	ev := feedOne(t, newNormalizer(), fixtureRateLimit)
	if ev.Kind != ports.ChatEventRateLimits || ev.RateLimits == nil {
		t.Fatalf("rate limit -> %+v", ev)
	}
	if ev.RateLimits.PrimaryUsedPercent != -1 {
		t.Errorf("used percent = %v, want -1 for a window with no utilization", ev.RateLimits.PrimaryUsedPercent)
	}
	if ev.RateLimits.PrimaryResetsInSeconds != 1800 {
		t.Errorf("resets in %ds, want 1800", ev.RateLimits.PrimaryResetsInSeconds)
	}
}

// The CLI states both sides of a compaction outright, so the reclaim is reported
// rather than bracketed from surrounding token reports.
func TestNormalizeCompactionReportsTheReclaim(t *testing.T) {
	ev := feedOne(t, newNormalizer(), `{"type":"system","subtype":"compact_boundary","compact_metadata":{"trigger":"auto","pre_tokens":152300,"post_tokens":41200,"duration_ms":8400},"uuid":"c1","session_id":"s"}`)
	if ev.Kind != ports.ChatEventCompacted {
		t.Fatalf("compact -> %+v", ev)
	}
	if !strings.Contains(ev.Summary, "111.1k tokens") {
		t.Errorf("summary = %q, want the reclaim", ev.Summary)
	}
	if !strings.Contains(string(ev.Detail), `"trigger":"auto"`) {
		t.Errorf("detail = %s, want the trigger", ev.Detail)
	}
}

// post_tokens is optional in the CLI's own declaration. A compaction that does
// not state its result must not be reported as having freed zero.
func TestNormalizeCompactionWithoutFiguresClaimsNothing(t *testing.T) {
	ev := feedOne(t, newNormalizer(), `{"type":"system","subtype":"compact_boundary","compact_metadata":{"trigger":"manual","pre_tokens":9000},"uuid":"c2","session_id":"s"}`)
	if ev.Summary != "Compacted the conversation history" {
		t.Errorf("summary = %q, want no invented figure", ev.Summary)
	}
}

func TestToolActivityLabels(t *testing.T) {
	cases := []struct {
		name    string
		tool    string
		input   string
		kind    domain.ActivityKind
		summary string
	}{
		{"bash names the command", "Bash", `{"command":"go test ./..."}`, domain.ActivityKindCommand, "go test ./..."},
		{"write names the file", "Write", `{"file_path":"/repo/pkg/main.go"}`, domain.ActivityKindFileChange, "Wrote pkg/main.go"},
		{"edit names the file", "Edit", `{"file_path":"/repo/pkg/main.go"}`, domain.ActivityKindFileChange, "Edited pkg/main.go"},
		{"todo is a plan", "TodoWrite", `{"todos":[]}`, domain.ActivityKindPlan, "Updated plan"},
		{"grep names the pattern", "Grep", `{"pattern":"func main"}`, domain.ActivityKindCommand, "Searched for func main"},
		// An MCP or plugin tool still reaches the timeline. A tool call the user
		// cannot see is worse than one labelled generically.
		{"unknown tool still shows", "mcp__notion__search", `{"q":"x"}`, domain.ActivityKindCommand, "Called mcp__notion__search"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			kind, summary := toolActivity(tc.tool, json.RawMessage(tc.input))
			if kind != tc.kind || summary != tc.summary {
				t.Fatalf("toolActivity(%q) = (%q, %q), want (%q, %q)", tc.tool, kind, summary, tc.kind, tc.summary)
			}
		})
	}
}
