package codexappserver

import (
	"encoding/json"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// The payloads here are shaped after frames captured from a real
// `codex app-server` session (codex-cli 0.146.0), not invented.

func normalizeOne(t *testing.T, method, params string) ports.ChatEvent {
	t.Helper()
	events := normalizeNotification(notification{Method: method, Params: json.RawMessage(params)})
	if len(events) != 1 {
		t.Fatalf("normalize(%s) produced %d events, want 1", method, len(events))
	}
	return events[0]
}

func normalizeNone(t *testing.T, method, params string) {
	t.Helper()
	if events := normalizeNotification(notification{Method: method, Params: json.RawMessage(params)}); len(events) != 0 {
		t.Fatalf("normalize(%s) produced %d events, want none: %+v", method, len(events), events)
	}
}

func TestNormalizeTurnLifecycle(t *testing.T) {
	started := normalizeOne(t, "turn/started", `{"threadId":"th1","turn":{"id":"tu1","status":"inProgress","items":[]}}`)
	if started.Kind != ports.ChatEventTurnStarted || started.ProviderTurnID != "tu1" {
		t.Fatalf("turn/started -> %+v", started)
	}

	done := normalizeOne(t, "turn/completed", `{"threadId":"th1","turn":{"id":"tu1","status":"completed","items":[]}}`)
	if done.Kind != ports.ChatEventTurnCompleted || done.TurnState != domain.TurnStateCompleted {
		t.Fatalf("turn/completed -> %+v", done)
	}
}

// The provider reports a cancelled turn with its own terminal status. AO must
// carry that through rather than calling it completed or failed.
func TestNormalizeInterruptedTurnKeepsItsOwnState(t *testing.T) {
	ev := normalizeOne(t, "turn/completed", `{"threadId":"th1","turn":{"id":"tu2","status":"interrupted","items":[]}}`)
	if ev.TurnState != domain.TurnStateInterrupted {
		t.Fatalf("state = %q, want %q", ev.TurnState, domain.TurnStateInterrupted)
	}
	if ev.Err != nil {
		t.Fatalf("interrupted turn carried an error: %v", ev.Err)
	}
}

// An unrecognized status must not be optimistically read as success.
func TestNormalizeUnknownTurnStatusFailsClosed(t *testing.T) {
	ev := normalizeOne(t, "turn/completed", `{"threadId":"th1","turn":{"id":"tu3","status":"someFutureStatus","items":[]}}`)
	if ev.TurnState != domain.TurnStateFailed {
		t.Fatalf("state = %q, want %q for an unknown status", ev.TurnState, domain.TurnStateFailed)
	}
}

func TestNormalizeAssistantStreaming(t *testing.T) {
	delta := normalizeOne(t, "item/agentMessage/delta",
		`{"threadId":"th1","turnId":"tu1","itemId":"msg_1","delta":"Running"}`)
	if delta.Kind != ports.ChatEventMessageDelta || delta.Delta != "Running" || delta.ProviderItemID != "msg_1" {
		t.Fatalf("delta -> %+v", delta)
	}

	// An empty delta carries no information and must not bump a revision.
	normalizeNone(t, "item/agentMessage/delta", `{"itemId":"msg_1","delta":""}`)

	completed := normalizeOne(t, "item/completed",
		`{"threadId":"th1","turnId":"tu1","item":{"id":"msg_1","type":"agentMessage","text":"Running the script."}}`)
	if completed.Kind != ports.ChatEventMessageCompleted || completed.Text != "Running the script." {
		t.Fatalf("agentMessage completed -> %+v", completed)
	}
}

// item/started for an assistant message adds nothing: the row is created by the
// first delta, so emitting an empty message would flash a blank bubble.
func TestNormalizeAgentMessageStartedIsIgnored(t *testing.T) {
	normalizeNone(t, "item/started", `{"turnId":"tu1","item":{"id":"msg_1","type":"agentMessage","text":""}}`)
}

// AO persists the user's message when it accepts the send. The provider echoing
// it back as an item must not create a duplicate timeline entry.
func TestNormalizeUserMessageEchoIsIgnored(t *testing.T) {
	normalizeNone(t, "item/completed", `{"turnId":"tu1","item":{"id":"um_1","type":"userMessage","content":[]}}`)
	normalizeNone(t, "item/started", `{"turnId":"tu1","item":{"id":"um_1","type":"userMessage","content":[]}}`)
}

func TestNormalizeCommandExecutionUnwrapsShellWrapper(t *testing.T) {
	started := normalizeOne(t, "item/started",
		`{"threadId":"th1","turnId":"tu1","item":{"id":"exec-1","type":"commandExecution",`+
			`"command":"/bin/zsh -lc 'date -u'","cwd":"/tmp/work"}}`)

	if started.Kind != ports.ChatEventActivityStarted {
		t.Fatalf("kind = %q", started.Kind)
	}
	if started.ActivityKind != domain.ActivityKindCommand {
		t.Fatalf("activity kind = %q", started.ActivityKind)
	}
	if started.ActivityStatus != domain.ActivityStatusRunning {
		t.Fatalf("status = %q, want running", started.ActivityStatus)
	}
	if started.Summary != "date -u" {
		t.Fatalf("summary = %q, want the shell wrapper stripped", started.Summary)
	}

	var detail map[string]any
	if err := json.Unmarshal(started.Detail, &detail); err != nil {
		t.Fatalf("detail not decodable: %v", err)
	}
	if detail["command"] != "date -u" {
		t.Errorf("detail command = %v", detail["command"])
	}
	// The raw invocation is kept so the exact thing that ran is recoverable.
	if detail["rawCommand"] != "/bin/zsh -lc 'date -u'" {
		t.Errorf("detail rawCommand = %v", detail["rawCommand"])
	}
	if detail["cwd"] != "/tmp/work" {
		t.Errorf("detail cwd = %v", detail["cwd"])
	}
}

func TestNormalizeCommandExitCodeDrivesStatus(t *testing.T) {
	ok := normalizeOne(t, "item/completed",
		`{"turnId":"tu1","item":{"id":"exec-1","type":"commandExecution","command":"true","exitCode":0,"durationMs":31,"aggregatedOutput":"hi\n"}}`)
	if ok.ActivityStatus != domain.ActivityStatusCompleted {
		t.Fatalf("exit 0 status = %q, want completed", ok.ActivityStatus)
	}

	var detail map[string]any
	if err := json.Unmarshal(ok.Detail, &detail); err != nil {
		t.Fatalf("detail not decodable: %v", err)
	}
	// Provider output aggregation was observed to drop leading bytes, so it must
	// be flagged rather than presented as the authoritative record.
	if detail["outputMayBePartial"] != true {
		t.Errorf("captured output was not flagged as possibly partial: %v", detail)
	}

	failed := normalizeOne(t, "item/completed",
		`{"turnId":"tu1","item":{"id":"exec-2","type":"commandExecution","command":"false","exitCode":1}}`)
	if failed.ActivityStatus != domain.ActivityStatusFailed {
		t.Fatalf("exit 1 status = %q, want failed", failed.ActivityStatus)
	}
}

func TestNormalizeOtherItemKinds(t *testing.T) {
	for _, tc := range []struct {
		name   string
		params string
		want   domain.ActivityKind
	}{
		{"file change", `{"turnId":"t","item":{"id":"i","type":"fileChange","changes":[]}}`, domain.ActivityKindFileChange},
		{"plan", `{"turnId":"t","item":{"id":"i","type":"plan","text":"1. do it"}}`, domain.ActivityKindPlan},
		{"reasoning", `{"turnId":"t","item":{"id":"i","type":"reasoning","summary":"thinking"}}`, domain.ActivityKindReasoning},
		{"mcp tool", `{"turnId":"t","item":{"id":"i","type":"mcpToolCall","toolName":"grep"}}`, domain.ActivityKindCommand},
		{"error", `{"turnId":"t","item":{"id":"i","type":"error","message":"boom"}}`, domain.ActivityKindError},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ev := normalizeOne(t, "item/completed", tc.params)
			if ev.ActivityKind != tc.want {
				t.Fatalf("activity kind = %q, want %q", ev.ActivityKind, tc.want)
			}
		})
	}
}

