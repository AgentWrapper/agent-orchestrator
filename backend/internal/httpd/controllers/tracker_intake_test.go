package controllers_test

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/config"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apierr"
	trackerintakesvc "github.com/aoagents/agent-orchestrator/backend/internal/service/trackerintake"
)

func TestGetTrackerIntakeIdentity(t *testing.T) {
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	svc := &fakeTrackerIntakeService{user: domain.TrackerUser{Login: "octocat"}}
	srv := httptest.NewServer(httpd.NewRouterWithControl(config.Config{}, log, nil, httpd.APIDeps{
		TrackerIntake: svc,
	}, httpd.ControlDeps{}))
	defer srv.Close()

	body, status, _ := doRequest(t, srv, http.MethodGet, "/api/v1/tracker-intake/github/user", "")
	if status != http.StatusOK {
		t.Fatalf("GET identity = %d, body=%s", status, body)
	}
	if !strings.Contains(string(body), `"login":"octocat"`) {
		t.Fatalf("body = %s, want octocat login", body)
	}
}

func TestListTrackerIntakeLabels(t *testing.T) {
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	svc := &fakeTrackerIntakeService{labels: []domain.TrackerLabel{{Name: "bug", Color: "d73a4a", Description: "Something is broken"}}}
	srv := httptest.NewServer(httpd.NewRouterWithControl(config.Config{}, log, nil, httpd.APIDeps{
		TrackerIntake: svc,
	}, httpd.ControlDeps{}))
	defer srv.Close()

	body, status, _ := doRequest(t, srv, http.MethodGet, "/api/v1/projects/demo/tracker-intake/github/labels?refresh=true", "")
	if status != http.StatusOK {
		t.Fatalf("GET labels = %d, body=%s", status, body)
	}
	if !strings.Contains(string(body), `"name":"bug"`) || svc.labelsProjectID != "demo" || !svc.refresh {
		t.Fatalf("body=%s project=%q refresh=%v", body, svc.labelsProjectID, svc.refresh)
	}
}

func TestPreviewTrackerIntakeIssues(t *testing.T) {
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	svc := &fakeTrackerIntakeService{preview: trackerintakesvc.Preview{Count: 7}}
	srv := httptest.NewServer(httpd.NewRouterWithControl(config.Config{}, log, nil, httpd.APIDeps{
		TrackerIntake: svc,
	}, httpd.ControlDeps{}))
	defer srv.Close()

	body, status, _ := doRequest(t, srv, http.MethodPost, "/api/v1/projects/demo/tracker-intake/github/preview", `{"labels":["bug","ready"]}`)
	if status != http.StatusOK {
		t.Fatalf("POST preview = %d, body=%s", status, body)
	}
	if !strings.Contains(string(body), `"count":7`) || svc.previewProjectID != "demo" || len(svc.previewLabels) != 2 {
		t.Fatalf("body=%s project=%q labels=%#v", body, svc.previewProjectID, svc.previewLabels)
	}
}

func TestTrackerIntakeValidationAndErrorEnvelopes(t *testing.T) {
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	svc := &fakeTrackerIntakeService{}
	srv := httptest.NewServer(httpd.NewRouterWithControl(config.Config{}, log, nil, httpd.APIDeps{
		TrackerIntake: svc,
	}, httpd.ControlDeps{}))
	defer srv.Close()

	body, status, _ := doRequest(t, srv, http.MethodGet, "/api/v1/projects/demo/tracker-intake/github/labels?refresh=sometimes", "")
	assertErrorCode(t, body, status, http.StatusBadRequest, "INVALID_REFRESH")

	body, status, _ = doRequest(t, srv, http.MethodPost, "/api/v1/projects/demo/tracker-intake/github/preview", `{`)
	assertErrorCode(t, body, status, http.StatusBadRequest, "INVALID_JSON")

	svc.err = apierr.Invalid("INVALID_TRACKER_INTAKE_FILTER", "invalid label filter", nil)
	body, status, _ = doRequest(t, srv, http.MethodPost, "/api/v1/projects/demo/tracker-intake/github/preview", `{"labels":[" "]}`)
	assertErrorCode(t, body, status, http.StatusBadRequest, "INVALID_TRACKER_INTAKE_FILTER")
}

type fakeTrackerIntakeService struct {
	user             domain.TrackerUser
	labels           []domain.TrackerLabel
	labelsProjectID  domain.ProjectID
	refresh          bool
	preview          trackerintakesvc.Preview
	previewProjectID domain.ProjectID
	previewLabels    []string
	err              error
}

func (f *fakeTrackerIntakeService) Preview(_ context.Context, projectID domain.ProjectID, labels []string) (trackerintakesvc.Preview, error) {
	f.previewProjectID = projectID
	f.previewLabels = append([]string(nil), labels...)
	return f.preview, f.err
}

func (f *fakeTrackerIntakeService) Labels(_ context.Context, projectID domain.ProjectID, refresh bool) ([]domain.TrackerLabel, error) {
	f.labelsProjectID = projectID
	f.refresh = refresh
	return f.labels, f.err
}

func (f *fakeTrackerIntakeService) Identity(context.Context) (domain.TrackerUser, error) {
	return f.user, f.err
}
