package gitlab

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/url"
	"path"
	"strconv"
	"strings"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

const (
	defaultProviderConcurrency = 4
	defaultDiscussionPages     = 5
)

// ProviderOptions configures one GitLab SCM connection. Client and WebBaseURL
// are explicit so the registry can construct independent self-hosted bundles.
type ProviderOptions struct {
	Client             *Client
	WebBaseURL         string
	MaxConcurrency     int
	MaxDiscussionPages int
	Logger             *slog.Logger
}

// Provider implements the provider-neutral SCM observer contract for one
// GitLab connection.
type Provider struct {
	client             *Client
	webBase            *url.URL
	host               string
	sem                chan struct{}
	maxDiscussionPages int
	logger             *slog.Logger
}

// NewProvider constructs a GitLab provider from a shared bounded client and
// the matching browser base URL.
func NewProvider(opts ProviderOptions) (*Provider, error) {
	if opts.Client == nil {
		return nil, errors.New("gitlab scm: client is required")
	}
	baseText := strings.TrimSpace(opts.WebBaseURL)
	if baseText == "" && opts.Client.baseURL != nil {
		derived := *opts.Client.baseURL
		derived.Path = strings.TrimSuffix(strings.TrimSuffix(derived.Path, "/"), "/api/v4")
		derived.RawPath = ""
		baseText = derived.String()
	}
	base, err := url.Parse(baseText)
	if err != nil || validateBaseURL(base) != nil {
		return nil, errors.New("gitlab scm: invalid web base URL")
	}
	base.Path = strings.TrimSuffix(base.Path, "/")
	base.RawPath = ""
	concurrency := opts.MaxConcurrency
	if concurrency <= 0 || concurrency > defaultProviderConcurrency {
		concurrency = defaultProviderConcurrency
	}
	pages := opts.MaxDiscussionPages
	if pages <= 0 {
		pages = defaultDiscussionPages
	}
	logger := opts.Logger
	if logger == nil {
		logger = slog.Default()
	}
	return &Provider{
		client:             opts.Client,
		webBase:            base,
		host:               strings.ToLower(base.Host),
		sem:                make(chan struct{}, concurrency),
		maxDiscussionPages: pages,
		logger:             logger,
	}, nil
}

// SCMCredentialsAvailable checks the connection lazily without making a
// network request.
func (p *Provider) SCMCredentialsAvailable(ctx context.Context) (bool, error) {
	if p == nil || p.client == nil || p.client.tokens == nil {
		return false, nil
	}
	if _, err := p.client.tokens.Token(ctx); err != nil {
		if errors.Is(err, ErrNoToken) {
			return false, nil
		}
		return false, err
	}
	return true, nil
}

// ParseRepository normalizes GitLab HTTPS, SSH, SCP, and configured path-only
// repository references. URLs for another host are rejected.
func (p *Provider) ParseRepository(remote string) (ports.SCMRepo, bool) {
	raw := strings.TrimSpace(remote)
	if raw == "" || p == nil {
		return ports.SCMRepo{}, false
	}
	host := p.host
	repoPath := raw
	urlReference := false
	switch {
	case strings.Contains(raw, "://"):
		u, err := url.Parse(raw)
		if err != nil || u.User == nil && strings.EqualFold(u.Scheme, "ssh") && u.Host == "" {
			return ports.SCMRepo{}, false
		}
		host = strings.ToLower(u.Host)
		repoPath = u.Path
		urlReference = true
	case strings.HasPrefix(raw, "git@"):
		remainder := strings.TrimPrefix(raw, "git@")
		colon := strings.IndexByte(remainder, ':')
		if colon <= 0 {
			return ports.SCMRepo{}, false
		}
		host = strings.ToLower(remainder[:colon])
		repoPath = remainder[colon+1:]
	case strings.Contains(raw, "-/merge_requests/"):
		return ports.SCMRepo{}, false
	}
	if !strings.EqualFold(host, p.host) {
		return ports.SCMRepo{}, false
	}
	if urlReference {
		repoPath = p.stripWebBasePath(repoPath)
	}
	repo, ok := makeRepo(p.host, repoPath)
	return repo, ok
}

