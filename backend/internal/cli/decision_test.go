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
		if r.Method != http.MethodPost {
			http.NotFound(w, r)
			return
		}
		if r.URL.Path != "/api/v1/sessions/demo-1/decision" {
			http.NotFound(w, r)
			return
		}
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Fatalf("read body: %v", err)
		}
		capture.body = string(body)
		capture.path = r.URL.Path
		w.Header().Set("Content-Type", "application/json")
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
		Option int `json:"option"`
	}
	if err := json.Unmarshal([]byte(capture.body), &req); err != nil {
		t.Fatalf("decode body: %v\nbody=%s", err, capture.body)
	}
	if capture.path != "/api/v1/sessions/demo-1/decision" || req.Option != 2 {
		t.Fatalf("request path=%q option=%d", capture.path, req.Option)
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
