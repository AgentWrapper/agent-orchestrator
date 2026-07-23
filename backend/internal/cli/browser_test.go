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

func TestBrowserCoreInteractionArguments(t *testing.T) {
	t.Setenv("AO_SESSION_ID", "ao-1")
	cfg := setConfigEnv(t)
	capture := &browserRequestCapture{}
	srv := browserCLIServer(t, capture)
	writeRunFileFor(t, cfg, srv)
	deps := Deps{ProcessAlive: func(int) bool { return true }}

	tests := []struct {
		name   string
		args   []string
		action string
		want   map[string]any
	}{
		{name: "type", args: []string{"type", "e1", "hello"}, action: "type", want: map[string]any{"ref": "e1", "text": "hello"}},
		{name: "press", args: []string{"press", "Control+A"}, action: "press", want: map[string]any{"key": "Control+A"}},
		{name: "hover", args: []string{"hover", "e2"}, action: "hover", want: map[string]any{"ref": "e2"}},
		{name: "scroll", args: []string{"scroll", "down", "--amount", "450"}, action: "scroll", want: map[string]any{"direction": "down", "amount": float64(450)}},
		{name: "select", args: []string{"select", "e3", "large"}, action: "select", want: map[string]any{"ref": "e3", "value": "large"}},
		{name: "check", args: []string{"check", "e4"}, action: "check", want: map[string]any{"ref": "e4"}},
		{name: "uncheck", args: []string{"uncheck", "e4"}, action: "uncheck", want: map[string]any{"ref": "e4"}},
		{name: "get", args: []string{"get", "value", "e5"}, action: "get", want: map[string]any{"property": "value", "ref": "e5"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if _, _, err := executeCLI(t, deps, append([]string{"browser"}, tt.args...)...); err != nil {
				t.Fatal(err)
			}
			if capture.body.Action != tt.action {
				t.Fatalf("action = %q, want %q", capture.body.Action, tt.action)
			}
			for key, want := range tt.want {
				if got := capture.body.Args[key]; got != want {
					t.Fatalf("%s arg %q = %#v, want %#v", tt.name, key, got, want)
				}
			}
		})
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
	if _, _, err := executeCLI(t, Deps{}, "browser", "get"); ExitCode(err) != 2 {
		t.Fatalf("get error = %v code=%d", err, ExitCode(err))
	}
}
