package cli

import (
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

func waitingServer(t *testing.T, status int, respBody string) (*httptest.Server, *string) {
	t.Helper()
	var gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		if r.Method != http.MethodGet || r.URL.Path != "/api/v1/attention/operator" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = io.WriteString(w, respBody)
	}))
	t.Cleanup(srv.Close)
	return srv, &gotPath
}

func TestWaitingCommandListsOperatorAttention(t *testing.T) {
	cfg := setConfigEnv(t)
	srv, gotPath := waitingServer(t, http.StatusOK, `{"items":[{"id":"session:ao-1:decision","kind":"decision","projectId":"ao","sessionId":"ao-1","reason":"Session is paused on a permission dialog.","action":"Approve or deny the permission in the session terminal.","deepLink":"/projects/ao/sessions/ao-1","updatedAt":"2026-07-11T03:20:00Z"},{"id":"pr:224:merge","kind":"pr","projectId":"ao","sessionId":"ao-2","prNumber":224,"reason":"PR is locally mergeable and waiting for operator merge authority.","action":"Merge the pull request.","deepLink":"https://github.com/aoagents/agent-orchestrator/pull/224","updatedAt":"2026-07-11T03:21:00Z"}]}`)
	writeRunFileFor(t, cfg, srv)

	out, errOut, err := executeCLI(t, Deps{ProcessAlive: func(pid int) bool { return pid == os.Getpid() }}, "waiting")
	if err != nil {
		t.Fatalf("waiting failed: %v\nstderr=%s", err, errOut)
	}
	if *gotPath != "/api/v1/attention/operator" {
		t.Fatalf("path = %q", *gotPath)
	}
	for _, want := range []string{"KIND", "decision", "ao-1", "permission dialog", "pr", "#224", "Merge the pull request"} {
		if !strings.Contains(out, want) {
			t.Fatalf("output missing %q:\n%s", want, out)
		}
	}
}

func TestWaitingCommandJSON(t *testing.T) {
	cfg := setConfigEnv(t)
	srv, _ := waitingServer(t, http.StatusOK, `{"items":[]}`)
	writeRunFileFor(t, cfg, srv)

	out, errOut, err := executeCLI(t, Deps{ProcessAlive: func(pid int) bool { return pid == os.Getpid() }}, "waiting", "--json")
	if err != nil {
		t.Fatalf("waiting --json failed: %v\nstderr=%s", err, errOut)
	}
	if !strings.Contains(out, `"items": []`) {
		t.Fatalf("json output = %s", out)
	}
}
