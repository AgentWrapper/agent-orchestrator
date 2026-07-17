package gitlab

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

type squashMergeRequest struct {
	Squash bool   `json:"squash"`
	SHA    string `json:"sha"`
}

type resolveDiscussionRequest struct {
	Resolved bool `json:"resolved"`
}

type replyDiscussionRequest struct {
	Body string `json:"body"`
}

// SquashMerge merges one merge request only if its head still matches expectedHeadSHA.
func (p *Provider) SquashMerge(ctx context.Context, ref ports.SCMPRRef, expectedHeadSHA string) error {
	if err := p.validateActionRef(ref); err != nil {
		return err
	}
	if strings.TrimSpace(expectedHeadSHA) == "" {
		return ports.ErrSCMActionPrecondition
	}
	return p.withSlot(ctx, func() error {
		var merged mergeRequestPayload
		_, err := p.client.DoJSON(ctx, http.MethodPut, mrAPIPath(ref.Repo, ref.Number, "merge"), nil, squashMergeRequest{
			Squash: true,
			SHA:    expectedHeadSHA,
		}, &merged)
		if err != nil {
			return gitLabActionError(err)
		}
		if !strings.EqualFold(merged.State, "merged") {
			return ports.ErrSCMActionPrecondition
		}
		return nil
	})
}

// ResolveReviewThread resolves one GitLab merge-request discussion.
func (p *Provider) ResolveReviewThread(ctx context.Context, ref ports.SCMPRRef, threadID string) error {
	if err := p.validateActionRef(ref); err != nil {
		return err
	}
	threadID = strings.TrimSpace(threadID)
	if threadID == "" || strings.Contains(threadID, "/") {
		return fmt.Errorf("%w: invalid discussion", ports.ErrSCMNotFound)
	}
	return p.withSlot(ctx, func() error {
		_, err := p.client.DoJSON(ctx, http.MethodPut, mrAPIPath(ref.Repo, ref.Number, "discussions", threadID), nil, resolveDiscussionRequest{Resolved: true}, nil)
		return gitLabActionError(err)
	})
}

// ReplyReviewThread replies inside one GitLab merge-request discussion.
func (p *Provider) ReplyReviewThread(ctx context.Context, ref ports.SCMPRRef, threadID, body string) error {
	if err := p.validateActionRef(ref); err != nil {
		return err
	}
	threadID = strings.TrimSpace(threadID)
	body = strings.TrimSpace(body)
	if threadID == "" || strings.Contains(threadID, "/") {
		return fmt.Errorf("%w: invalid discussion", ports.ErrSCMNotFound)
	}
	if body == "" {
		return ports.ErrSCMActionPrecondition
	}
	return p.withSlot(ctx, func() error {
		var note notePayload
		_, err := p.client.DoJSON(ctx, http.MethodPost, mrAPIPath(ref.Repo, ref.Number, "discussions", threadID, "notes"), nil, replyDiscussionRequest{Body: body}, &note)
		if err != nil {
			return gitLabActionError(err)
		}
		if note.ID <= 0 {
			return ports.ErrSCMActionPrecondition
		}
		return nil
	})
}

func (p *Provider) validateActionRef(ref ports.SCMPRRef) error {
	if p == nil || p.client == nil || ref.Number <= 0 ||
		!strings.EqualFold(strings.TrimSpace(ref.Repo.Provider), "gitlab") ||
		!strings.EqualFold(strings.TrimSpace(ref.Repo.Host), p.host) ||
		strings.TrimSpace(projectPath(ref.Repo)) == "" {
		return fmt.Errorf("%w: merge request does not match connection", ports.ErrSCMNotFound)
	}
	return nil
}

func gitLabActionError(err error) error {
	switch {
	case err == nil:
		return nil
	case errors.Is(err, ErrNotFound):
		return fmt.Errorf("%w: merge request action target", ports.ErrSCMNotFound)
	case errors.Is(err, ErrAuthFailed), errors.Is(err, ErrForbidden):
		return ports.ErrSCMActionForbidden
	case errors.Is(err, ErrPrecondition):
		return ports.ErrSCMActionPrecondition
	default:
		return err
	}
}
