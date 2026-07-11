package pr

import (
	"context"
	"fmt"
	"strconv"
	"strings"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

const defaultMainCIFixLabel = "main-ci-fix"

// OpenPRLister is the persistence read surface needed to resolve the number-only
// PR action API to one tracked repository PR.
type OpenPRLister interface {
	ListOpenPRs(ctx context.Context) ([]domain.PullRequest, error)
}

// CommitChecksReader reads CI facts for a repository ref.
type CommitChecksReader interface {
	FetchCommitChecks(ctx context.Context, repo ports.SCMRepo, ref string) (ports.SCMCommitChecksObservation, error)
}

// LiveMainCIGate checks the repository default branch before merge execution.
type LiveMainCIGate struct {
	PRs       OpenPRLister
	SCM       CommitChecksReader
	Tracker   ports.Tracker
	FixLabels []string
}

var _ MainCIGate = (*LiveMainCIGate)(nil)

// Check reports default-branch CI state for the target PR and whether it carries
// an explicit red-main-fix exemption label.
func (g *LiveMainCIGate) Check(ctx context.Context, prID string) (MainCIStatus, error) {
	if g == nil || g.PRs == nil || g.SCM == nil {
		return MainCIStatus{}, ErrPRPreconditions
	}
	number, err := strconv.Atoi(strings.TrimSpace(prID))
	if err != nil || number <= 0 {
		return MainCIStatus{}, ErrPRNotFound
	}
	pr, err := g.resolvePR(ctx, number)
	if err != nil {
		return MainCIStatus{}, err
	}
	repo, err := repoFromPR(pr)
	if err != nil {
		return MainCIStatus{}, err
	}
	ref := strings.TrimSpace(pr.TargetBranch)
	if ref == "" {
		ref = domain.DefaultBranchName
	}
	checks, err := g.SCM.FetchCommitChecks(ctx, repo, ref)
	if err != nil {
		return MainCIStatus{}, err
	}
	status := MainCIStatus{
		State:      mainCIState(checks.Summary),
		SHA:        checks.HeadSHA,
		FailedJobs: failedJobNames(checks.FailedChecks),
	}
	if status.State == MainCIFailing {
		status.FixPR, err = g.hasFixLabel(ctx, repo, number)
		if err != nil {
			return MainCIStatus{}, err
		}
	}
	return status, nil
}

func (g *LiveMainCIGate) resolvePR(ctx context.Context, number int) (domain.PullRequest, error) {
	prs, err := g.PRs.ListOpenPRs(ctx)
	if err != nil {
		return domain.PullRequest{}, err
	}
	var match domain.PullRequest
	count := 0
	for _, pr := range prs {
		if pr.Number != number {
			continue
		}
		match = pr
		count++
	}
	switch count {
	case 0:
		return domain.PullRequest{}, ErrPRNotFound
	case 1:
		return match, nil
	default:
		return domain.PullRequest{}, ErrPRPreconditions
	}
}

func (g *LiveMainCIGate) hasFixLabel(ctx context.Context, repo ports.SCMRepo, number int) (bool, error) {
	if g.Tracker == nil {
		return false, nil
	}
	issue, err := g.Tracker.Get(ctx, domain.TrackerID{
		Provider: domain.TrackerProviderGitHub,
		Native:   repoFullName(repo) + "#" + strconv.Itoa(number),
	})
	if err != nil {
		return false, fmt.Errorf("%w: fix-label lookup: %w", ErrPRPreconditions, err)
	}
	labels := g.FixLabels
	if len(labels) == 0 {
		labels = []string{defaultMainCIFixLabel}
	}
	for _, got := range issue.Labels {
		for _, want := range labels {
			if strings.EqualFold(strings.TrimSpace(got), strings.TrimSpace(want)) {
				return true, nil
			}
		}
	}
	return false, nil
}

func repoFromPR(pr domain.PullRequest) (ports.SCMRepo, error) {
	if repo := strings.TrimSpace(pr.Repo); repo != "" {
		owner, name, ok := splitOwnerRepo(repo)
		if ok {
			return ports.SCMRepo{Provider: "github", Host: "github.com", Owner: owner, Name: name, Repo: owner + "/" + name}, nil
		}
	}
	owner, name, _, err := parseGitHubPRURL(pr.URL)
	if err != nil {
		return ports.SCMRepo{}, ErrPRPreconditions
	}
	return ports.SCMRepo{Provider: "github", Host: "github.com", Owner: owner, Name: name, Repo: owner + "/" + name}, nil
}

func splitOwnerRepo(s string) (string, string, bool) {
	parts := strings.Split(strings.Trim(strings.TrimSuffix(s, ".git"), "/"), "/")
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return "", "", false
	}
	return parts[0], parts[1], true
}

func parseGitHubPRURL(raw string) (string, string, int, error) {
	parts := strings.Split(strings.Trim(raw, "/"), "/")
	for i := 0; i+4 < len(parts); i++ {
		if parts[i] == "github.com" && parts[i+3] == "pull" {
			n, err := strconv.Atoi(parts[i+4])
			if err == nil {
				return parts[i+1], parts[i+2], n, nil
			}
		}
	}
	return "", "", 0, ErrPRPreconditions
}

func repoFullName(repo ports.SCMRepo) string {
	if strings.TrimSpace(repo.Repo) != "" {
		return repo.Repo
	}
	return repo.Owner + "/" + repo.Name
}

func mainCIState(summary string) string {
	switch domain.CIState(summary) {
	case domain.CIPassing:
		return MainCISuccess
	case domain.CIPending:
		return MainCIPending
	case domain.CIFailing:
		return MainCIFailing
	default:
		return MainCIUnknown
	}
}

func failedJobNames(checks []ports.SCMCheckObservation) []string {
	out := make([]string, 0, len(checks))
	for _, ch := range checks {
		if strings.TrimSpace(ch.Name) != "" {
			out = append(out, ch.Name)
		}
	}
	return out
}
