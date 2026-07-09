package trackerintake

import (
	"strings"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

// IssueTrackerID is the inverse of CanonicalIssueID: it maps a session's stored
// issue id back to the tracker id needed to fetch that issue.
//
// Two forms reach it. Sessions created by intake carry the canonical
// `provider:native` id CanonicalIssueID produced ("github:owner/repo#146").
// Sessions created by `ao spawn --issue 146` carry a bare issue number, which
// only means something relative to the project's own tracker repo — so the repo
// is resolved from the project's intake config, falling back to its git origin.
//
// The second return is false when the id cannot be mapped: an unset id, an
// unrecognised shape, or a project with no resolvable GitHub repo. Callers use
// the title only to decorate a display name, so they degrade rather than fail.
func IssueTrackerID(project domain.ProjectRecord, issue domain.IssueID) (domain.TrackerID, bool) {
	raw := strings.TrimSpace(string(issue))
	if raw == "" {
		return domain.TrackerID{}, false
	}
	if provider, native, ok := strings.Cut(raw, ":"); ok {
		// Only a known provider prefix makes this the canonical form; anything
		// else with a colon (a URL, say) falls through to be rejected below
		// rather than being misread as `provider:native`.
		if domain.TrackerProvider(provider) != domain.TrackerProviderGitHub {
			return domain.TrackerID{}, false
		}
		if strings.TrimSpace(native) == "" {
			return domain.TrackerID{}, false
		}
		return domain.TrackerID{Provider: domain.TrackerProviderGitHub, Native: strings.TrimSpace(native)}, true
	}
	number := strings.TrimPrefix(raw, "#")
	if !isIssueNumber(number) {
		return domain.TrackerID{}, false
	}
	repo, ok := trackerRepo(project, project.Config.TrackerIntake)
	if !ok {
		return domain.TrackerID{}, false
	}
	return domain.TrackerID{Provider: repo.Provider, Native: repo.Native + "#" + number}, true
}

func isIssueNumber(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}
