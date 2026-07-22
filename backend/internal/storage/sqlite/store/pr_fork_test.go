package store_test

import (
	"context"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// The is_from_fork tri-state (migration 0041) round-trips through the observer
// write path (WriteSCMObservation -> UpsertPR) and is projected onto PRFacts by
// both the by-url and display reads the trigger bridge + command-executor gate
// use. NULL (unpopulated) reads back as nil = unknown.
func TestPRIsFromForkRoundTrip(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	seedProject(t, s, "mer")
	now := time.Now().UTC().Truncate(time.Second)
	yes, no := true, false

	cases := []struct {
		url  string
		fork *bool
	}{
		{"pr-fork", &yes},
		{"pr-samerepo", &no},
		{"pr-unknown", nil},
	}
	for _, tc := range cases {
		r, _ := s.CreateSession(ctx, sampleRecord("mer"))
		pr := domain.PullRequest{
			URL:        tc.url,
			SessionID:  r.ID,
			Number:     1,
			CI:         domain.CIPassing,
			HeadSHA:    "deadbeef",
			IsFromFork: tc.fork,
			UpdatedAt:  now,
			ObservedAt: now,
		}
		if err := s.WriteSCMObservation(ctx, pr, nil, nil, nil, nil, ports.ReviewWritePreserve); err != nil {
			t.Fatalf("write %s: %v", tc.url, err)
		}

		// By-url read (trigger bridge path): head_sha + fork provenance.
		byURL, ok, err := s.GetPRFactsByURL(ctx, tc.url)
		if err != nil || !ok {
			t.Fatalf("GetPRFactsByURL %s: ok=%v err=%v", tc.url, ok, err)
		}
		if byURL.HeadSHA != "deadbeef" {
			t.Fatalf("%s head_sha = %q, want deadbeef", tc.url, byURL.HeadSHA)
		}
		assertForkPtr(t, tc.url+" by-url", byURL.IsFromFork, tc.fork)

		// Display read (command-executor fork gate path).
		disp, ok, err := s.GetDisplayPRFactsForSession(ctx, r.ID)
		if err != nil || !ok {
			t.Fatalf("GetDisplayPRFactsForSession %s: ok=%v err=%v", tc.url, ok, err)
		}
		assertForkPtr(t, tc.url+" display", disp.IsFromFork, tc.fork)
	}

	// A url with no row reads back ok=false, not an error.
	if _, ok, err := s.GetPRFactsByURL(ctx, "missing"); ok || err != nil {
		t.Fatalf("GetPRFactsByURL missing: ok=%v err=%v, want false/nil", ok, err)
	}
}

func assertForkPtr(t *testing.T, label string, got, want *bool) {
	t.Helper()
	switch {
	case want == nil && got != nil:
		t.Fatalf("%s IsFromFork = %v, want nil (unknown)", label, *got)
	case want != nil && got == nil:
		t.Fatalf("%s IsFromFork = nil, want %v", label, *want)
	case want != nil && got != nil && *got != *want:
		t.Fatalf("%s IsFromFork = %v, want %v", label, *got, *want)
	}
}
