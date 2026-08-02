package controllers_test

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/config"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd"
)

type fakeUsageSummaryService struct {
	projectID domain.ProjectID
	items     []domain.CompactSessionUsage
	sessionID domain.SessionID
	detail    domain.SessionUsageSummary
	err       error
}

func (f *fakeUsageSummaryService) ListCompact(_ context.Context, projectID domain.ProjectID) ([]domain.CompactSessionUsage, error) {
	f.projectID = projectID
	return f.items, f.err
}

func (f *fakeUsageSummaryService) Get(
	_ context.Context,
	sessionID domain.SessionID,
) (domain.SessionUsageSummary, error) {
	f.sessionID = sessionID
	return f.detail, f.err
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

func TestUsageAPIShowsDetailedSessionTelemetry(t *testing.T) {
	now := time.Date(2026, 7, 27, 12, 0, 0, 0, time.UTC)
	input := int64(1000)
	output := int64(200)
	cacheRead := int64(400)
	svc := &fakeUsageSummaryService{detail: domain.SessionUsageSummary{
		SessionID: "reverb-12",
		Collection: domain.UsageCollectionSummary{
			State:          domain.UsageCollectionCollecting,
			LastObservedAt: &now,
		},
		Totals: domain.UsageMetricTotals{
			InputTokens:     domain.UsageMetricCoverage{Value: &input, Coverage: domain.UsageCoveragePartial},
			CacheReadTokens: domain.UsageMetricCoverage{Value: &cacheRead, Coverage: domain.UsageCoveragePartial},
			OutputTokens:    domain.UsageMetricCoverage{Value: &output, Coverage: domain.UsageCoveragePartial},
			CostNanos:       domain.UsageCostCoverage{Coverage: domain.UsageCoverageUnavailable},
		},
		Harnesses: []domain.HarnessUsageSummary{{
			Harness:  domain.HarnessCodex,
			Provider: "openai",
			Models:   []domain.ModelUsageSummary{{ModelID: "gpt-5.6", Provider: "openai"}},
		}},
	}}
	srv := newUsageTestServer(t, svc)

	body, status, _ := doRequest(t, srv, http.MethodGet, "/api/v1/usage/sessions/reverb-12", "")
	if status != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", status, body)
	}
	if svc.sessionID != "reverb-12" {
		t.Fatalf("session id = %q", svc.sessionID)
	}
	var got struct {
		SessionID       string `json:"sessionId"`
		CollectionState string `json:"collectionState"`
		Totals          struct {
			InputTokens struct {
				Value int64 `json:"value"`
			} `json:"inputTokens"`
			Cost struct {
				ValueNanos *int64 `json:"valueNanos"`
				Coverage   string `json:"coverage"`
			} `json:"cost"`
		} `json:"totals"`
		Harnesses []struct {
			Models []struct {
				ModelID string `json:"modelId"`
			} `json:"models"`
		} `json:"harnesses"`
	}
	mustJSON(t, body, &got)
	if got.SessionID != "reverb-12" || got.CollectionState != "collecting" ||
		got.Totals.InputTokens.Value != 1000 ||
		got.Totals.Cost.ValueNanos != nil ||
		got.Totals.Cost.Coverage != "unavailable" ||
		len(got.Harnesses) != 1 || len(got.Harnesses[0].Models) != 1 ||
		got.Harnesses[0].Models[0].ModelID != "gpt-5.6" {
		t.Fatalf("response = %+v", got)
	}
}

func TestUsageAPICostPricingVersion(t *testing.T) {
	cost := int64(123456)
	version := "pricing-v1"
	tests := []struct {
		name    string
		version *string
		want    string
	}{
		{name: "single version", version: &version, want: version},
		{name: "mixed versions omitted"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			svc := &fakeUsageSummaryService{detail: domain.SessionUsageSummary{
				SessionID: "reverb-12",
				Totals: domain.UsageMetricTotals{CostNanos: domain.UsageCostCoverage{
					Value:          &cost,
					Coverage:       domain.UsageCoverageComplete,
					PricingVersion: test.version,
				}},
			}}
			srv := newUsageTestServer(t, svc)
			body, status, _ := doRequest(t, srv, http.MethodGet, "/api/v1/usage/sessions/reverb-12", "")
			if status != http.StatusOK {
				t.Fatalf("status = %d, want 200; body=%s", status, body)
			}
			var got struct {
				Totals struct {
					Cost struct {
						PricingVersion *string `json:"pricingVersion"`
					} `json:"cost"`
				} `json:"totals"`
			}
			mustJSON(t, body, &got)
			if test.want == "" {
				if got.Totals.Cost.PricingVersion != nil || strings.Contains(string(body), `"pricingVersion"`) {
					t.Fatalf("mixed pricing version was not omitted: %s", body)
				}
			} else if got.Totals.Cost.PricingVersion == nil || *got.Totals.Cost.PricingVersion != test.want {
				t.Fatalf("pricing version response = %s, want %q", body, test.want)
			}
		})
	}
}
