package cli

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"strings"
	"testing"
)

func waitingCommandServer(t *testing.T, body string) (*httptest.Server, *sessionRequestLog) {
	return waitingCommandServerWithNotifications(t, body, `{"notifications":[]}`)
}

func waitingCommandServerWithNotifications(t *testing.T, sessionsBody, notificationsBody string) (*httptest.Server, *sessionRequestLog) {
	t.Helper()
	log := &sessionRequestLog{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		log.append(r)
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/api/v1/sessions":
			_, _ = io.WriteString(w, sessionsBody)
		case r.Method == http.MethodGet && r.URL.Path == "/api/v1/notifications":
			_, _ = io.WriteString(w, notificationsBody)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	return srv, log
}

func TestWaitingListsCurrentOperatorWaits(t *testing.T) {
	cfg := setConfigEnv(t)
	srv, log := waitingCommandServer(t, `{"sessions":[
		{"id":"worker-input","projectId":"ao","kind":"worker","activity":{"state":"waiting_input"},"status":"needs_input"},
		{"id":"worker-blocked","projectId":"ao","kind":"worker","activity":{"state":"blocked"},"status":"needs_input"},
		{"id":"orch-dead","projectId":"ao","kind":"orchestrator","activity":{"state":"idle"},"status":"no_signal"},
		{"id":"worker-active","projectId":"ao","kind":"worker","activity":{"state":"active"},"status":"working"},
		{"id":"old","projectId":"ao","kind":"worker","activity":{"state":"waiting_input"},"isTerminated":true,"status":"terminated"}
	]}`)
	writeRunFileFor(t, cfg, srv)

	out, errOut, err := executeCLI(t, Deps{ProcessAlive: func(int) bool { return true }}, "waiting")
	if err != nil {
		t.Fatalf("waiting failed: %v\nstderr=%s", err, errOut)
	}
	for _, want := range []string{
		"3 things need operator response",
		"ao:",
		"worker-input — needs_input",
		"worker-blocked — blocked",
		"orch-dead — orchestrator_dead",
	} {
		if !strings.Contains(out, want) {
			t.Fatalf("waiting output missing %q:\n%s", want, out)
		}
	}
	if strings.Contains(out, "worker-active") || strings.Contains(out, "old") {
		t.Fatalf("waiting output included non-waiting sessions:\n%s", out)
	}
	if got, want := log.all(), []string{
		"GET /api/v1/sessions?active=true",
		"GET /api/v1/notifications?limit=100&status=unread",
	}; !reflect.DeepEqual(got, want) {
		t.Fatalf("requests = %#v, want %#v", got, want)
	}
}

func TestWaitingIncludesNotificationDerivedOperatorWaits(t *testing.T) {
	cfg := setConfigEnv(t)
	srv, log := waitingCommandServerWithNotifications(t, `{"sessions":[]}`, `{"notifications":[
		{"id":"n-ready-sensitive","sessionId":"worker-pr","projectId":"ao","type":"ready_to_merge","title":"PR #7 ready","prUrl":"https://github.example/pr/7","sensitive":true,"status":"unread"},
		{"id":"n-ready-routine","sessionId":"worker-routine","projectId":"ao","type":"ready_to_merge","title":"PR #8 ready","prUrl":"https://github.example/pr/8","sensitive":false,"status":"unread"},
		{"id":"n-capped","sessionId":"orch","projectId":"ao","type":"orchestrator_replacement_capped","title":"orchestrator capped","status":"unread"}
	]}`)
	writeRunFileFor(t, cfg, srv)

	out, errOut, err := executeCLI(t, Deps{ProcessAlive: func(int) bool { return true }}, "waiting")
	if err != nil {
		t.Fatalf("waiting failed: %v\nstderr=%s", err, errOut)
	}
	for _, want := range []string{
		"2 things need operator response",
		"worker-pr — parked_sensitive_merge",
		"https://github.example/pr/7",
		"orch — orchestrator_replacement_capped",
	} {
		if !strings.Contains(out, want) {
			t.Fatalf("waiting output missing %q:\n%s", want, out)
		}
	}
	if strings.Contains(out, "worker-routine") || strings.Contains(out, "https://github.example/pr/8") {
		t.Fatalf("waiting output included routine PR notification:\n%s", out)
	}
	if got, want := log.all(), []string{
		"GET /api/v1/sessions?active=true",
		"GET /api/v1/notifications?limit=100&status=unread",
	}; !reflect.DeepEqual(got, want) {
		t.Fatalf("requests = %#v, want %#v", got, want)
	}
}

func TestWaitingIncludesPersistedSlackNeedsResponseState(t *testing.T) {
	cfg := setConfigEnv(t)
	stateFile := t.TempDir() + "/slack-state.json"
	t.Setenv("AO_SLACK_NOTIFIER_STATE", stateFile)
	if err := os.WriteFile(stateFile, []byte(`{"needsResponseMessages":{
		"parked": {"record": {"sessionId":"worker-pr","projectId":"ao","kind":"parked_sensitive_merge","title":"PR #7 ready","url":"https://github.example/pr/7"}},
		"blocked": {"record": {"sessionId":"worker-blocked","projectId":"ao","kind":"blocked","title":"blocked / stuck"}}
	}}`), 0o600); err != nil {
		t.Fatalf("write slack state: %v", err)
	}
	srv, _ := waitingCommandServerWithNotifications(t, `{"sessions":[]}`, `{"notifications":[]}`)
	writeRunFileFor(t, cfg, srv)

	out, errOut, err := executeCLI(t, Deps{ProcessAlive: func(int) bool { return true }}, "waiting")
	if err != nil {
		t.Fatalf("waiting failed: %v\nstderr=%s", err, errOut)
	}
	for _, want := range []string{
		"2 things need operator response",
		"worker-pr — parked_sensitive_merge",
		"https://github.example/pr/7",
		"worker-blocked — blocked",
	} {
		if !strings.Contains(out, want) {
			t.Fatalf("waiting output missing %q:\n%s", want, out)
		}
	}
}

func TestWaitingJSONOutput(t *testing.T) {
	cfg := setConfigEnv(t)
	srv, _ := waitingCommandServer(t, `{"sessions":[
		{"id":"worker-blocked","projectId":"ao","kind":"worker","activity":{"state":"blocked"},"status":"needs_input","prs":[{"url":"https://github.example/pr/1"}]}
	]}`)
	writeRunFileFor(t, cfg, srv)

	out, errOut, err := executeCLI(t, Deps{ProcessAlive: func(int) bool { return true }}, "waiting", "--json")
	if err != nil {
		t.Fatalf("waiting --json failed: %v\nstderr=%s", err, errOut)
	}
	var got waitingOutput
	if err := json.Unmarshal([]byte(out), &got); err != nil {
		t.Fatalf("waiting JSON did not decode: %v\noutput=%s", err, out)
	}
	if got.Meta.Count != 1 || len(got.Data) != 1 {
		t.Fatalf("unexpected JSON counts: %#v", got)
	}
	if got.Data[0].SessionID != "worker-blocked" || got.Data[0].Kind != "blocked" || got.Data[0].URL != "https://github.example/pr/1" {
		t.Fatalf("unexpected JSON item: %#v", got.Data[0])
	}
}

func TestWaitingEmptyState(t *testing.T) {
	cfg := setConfigEnv(t)
	srv, _ := waitingCommandServer(t, `{"sessions":[]}`)
	writeRunFileFor(t, cfg, srv)

	out, errOut, err := executeCLI(t, Deps{ProcessAlive: func(int) bool { return true }}, "waiting")
	if err != nil {
		t.Fatalf("waiting empty failed: %v\nstderr=%s", err, errOut)
	}
	if !strings.Contains(out, "Nothing needs operator response") {
		t.Fatalf("missing empty state:\n%s", out)
	}
}