// An item type this build does not model must produce nothing rather than an
// activity with guessed semantics.
func TestNormalizeUnknownItemTypeIsDropped(t *testing.T) {
	normalizeNone(t, "item/completed", `{"turnId":"t","item":{"id":"i","type":"someFutureItem"}}`)
}

// Provider bookkeeping is not conversation content. These are the methods a real
// three-turn session emitted alongside the useful ones.
func TestNormalizeIgnoresProviderBookkeeping(t *testing.T) {
	for _, method := range []string{
		"mcpServer/startupStatus/updated",
		"hook/started",
		"hook/completed",
		"account/rateLimits/updated",
		"thread/status/changed",
		"remoteControl/status/changed",
		"thread/goal/cleared",
		"thread/started",
		"someMethodAddedNextRelease",
	} {
		t.Run(method, func(t *testing.T) { normalizeNone(t, method, `{}`) })
	}
}

// The provider broadcasts this once a request is answered; it is how a second
// client learns an approval card is no longer actionable.
func TestNormalizeServerRequestResolved(t *testing.T) {
	// The real shape: requestId is the JSON-RPC id of the original server->client
	// request, and it arrives as a number. Zero is a legitimate id — the first
	// approval of a session is id 0 — so it must not be treated as absent.
	ev := normalizeOne(t, "serverRequest/resolved", `{"threadId":"th1","requestId":0}`)
	if ev.Kind != ports.ChatEventApprovalResolved {
		t.Fatalf("kind = %q", ev.Kind)
	}
	if ev.RequestID != "0" {
		t.Fatalf("request id = %q, want %q", ev.RequestID, "0")
	}

	if ev := normalizeOne(t, "serverRequest/resolved", `{"requestId":2}`); ev.RequestID != "2" {
		t.Fatalf("request id = %q, want 2", ev.RequestID)
	}

	// A string id is also legal per the JSON-RPC envelope.
	if ev := normalizeOne(t, "serverRequest/resolved", `{"requestId":"r-42"}`); ev.RequestID != "r-42" {
		t.Fatalf("request id = %q, want r-42", ev.RequestID)
	}

	normalizeNone(t, "serverRequest/resolved", `{}`)
	normalizeNone(t, "serverRequest/resolved", `{"requestId":null}`)
}

