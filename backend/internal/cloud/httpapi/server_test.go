package httpapi

import (
	"encoding/base64"
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

func TestRedactWorkerEventPayload(t *testing.T) {
	payload := json.RawMessage(`{"token":"secret","nested":{"api_key":"key"},"message":"AO_WORKER_TOKEN=abc123"}`)
	redacted := redactWorkerEventPayload("custom", payload)
	if string(redacted) != `{"message":"AO_WORKER_TOKEN=[redacted]","nested":{"api_key":"[redacted]"},"token":"[redacted]"}` {
		t.Fatalf("redacted payload = %s", redacted)
	}
}

func TestRedactWorkerTerminalPayload(t *testing.T) {
	encoded := base64.StdEncoding.EncodeToString([]byte("hello\nAO_WORKER_BOOTSTRAP_TOKEN=secret\n"))
	payload, _ := json.Marshal(map[string]string{
		"encoding": "base64",
		"data":     encoded,
	})
	redacted := redactWorkerEventPayload("terminal.output", payload)
	var result struct {
		Data string `json:"data"`
	}
	if err := json.Unmarshal(redacted, &result); err != nil {
		t.Fatalf("decode redacted payload: %v", err)
	}
	decoded, err := base64.StdEncoding.DecodeString(result.Data)
	if err != nil {
		t.Fatalf("decode data: %v", err)
	}
	if got := string(decoded); got != "hello\nAO_WORKER_BOOTSTRAP_TOKEN=[redacted]\n" {
		t.Fatalf("decoded payload = %q", got)
	}
}

func TestValidDaytonaAPIURL(t *testing.T) {
	configured := "https://app.daytona.io/api"
	for _, value := range []string{
		"https://app.daytona.io/api",
		"https://api.daytona.io",
		"https://tenant.daytona.io/custom",
	} {
		if !validDaytonaAPIURL(value, configured) {
			t.Fatalf("validDaytonaAPIURL(%q) = false, want true", value)
		}
	}
	for _, value := range []string{
		"http://app.daytona.io/api",
		"https://evil.example/api",
		"https://app.daytona.io.evil.example/api",
		"https://app.daytona.io:8443/api",
		"https://user:pass@app.daytona.io/api",
	} {
		if validDaytonaAPIURL(value, configured) {
			t.Fatalf("validDaytonaAPIURL(%q) = true, want false", value)
		}
	}
	if !validDaytonaAPIURL("https://daytona.internal:8443/api", "https://daytona.internal:8443/api") {
		t.Fatal("configured Daytona URL with explicit port was rejected")
	}
}
