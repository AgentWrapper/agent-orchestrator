package localgh

import (
	"context"
	"fmt"
	"net/http"
)

// MergePullRequest merges a repository-scoped pull request through GitHub.
func (c *Client) MergePullRequest(ctx context.Context, repositoryURL string, number int) (PullRequest, error) {
	owner, repository, ok := ParseRepositoryURL(repositoryURL)
	if !ok || number <= 0 {
		return PullRequest{}, fmt.Errorf("invalid GitHub pull request reference")
	}
	var output struct {
		SHA     string `json:"sha"`
		Merged  bool   `json:"merged"`
		Message string `json:"message"`
	}
	if err := c.doGitHub(ctx, http.MethodPut, fmt.Sprintf("/repos/%s/%s/pulls/%d/merge", owner, repository, number), map[string]string{
		"merge_method": "squash",
	}, &output); err != nil {
		return PullRequest{}, fmt.Errorf("merge GitHub pull request: %w", err)
	}
	if !output.Merged {
		return PullRequest{}, fmt.Errorf("GitHub did not merge pull request: %s", output.Message)
	}
	return PullRequest{
		Repository: owner + "/" + repository,
		Number:     number,
		URL:        fmt.Sprintf("https://github.com/%s/%s/pull/%d", owner, repository, number),
		State:      "merged",
	}, nil
}

// ResolveReviewThread marks a GitHub pull-request review thread resolved.
func (c *Client) ResolveReviewThread(ctx context.Context, threadID string) error {
	var output struct {
		Data struct {
			ResolveReviewThread struct {
				Thread struct {
					ID         string `json:"id"`
					IsResolved bool   `json:"isResolved"`
				} `json:"thread"`
			} `json:"resolveReviewThread"`
		} `json:"data"`
	}
	query := `mutation($threadId:ID!) {
  resolveReviewThread(input:{threadId:$threadId}) {
    thread { id isResolved }
  }
}`
	if err := c.graphQL(ctx, query, map[string]any{"threadId": threadID}, &output); err != nil {
		return fmt.Errorf("resolve GitHub review thread: %w", err)
	}
	if !output.Data.ResolveReviewThread.Thread.IsResolved {
		return fmt.Errorf("GitHub did not resolve review thread")
	}
	return nil
}

func (c *Client) graphQL(ctx context.Context, query string, variables map[string]any, output any) error {
	return c.doGitHub(ctx, http.MethodPost, "/graphql", map[string]any{
		"query":     query,
		"variables": variables,
	}, output)
}
