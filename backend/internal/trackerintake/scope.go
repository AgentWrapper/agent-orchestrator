// Package trackerintake contains shared issue-intake matching and repository
// scope rules used by both the background observer and preview service.
package trackerintake

import (
	"net/url"
	"strings"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

// Repository resolves the configured GitHub repository, falling back to the
// project's persisted origin URL.
func Repository(project domain.ProjectRecord, cfg domain.TrackerIntakeConfig) (domain.TrackerRepo, bool) {
	provider := cfg.Provider
	if provider == "" {
		provider = domain.TrackerProviderGitHub
	}
	if provider != domain.TrackerProviderGitHub {
		return domain.TrackerRepo{}, false
	}
	native := strings.TrimSpace(cfg.Repo)
	if native == "" {
		native = parseGitHubRepoNative(project.RepoOriginURL)
	}
	if native == "" {
		return domain.TrackerRepo{}, false
	}
	return domain.TrackerRepo{Provider: provider, Native: native}, true
}

// MatchesAnyLabel reports whether the issue has at least one selected label.
// An empty selection means "all labels", so every issue matches.
func MatchesAnyLabel(issueLabels, selected []string) bool {
	if len(selected) == 0 {
		return true
	}
	for _, selectedLabel := range selected {
		for _, issueLabel := range issueLabels {
			if strings.EqualFold(strings.TrimSpace(issueLabel), strings.TrimSpace(selectedLabel)) {
				return true
			}
		}
	}
	return false
}

// MatchesAssignee reports whether the authenticated login is assigned to the
// issue, using GitHub's case-insensitive login semantics.
func MatchesAssignee(assignees []string, login string) bool {
	login = strings.TrimSpace(login)
	if login == "" {
		return false
	}
	for _, assignee := range assignees {
		if strings.EqualFold(strings.TrimSpace(assignee), login) {
			return true
		}
	}
	return false
}

func parseGitHubRepoNative(remote string) string {
	remote = strings.TrimSpace(remote)
	if remote == "" {
		return ""
	}
	if u, err := url.Parse(remote); err == nil && u.Host != "" {
		if isGitHubHost(u.Host) {
			return cleanRepoPath(u.Path)
		}
		return ""
	}
	if host, path, ok := parseSCPRemote(remote); ok {
		if !isGitHubHost(host) {
			return ""
		}
		return cleanRepoPath(path)
	}
	return ""
}

func isGitHubHost(host string) bool {
	host = strings.TrimPrefix(strings.ToLower(strings.TrimSpace(host)), "www.")
	return host == "github.com" || strings.HasSuffix(host, ".github.com") || strings.HasSuffix(host, ".ghe.io")
}

func parseSCPRemote(remote string) (string, string, bool) {
	prefix, path, ok := strings.Cut(remote, ":")
	if !ok || prefix == "" || path == "" {
		return "", "", false
	}
	if strings.Contains(prefix, "/") || strings.HasPrefix(path, "//") {
		return "", "", false
	}
	host := prefix
	if _, afterUser, ok := strings.Cut(prefix, "@"); ok {
		host = afterUser
	}
	host = strings.TrimSpace(host)
	if host == "" {
		return "", "", false
	}
	return host, path, true
}

func cleanRepoPath(path string) string {
	path = strings.Trim(strings.TrimSpace(path), "/")
	path = strings.TrimSuffix(path, ".git")
	parts := strings.Split(path, "/")
	if len(parts) < 2 {
		return ""
	}
	owner := strings.TrimSpace(parts[len(parts)-2])
	repo := strings.TrimSpace(parts[len(parts)-1])
	if owner == "" || repo == "" {
		return ""
	}
	return owner + "/" + repo
}
