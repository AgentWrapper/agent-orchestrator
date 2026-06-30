package cli

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
)

// TestSpawnCommand_RequiresProject asserts `ao spawn` rejects a missing
// --project before touching the network, so it fails fast without a daemon.
func TestSpawnCommand_RequiresProject(t *testing.T) {
	var out, errb bytes.Buffer
	root := NewRootCommand(Deps{Out: &out, Err: &errb})
	root.SetArgs([]string{"spawn"})
	err := root.Execute()
	if err == nil {
		t.Fatal("expected an error when --project is missing")
	}
	if !strings.Contains(err.Error(), "--project is required") {
		t.Fatalf("error = %v, want it to mention --project is required", err)
	}
}

// TestProjectAddCommand_RequiresPath asserts `ao project add` rejects a missing
// --path before touching the network.
func TestProjectAddCommand_RequiresPath(t *testing.T) {
	var out, errb bytes.Buffer
	root := NewRootCommand(Deps{Out: &out, Err: &errb})
	root.SetArgs([]string{"project", "add"})
	err := root.Execute()
	if err == nil {
		t.Fatal("expected an error when --path is missing")
	}
	if !strings.Contains(err.Error(), "--path is required") {
		t.Fatalf("error = %v, want it to mention --path is required", err)
	}
}

func TestSpawnClaimPRWiring(t *testing.T) {
	cfg := setConfigEnv(t)
	var requests []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		appendPrimaryRequest(&requests, r)
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/api/v1/projects/demo":
			_, _ = io.WriteString(w, `{"status":"ok","project":{"id":"demo","name":"Demo","path":"/repo/demo","repo":"https://github.com/aoagents/agent-orchestrator","defaultBranch":"main"}}`)
		case r.Method == http.MethodPost && r.URL.Path == "/api/v1/sessions":
			_, _ = io.WriteString(w, `{"session":{"id":"demo-9","status":"idle"}}`)
		case r.Method == http.MethodPost && r.URL.Path == "/api/v1/sessions/demo-9/pr/claim":
			var req claimPRRequest
			_ = json.NewDecoder(r.Body).Decode(&req)
			if req.PR != "https://github.com/aoagents/agent-orchestrator/pull/142" || req.AllowTakeover {
				t.Fatalf("claim request = %#v", req)
			}
			_, _ = io.WriteString(w, `{"ok":true,"sessionId":"demo-9","prs":[{"url":"https://github.com/aoagents/agent-orchestrator/pull/142","number":142,"state":"open","ci":"passing","review":"review_required","mergeability":"mergeable","reviewComments":false,"updatedAt":"2026-06-04T12:00:00Z"}],"branchChanged":false,"takenOverFrom":[]}`)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	writeRunFileFor(t, cfg, srv)

	out, errOut, err := executeCLI(t, Deps{ProcessAlive: func(int) bool { return true }}, "spawn", "--project", "demo", "--name", "worker", "--claim-pr", "142", "--no-takeover")
	if err != nil {
		t.Fatalf("spawn claim-pr failed: %v stderr=%s", err, errOut)
	}
	if !strings.Contains(out, "claimed https://github.com/aoagents/agent-orchestrator/pull/142") {
		t.Fatalf("output missing claimed label: %s", out)
	}
	want := []string{"GET /api/v1/projects/demo", "POST /api/v1/sessions", "POST /api/v1/sessions/demo-9/pr/claim"}
	if !reflect.DeepEqual(requests, want) {
		t.Fatalf("requests=%#v want %#v", requests, want)
	}
}

func TestSpawnClaimPRFailureRollsBackSession(t *testing.T) {
	cfg := setConfigEnv(t)
	var requests []string
	sessions := map[string]bool{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		appendPrimaryRequest(&requests, r)
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/api/v1/projects/demo":
			_, _ = io.WriteString(w, `{"status":"ok","project":{"id":"demo","name":"Demo","path":"/repo/demo","repo":"https://github.com/aoagents/agent-orchestrator","defaultBranch":"main"}}`)
		case r.Method == http.MethodPost && r.URL.Path == "/api/v1/sessions":
			sessions["demo-10"] = true
			_, _ = io.WriteString(w, `{"session":{"id":"demo-10","status":"idle"}}`)
		case r.Method == http.MethodPost && r.URL.Path == "/api/v1/sessions/demo-10/pr/claim":
			if !sessions["demo-10"] {
				t.Fatal("claim called before session existed")
			}
			w.WriteHeader(http.StatusNotFound)
			_, _ = io.WriteString(w, `{"error":"not_found","code":"PR_NOT_FOUND","message":"PR not found"}`)
		case r.Method == http.MethodPost && r.URL.Path == "/api/v1/sessions/demo-10/rollback":
			delete(sessions, "demo-10")
			_, _ = io.WriteString(w, `{"ok":true,"sessionId":"demo-10","deleted":true}`)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	writeRunFileFor(t, cfg, srv)

	_, _, err := executeCLI(t, Deps{ProcessAlive: func(int) bool { return true }}, "spawn", "--project", "demo", "--name", "worker", "--claim-pr", "142")
	if err == nil {
		t.Fatal("expected spawn claim failure")
	}
	msg := err.Error()
	if !strings.Contains(msg, "failed to claim PR 142") || !strings.Contains(msg, "rolled back session demo-10") {
		t.Fatalf("error = %v", err)
	}
	if sessions["demo-10"] {
		t.Fatalf("spawned session still present after claim rollback: %#v", sessions)
	}
	want := []string{"GET /api/v1/projects/demo", "POST /api/v1/sessions", "POST /api/v1/sessions/demo-10/pr/claim", "POST /api/v1/sessions/demo-10/rollback"}
	if !reflect.DeepEqual(requests, want) {
		t.Fatalf("requests=%#v want %#v", requests, want)
	}
}

func TestSpawnNoTakeoverRequiresClaimPR(t *testing.T) {
	_, _, err := executeCLI(t, Deps{}, "spawn", "--project", "demo", "--name", "worker", "--no-takeover")
	if err == nil || ExitCode(err) != 2 || !strings.Contains(err.Error(), "--no-takeover requires --claim-pr") {
		t.Fatalf("err=%v exit=%d", err, ExitCode(err))
	}
}

// TestSpawnCommand_RequiresName asserts `ao spawn` rejects a missing --name
// before touching the network, mirroring the --project guard.
func TestSpawnCommand_RequiresName(t *testing.T) {
	_, _, err := executeCLI(t, Deps{}, "spawn", "--project", "demo")
	if err == nil || ExitCode(err) != 2 || !strings.Contains(err.Error(), "--name is required") {
		t.Fatalf("err=%v exit=%d, want --name is required", err, ExitCode(err))
	}
}

// TestSpawnCommand_RejectsOverlongName asserts `ao spawn` rejects a --name
// longer than 20 characters without contacting the daemon.
func TestSpawnCommand_RejectsOverlongName(t *testing.T) {
	_, _, err := executeCLI(t, Deps{}, "spawn", "--project", "demo", "--name", strings.Repeat("x", 21))
	if err == nil || ExitCode(err) != 2 || !strings.Contains(err.Error(), "20 characters or fewer") {
		t.Fatalf("err=%v exit=%d, want 20 characters or fewer", err, ExitCode(err))
	}
}
