package github

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

type reviewRequest struct {
	CommitID string                 `json:"commit_id"`
	Event    string                 `json:"event"`
	Body     string                 `json:"body"`
	Comments []reviewRequestComment `json:"comments,omitempty"`
}

type reviewRequestComment struct {
	Path string `json:"path"`
	Line int    `json:"line"`
	Side string `json:"side"`
	Body string `json:"body"`
}

// PublishReview creates one GitHub review at the requested head commit.
// COMMENT is intentional: AO may review a pull request using its author's
// token, for which GitHub rejects APPROVE and REQUEST_CHANGES.
func (p *Provider) PublishReview(ctx context.Context, ref ports.SCMPRRef, publication ports.ReviewPublication) (ports.ReviewPublicationResult, error) {
	if p == nil || p.client == nil {
		return ports.ReviewPublicationResult{}, errors.New("github scm: review publisher is not configured")
	}
	if !p.reviewRepoMatchesConnection(ref.Repo) {
		return ports.ReviewPublicationResult{}, fmt.Errorf("%w: pull request provider does not match connection", ErrNotFound)
	}
	owner, repo, ok := githubReviewRepo(ref.Repo)
	if !ok || ref.Number <= 0 {
		return ports.ReviewPublicationResult{}, fmt.Errorf("%w: invalid pull request reference", ErrNotFound)
	}
	if strings.TrimSpace(publication.TargetSHA) == "" {
		return ports.ReviewPublicationResult{}, errors.New("github scm: review target SHA is required")
	}
	comments := make([]reviewRequestComment, len(publication.Findings))
	for i, finding := range publication.Findings {
		if strings.TrimSpace(finding.Path) == "" || finding.Line <= 0 || strings.TrimSpace(finding.Body) == "" {
			return ports.ReviewPublicationResult{}, errors.New("github scm: invalid inline review finding")
		}
		comments[i] = reviewRequestComment{Path: finding.Path, Line: finding.Line, Side: "RIGHT", Body: finding.Body}
	}
	response, err := p.client.doREST(ctx, http.MethodPost, repoPath(owner, repo, "pulls", strconv.Itoa(ref.Number), "reviews"), nil, reviewRequest{
		CommitID: publication.TargetSHA,
		Event:    "COMMENT",
		Body:     publication.Body,
		Comments: comments,
	})
	if err != nil {
		return ports.ReviewPublicationResult{}, err
	}
	var created struct {
		ID int64 `json:"id"`
	}
	if err := json.Unmarshal(response.Body, &created); err != nil || created.ID <= 0 {
		return ports.ReviewPublicationResult{}, errors.New("github scm: decode created review")
	}
	return ports.ReviewPublicationResult{Reference: strconv.FormatInt(created.ID, 10)}, nil
}

func (p *Provider) reviewRepoMatchesConnection(repo ports.SCMRepo) bool {
	if !strings.EqualFold(strings.TrimSpace(repo.Provider), "github") || strings.TrimSpace(repo.Host) == "" {
		return false
	}
	base, err := url.Parse(p.client.restBase)
	if err != nil || base.Host == "" {
		return false
	}
	repoHost := strings.ToLower(strings.TrimSpace(repo.Host))
	baseHost := strings.ToLower(base.Host)
	if baseHost == "api.github.com" {
		return repoHost == "github.com" || repoHost == "www.github.com" || repoHost == baseHost
	}
	return repoHost == baseHost
}

func githubReviewRepo(repo ports.SCMRepo) (string, string, bool) {
	owner := strings.TrimSpace(repo.Owner)
	name := strings.TrimSpace(repo.Name)
	if owner != "" && name != "" {
		return owner, name, true
	}
	parts := strings.Split(strings.Trim(strings.TrimSpace(repo.Repo), "/"), "/")
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return "", "", false
	}
	return parts[0], parts[1], true
}
