package codexappserver

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// Every scripted reply below is a SINGLE line. readFrame is newline-delimited, so a
// pretty-printed reply is read as a truncated frame and the client waits forever.

// threadWithTurns is a thread/read result carrying an ordered turn list.
const threadWithTurns = `{"thread":{"id":"thread-1","turns":[` +
	`{"id":"turn-a","status":"completed"},` +
	`{"id":"turn-b","status":"completed"},` +
	`{"id":"turn-c","status":"completed"}]}}`

func openConversation(t *testing.T) (*conversation, *scriptedServer) {
	t.Helper()
	d, srv := newTestDriver(t)
	conv, err := d.Start(context.Background(), ports.ChatStartConfig{WorkspacePath: "/tmp/ws"})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	t.Cleanup(func() { _ = conv.Close() })
	return conv.(*conversation), srv
}

// The provider takes a COUNT from the end of the thread, not a turn id, so the whole
// correctness of rollback rests on turning the named turn into the right number.
// Naming the middle of three turns must discard that turn and the one after it.
func TestRollbackCountsTurnsFromTheNamedOneToTheEnd(t *testing.T) {
	conv, srv := openConversation(t)
	srv.reply("thread/read", threadWithTurns)
	srv.reply("thread/rollback", `{"thread":{"id":"thread-1","turns":[{"id":"turn-a","status":"completed"}]}}`)

	if err := conv.Rollback(context.Background(), "turn-b"); err != nil {
		t.Fatalf("Rollback: %v", err)
	}

	read := srv.awaitFrame(func(f frame) bool { return f.Method == "thread/read" })
	var readParams struct {
		ThreadID     string `json:"threadId"`
		IncludeTurns bool   `json:"includeTurns"`
	}
	if err := json.Unmarshal(read.Params, &readParams); err != nil {
		t.Fatalf("thread/read params: %v", err)
	}
	if readParams.ThreadID != "thread-1" || !readParams.IncludeTurns {
		t.Errorf("thread/read params = %+v, want thread-1 with turns", readParams)
	}

	rollback := srv.awaitFrame(func(f frame) bool { return f.Method == "thread/rollback" })
	var params struct {
		ThreadID string `json:"threadId"`
		NumTurns int    `json:"numTurns"`
	}
	if err := json.Unmarshal(rollback.Params, &params); err != nil {
		t.Fatalf("thread/rollback params: %v", err)
	}
	if params.ThreadID != "thread-1" {
		t.Errorf("threadId = %q, want thread-1", params.ThreadID)
	}
	if params.NumTurns != 2 {
		t.Errorf("numTurns = %d, want 2 (the named turn and the one after it)", params.NumTurns)
	}
}

// Naming the last turn is the common case and must ask for exactly one turn: the
// provider rejects numTurns < 1, and asking for zero would be a silent no-op.
func TestRollbackOfTheLastTurnDiscardsOne(t *testing.T) {
	conv, srv := openConversation(t)
	srv.reply("thread/read", threadWithTurns)
	srv.reply("thread/rollback", `{"thread":{"id":"thread-1","turns":[]}}`)

	if err := conv.Rollback(context.Background(), "turn-c"); err != nil {
		t.Fatalf("Rollback: %v", err)
	}

	rollback := srv.awaitFrame(func(f frame) bool { return f.Method == "thread/rollback" })
	var params struct {
		NumTurns int `json:"numTurns"`
	}
	if err := json.Unmarshal(rollback.Params, &params); err != nil {
		t.Fatalf("params: %v", err)
	}
	if params.NumTurns != 1 {
		t.Errorf("numTurns = %d, want 1", params.NumTurns)
	}
}

// A turn the provider does not have must not produce a rollback at all. Guessing a
// count would discard turns the user never named.
func TestRollbackRefusesATurnTheProviderDoesNotHave(t *testing.T) {
	conv, srv := openConversation(t)
	srv.reply("thread/read", threadWithTurns)

	err := conv.Rollback(context.Background(), "turn-zzz")
	if err == nil {
		t.Fatal("Rollback of an unknown turn succeeded")
	}
	if !isRefusal(err) {
		t.Errorf("err = %v, want a provider refusal", err)
	}
	if srv.sentMethod("thread/rollback") {
		t.Fatal("thread/rollback was sent for a turn the provider does not have")
	}
}

// The provider refuses a rollback while a turn runs. That refusal must reach the
// caller as a conflict, not as an internal failure: it is an ordinary thing to press
// undo a moment too early.
func TestRollbackTranslatesTheMidTurnRefusal(t *testing.T) {
	conv, srv := openConversation(t)
	srv.reply("thread/read", threadWithTurns)
	srv.replyError("thread/rollback", -32600, "Cannot rollback while a turn is in progress.")

	err := conv.Rollback(context.Background(), "turn-c")
	if err == nil {
		t.Fatal("Rollback succeeded despite the provider refusing")
	}
	if !isRefusal(err) {
		t.Errorf("err = %v, want a provider refusal", err)
	}
	if !strings.Contains(err.Error(), "turn is in progress") {
		t.Errorf("err = %v, want the provider's own explanation carried through", err)
	}
}

// A transport failure is NOT a refusal. Reporting it as one would tell the user to
// stop the agent when the real problem is that the provider is gone.
func TestRollbackKeepsATransportFailureAsAFailure(t *testing.T) {
	conv, srv := openConversation(t)
	srv.replyError("thread/read", -32603, "internal error")

	err := conv.Rollback(context.Background(), "turn-c")
	if err == nil {
		t.Fatal("Rollback succeeded despite thread/read failing")
	}
	if isRefusal(err) {
		t.Errorf("err = %v, want a plain failure rather than a refusal", err)
	}
}

