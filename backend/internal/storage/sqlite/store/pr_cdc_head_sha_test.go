package store_test

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/cdc"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// New-SHA cancel-and-rearm (spec decision 9) rides pr_updated. Migration 0026
// added OLD.head_sha <> NEW.head_sha to the pr_cdc_update WHEN clause so a push
// that changes ONLY the head SHA (no CI/review/state/mergeability change, e.g. a
// repo without CI) still emits pr_updated for the trigger bridge. Without it the
// stale run would keep running and no fresh run would arm.
func TestPRCDC_EmitsOnHeadSHAOnlyChange(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	seedProject(t, s, "mer")
	rec, err := s.CreateSession(ctx, sampleRecord("mer"))
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC().Truncate(time.Second)
	url := "https://example/pr/head"

	// Every write keeps CI/review/state/mergeability identical so the ONLY thing
	// that can drive a pr_updated event is the head_sha change.
	write := func(headSHA string, at time.Time) {
		t.Helper()
		if err := s.WriteSCMObservation(ctx, domain.PullRequest{
			URL: url, SessionID: rec.ID, Number: 1,
			CI: domain.CIPassing, Review: domain.ReviewApproved, Mergeability: domain.MergeMergeable,
			HeadSHA: headSHA, UpdatedAt: at, ObservedAt: at,
		}, nil, nil, nil, nil, ports.ReviewWritePreserve); err != nil {
			t.Fatalf("write %s: %v", headSHA, err)
		}
	}

	write("sha1", now)                    // INSERT -> pr_created
	write("sha2", now.Add(time.Second))   // head_sha-only change -> pr_updated
	write("sha2", now.Add(2*time.Second)) // nothing changed -> NO event

	rows, err := s.EventsAfter(ctx, 0, 100)
	if err != nil {
		t.Fatal(err)
	}
	var updated []cdc.Event
	for _, r := range rows {
		if r.Type == cdc.EventPRUpdated {
			updated = append(updated, r)
		}
	}
	if len(updated) != 1 {
		t.Fatalf("want exactly 1 pr_updated CDC event from the head_sha-only change (no-op suppressed), got %d", len(updated))
	}
	// The bridge reads head_sha from the store, so the payload need not carry it;
	// assert the event is well-formed and tied to the right PR.
	if !strings.Contains(string(updated[0].Payload), `"url":"`+url+`"`) {
		t.Fatalf("pr_updated payload missing url: %q", updated[0].Payload)
	}
}
