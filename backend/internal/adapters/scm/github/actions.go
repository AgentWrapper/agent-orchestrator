package github

import (
	"context"
	"fmt"
	"net/http"
	"strconv"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	prsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/pr"
)

var _ ports.SCMPRActions = (*Provider)(nil)

type mergePRRequest struct {
	MergeMethod string `json:"merge_method"`
}

type closePRRequest struct {
	State string `json:"state"`
}

// MergePR squash/merge/rebase-merges one GitHub pull request using the REST
// merge endpoint. It performs exactly one HTTP request.
func (p *Provider) MergePR(ctx context.Context, owner, repo string, number int, method string) error {
	if p == nil || p.client == nil {
		return fmt.Errorf("github scm: client unavailable")
	}
	return p.client.MergePR(ctx, owner, repo, number, method)
}

// ClosePR closes one GitHub pull request without merging it. It performs
// exactly one HTTP request.
func (p *Provider) ClosePR(ctx context.Context, owner, repo string, number int) error {
	if p == nil || p.client == nil {
		return fmt.Errorf("github scm: client unavailable")
	}
	return p.client.ClosePR(ctx, owner, repo, number)
}

// MergePR calls PUT /repos/{owner}/{repo}/pulls/{number}/merge.
func (c *Client) MergePR(ctx context.Context, owner, repo string, number int, method string) error {
	if method == "" {
		method = "squash"
	}
	resp, err := c.doREST(ctx, http.MethodPut, repoPath(owner, repo, "pulls", strconv.Itoa(number), "merge"), nil, mergePRRequest{MergeMethod: method})
	if err != nil {
		return mapPRActionError(resp.StatusCode, err)
	}
	return nil
}

// ClosePR calls PATCH /repos/{owner}/{repo}/pulls/{number}.
func (c *Client) ClosePR(ctx context.Context, owner, repo string, number int) error {
	resp, err := c.doREST(ctx, http.MethodPatch, repoPath(owner, repo, "pulls", strconv.Itoa(number)), nil, closePRRequest{State: "closed"})
	if err != nil {
		return mapPRActionError(resp.StatusCode, err)
	}
	return nil
}

func mapPRActionError(status int, err error) error {
	switch status {
	case http.StatusNotFound:
		return fmt.Errorf("%w: %w", prsvc.ErrPRNotFound, err)
	case http.StatusMethodNotAllowed, http.StatusConflict:
		return fmt.Errorf("%w: %w", prsvc.ErrPRNotMergeable, err)
	case http.StatusUnprocessableEntity:
		return fmt.Errorf("%w: %w", prsvc.ErrPRPreconditions, err)
	default:
		return err
	}
}