func TestForkReturnsTheNewThreadIDAndInheritsTheWorkingDirectory(t *testing.T) {
	conv, srv := openConversation(t)
	srv.reply("thread/fork", `{"thread":{"id":"thread-2","forkedFromId":"thread-1"},"cwd":"/tmp/ws"}`)

	forked, err := conv.Fork(context.Background())
	if err != nil {
		t.Fatalf("Fork: %v", err)
	}
	if forked != "thread-2" {
		t.Errorf("forked thread = %q, want thread-2", forked)
	}

	fork := srv.awaitFrame(func(f frame) bool { return f.Method == "thread/fork" })
	var params map[string]any
	if err := json.Unmarshal(fork.Params, &params); err != nil {
		t.Fatalf("thread/fork params: %v", err)
	}
	if params["threadId"] != "thread-1" {
		t.Errorf("threadId = %v, want thread-1", params["threadId"])
	}
	// cwd must be absent so the fork inherits the source thread's directory. A fork
	// pointed at another tree would remember editing files that are not there.
	if _, ok := params["cwd"]; ok {
		t.Errorf("thread/fork sent a cwd (%v); it must inherit the source thread's", params["cwd"])
	}
	// lastTurnId must be absent too: ChatForker names no turn, and a fork that
	// quietly truncated would be a rollback wearing the wrong name.
	if _, ok := params["lastTurnId"]; ok {
		t.Error("thread/fork sent a lastTurnId; a fork copies the whole history")
	}
}

func TestForkRejectsAResponseWithNoThreadID(t *testing.T) {
	conv, srv := openConversation(t)
	srv.reply("thread/fork", `{"thread":{}}`)

	if _, err := conv.Fork(context.Background()); err == nil {
		t.Fatal("Fork accepted a response carrying no thread id")
	}
}

func TestSetTitleSendsTheTrimmedName(t *testing.T) {
	conv, srv := openConversation(t)
	srv.reply("thread/name/set", `{}`)

	if err := conv.SetTitle(context.Background(), "  Fix OAuth Return URL Loss  "); err != nil {
		t.Fatalf("SetTitle: %v", err)
	}

	set := srv.awaitFrame(func(f frame) bool { return f.Method == "thread/name/set" })
	var params struct {
		ThreadID string `json:"threadId"`
		Name     string `json:"name"`
	}
	if err := json.Unmarshal(set.Params, &params); err != nil {
		t.Fatalf("thread/name/set params: %v", err)
	}
	if params.ThreadID != "thread-1" {
		t.Errorf("threadId = %q, want thread-1", params.ThreadID)
	}
	if params.Name != "Fix OAuth Return URL Loss" {
		t.Errorf("name = %q, want the trimmed title", params.Name)
	}
}

// The provider rejects a blank name. Refusing locally keeps the error about the
// caller's input and spends no round trip on a call that cannot succeed.
func TestSetTitleRefusesABlankName(t *testing.T) {
	conv, srv := openConversation(t)

	err := conv.SetTitle(context.Background(), "   \t ")
	if err == nil {
		t.Fatal("SetTitle accepted a blank name")
	}
	if !isRefusal(err) {
		t.Errorf("err = %v, want a refusal", err)
	}
	if srv.sentMethod("thread/name/set") {
		t.Fatal("thread/name/set was sent for a blank name")
	}
}

// A title AO did not set still has to reach it: another client naming the thread is
// how a provider-derived title arrives at all.
func TestThreadRenamedNotificationBecomesATitleEvent(t *testing.T) {
	conv, srv := openConversation(t)
	srv.push(`{"method":"thread/name/updated","params":{"threadId":"thread-1","threadName":"  Restore Canvas Renderer Fallback  "}}`)

	ev := nextEvent(t, conv.Events(), ports.ChatEventThreadRenamed)
	if ev.Title != "Restore Canvas Renderer Fallback" {
		t.Errorf("title = %q, want the trimmed name", ev.Title)
	}
}

// A cleared name is reported as an empty title rather than dropped: the projection
// has to see that the thread no longer has one.
func TestThreadRenamedNotificationReportsAClearedName(t *testing.T) {
	conv, srv := openConversation(t)
	srv.push(`{"method":"thread/name/updated","params":{"threadId":"thread-1","threadName":null}}`)

	ev := nextEvent(t, conv.Events(), ports.ChatEventThreadRenamed)
	if ev.Title != "" {
		t.Errorf("title = %q, want empty for a cleared name", ev.Title)
	}
}

// The service feature-detects each of these, so a dropped method would read as "the
// provider cannot do this" with nothing to notice.
func TestConversationAdvertisesTheHistoryCapabilities(t *testing.T) {
	caps := capabilities()
	for _, want := range []ports.ChatCapability{
		ports.ChatCapabilityRollback,
		ports.ChatCapabilityFork,
		ports.ChatCapabilityRename,
	} {
		if !caps.Has(want) {
			t.Errorf("capability %q not advertised", want)
		}
	}
}

// isRefusal asks the error the same question the Chat service does.
func isRefusal(err error) bool {
	var refusal interface{ ChatRefusal() bool }
	return errors.As(err, &refusal) && refusal.ChatRefusal()
}
