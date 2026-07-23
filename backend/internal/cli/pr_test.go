package cli

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"testing"
)

type prRequestLog struct {
	mu       sync.Mutex
	requests []string
	bodies   []string
}

func prCommandServer(t *testing.T) (*httptest.Server, *prRequestLog) {
	t.Helper()
	log := &prRequestLog{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		log.mu.Lock()
		appendPrimaryRequest(&log.requests, r)
		if requestLogEntry(r) != cliInvokedRequest {
			log.bodies = append(log.bodies, string(body))
		}
		log.mu.Unlock()

		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/api/v1/prs/42/merge":
			_, _ = io.WriteString(w, `{"ok":true,"prNumber":42,"method":"squash"}`)
		case r.Method == http.MethodPost && r.URL.Path == "/api/v1/prs/42/resolve-comments":
			_, _ = io.WriteString(w, `{"ok":true,"resolved":2}`)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	return srv, log
}

func (l *prRequestLog) all() ([]string, []string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]string(nil), l.requests...), append([]string(nil), l.bodies...)
}

func TestPRMergeCallsDaemon(t *testing.T) {
	cfg := setConfigEnv(t)
	srv, log := prCommandServer(t)
	writeRunFileFor(t, cfg, srv)

	out, errOut, err := executeCLI(t, aliveDeps(), "pr", "merge", "42")
	if err != nil {
		t.Fatalf("unexpected error: %v\nstderr=%s", err, errOut)
	}
	if !strings.Contains(out, "merged PR #42 with squash") {
		t.Fatalf("stdout = %q", out)
	}
	requests, bodies := log.all()
	if want := []string{"POST /api/v1/prs/42/merge"}; !reflect.DeepEqual(requests, want) {
		t.Fatalf("requests = %#v, want %#v", requests, want)
	}
	if len(bodies) != 1 || bodies[0] != "" {
		t.Fatalf("merge body = %#v, want empty body", bodies)
	}
}

func TestPRResolveCommentsSendsOptionalCommentIDs(t *testing.T) {
	cfg := setConfigEnv(t)
	srv, log := prCommandServer(t)
	writeRunFileFor(t, cfg, srv)

	out, errOut, err := executeCLI(t, aliveDeps(), "pr", "resolve-comments", "42", "comment-a", "comment-b")
	if err != nil {
		t.Fatalf("unexpected error: %v\nstderr=%s", err, errOut)
	}
	if !strings.Contains(out, "resolved 2 review comment(s) on PR 42") {
		t.Fatalf("stdout = %q", out)
	}
	requests, bodies := log.all()
	if want := []string{"POST /api/v1/prs/42/resolve-comments"}; !reflect.DeepEqual(requests, want) {
		t.Fatalf("requests = %#v, want %#v", requests, want)
	}
	var req resolveCommentsRequest
	if err := json.Unmarshal([]byte(bodies[0]), &req); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	if want := []string{"comment-a", "comment-b"}; !reflect.DeepEqual(req.CommentIDs, want) {
		t.Fatalf("commentIds = %#v, want %#v", req.CommentIDs, want)
	}
}

func TestPRResolveCommentsAllowsAllComments(t *testing.T) {
	cfg := setConfigEnv(t)
	srv, log := prCommandServer(t)
	writeRunFileFor(t, cfg, srv)

	if _, errOut, err := executeCLI(t, aliveDeps(), "pr", "resolve-comments", "42"); err != nil {
		t.Fatalf("unexpected error: %v\nstderr=%s", err, errOut)
	}
	_, bodies := log.all()
	var req resolveCommentsRequest
	if err := json.Unmarshal([]byte(bodies[0]), &req); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	if len(req.CommentIDs) != 0 {
		t.Fatalf("commentIds = %#v, want empty/all-comments request", req.CommentIDs)
	}
}

func TestPRMergeMissingIDIsUsageError(t *testing.T) {
	setConfigEnv(t)
	_, _, err := executeCLI(t, aliveDeps(), "pr", "merge")
	if got := ExitCode(err); got != 2 {
		t.Fatalf("exit code = %d, want 2 (usage); err=%v", got, err)
	}
}
