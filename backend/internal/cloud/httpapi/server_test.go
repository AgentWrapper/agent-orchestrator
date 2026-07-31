package httpapi

import (
	"encoding/json"
	"testing"
)

func TestActivityTurnTransitions(t *testing.T) {
	for _, test := range []struct {
		event         string
		state         string
		wantStarts    bool
		wantCompletes bool
	}{
		{event: "user-prompt-submit", state: "active", wantStarts: true},
		{event: "pre-tool-use", state: "active"},
		{event: "stop", state: "idle", wantCompletes: true},
		{event: "after-agent", state: "idle", wantCompletes: true},
		{event: "notification", state: "idle"},
		{event: "permission-request", state: "blocked"},
		{event: "session-end", state: "exited"},
	} {
		t.Run(test.event+"/"+test.state, func(t *testing.T) {
			if got := activityStartsTurn(test.event, test.state); got != test.wantStarts {
				t.Fatalf(
					"activityStartsTurn(%q, %q) = %t, want %t",
					test.event,
					test.state,
					got,
					test.wantStarts,
				)
			}
			if got := activityCompletesTurn(test.event, test.state); got != test.wantCompletes {
				t.Fatalf(
					"activityCompletesTurn(%q, %q) = %t, want %t",
					test.event,
					test.state,
					got,
					test.wantCompletes,
				)
			}
		})
	}
}

func TestActivityNativeSessionID(t *testing.T) {
	if got := activityNativeSessionID(json.RawMessage(`{"session_id":"native-session"}`)); got != "native-session" {
		t.Fatalf("activityNativeSessionID() = %q", got)
	}
	if got := activityNativeSessionID(json.RawMessage(`{"session_id":""}`)); got != "" {
		t.Fatalf("activityNativeSessionID(blank) = %q", got)
	}
}
