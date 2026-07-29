package localgh

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// PullRequestObservation is normalized GitHub pull-request and CI state.
type PullRequestObservation struct {
	Repository   string             `json:"repository"`
	Number       int                `json:"number"`
	URL          string             `json:"url"`
	Title        string             `json:"title"`
	State        string             `json:"state"`
	Draft        bool               `json:"draft"`
	HeadSHA      string             `json:"headSha"`
	SourceBranch string             `json:"sourceBranch"`
	TargetBranch string             `json:"targetBranch"`
	CIState      string             `json:"ciState"`
	ReviewState  string             `json:"reviewState"`
	Mergeability string             `json:"mergeability"`
	Checks       []CheckObservation `json:"checks"`
	ObservedAt   time.Time          `json:"observedAt"`
}

// CheckObservation records one observed GitHub check run.
type CheckObservation struct {
	Name       string    `json:"name"`
	Status     string    `json:"status"`
	Conclusion string    `json:"conclusion"`
	URL        string    `json:"url"`
	ObservedAt time.Time `json:"observedAt"`
}

// ObserveBranch returns the latest pull request whose head matches branch.
func (c *Client) ObserveBranch(
	ctx context.Context,
	repositoryURL, branch string,
) (*PullRequestObservation, error) {
	owner, repository, ok := ParseRepositoryURL(repositoryURL)
	if !ok {
		return nil, fmt.Errorf("unsupported GitHub repository URL %q", repositoryURL)
	}
	var pulls []struct {
		Number         int        `json:"number"`
		HTMLURL        string     `json:"html_url"`
		Title          string     `json:"title"`
		State          string     `json:"state"`
		Draft          bool       `json:"draft"`
		MergedAt       *time.Time `json:"merged_at"`
		Mergeable      *bool      `json:"mergeable"`
		MergeableState string     `json:"mergeable_state"`
		Head           struct {
			SHA string `json:"sha"`
			Ref string `json:"ref"`
		} `json:"head"`
		Base struct {
			Ref string `json:"ref"`
		} `json:"base"`
	}
	query := url.Values{}
	query.Set("state", "all")
	query.Set("head", owner+":"+branch)
	query.Set("per_page", "10")
	if err := c.getGitHub(ctx, "/repos/"+owner+"/"+repository+"/pulls?"+query.Encode(), &pulls); err != nil {
		return nil, err
	}
	if len(pulls) == 0 {
		return nil, nil
	}
	pull := pulls[0]
	state := pull.State
	if pull.MergedAt != nil {
		state = "merged"
	}
	checks, ciState, err := c.observeChecks(ctx, owner, repository, pull.Head.SHA)
	if err != nil {
		return nil, err
	}
	reviewState, err := c.observeReviews(ctx, owner, repository, pull.Number)
	if err != nil {
		return nil, err
	}
	mergeability := "unknown"
	switch {
	case pull.MergedAt != nil:
		mergeability = "merged"
	case pull.Mergeable != nil && *pull.Mergeable:
		mergeability = "mergeable"
	case pull.Mergeable != nil && !*pull.Mergeable:
		mergeability = "conflicting"
	case pull.MergeableState != "":
		mergeability = pull.MergeableState
	}
	return &PullRequestObservation{
		Repository:   owner + "/" + repository,
		Number:       pull.Number,
		URL:          pull.HTMLURL,
		Title:        pull.Title,
		State:        state,
		Draft:        pull.Draft,
		HeadSHA:      pull.Head.SHA,
		SourceBranch: pull.Head.Ref,
		TargetBranch: pull.Base.Ref,
		CIState:      ciState,
		ReviewState:  reviewState,
		Mergeability: mergeability,
		Checks:       checks,
		ObservedAt:   time.Now().UTC(),
	}, nil
}

func (c *Client) observeChecks(
	ctx context.Context,
	owner, repository, sha string,
) ([]CheckObservation, string, error) {
	var response struct {
		CheckRuns []struct {
			Name        string     `json:"name"`
			Status      string     `json:"status"`
			Conclusion  string     `json:"conclusion"`
			HTMLURL     string     `json:"html_url"`
			CompletedAt *time.Time `json:"completed_at"`
		} `json:"check_runs"`
	}
	if err := c.getGitHub(ctx, "/repos/"+owner+"/"+repository+"/commits/"+sha+"/check-runs?per_page=100", &response); err != nil {
		return nil, "", err
	}
	checks := make([]CheckObservation, 0, len(response.CheckRuns))
	hasPending := false
	hasFailure := false
	for _, run := range response.CheckRuns {
		observedAt := time.Now().UTC()
		if run.CompletedAt != nil {
			observedAt = run.CompletedAt.UTC()
		}
		checks = append(checks, CheckObservation{
			Name:       run.Name,
			Status:     run.Status,
			Conclusion: run.Conclusion,
			URL:        run.HTMLURL,
			ObservedAt: observedAt,
		})
		if run.Status != "completed" {
			hasPending = true
		}
		switch run.Conclusion {
		case "failure", "cancelled", "timed_out", "action_required", "startup_failure":
			hasFailure = true
		}
	}
	switch {
	case hasFailure:
		return checks, "failing", nil
	case hasPending:
		return checks, "pending", nil
	case len(checks) > 0:
		return checks, "passing", nil
	default:
		return checks, "unknown", nil
	}
}

func (c *Client) observeReviews(
	ctx context.Context,
	owner, repository string,
	number int,
) (string, error) {
	var reviews []struct {
		User struct {
			Login string `json:"login"`
		} `json:"user"`
		State       string    `json:"state"`
		SubmittedAt time.Time `json:"submitted_at"`
	}
	if err := c.getGitHub(
		ctx,
		fmt.Sprintf("/repos/%s/%s/pulls/%d/reviews?per_page=100", owner, repository, number),
		&reviews,
	); err != nil {
		return "", err
	}
	latest := make(map[string]string)
	for _, review := range reviews {
		if review.User.Login != "" {
			latest[review.User.Login] = strings.ToLower(review.State)
		}
	}
	hasApproval := false
	for _, state := range latest {
		if state == "changes_requested" {
			return "changes_requested", nil
		}
		if state == "approved" {
			hasApproval = true
		}
	}
	if hasApproval {
		return "approved", nil
	}
	return "none", nil
}

func (c *Client) getGitHub(ctx context.Context, path string, output any) error {
	token, err := c.tokens.Token(ctx)
	if err != nil {
		return err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://api.github.com"+path, http.NoBody)
	if err != nil {
		return err
	}
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Accept", "application/vnd.github+json")
	request.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	response, err := c.http.Do(request)
	if err != nil {
		return err
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		payload, _ := io.ReadAll(io.LimitReader(response.Body, 64<<10))
		return fmt.Errorf("GitHub returned %s: %s", response.Status, strings.TrimSpace(string(payload)))
	}
	return json.NewDecoder(io.LimitReader(response.Body, 4<<20)).Decode(output)
}
