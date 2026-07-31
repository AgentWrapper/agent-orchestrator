package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite/gen"
)

// GetDisplayPRFactsForSession returns the PR snapshot that should represent a
// session in derived display status: active PRs first, otherwise the newest
// historical PR. ok=false means the session has no associated PRs.
func (s *Store) GetDisplayPRFactsForSession(ctx context.Context, id domain.SessionID) (domain.PRFacts, bool, error) {
	r, err := s.qr.GetDisplayPRFactsBySession(ctx, id)
	if errors.Is(err, sql.ErrNoRows) {
		return domain.PRFacts{}, false, nil
	}
	if err != nil {
		return domain.PRFacts{}, false, fmt.Errorf("display pr facts for %s: %w", id, err)
	}
	return prFactsFromGen(r), true, nil
}

// ListPRFactsForSession returns the PR snapshot for every PR a session owns
// (open, merged, and closed), newest first. The status aggregator filters and
// builds stacks from these; an empty slice means the session has no PRs.
func (s *Store) ListPRFactsForSession(ctx context.Context, id domain.SessionID) ([]domain.PRFacts, error) {
	rows, err := s.qr.ListPRFactsBySession(ctx, id)
	if err != nil {
		return nil, fmt.Errorf("list pr facts for %s: %w", id, err)
	}
	out := make([]domain.PRFacts, 0, len(rows))
	for _, r := range rows {
		out = append(out, domain.PRFacts{
			URL:            r.URL,
			Number:         int(r.Number),
			Draft:          r.PRState == domain.PRStateDraft,
			Merged:         r.PRState == domain.PRStateMerged,
			Closed:         r.PRState == domain.PRStateClosed,
			CI:             r.CIState,
			Review:         r.ReviewDecision,
			Mergeability:   r.Mergeability,
			ReviewComments: r.ReviewComments,
			SourceBranch:   r.SourceBranch,
			TargetBranch:   r.TargetBranch,
			UpdatedAt:      r.UpdatedAt,
		})
	}
	return out, nil
}

func prFactsFromGen(r gen.GetDisplayPRFactsBySessionRow) domain.PRFacts {
	state := r.PRState
	return domain.PRFacts{
		URL:            r.URL,
		Number:         int(r.Number),
		Draft:          state == domain.PRStateDraft,
		Merged:         state == domain.PRStateMerged,
		Closed:         state == domain.PRStateClosed,
		CI:             r.CIState,
		Review:         r.ReviewDecision,
		Mergeability:   r.Mergeability,
		ReviewComments: r.ReviewComments,
		HeadSHA:        r.HeadSha,
		IsFromFork:     boolPtrFromNullInt(r.IsFromFork),
		UpdatedAt:      r.UpdatedAt,
	}
}

// GetPRFactsByURL returns the facts for one exact PR url, including head_sha and
// fork provenance. It backs the pipeline trigger bridge (T6), which needs the
// changed PR named in a CDC payload, not the session's display PR. ok=false when
// no PR with that url exists.
func (s *Store) GetPRFactsByURL(ctx context.Context, url string) (domain.PRFacts, bool, error) {
	r, err := s.qr.GetPRFactsByURL(ctx, url)
	if errors.Is(err, sql.ErrNoRows) {
		return domain.PRFacts{}, false, nil
	}
	if err != nil {
		return domain.PRFacts{}, false, fmt.Errorf("pr facts for %s: %w", url, err)
	}
	state := r.PRState
	return domain.PRFacts{
		URL:          r.URL,
		Number:       int(r.Number),
		Draft:        state == domain.PRStateDraft,
		Merged:       state == domain.PRStateMerged,
		Closed:       state == domain.PRStateClosed,
		CI:           r.CIState,
		Review:       r.ReviewDecision,
		Mergeability: r.Mergeability,
		HeadSHA:      r.HeadSha,
		IsFromFork:   boolPtrFromNullInt(r.IsFromFork),
		UpdatedAt:    r.UpdatedAt,
	}, true, nil
}