// ParseMergeRequestRef accepts a GitLab MR URL, project!iid, !iid, or numeric
// IID and returns a canonical browser URL in the supplied project context.
func (p *Provider) ParseMergeRequestRef(raw string, contextRepo ports.SCMRepo) (ports.SCMPRRef, bool) {
	input := strings.TrimSpace(raw)
	if input == "" || p == nil {
		return ports.SCMPRRef{}, false
	}
	repo := contextRepo
	numberText := input
	if strings.Contains(input, "://") {
		u, err := url.Parse(input)
		if err != nil || !strings.EqualFold(u.Host, p.host) {
			return ports.SCMPRRef{}, false
		}
		marker := "/-/merge_requests/"
		at := strings.LastIndex(u.Path, marker)
		if at <= 0 {
			return ports.SCMPRRef{}, false
		}
		parsed, ok := makeRepo(p.host, p.stripWebBasePath(u.Path[:at]))
		if !ok || (contextRepo.Repo != "" && !sameRepo(parsed, contextRepo)) {
			return ports.SCMPRRef{}, false
		}
		repo = parsed
		numberText = strings.Trim(u.Path[at+len(marker):], "/")
	} else if bang := strings.LastIndex(input, "!"); bang >= 0 {
		if bang > 0 {
			parsed, ok := makeRepo(p.host, input[:bang])
			if !ok || (contextRepo.Repo != "" && !sameRepo(parsed, contextRepo)) {
				return ports.SCMPRRef{}, false
			}
			repo = parsed
		}
		numberText = input[bang+1:]
	}
	iid, err := strconv.Atoi(numberText)
	if err != nil || iid <= 0 || repo.Repo == "" {
		return ports.SCMPRRef{}, false
	}
	return ports.SCMPRRef{Repo: repo, Number: iid, URL: p.mergeRequestURL(repo.Repo, iid)}, true
}

func (p *Provider) stripWebBasePath(repoPath string) string {
	clean := strings.Trim(repoPath, "/")
	base := strings.Trim(p.webBase.Path, "/")
	if base != "" && strings.HasPrefix(clean, base+"/") {
		clean = strings.TrimPrefix(clean, base+"/")
	}
	return clean
}

// ParseChangeRef exposes GitLab MR reference parsing through the shared claim boundary.
func (p *Provider) ParseChangeRef(raw string, contextRepo ports.SCMRepo) (ports.SCMPRRef, bool) {
	return p.ParseMergeRequestRef(raw, contextRepo)
}

func (p *Provider) mergeRequestURL(repo string, iid int) string {
	u := *p.webBase
	u.Path = path.Join(p.webBase.Path, repo, "-", "merge_requests", strconv.Itoa(iid))
	return u.String()
}

func (p *Provider) withSlot(ctx context.Context, fn func() error) error {
	select {
	case p.sem <- struct{}{}:
		defer func() { <-p.sem }()
		return fn()
	case <-ctx.Done():
		return ctx.Err()
	}
}

func makeRepo(host, rawPath string) (ports.SCMRepo, bool) {
	clean := strings.TrimSuffix(strings.Trim(strings.TrimSpace(rawPath), "/"), ".git")
	if clean == "" || strings.ContainsAny(clean, "\\:#!?\t\r\n ") {
		return ports.SCMRepo{}, false
	}
	parts := strings.Split(clean, "/")
	if len(parts) < 2 {
		return ports.SCMRepo{}, false
	}
	for _, part := range parts {
		if part == "" || part == "." || part == ".." {
			return ports.SCMRepo{}, false
		}
	}
	owner := strings.Join(parts[:len(parts)-1], "/")
	name := parts[len(parts)-1]
	return ports.SCMRepo{Provider: "gitlab", Host: strings.ToLower(host), Owner: owner, Name: name, Repo: owner + "/" + name}, true
}

func sameRepo(a, b ports.SCMRepo) bool {
	return strings.EqualFold(a.Host, b.Host) && a.Repo == b.Repo
}

func projectPath(repo ports.SCMRepo) string {
	if repo.Repo != "" {
		return repo.Repo
	}
	return strings.Trim(repo.Owner+"/"+repo.Name, "/")
}

func mrAPIPath(repo ports.SCMRepo, iid int, suffix ...string) string {
	parts := make([]string, 0, 3+len(suffix))
	parts = append(parts, "/projects/"+EncodedProjectPath(projectPath(repo)), "merge_requests", strconv.Itoa(iid))
	parts = append(parts, suffix...)
	return strings.Join(parts, "/")
}

func (p *Provider) apiError(operation string, err error) error {
	if err == nil {
		return nil
	}
	return fmt.Errorf("gitlab scm: %s: %w", operation, err)
}
