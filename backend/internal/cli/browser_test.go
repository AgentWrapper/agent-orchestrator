package cli

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type browserRequestCapture struct {
	path string
	body browserCommandRequestDTO
}

func browserCLIServer(t *testing.T, capture *browserRequestCapture) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		capture.path = r.URL.RequestURI()
		w.Header().Set("Content-Type", "application/json")
		if r.Method == http.MethodGet && r.URL.Path == "/api/v1/browser/status" {
			_, _ = io.WriteString(w, `{"sessionId":"ao-1","connected":true,"transport":"electron-webcontents-debugger"}`)
			return
		}
		if r.Method != http.MethodPost || r.URL.Path != "/api/v1/browser/commands" {
			http.NotFound(w, r)
			return
		}
		if err := json.NewDecoder(r.Body).Decode(&capture.body); err != nil {
			t.Fatalf("decode command: %v", err)
		}
		result := `{"ok":true}`
		switch capture.body.Action {
		case "snapshot":
			result = `{"text":"button Save [ref=e1]"}`
		case "screenshot":
			result = `{"data":"cG5n","width":10,"height":20}`
		}
		_, _ = io.WriteString(w, `{"requestId":"r1","sessionId":"ao-1","action":"`+capture.body.Action+`","result":`+result+`}`)
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestBrowserStatusAndSnapshot(t *testing.T) {
	t.Setenv("AO_SESSION_ID", "ao-1")
	cfg := setConfigEnv(t)
	capture := &browserRequestCapture{}
	srv := browserCLIServer(t, capture)
	writeRunFileFor(t, cfg, srv)
	deps := Deps{ProcessAlive: func(int) bool { return true }}

	out, errOut, err := executeCLI(t, deps, "browser", "status")
	if err != nil || !strings.Contains(out, "Browser runtime: connected") {
		t.Fatalf("status err=%v stderr=%s stdout=%s", err, errOut, out)
	}
	if capture.path != "/api/v1/browser/status?sessionId=ao-1" {
		t.Fatalf("status path = %q", capture.path)
	}
	out, errOut, err = executeCLI(t, deps, "browser", "snapshot", "--interactive")
	if err != nil || !strings.Contains(out, "button Save [ref=e1]") {
		t.Fatalf("snapshot err=%v stderr=%s stdout=%s", err, errOut, out)
	}
	if capture.body.SessionID != "ao-1" || capture.body.Action != "snapshot" || capture.body.Args["interactive"] != true {
		t.Fatalf("command = %#v", capture.body)
	}
}

func TestBrowserClickAndWaitArguments(t *testing.T) {
	t.Setenv("AO_SESSION_ID", "ao-1")
	cfg := setConfigEnv(t)
	capture := &browserRequestCapture{}
	srv := browserCLIServer(t, capture)
	writeRunFileFor(t, cfg, srv)
	deps := Deps{ProcessAlive: func(int) bool { return true }}

	if _, _, err := executeCLI(t, deps, "browser", "click", "e2"); err != nil {
		t.Fatal(err)
	}
	if capture.body.Action != "click" || capture.body.Args["ref"] != "e2" {
		t.Fatalf("click = %#v", capture.body)
	}
	if _, _, err := executeCLI(t, deps, "browser", "wait", "--text", "Ready", "--timeout", "2500"); err != nil {
		t.Fatal(err)
	}
	if capture.body.Action != "wait" || capture.body.Args["text"] != "Ready" || capture.body.Args["timeoutMs"] != float64(2500) {
		t.Fatalf("wait = %#v", capture.body)
	}
}

func TestBrowserScreenshotWritesWithoutOverwrite(t *testing.T) {
	t.Setenv("AO_SESSION_ID", "ao-1")
	cfg := setConfigEnv(t)
	capture := &browserRequestCapture{}
	srv := browserCLIServer(t, capture)
	writeRunFileFor(t, cfg, srv)
	deps := Deps{ProcessAlive: func(int) bool { return true }}
	target := filepath.Join(t.TempDir(), "shot.png")

	out, errOut, err := executeCLI(t, deps, "browser", "screenshot", target)
	if err != nil {
		t.Fatalf("screenshot err=%v stderr=%s", err, errOut)
	}
	data, err := os.ReadFile(target)
	if err != nil || string(data) != "png" || !strings.Contains(out, "10x20") {
		t.Fatalf("screenshot data=%q err=%v out=%s", data, err, out)
	}
	if _, _, err := executeCLI(t, deps, "browser", "screenshot", target); err == nil || !strings.Contains(err.Error(), "refusing to overwrite") {
		t.Fatalf("overwrite error = %v", err)
	}
}

func TestBrowserRequiresSessionAndValidWait(t *testing.T) {
	t.Setenv("AO_SESSION_ID", "")
	if _, _, err := executeCLI(t, Deps{}, "browser", "status"); ExitCode(err) != 2 {
		t.Fatalf("status error = %v code=%d", err, ExitCode(err))
	}
	t.Setenv("AO_SESSION_ID", "ao-1")
	if _, _, err := executeCLI(t, Deps{}, "browser", "wait", "--text", "x", "--url", "y"); ExitCode(err) != 2 {
		t.Fatalf("wait error = %v code=%d", err, ExitCode(err))
	}
}
