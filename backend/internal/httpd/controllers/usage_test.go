package controllers_test

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/config"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd"
)

type fakeUsageSummaryService struct {
	projectID domain.ProjectID
	items     []domain.CompactSessionUsage
	err       error
}

func (f *fakeUsageSummaryService) ListCompact(_ context.Context, projectID domain.ProjectID) ([]domain.CompactSessionUsage, error) {
	f.projectID = projectID
	return f.items, f.err
}

func newUsageTestServer(t *testing.T, svc *fakeUsageSummaryService) *httptest.Server {
	t.Helper()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	srv := httptest.NewServer(httpd.NewRouterWithControl(config.Config{}, log, nil, httpd.APIDeps{UsageSummary: svc}, httpd.ControlDeps{}))
	t.Cleanup(srv.Close)
	return srv
}

func TestUsageAPIListsCompactProjectUsage(t *testing.T) {
	now := time.Date(2026, 7, 27, 12, 0, 0, 0, time.UTC)
	svc := &fakeUsageSummaryService{items: []domain.CompactSessionUsage{{
		SessionID:       "reverb-12",
		TotalTokens:     12400,
		CollectionState: domain.UsageCollectionCollecting,
		Coverage:        domain.UsageCoveragePartial,
		LastObservedAt:  &now,
	}}}
	srv := newUsageTestServer(t, svc)

	body, status, _ := doRequest(t, srv, http.MethodGet, "/api/v1/usage/sessions?projectId=reverb", "")
	if status != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", status, body)
	}
	if svc.projectID != "reverb" {
		t.Fatalf("project id = %q, want reverb", svc.projectID)
	}
	var got struct {
		Sessions []struct {
			SessionID       string     `json:"sessionId"`
			TotalTokens     int64      `json:"totalTokens"`
			CollectionState string     `json:"collectionState"`
			Coverage        string     `json:"coverage"`
			LastObservedAt  *time.Time `json:"lastObservedAt"`
		} `json:"sessions"`
	}
	mustJSON(t, body, &got)
	if len(got.Sessions) != 1 || got.Sessions[0].SessionID != "reverb-12" ||
		got.Sessions[0].TotalTokens != 12400 || got.Sessions[0].CollectionState != "collecting" ||
		got.Sessions[0].Coverage != "partial" || got.Sessions[0].LastObservedAt == nil ||
		!got.Sessions[0].LastObservedAt.Equal(now) {
		t.Fatalf("response = %+v", got)
	}
}
