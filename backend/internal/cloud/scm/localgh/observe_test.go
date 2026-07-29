package localgh

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

type staticToken string

func (s staticToken) Token(context.Context) (string, error) { return string(s), nil }

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return f(request)
}

func TestObserveBranchNormalizesPRChecksAndReviews(t *testing.T) {
	client := NewWithTokenSource(staticToken("token"), &http.Client{
		Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
			var body string
			switch {
			case strings.Contains(request.URL.Path, "/pulls") && !strings.Contains(request.URL.Path, "/reviews"):
				body = `[{
					"number":42,
					"html_url":"https://github.com/aoagents/agent-orchestrator/pull/42",
					"title":"Cloud worker",
					"state":"open",
					"draft":false,
					"mergeable":true,
					"head":{"sha":"abc","ref":"ao/cloud-worker"},
					"base":{"ref":"main"}
				}]`
			case strings.Contains(request.URL.Path, "/check-runs"):
				body = `{"check_runs":[{"name":"test","status":"completed","conclusion":"failure","html_url":"https://ci.example","completed_at":"2026-07-29T20:00:00Z"}]}`
			case strings.Contains(request.URL.Path, "/reviews"):
				body = `[{"user":{"login":"reviewer"},"state":"CHANGES_REQUESTED","submitted_at":"2026-07-29T20:00:00Z"}]`
			default:
				t.Fatalf("unexpected GitHub path %q", request.URL.Path)
			}
			return &http.Response{
				StatusCode: http.StatusOK,
				Status:     "200 OK",
				Header:     make(http.Header),
				Body:       io.NopCloser(strings.NewReader(body)),
				Request:    request,
			}, nil
		}),
	})
	observation, err := client.ObserveBranch(
		context.Background(),
		"https://github.com/aoagents/agent-orchestrator",
		"ao/cloud-worker",
	)
	if err != nil {
		t.Fatalf("ObserveBranch() error = %v", err)
	}
	if observation == nil {
		t.Fatal("ObserveBranch() = nil")
	}
	if observation.CIState != "failing" || observation.ReviewState != "changes_requested" {
		t.Fatalf("observation = %#v", observation)
	}
	if observation.Mergeability != "mergeable" || len(observation.Checks) != 1 {
		t.Fatalf("observation = %#v", observation)
	}
	if observation.ObservedAt.Before(time.Now().Add(-time.Minute)) {
		t.Fatalf("ObservedAt = %s", observation.ObservedAt)
	}
}
