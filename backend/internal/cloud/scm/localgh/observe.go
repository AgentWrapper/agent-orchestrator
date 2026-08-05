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
	Repository    string                    `json:"repository"`
	Number        int                       `json:"number"`
	URL           string                    `json:"url"`
	Title         string                    `json:"title"`
	State         string                    `json:"state"`
	Draft         bool                      `json:"draft"`
	HeadSHA       string                    `json:"headSha"`
	SourceBranch  string                    `json:"sourceBranch"`
	TargetBranch  string                    `json:"targetBranch"`
	CIState       string                    `json:"ciState"`
	ReviewState   string                    `json:"reviewState"`
	Mergeability  string                    `json:"mergeability"`
	Checks        []CheckObservation        `json:"checks"`
	ReviewThreads []ReviewThreadObservation `json:"reviewThreads,omitempty"`
	ObservedAt    time.Time                 `json:"observedAt"`
}

// CheckObservation records one observed GitHub check run.
type CheckObservation struct {
	Name       string    `json:"name"`
	Status     string    `json:"status"`
	Conclusion string    `json:"conclusion"`
	URL        string    `json:"url"`
	ObservedAt time.Time `json:"observedAt"`
}

// ReviewThreadObservation records one actionable GitHub review thread.
type ReviewThreadObservation struct {
	ID          string    `json:"id"`
	IsResolved  bool      `json:"isResolved"`
	IsOutdated  bool      `json:"isOutdated"`
	Path        string    `json:"path"`
	Line        int       `json:"line"`
	Body        string    `json:"body"`
	AuthorLogin string    `json:"authorLogin"`
	ObservedAt  time.Time `json:"observedAt"`
}

type githubPull struct {
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

// ObserveBranch returns the latest pull request whose head matches branch.
func (c *Client) ObserveBranch(
	ctx context.Context,
	repositoryURL, branch string,
) (*PullRequestObservation, error) {
	owner, repository, ok := ParseRepositoryURL(repositoryURL)
	if !ok {
		return nil, fmt.Errorf("unsupported GitHub repository URL %q", repositoryURL)
	}
	var pulls []githubPull
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
	if err := c.getGitHub(ctx, fmt.Sprintf("/repos/%s/%s/pulls/%d", owner, repository, pull.Number), &pull); err != nil {
		return nil, err
	}
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
	reviewThreads, err := c.observeReviewThreads(ctx, owner, repository, pull.Number)
	if err != nil {
		return nil, err
	}
	mergeability := normalizeMergeability(pull.MergedAt, pull.Mergeable, pull.MergeableState)
	return &PullRequestObservation{
		Repository:    owner + "/" + repository,
		Number:        pull.Number,
		URL:           pull.HTMLURL,
		Title:         pull.Title,
		State:         state,
		Draft:         pull.Draft,
		HeadSHA:       pull.Head.SHA,
		SourceBranch:  pull.Head.Ref,
		TargetBranch:  pull.Base.Ref,
		CIState:       ciState,
		ReviewState:   reviewState,
		Mergeability:  mergeability,
		Checks:        checks,
		ReviewThreads: reviewThreads,
		ObservedAt:    time.Now().UTC(),
	}, nil
}

func normalizeMergeability(mergedAt *time.Time, mergeable *bool, state string) string {
	switch {
	case mergedAt != nil:
		return "merged"
	case mergeable != nil && *mergeable:
		switch state {
		case "", "unknown", "clean", "has_hooks", "unstable":
			return "mergeable"
		case "dirty":
			return "conflicting"
		default:
			return state
		}
	case mergeable != nil && !*mergeable:
		return "conflicting"
	case state == "clean" || state == "has_hooks" || state == "unstable":
		return "mergeable"
	case state == "dirty":
		return "conflicting"
	case state != "":
		return state
	default:
		return "unknown"
	}
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

func (c *Client) observeReviewThreads(
	ctx context.Context,
	owner, repository string,
	number int,
) ([]ReviewThreadObservation, error) {
	var output struct {
		Data struct {
			Repository struct {
				PullRequest struct {
					ReviewThreads struct {
						Nodes []struct {
							ID         string `json:"id"`
							IsResolved bool   `json:"isResolved"`
							IsOutdated bool   `json:"isOutdated"`
							Path       string `json:"path"`
							Line       int    `json:"line"`
							Comments   struct {
								Nodes []struct {
									Body   string `json:"body"`
									Author struct {
										Login string `json:"login"`
									} `json:"author"`
								} `json:"nodes"`
							} `json:"comments"`
						} `json:"nodes"`
					} `json:"reviewThreads"`
				} `json:"pullRequest"`
			} `json:"repository"`
		} `json:"data"`
	}
	query := `query($owner:String!, $name:String!, $number:Int!) {
  repository(owner:$owner, name:$name) {
    pullRequest(number:$number) {
      reviewThreads(first:100) {
        nodes {
          id
          isResolved
          isOutdated
          path
          line
          comments(first:1) {
            nodes {
              body
              author { login }
            }
          }
        }
      }
    }
  }
}`
	if err := c.graphQL(ctx, query, map[string]any{
		"owner":  owner,
		"name":   repository,
		"number": number,
	}, &output); err != nil {
		return nil, err
	}
	threads := output.Data.Repository.PullRequest.ReviewThreads.Nodes
	result := make([]ReviewThreadObservation, 0, len(threads))
	for _, thread := range threads {
		body := ""
		author := ""
		if len(thread.Comments.Nodes) > 0 {
			body = thread.Comments.Nodes[0].Body
			author = thread.Comments.Nodes[0].Author.Login
		}
		result = append(result, ReviewThreadObservation{
			ID:          thread.ID,
			IsResolved:  thread.IsResolved,
			IsOutdated:  thread.IsOutdated,
			Path:        thread.Path,
			Line:        thread.Line,
			Body:        body,
			AuthorLogin: author,
			ObservedAt:  time.Now().UTC(),
		})
	}
	return result, nil
}

func (c *Client) getGitHub(ctx context.Context, path string, output any) error {
	return c.doGitHub(ctx, http.MethodGet, path, nil, output)
}

func (c *Client) doGitHub(ctx context.Context, method, path string, input, output any) error {
	token, err := c.tokens.Token(ctx)
	if err != nil {
		return err
	}
	var body io.Reader = http.NoBody
	if input != nil {
		encoded, err := json.Marshal(input)
		if err != nil {
			return err
		}
		body = strings.NewReader(string(encoded))
	}
	request, err := http.NewRequestWithContext(ctx, method, "https://api.github.com"+path, body)
	if err != nil {
		return err
	}
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Accept", "application/vnd.github+json")
	request.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	if input != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := c.http.Do(request)
	if err != nil {
		return err
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		payload, _ := io.ReadAll(io.LimitReader(response.Body, 64<<10))
		return fmt.Errorf("GitHub returned %s: %s", response.Status, strings.TrimSpace(string(payload)))
	}
	if output == nil || response.StatusCode == http.StatusNoContent {
		_, _ = io.Copy(io.Discard, response.Body)
		return nil
	}
	return json.NewDecoder(io.LimitReader(response.Body, 4<<20)).Decode(output)
}
