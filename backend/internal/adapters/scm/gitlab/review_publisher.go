package gitlab

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
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

		summaryMarker, findingMarkers := reviewPublicationMarkers(publication)
		existing, err := p.findPublishedReviewParts(ctx, ref, summaryMarker, findingMarkers)
		if err != nil {
			return err
		}
		if existing.summaryID > 0 {
			result.Reference = strconv.FormatInt(existing.summaryID, 10)
		} else {
			var note notePayload
			body := appendReviewMarker(publication.Body, summaryMarker)
			if _, err := p.client.DoJSON(ctx, http.MethodPost, mrAPIPath(ref.Repo, ref.Number, "notes"), nil, reviewNoteRequest{Body: body}, &note); err != nil {
				return p.apiError("publish merge request review summary", err)
			}
			if note.ID <= 0 {
				return errors.New("gitlab scm: created review summary is missing id")
			}
			result.Reference = strconv.FormatInt(note.ID, 10)
		}

		for i, finding := range publication.Findings {
			if existing.findings[i] {
				continue
			}
			request := reviewDiscussionRequest{
				Body: appendReviewMarker(finding.Body, findingMarkers[i]),
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

type publishedReviewParts struct {
	summaryID int64
	findings  map[int]bool
}

func reviewPublicationMarkers(publication ports.ReviewPublication) (string, []string) {
	key := strings.TrimSpace(publication.IdempotencyKey)
	if key == "" {
		return "", make([]string, len(publication.Findings))
	}
	digest := sha256.Sum256([]byte(key))
	prefix := fmt.Sprintf("<!-- ao-review:%x:", digest[:16])
	findings := make([]string, len(publication.Findings))
	for i := range findings {
		findings[i] = fmt.Sprintf("%sfinding-%d -->", prefix, i)
	}
	return prefix + "summary -->", findings
}

func appendReviewMarker(body, marker string) string {
	if marker == "" {
		return body
	}
	return strings.TrimRight(body, "\r\n") + "\n\n" + marker
}

func (p *Provider) findPublishedReviewParts(ctx context.Context, ref ports.SCMPRRef, summaryMarker string, findingMarkers []string) (publishedReviewParts, error) {
	out := publishedReviewParts{findings: make(map[int]bool)}
	if summaryMarker == "" {
		return out, nil
	}
	query := url.Values{"per_page": {"100"}, "order_by": {"created_at"}, "sort": {"desc"}}
	if err := p.client.GetJSONPages(ctx, mrAPIPath(ref.Repo, ref.Number, "notes"), query, func(body []byte) error {
		var notes []notePayload
		if err := json.Unmarshal(body, &notes); err != nil {
			return errors.New("gitlab scm: decode merge request notes")
		}
		for _, note := range notes {
			if out.summaryID == 0 && note.ID > 0 && strings.Contains(note.Body, summaryMarker) {
				out.summaryID = note.ID
			}
		}
		return nil
	}); err != nil {
		return publishedReviewParts{}, p.apiError("find existing merge request review summary", err)
	}
	discussionQuery := url.Values{"per_page": {"100"}}
	if err := p.client.GetJSONPages(ctx, mrAPIPath(ref.Repo, ref.Number, "discussions"), discussionQuery, func(body []byte) error {
		var discussions []discussionPayload
		if err := json.Unmarshal(body, &discussions); err != nil {
			return errors.New("gitlab scm: decode merge request discussions")
		}
		for _, discussion := range discussions {
			for _, note := range discussion.Notes {
				for i, marker := range findingMarkers {
					if marker != "" && strings.Contains(note.Body, marker) {
						out.findings[i] = true
					}
				}
			}
		}
		return nil
	}); err != nil {
		return publishedReviewParts{}, p.apiError("find existing merge request review discussions", err)
	}
	return out, nil
}
