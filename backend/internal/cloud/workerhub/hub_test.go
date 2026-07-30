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
