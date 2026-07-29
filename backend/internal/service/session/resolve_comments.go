package session

import (
	"context"
	"fmt"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

// ResolvePRComments resolves review threads on one of a session's pull requests.
//
// The PR is addressed by session + number rather than number alone: numbers are
// only unique within a repository, and AO indexes pull requests by the session
// that owns them, so a bare number cannot identify one.
//
// An empty threadIDs resolves every unresolved human thread on the PR, matching
// the CLI's "resolve everything" shape. Bot comments are left alone — they are
// not what a reviewer is waiting on.
func (s *Service) ResolvePRComments(ctx context.Context, id domain.SessionID, prNumber int, threadIDs []string) (int, error) {
	if s.scm == nil {
		return 0, fmt.Errorf("resolve pr comments: %w", ErrSCMUnavailable)
	}
	prs, err := s.store.ListPRsBySession(ctx, id)
	if err != nil {
		return 0, fmt.Errorf("resolve pr comments: list prs: %w", err)
	}
	var target domain.PullRequest
	found := false
	for _, pr := range prs {
		if pr.Number == prNumber {
			target, found = pr, true
			break
		}
	}
	if !found {
		return 0, fmt.Errorf("resolve pr comments: pr #%d on session %s: %w", prNumber, id, ErrPRNotFound)
	}

	targets, err := s.resolveTargets(ctx, target.URL, threadIDs)
	if err != nil {
		return 0, err
	}

	resolved := 0
	for _, threadID := range targets {
		if err := s.scm.ResolveReviewThread(ctx, threadID); err != nil {
			// Report what did land: a partial resolve is still progress, and the
			// caller can retry the rest without undoing it.
			return resolved, fmt.Errorf("resolve pr comments: thread %s: %w", threadID, err)
		}
		resolved++
	}
	return resolved, nil
}

// resolveTargets returns the thread ids to act on, deduped and in a stable
// order. Several comments share one thread, so the caller's list and the stored
// comments both need collapsing before we call the provider.
func (s *Service) resolveTargets(ctx context.Context, prURL string, threadIDs []string) ([]string, error) {
	seen := map[string]bool{}
	out := make([]string, 0, len(threadIDs))
	add := func(id string) {
		if id == "" || seen[id] {
			return
		}
		seen[id] = true
		out = append(out, id)
	}
	if len(threadIDs) > 0 {
		for _, id := range threadIDs {
			add(id)
		}
		return out, nil
	}
	comments, err := s.store.ListPRComments(ctx, prURL)
	if err != nil {
		return nil, fmt.Errorf("resolve pr comments: list comments: %w", err)
	}
	for _, c := range comments {
		if c.Resolved || c.IsBot {
			continue
		}
		add(c.ThreadID)
	}
	return out, nil
}
