package localgh

import (
	"context"
	"fmt"
	"net/url"
	"strconv"
	"strings"
)

// Issue is the trusted GitHub snapshot attached to an issue-backed Cloud session.
type Issue struct {
	Repository string `json:"repository"`
	Number     int    `json:"number"`
	URL        string `json:"url"`
	Title      string `json:"title"`
	Body       string `json:"body"`
	State      string `json:"state"`
}

// PullRequest identifies a repository pull request that can be claimed or acted on.
type PullRequest struct {
	Repository string `json:"repository"`
	Number     int    `json:"number"`
	URL        string `json:"url"`
	State      string `json:"state"`
}

// GetIssue returns an issue only when it belongs to the registered repository.
func (c *Client) GetIssue(ctx context.Context, repositoryURL string, number int) (Issue, error) {
	owner, repository, ok := ParseRepositoryURL(repositoryURL)
	if !ok || number <= 0 {
		return Issue{}, fmt.Errorf("invalid GitHub issue reference")
	}
	var issue struct {
		Number      int    `json:"number"`
		HTMLURL     string `json:"html_url"`
		Title       string `json:"title"`
		Body        string `json:"body"`
		State       string `json:"state"`
		PullRequest any    `json:"pull_request"`
	}
	if err := c.getGitHub(ctx, fmt.Sprintf("/repos/%s/%s/issues/%d", owner, repository, number), &issue); err != nil {
		return Issue{}, fmt.Errorf("get GitHub issue: %w", err)
	}
	if issue.PullRequest != nil {
		return Issue{}, fmt.Errorf("GitHub reference #%d is a pull request, not an issue", number)
	}
	return Issue{
		Repository: owner + "/" + repository,
		Number:     issue.Number,
		URL:        issue.HTMLURL,
		Title:      issue.Title,
		Body:       issue.Body,
		State:      strings.ToLower(issue.State),
	}, nil
}

// GetPullRequest resolves a numeric or canonical GitHub pull-request reference
// within the registered repository.
func (c *Client) GetPullRequest(ctx context.Context, repositoryURL, reference string) (PullRequest, error) {
	owner, repository, ok := ParseRepositoryURL(repositoryURL)
	if !ok {
		return PullRequest{}, fmt.Errorf("unsupported GitHub repository URL %q", repositoryURL)
	}
	number, err := parsePullNumber(owner, repository, reference)
	if err != nil {
		return PullRequest{}, err
	}
	var pull struct {
		Number  int    `json:"number"`
		HTMLURL string `json:"html_url"`
		State   string `json:"state"`
	}
	if err := c.getGitHub(ctx, fmt.Sprintf("/repos/%s/%s/pulls/%d", owner, repository, number), &pull); err != nil {
		return PullRequest{}, fmt.Errorf("get GitHub pull request: %w", err)
	}
	return PullRequest{Repository: owner + "/" + repository, Number: pull.Number, URL: pull.HTMLURL, State: strings.ToLower(pull.State)}, nil
}

func parsePullNumber(owner, repository, reference string) (int, error) {
	value := strings.TrimSpace(reference)
	if number, err := strconv.Atoi(strings.TrimPrefix(value, "#")); err == nil && number > 0 {
		return number, nil
	}
	parsed, err := url.Parse(value)
	if err != nil || parsed.Host != "github.com" {
		return 0, fmt.Errorf("invalid GitHub pull request reference %q", reference)
	}
	parts := strings.Split(strings.Trim(parsed.Path, "/"), "/")
	if len(parts) != 4 || parts[0] != owner || parts[1] != repository || parts[2] != "pull" {
		return 0, fmt.Errorf("pull request must belong to %s/%s", owner, repository)
	}
	number, err := strconv.Atoi(parts[3])
	if err != nil || number <= 0 {
		return 0, fmt.Errorf("invalid GitHub pull request reference %q", reference)
	}
	return number, nil
}
