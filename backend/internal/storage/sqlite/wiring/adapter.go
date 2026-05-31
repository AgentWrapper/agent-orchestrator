// Package wiring bridges *sqlite.Store to the engine's outbound ports. It
// embeds the store (so the SessionStore reads/writes and PRWriter.RecentCheckStatuses
// promote directly) and supplies the PR conversions plus the PRFacts read-model
// that drives the derived display status.
//
// The adapter lives in its own package so the daemon's composition root and any
// in-process integration tests (e.g. backend/internal/integration) can share the
// same bridge instead of redefining it.
package wiring

import (
	"context"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite"
)

// Adapter wraps *sqlite.Store and implements ports.SessionStore + ports.PRWriter.
// The embedded *sqlite.Store promotes CreateSession / UpdateSession / GetSession
// / ListSessions / ListAllSessions and RecentCheckStatuses verbatim; the two
// methods defined here are the ones that need shape translation between the port
// types and the sqlite row types.
type Adapter struct{ *sqlite.Store }

var (
	_ ports.SessionStore = Adapter{}
	_ ports.PRWriter     = Adapter{}
)

// PRFactsForSession picks the PR that drives display status — the most-recently
// updated non-closed PR, else the most recent — and folds in whether it has
// unresolved review comments.
func (a Adapter) PRFactsForSession(ctx context.Context, id domain.SessionID) (domain.PRFacts, error) {
	rows, err := a.Store.ListPRsBySession(ctx, string(id)) // newest first
	if err != nil {
		return domain.PRFacts{}, err
	}
	if len(rows) == 0 {
		return domain.PRFacts{}, nil
	}
	pick := rows[0]
	for _, r := range rows {
		if r.State == "draft" || r.State == "open" {
			pick = r
			break
		}
	}
	facts := domain.PRFacts{
		URL: pick.URL, Number: int(pick.Number), Exists: true,
		Draft: pick.State == "draft", Merged: pick.State == "merged", Closed: pick.State == "closed",
		CI:           domain.CIState(pick.CIState),
		Review:       domain.ReviewDecision(pick.ReviewDecision),
		Mergeability: domain.Mergeability(pick.Mergeability),
	}
	comments, err := a.Store.ListPRComments(ctx, pick.URL)
	if err != nil {
		return domain.PRFacts{}, err
	}
	for _, c := range comments {
		if !c.Resolved {
			facts.ReviewComments = true
			break
		}
	}
	return facts, nil
}

func (a Adapter) WritePR(ctx context.Context, pr ports.PRRow, checks []ports.PRCheckRow, comments []ports.PRComment) error {
	row := sqlite.PRRow{
		URL: pr.URL, SessionID: pr.SessionID, Number: int64(pr.Number),
		State:          prState(pr),
		ReviewDecision: string(pr.Review),
		CIState:        string(pr.CI),
		Mergeability:   string(pr.Mergeability),
		UpdatedAt:      pr.UpdatedAt,
	}
	checkRows := make([]sqlite.PRCheckRow, len(checks))
	for i, c := range checks {
		checkRows[i] = sqlite.PRCheckRow{
			PRURL: c.PRURL, Name: c.Name, CommitHash: c.CommitHash,
			Status: c.Status, URL: c.URL, LogTail: c.LogTail, CreatedAt: c.CreatedAt,
		}
	}
	commentRows := make([]sqlite.PRCommentRow, len(comments))
	for i, c := range comments {
		commentRows[i] = sqlite.PRCommentRow{
			PRURL: pr.URL, CommentID: c.ID, Author: c.Author, File: c.File,
			Line: int64(c.Line), Body: c.Body, Resolved: c.Resolved, CreatedAt: c.CreatedAt,
		}
	}
	return a.Store.WritePRObservation(ctx, row, checkRows, commentRows)
}

// prState collapses the PR's bools into the single pr.state column value.
func prState(r ports.PRRow) string {
	switch {
	case r.Merged:
		return "merged"
	case r.Closed:
		return "closed"
	case r.Draft:
		return "draft"
	default:
		return "open"
	}
}
