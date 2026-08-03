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
			case request.URL.Path == "/repos/aoagents/agent-orchestrator/pulls":
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
			case request.URL.Path == "/repos/aoagents/agent-orchestrator/pulls/42":
				body = `{
					"number":42,
					"html_url":"https://github.com/aoagents/agent-orchestrator/pull/42",
					"title":"Cloud worker",
					"state":"open",
					"draft":false,
					"mergeable":true,
					"mergeable_state":"clean",
					"head":{"sha":"abc","ref":"ao/cloud-worker"},
					"base":{"ref":"main"}
				}`
			case strings.Contains(request.URL.Path, "/check-runs"):
				body = `{"check_runs":[{"name":"test","status":"completed","conclusion":"failure","html_url":"https://ci.example","completed_at":"2026-07-29T20:00:00Z"}]}`
			case strings.Contains(request.URL.Path, "/reviews"):
				body = `[{"user":{"login":"reviewer"},"state":"CHANGES_REQUESTED","submitted_at":"2026-07-29T20:00:00Z"}]`
			case request.URL.Path == "/graphql":
				body = `{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[{"id":"thread-one","isResolved":false,"isOutdated":false,"path":"app.go","line":12,"comments":{"nodes":[{"body":"Please fix","author":{"login":"reviewer"}}]}}]}}}}}`
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
	if len(observation.ReviewThreads) != 1 || observation.ReviewThreads[0].ID != "thread-one" {
		t.Fatalf("review threads = %#v", observation.ReviewThreads)
	}
	if observation.ObservedAt.Before(time.Now().Add(-time.Minute)) {
		t.Fatalf("ObservedAt = %s", observation.ObservedAt)
	}
}

func TestObserveBranchKeepsPRWhenOptionalDetailPermissionsAreMissing(t *testing.T) {
	client := NewWithTokenSource(staticToken("token"), &http.Client{
		Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
			var body string
			statusCode := http.StatusOK
			status := "200 OK"
			switch {
			case request.URL.Path == "/repos/aoagents/agent-orchestrator/pulls":
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
			case request.URL.Path == "/repos/aoagents/agent-orchestrator/pulls/42":
				body = `{
					"number":42,
					"html_url":"https://github.com/aoagents/agent-orchestrator/pull/42",
					"title":"Cloud worker",
					"state":"open",
					"draft":false,
					"mergeable":true,
					"mergeable_state":"clean",
					"head":{"sha":"abc","ref":"ao/cloud-worker"},
					"base":{"ref":"main"}
				}`
			case strings.Contains(request.URL.Path, "/check-runs"):
				statusCode = http.StatusForbidden
				status = "403 Forbidden"
				body = `{"message":"Resource not accessible by integration"}`
			case strings.Contains(request.URL.Path, "/reviews"):
				body = `[]`
			case request.URL.Path == "/graphql":
				statusCode = http.StatusForbidden
				status = "403 Forbidden"
				body = `{"message":"Resource not accessible by integration"}`
			default:
				t.Fatalf("unexpected GitHub path %q", request.URL.Path)
			}
			return &http.Response{
				StatusCode: statusCode,
				Status:     status,
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
	if observation.Number != 42 || observation.Mergeability != "mergeable" {
		t.Fatalf("observation = %#v", observation)
	}
	if observation.CIState != "unknown" || len(observation.Checks) != 0 {
		t.Fatalf("optional checks should be omitted: %#v", observation)
	}
}

func TestGetIssueAndPullRequestStayInRegisteredRepository(t *testing.T) {
	client := NewWithTokenSource(staticToken("token"), &http.Client{
		Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
			var body string
			switch request.URL.Path {
			case "/repos/aoagents/agent-orchestrator/issues/7":
				body = `{"number":7,"html_url":"https://github.com/aoagents/agent-orchestrator/issues/7","title":"Cloud parity","body":"Ship it","state":"open"}`
			case "/repos/aoagents/agent-orchestrator/pulls/9":
				body = `{"number":9,"html_url":"https://github.com/aoagents/agent-orchestrator/pull/9","state":"open"}`
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
	ctx := context.Background()
	issue, err := client.GetIssue(ctx, "https://github.com/aoagents/agent-orchestrator", 7)
	if err != nil || issue.Repository != "aoagents/agent-orchestrator" || issue.Title != "Cloud parity" {
		t.Fatalf("GetIssue() = %#v, error = %v", issue, err)
	}
	pull, err := client.GetPullRequest(ctx, "https://github.com/aoagents/agent-orchestrator", "https://github.com/aoagents/agent-orchestrator/pull/9")
	if err != nil || pull.Number != 9 {
		t.Fatalf("GetPullRequest() = %#v, error = %v", pull, err)
	}
	if _, err := client.GetPullRequest(ctx, "https://github.com/aoagents/agent-orchestrator", "https://github.com/other/repository/pull/9"); err == nil {
		t.Fatal("GetPullRequest() accepted a cross-project pull request")
	}
}