func TestNormalizeTokenUsage(t *testing.T) {
	ev := normalizeOne(t, "thread/tokenUsage/updated",
		`{"threadId":"th1","usage":{"inputTokens":120,"outputTokens":45}}`)
	if ev.ActivityKind != domain.ActivityKindUsage {
		t.Fatalf("activity kind = %q", ev.ActivityKind)
	}
	if len(ev.Detail) == 0 {
		t.Fatal("usage event carried no detail")
	}
}

// Malformed params must be skipped, never panic.
func TestNormalizeToleratesMalformedParams(t *testing.T) {
	for _, method := range []string{
		"turn/started", "turn/completed", "item/started", "item/completed",
		"item/agentMessage/delta", "thread/tokenUsage/updated", "serverRequest/resolved",
	} {
		normalizeNone(t, method, `"not an object"`)
	}
}

func TestUnwrapShellLeavesPlainCommands(t *testing.T) {
	for _, tc := range []struct{ in, want string }{
		{"date -u", "date -u"},
		{"/bin/sh -c 'ls -la'", "ls -la"},
		{`/bin/bash -lc "git status"`, "git status"},
		{"ao spawn --project p --name w", "ao spawn --project p --name w"},
		// A non-shell binary that happens to take -c must not be unwrapped.
		{"python -c print(1)", "python -c print(1)"},
	} {
		if got := unwrapShell(tc.in); got != tc.want {
			t.Errorf("unwrapShell(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

// A current app-server reports compaction ONLY as a contextCompaction item. The
// schema still declares a thread/compacted notification and marks it deprecated;
// 0.146.0 never sends it. Reading only the notification would mean AO silently
// never noticed a compaction, and a conversation that quietly lost half its
// history with nothing to mark where reads as if the agent simply forgot.
func TestNormalizeContextCompactionItem(t *testing.T) {
	ev := normalizeOne(t, "item/completed",
		`{"item":{"type":"contextCompaction","id":"cc-1"},"threadId":"th1","turnId":"t1","completedAtMs":1785669337435}`)
	if ev.Kind != ports.ChatEventCompacted {
		t.Fatalf("kind = %q, want %q", ev.Kind, ports.ChatEventCompacted)
	}
	if ev.ProviderItemID != "cc-1" || ev.ProviderTurnID != "t1" {
		t.Fatalf("ids = %q/%q, want cc-1/t1", ev.ProviderItemID, ev.ProviderTurnID)
	}
}

// The reclaim is unknown until the item settles: the reduced token figure arrives
// between start and completion. A row emitted on start would have to be rewritten
// with the real numbers.
func TestNormalizeContextCompactionStartIsIgnored(t *testing.T) {
	normalizeNone(t, "item/started",
		`{"item":{"type":"contextCompaction","id":"cc-1"},"threadId":"th1","turnId":"t1"}`)
}

// The deprecated spelling, for a provider old enough to send it. It carries only
// ids: no token figures at all, which is why the reclaim has to be bracketed from
// token-usage reports rather than read off the event.
func TestNormalizeDeprecatedCompactedNotification(t *testing.T) {
	ev := normalizeOne(t, "thread/compacted", `{"threadId":"th1","turnId":"t1"}`)
	if ev.Kind != ports.ChatEventCompacted {
		t.Fatalf("kind = %q", ev.Kind)
	}
	if ev.ProviderTurnID != "t1" {
		t.Fatalf("turn id = %q, want t1", ev.ProviderTurnID)
	}
	normalizeNone(t, "thread/compacted", `"not an object"`)
}

// `last` and `total` answer different questions and only one of them is the
// context position. Measured across a compaction: total stayed at 15650 while last
// fell to 4632, because compaction cannot undo cumulative spend. Reading total
// would report every compaction as reclaiming nothing.
func TestContextPositionReadsLastNotTotal(t *testing.T) {
	used, window, ok := contextPositionFrom(notification{
		Method: "thread/tokenUsage/updated",
		Params: json.RawMessage(`{"threadId":"th1","turnId":"t1","tokenUsage":{"total":{"totalTokens":15650},"last":{"totalTokens":4632},"modelContextWindow":258400}}`),
	})
	if !ok {
		t.Fatal("token usage was not recognized")
	}
	if used != 4632 {
		t.Errorf("context used = %d, want 4632 (last, not total)", used)
	}
	if window != 258400 {
		t.Errorf("context window = %d, want 258400", window)
	}

	// The window is optional; a report without it must still yield the position.
	if used, window, ok := contextPositionFrom(notification{
		Method: "thread/tokenUsage/updated",
		Params: json.RawMessage(`{"tokenUsage":{"last":{"totalTokens":10},"total":{"totalTokens":10}}}`),
	}); !ok || used != 10 || window != 0 {
		t.Errorf("used/window/ok = %d/%d/%v, want 10/0/true", used, window, ok)
	}

	if _, _, ok := contextPositionFrom(notification{Method: "turn/started"}); ok {
		t.Error("a non-usage notification was read as a context position")
	}
}
