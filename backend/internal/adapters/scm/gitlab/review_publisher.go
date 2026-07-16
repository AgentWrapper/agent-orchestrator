package gitlab

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

type reviewNoteRequest struct {
	Body string `json:"body"`
}

type reviewDiscussionRequest struct {
	Body     string                   `json:"body"`
	Position reviewDiscussionPosition `json:"position"`
}

type reviewDiscussionPosition struct {
	PositionType string `json:"position_type"`
	BaseSHA      string `json:"base_sha"`
	StartSHA     string `json:"start_sha"`
	HeadSHA      string `json:"head_sha"`
	OldPath      string `json:"old_path"`
	NewPath      string `json:"new_path"`
	NewLine      int    `json:"new_line"`
}

// PublishReview creates a GitLab summary note followed by one resolvable diff
// discussion per inline finding. A fresh MR read prevents publication against
// a head commit that advanced after AO planned the review.
func (p *Provider) PublishReview(ctx context.Context, ref ports.SCMPRRef, publication ports.ReviewPublication) (ports.ReviewPublicationResult, error) {
	if p == nil || p.client == nil {
		return ports.ReviewPublicationResult{}, errors.New("gitlab scm: review publisher is not configured")
	}
	if !strings.EqualFold(strings.TrimSpace(ref.Repo.Provider), "gitlab") || !strings.EqualFold(strings.TrimSpace(ref.Repo.Host), p.host) {
		return ports.ReviewPublicationResult{}, fmt.Errorf("%w: merge request provider does not match connection", ErrNotFound)
	}
	if strings.TrimSpace(projectPath(ref.Repo)) == "" || ref.Number <= 0 {
		return ports.ReviewPublicationResult{}, fmt.Errorf("%w: invalid merge request reference", ErrNotFound)
	}
	if strings.TrimSpace(publication.TargetSHA) == "" {
		return ports.ReviewPublicationResult{}, fmt.Errorf("%w: review target SHA is required", ErrPrecondition)
	}
	for _, finding := range publication.Findings {
		if strings.TrimSpace(finding.Path) == "" || finding.Line <= 0 || strings.TrimSpace(finding.Body) == "" {
			return ports.ReviewPublicationResult{}, errors.New("gitlab scm: invalid inline review finding")
		}
	}

	var result ports.ReviewPublicationResult
	err := p.withSlot(ctx, func() error {
		var mr mergeRequestPayload
		if _, err := p.client.DoJSON(ctx, http.MethodGet, mrAPIPath(ref.Repo, ref.Number), nil, nil, &mr); err != nil {
			return p.apiError("refresh merge request before review", err)
		}
		if mr.DiffRefs.HeadSHA == "" || mr.DiffRefs.HeadSHA != publication.TargetSHA {
			return fmt.Errorf("%w: merge request head changed", ErrPrecondition)
		}

		var note notePayload
		if _, err := p.client.DoJSON(ctx, http.MethodPost, mrAPIPath(ref.Repo, ref.Number, "notes"), nil, reviewNoteRequest{Body: publication.Body}, &note); err != nil {
			return p.apiError("publish merge request review summary", err)
		}
		if note.ID <= 0 {
			return errors.New("gitlab scm: created review summary is missing id")
		}
		result.Reference = strconv.FormatInt(note.ID, 10)

		for _, finding := range publication.Findings {
			request := reviewDiscussionRequest{
				Body: finding.Body,
				Position: reviewDiscussionPosition{
					PositionType: "text",
					BaseSHA:      mr.DiffRefs.BaseSHA,
					StartSHA:     mr.DiffRefs.StartSHA,
					HeadSHA:      mr.DiffRefs.HeadSHA,
					OldPath:      finding.Path,
					NewPath:      finding.Path,
					NewLine:      finding.Line,
				},
			}
			if _, err := p.client.DoJSON(ctx, http.MethodPost, mrAPIPath(ref.Repo, ref.Number, "discussions"), nil, request, nil); err != nil {
				return p.apiError("publish merge request inline discussion", err)
			}
		}
		return nil
	})
	if err != nil {
		return ports.ReviewPublicationResult{}, err
	}
	return result, nil
}
