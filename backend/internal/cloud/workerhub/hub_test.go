package workerhub

import (
	"testing"

	clouddomain "github.com/aoagents/agent-orchestrator/backend/internal/cloud/domain"
)

func TestNewerWorkerEpochReplacesOlderConnection(t *testing.T) {
	hub := New()
	oldCommands, unregisterOld := hub.Register("session-one", "worker-old", 1)
	defer unregisterOld()
	newCommands, unregisterNew := hub.Register("session-one", "worker-new", 2)
	defer unregisterNew()
	if _, ok := <-oldCommands; ok {
		t.Fatal("old command channel remained open")
	}
	want := Command{Type: "input", Data: "aGVsbG8="}
	if err := hub.Send(clouddomain.SessionID("session-one"), want); err != nil {
		t.Fatalf("Send() error = %v", err)
	}
	if got := <-newCommands; got != want {
		t.Fatalf("command = %#v, want %#v", got, want)
	}
}

func TestSendQueuesWhileWorkerIsDisconnected(t *testing.T) {
	hub := New()
	want := Command{Type: "input", Data: "aGVsbG8="}
	if err := hub.Send("session-one", want); err != nil {
		t.Fatalf("Send() error = %v", err)
	}
	commands, unregister := hub.Register("session-one", "worker-one", 1)
	defer unregister()
	if got := <-commands; got != want {
		t.Fatalf("command = %#v, want %#v", got, want)
	}
}

func TestOldCleanupDoesNotCloseSameEpochReplacement(t *testing.T) {
	hub := New()
	oldCommands, unregisterOld := hub.Register("session-one", "worker-one", 1)
	newCommands, unregisterNew := hub.Register("session-one", "worker-one", 1)
	defer unregisterNew()

	if _, ok := <-oldCommands; ok {
		t.Fatal("old command channel remained open")
	}
	unregisterOld()

	want := Command{Type: "interrupt"}
	if err := hub.Send("session-one", want); err != nil {
		t.Fatalf("Send() error = %v", err)
	}
	if got, ok := <-newCommands; !ok || got != want {
		t.Fatalf("replacement command = %#v, open=%t, want %#v", got, ok, want)
	}
}

func TestDisconnectAndRequeuePreservesFailedAndBufferedCommands(t *testing.T) {
	hub := New()
	commands, unregister := hub.Register("session-one", "worker-one", 1)
	defer unregister()
	failed := Command{Type: "input", Data: "ZmFpbGVk"}
	buffered := Command{Type: "resize", Rows: 40, Cols: 120}
	if err := hub.Send("session-one", failed); err != nil {
		t.Fatalf("Send(failed) error = %v", err)
	}
	if err := hub.Send("session-one", buffered); err != nil {
		t.Fatalf("Send(buffered) error = %v", err)
	}
	if got := <-commands; got != failed {
		t.Fatalf("in-flight command = %#v, want %#v", got, failed)
	}

	hub.DisconnectAndRequeue("session-one", "worker-one", 1, failed)
	replacement, unregisterReplacement := hub.Register("session-one", "worker-two", 2)
	defer unregisterReplacement()

	for index, want := range []Command{failed, buffered} {
		if got := <-replacement; got != want {
			t.Fatalf("replacement command %d = %#v, want %#v", index, got, want)
		}
	}
}

func TestCleanupRequeuesBufferedCommands(t *testing.T) {
	hub := New()
	commands, unregister := hub.Register("session-one", "worker-one", 1)
	want := Command{Type: "input", Data: "cGVyc2lzdA=="}
	if err := hub.Send("session-one", want); err != nil {
		t.Fatalf("Send() error = %v", err)
	}
	unregister()
	if _, ok := <-commands; ok {
		t.Fatal("original command channel remained open")
	}

	replacement, unregisterReplacement := hub.Register("session-one", "worker-two", 2)
	defer unregisterReplacement()
	if got := <-replacement; got != want {
		t.Fatalf("replacement command = %#v, want %#v", got, want)
	}
}
