package trackerintake

import (
	"strconv"
	"strings"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

// IssueTrackerID is the inverse of CanonicalIssueID: it maps a session's stored
// issue id back to the tracker id needed to fetch that issue.
//
// Two forms reach it. Current tracker-linked sessions carry the canonical
// `provider:native` id CanonicalIssueID produced ("github:owner/repo#146").
// Older rows and direct API callers can still carry a bare issue number, which
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
	number, ok := canonicalIssueNumber(strings.TrimPrefix(raw, "#"))
	if !ok {
		return domain.TrackerID{}, false
	}
	repo, ok := trackerRepo(project, project.Config.TrackerIntake)
	if !ok {
		return domain.TrackerID{}, false
	}
	return domain.TrackerID{Provider: repo.Provider, Native: repo.Native + "#" + number}, true
}

// CanonicalIssueIDFromRef maps an explicit session issue ref to the same stored
// issue id tracker intake uses. Non-GitHub or non-issue refs are left alone by
// callers when this returns false.
func CanonicalIssueIDFromRef(project domain.ProjectRecord, ref domain.IssueID) (domain.IssueID, bool) {
	id, ok := IssueTrackerID(project, ref)
	if !ok {
		return "", false
	}
	id, ok = normalizeGitHubIssueTrackerID(id)
	if !ok {
		return "", false
	}
	return CanonicalIssueID(id), true
}

// CanonicalIssueIDFromAddressIssuePrompt recognizes AO's canonical worker
// dispatch prompt and returns the same stored issue id tracker intake would.
func CanonicalIssueIDFromAddressIssuePrompt(project domain.ProjectRecord, prompt string) (domain.IssueID, bool) {
	fields := strings.Fields(strings.TrimSpace(prompt))
	if len(fields) != 2 || fields[0] != "/address-issue" {
		return "", false
	}
	return CanonicalIssueIDFromRef(project, domain.IssueID(fields[1]))
}

func normalizeGitHubIssueTrackerID(id domain.TrackerID) (domain.TrackerID, bool) {
	// IssueTrackerID only returns GitHub tracker IDs today; keep this guard so a
	// future provider cannot be rewritten by a GitHub-specific number normalizer.
	if id.Provider != "" && id.Provider != domain.TrackerProviderGitHub {
		return id, false
	}
	repo, number, ok := strings.Cut(strings.TrimSpace(id.Native), "#")
	if !ok {
		return id, false
	}
	canonical, ok := canonicalIssueNumber(number)
	if !ok {
		return id, false
	}
	repo = strings.TrimSpace(repo)
	if repo == "" {
		return id, false
	}
	id.Provider = domain.TrackerProviderGitHub
	id.Native = repo + "#" + canonical
	return id, true
}

func canonicalIssueNumber(s string) (string, bool) {
	if !isIssueNumber(s) {
		return "", false
	}
	n, err := strconv.Atoi(s)
	if err != nil || n <= 0 {
		return "", false
	}
	return strconv.Itoa(n), true
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
