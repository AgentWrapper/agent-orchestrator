package cli

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type decisionCapture struct {
	body string
	path string
}

func decisionServer(t *testing.T, status int, respBody string) (*httptest.Server, *decisionCapture) {
	t.Helper()
	capture := &decisionCapture{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/sessions/demo-1/decision" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		if r.Method == http.MethodGet {
			// The decide flow fetches the current decision first to learn the
			// revision its answer must name.
			_, _ = io.WriteString(w, `{"sessionId":"demo-1","kind":"question","question":"Deploy?","options":["Yes","No"],"revision":"rev-42"}`)
			return
		}
		if r.Method != http.MethodPost {
			http.NotFound(w, r)
			return
		}
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Fatalf("read body: %v", err)
		}
		capture.body = string(body)
		capture.path = r.URL.Path
		w.WriteHeader(status)
		_, _ = io.WriteString(w, respBody)
	}))
	t.Cleanup(srv.Close)
	return srv, capture
}

func TestSessionDecide_Option(t *testing.T) {
	cfg := setConfigEnv(t)
	srv, capture := decisionServer(t, http.StatusOK, `{"ok":true,"sessionId":"demo-1"}`)
	writeRunFileFor(t, cfg, srv)

	_, errOut, err := executeCLI(t, Deps{
		ProcessAlive: func(int) bool { return true },
	}, "session", "decide", "demo-1", "--option", "2")
	if err != nil {
		t.Fatalf("unexpected error: %v\nstderr=%s", err, errOut)
	}
	var req struct {
		Option   int    `json:"option"`
		Revision string `json:"revision"`
	}
	if err := json.Unmarshal([]byte(capture.body), &req); err != nil {
		t.Fatalf("decode body: %v\nbody=%s", err, capture.body)
	}
	if capture.path != "/api/v1/sessions/demo-1/decision" || req.Option != 2 {
		t.Fatalf("request path=%q option=%d", capture.path, req.Option)
	}
	if req.Revision != "rev-42" {
		t.Fatalf("answer revision = %q, want the fetched decision's rev-42", req.Revision)
	}
}

// TestSessionDecide_ExplicitRevisionPassthrough: --revision pins the answer to
// one dialog instance, is sent without a preliminary GET, and a stale revision
// surfaces the daemon's 409 SESSION_DECISION_STALE to the operator.
func TestSessionDecide_ExplicitRevisionPassthrough(t *testing.T) {
	cfg := setConfigEnv(t)
	var sawGet bool
	capture := &decisionCapture{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/sessions/demo-1/decision" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		if r.Method == http.MethodGet {
			sawGet = true
			_, _ = io.WriteString(w, `{"sessionId":"demo-1","kind":"question","revision":"rev-42"}`)
			return
		}
		body, _ := io.ReadAll(r.Body)
		capture.body = string(body)
		var req struct {
			Revision string `json:"revision"`
		}
		_ = json.Unmarshal(body, &req)
		if req.Revision != "rev-42" {
			w.WriteHeader(http.StatusConflict)
			_, _ = io.WriteString(w, `{"message":"The pending decision changed since it was fetched; fetch it again and re-answer the current dialog","code":"SESSION_DECISION_STALE"}`)
			return
		}
		_, _ = io.WriteString(w, `{"ok":true,"sessionId":"demo-1"}`)
	}))
	t.Cleanup(srv.Close)
	writeRunFileFor(t, cfg, srv)

	// A stale pinned revision is refused with the daemon's 409, surfaced as-is.
	_, _, err := executeCLI(t, Deps{
		ProcessAlive: func(int) bool { return true },
	}, "session", "decide", "demo-1", "--option", "1", "--revision", "rev-STALE")
	if err == nil {
		t.Fatal("stale --revision should surface the daemon's conflict")
	}
	if !strings.Contains(err.Error(), "SESSION_DECISION_STALE") {
		t.Fatalf("error = %v, want the SESSION_DECISION_STALE code surfaced", err)
	}
	if sawGet {
		t.Fatal("an explicit --revision must be passed through without a preliminary GET")
	}

	// A current pinned revision answers successfully.
	_, errOut, err := executeCLI(t, Deps{
		ProcessAlive: func(int) bool { return true },
	}, "session", "decide", "demo-1", "--option", "1", "--revision", "rev-42")
	if err != nil {
		t.Fatalf("unexpected error: %v\nstderr=%s", err, errOut)
	}
}

func TestSessionDecide_RequiresOptionOrText(t *testing.T) {
	setConfigEnv(t)
	_, _, err := executeCLI(t, Deps{}, "session", "decide", "demo-1")
	if err == nil {
		t.Fatal("expected usage error")
	}
	if got := ExitCode(err); got != 2 {
		t.Fatalf("exit code = %d, want 2", got)
	}
	if !strings.Contains(err.Error(), "--option or --text is required") {
		t.Fatalf("error = %v", err)
	}
}
