package session

import (
	"context"
	"fmt"
	"net/url"
	"strconv"
	"strings"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

const issueContextBodyLimit = 12000

func (s *Service) withIssueContext(ctx context.Context, cfg ports.SpawnConfig, project domain.ProjectRecord) ports.SpawnConfig {
	if cfg.IssueContext != "" || cfg.IssueID == "" {
		return cfg
	}
	if cfg.Kind != "" && cfg.Kind != domain.KindWorker {
		return cfg
	}
	bundle, err := s.projectProvider(ctx, project)
	if err != nil || bundle.Tracker == nil {
		return cfg
	}
	id, ok := trackerIDForIssue(project, bundle.SCM, cfg.IssueID)
	if !ok {
		return cfg
	}
	issue, err := bundle.Tracker.Get(ctx, id)
	if err != nil {
		return cfg
	}
	if issueContext := formatIssueContext(issue); issueContext != "" {
		cfg.IssueContext = issueContext
	}
	return cfg
}

func trackerIDForIssue(project domain.ProjectRecord, provider SCMProvider, issueID domain.IssueID) (domain.TrackerID, bool) {
	scmConfig := project.Config.SCM.WithDefaults()
	trackerProvider := domain.TrackerProvider(scmConfig.Provider)
	issue := strings.TrimSpace(string(issueID))
	prefix := string(scmConfig.Provider) + ":"
	if strings.HasPrefix(strings.ToLower(issue), prefix) {
		issue = issue[len(prefix):]
	}
	issue = strings.TrimPrefix(issue, "#")
	if issue == "" {
		return domain.TrackerID{}, false
	}
	repo, repoOK := projectSCMRepo(provider, project)
	switch trackerProvider {
	case domain.TrackerProviderGitHub:
		if native, ok := canonicalGitHubIssueNative(issue); ok {
			return domain.TrackerID{Provider: trackerProvider, Native: native}, true
		}
	case domain.TrackerProviderGitLab:
		if repoOK {
			if native, ok := canonicalGitLabIssueNative(issue, repo); ok {
				return domain.TrackerID{Provider: trackerProvider, Native: native}, true
			}
		}
	}
	n, err := strconv.Atoi(issue)
	if err != nil || n <= 0 || !repoOK {
		return domain.TrackerID{}, false
	}
	switch trackerProvider {
	case domain.TrackerProviderGitHub:
		return domain.TrackerID{Provider: trackerProvider, Native: fmt.Sprintf("%s#%d", repo.Repo, n)}, true
	case domain.TrackerProviderGitLab:
		return domain.TrackerID{Provider: trackerProvider, Native: fmt.Sprintf("%s/%s#!%d", repo.Host, repo.Repo, n)}, true
	default:
		return domain.TrackerID{}, false
	}
}

func projectSCMRepo(provider SCMProvider, project domain.ProjectRecord) (ports.SCMRepo, bool) {
	if provider == nil {
		if project.Config.SCM.WithDefaults().Provider != domain.SCMProviderGitHub {
			return ports.SCMRepo{}, false
		}
		owner, name, err := githubRepoFromURL(project.RepoOriginURL)
		if err != nil {
			return ports.SCMRepo{}, false
		}
		return ports.SCMRepo{Provider: "github", Host: "github.com", Owner: owner, Name: name, Repo: owner + "/" + name}, true
	}
	repository := strings.TrimSpace(project.Config.SCM.Repo)
	if repository == "" {
		repository = project.RepoOriginURL
	}
	return provider.ParseRepository(repository)
}

func canonicalGitLabIssueNative(raw string, repo ports.SCMRepo) (string, bool) {
	if strings.Contains(raw, "://") {
		u, err := url.Parse(raw)
		if err != nil || !strings.EqualFold(u.Hostname(), repo.Host) {
			return "", false
		}
		marker := "/-/issues/"
		at := strings.LastIndex(u.Path, marker)
		if at <= 0 {
			return "", false
		}
		n, err := strconv.Atoi(strings.Trim(u.Path[at+len(marker):], "/"))
		if err != nil || n <= 0 || !strings.EqualFold(strings.Trim(u.Path[:at], "/"), repo.Repo) {
			return "", false
		}
		return fmt.Sprintf("%s/%s#!%d", repo.Host, repo.Repo, n), true
	}
	delimiter := strings.LastIndex(raw, "#!")
	if delimiter <= 0 {
		return "", false
	}
	n, err := strconv.Atoi(raw[delimiter+2:])
	if err != nil || n <= 0 || !strings.EqualFold(strings.Trim(raw[:delimiter], "/"), repo.Host+"/"+repo.Repo) {
		return "", false
	}
	return fmt.Sprintf("%s/%s#!%d", repo.Host, repo.Repo, n), true
}

func canonicalGitHubIssueNative(raw string) (string, bool) {
	if strings.Contains(raw, "://") {
		return canonicalGitHubIssueURL(raw)
	}
	hash := strings.LastIndexByte(raw, '#')
	if hash <= 0 || hash == len(raw)-1 {
		return "", false
	}
	repo := strings.Trim(raw[:hash], "/")
	owner, name, ok := splitIssueOwnerRepo(repo)
	if !ok {
		return "", false
	}
	n, err := strconv.Atoi(raw[hash+1:])
	if err != nil || n <= 0 {
		return "", false
	}
	return fmt.Sprintf("%s/%s#%d", owner, name, n), true
}

func splitIssueOwnerRepo(repo string) (string, string, bool) {
	parts := strings.Split(strings.Trim(repo, "/"), "/")
	if len(parts) != 2 {
		return "", "", false
	}
	owner := strings.TrimSpace(parts[0])
	name := strings.TrimSuffix(strings.TrimSpace(parts[1]), ".git")
	return owner, name, owner != "" && name != ""
}

func canonicalGitHubIssueURL(raw string) (string, bool) {
	u, err := url.Parse(raw)
	if err != nil || !strings.EqualFold(u.Hostname(), "github.com") {
		return "", false
	}
	parts := strings.Split(strings.Trim(u.Path, "/"), "/")
	if len(parts) != 4 || parts[2] != "issues" {
		return "", false
	}
	n, err := strconv.Atoi(parts[3])
	if err != nil || n <= 0 {
		return "", false
	}
	return fmt.Sprintf("%s/%s#%d", parts[0], strings.TrimSuffix(parts[1], ".git"), n), true
}

func formatIssueContext(issue domain.Issue) string {
	var b strings.Builder
	writeIssueLine(&b, "Issue", issue.ID.Native)
	writeIssueLine(&b, "Title", issue.Title)
	writeIssueLine(&b, "State", string(issue.State))
	writeIssueLine(&b, "URL", issue.URL)
	if len(issue.Labels) > 0 {
		writeIssueLine(&b, "Labels", strings.Join(issue.Labels, ", "))
	}
	if len(issue.Assignees) > 0 {
		writeIssueLine(&b, "Assignees", strings.Join(issue.Assignees, ", "))
	}
	body := strings.TrimSpace(domain.SanitizeControlChars(issue.Body))
	if body != "" {
		if b.Len() > 0 {
			b.WriteString("\n\n")
		}
		b.WriteString("Body:\n")
		b.WriteString(truncateIssueBody(body, issueContextBodyLimit))
	}
	return strings.TrimSpace(b.String())
}

func writeIssueLine(b *strings.Builder, label, value string) {
	value = strings.TrimSpace(domain.SanitizeControlChars(value))
	if value == "" {
		return
	}
	if b.Len() > 0 {
		b.WriteByte('\n')
	}
	fmt.Fprintf(b, "%s: %s", label, value)
}

func truncateIssueBody(body string, limit int) string {
	runes := []rune(body)
	if limit <= 0 || len(runes) <= limit {
		return body
	}
	return string(runes[:limit]) + fmt.Sprintf("\n\n[Issue body truncated to %d characters.]", limit)
}
