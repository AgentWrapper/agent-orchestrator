package cli

import (
	"encoding/json"
	"net/http"
	"testing"
)

func TestSuggestionAdd(t *testing.T) {
	cfg := setConfigEnv(t)
	srv, capture := projectServer(t, http.StatusCreated, `{"suggestion":{"id":"sg_1","projectId":"demo","title":"Shared cache","priority":"important","status":"backlog","createdAt":"2026-07-14T12:00:00Z","updatedAt":"2026-07-14T12:00:00Z"}}`)
	writeRunFileFor(t, cfg, srv)

	_, stderr, err := executeCLI(t, Deps{ProcessAlive: func(int) bool { return true }},
		"suggestion", "add", "--project", "demo", "--title", "Shared cache", "--note", "Later workflow idea", "--priority", "important")
	if err != nil {
		t.Fatalf("suggestion add: %v\nstderr=%s", err, stderr)
	}
	if capture.method != http.MethodPost || capture.path != "/api/v1/projects/demo/suggestions" {
		t.Fatalf("request = %s %s", capture.method, capture.path)
	}
	var body suggestionCreateRequest
	if err := json.Unmarshal(capture.body, &body); err != nil {
		t.Fatal(err)
	}
	if body.Title != "Shared cache" || body.Note != "Later workflow idea" || body.Priority != "important" {
		t.Fatalf("body = %#v", body)
	}
}

func TestSuggestionStart(t *testing.T) {
	cfg := setConfigEnv(t)
	srv, capture := projectServer(t, http.StatusCreated, `{"suggestion":{"id":"sg_1","projectId":"demo","title":"Shared cache","priority":"normal","status":"in_progress","sessionId":"demo-7","createdAt":"2026-07-14T12:00:00Z","updatedAt":"2026-07-14T12:01:00Z"},"sessionId":"demo-7"}`)
	writeRunFileFor(t, cfg, srv)

	out, stderr, err := executeCLI(t, Deps{ProcessAlive: func(int) bool { return true }},
		"suggestion", "start", "sg_1", "--project", "demo")
	if err != nil {
		t.Fatalf("suggestion start: %v\nstderr=%s", err, stderr)
	}
	if capture.method != http.MethodPost || capture.path != "/api/v1/projects/demo/suggestions/sg_1/start" {
		t.Fatalf("request = %s %s", capture.method, capture.path)
	}
	if out != "Started demo-7 for Shared cache\n" {
		t.Fatalf("output = %q", out)
	}
}
