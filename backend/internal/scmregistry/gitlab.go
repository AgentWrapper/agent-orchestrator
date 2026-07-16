package scmregistry

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"net/url"
	"strings"

	scmgitlab "github.com/aoagents/agent-orchestrator/backend/internal/adapters/scm/gitlab"
	trackergitlab "github.com/aoagents/agent-orchestrator/backend/internal/adapters/tracker/gitlab"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/service/scmconnection"
)

const gitLabDeveloperAccessLevel = 30

// GitLabFactoryOptions supplies production GitLab adapter dependencies.
type GitLabFactoryOptions struct {
	HTTPClient *http.Client
	Logger     *slog.Logger
}

type gitLabFactory struct {
	httpClient *http.Client
	logger     *slog.Logger
}

// NewGitLabFactory constructs connection-scoped GitLab SCM and tracker adapters.
func NewGitLabFactory(opts GitLabFactoryOptions) ProviderFactory {
	return &gitLabFactory{httpClient: opts.HTTPClient, logger: opts.Logger}
}

func (f *gitLabFactory) Build(_ context.Context, config FactoryConfig) (ProviderBundle, error) {
	if config.Provider != domain.SCMProviderGitLab {
		return ProviderBundle{}, errors.New("gitlab factory: provider mismatch")
	}
	webBase, err := url.Parse(strings.TrimSpace(config.WebBaseURL))
	if err != nil || webBase.Hostname() == "" {
		return ProviderBundle{}, errors.New("gitlab factory: invalid web base URL")
	}
	client := scmgitlab.NewClient(scmgitlab.ClientOptions{
		HTTPClient: f.httpClient,
		Token:      config.Token,
		BaseURL:    config.APIBaseURL,
	})
	provider, err := scmgitlab.NewProvider(scmgitlab.ProviderOptions{
		Client: client, WebBaseURL: config.WebBaseURL, Logger: f.logger,
	})
	if err != nil {
		return ProviderBundle{}, err
	}
	tracker, err := trackergitlab.New(trackergitlab.Options{Client: client, Host: webBase.Hostname()})
	if err != nil {
		return ProviderBundle{}, err
	}
	return ProviderBundle{SCM: provider, Tracker: tracker}, nil
}

func (f *gitLabFactory) Test(ctx context.Context, config scmconnection.ConnectionTestConfig, token []byte) (scmconnection.TestResult, error) {
	if config.Provider != domain.SCMProviderGitLab || strings.TrimSpace(string(token)) == "" {
		return scmconnection.TestResult{}, gitLabTestFailure(scmconnection.TestFailureAuth)
	}
	client := scmgitlab.NewClient(scmgitlab.ClientOptions{
		HTTPClient: f.httpClient,
		Token:      scmgitlab.StaticTokenSource(strings.TrimSpace(string(token))),
		BaseURL:    config.APIBaseURL,
		UserAgent:  "ao-agent-orchestrator/scm-connection-test",
	})
	var identity struct {
		Username string `json:"username"`
		Name     string `json:"name"`
	}
	if _, err := client.DoJSON(ctx, http.MethodGet, "/user", nil, nil, &identity); err != nil {
		return scmconnection.TestResult{}, gitLabTestFailureFor(err, false)
	}
	if strings.TrimSpace(identity.Username) == "" {
		return scmconnection.TestResult{}, gitLabTestFailure(scmconnection.TestFailureUnreachable)
	}
	result := scmconnection.TestResult{
		Status: scmconnection.StatusConnected,
		Identity: scmconnection.Identity{
			Username: strings.TrimSpace(identity.Username), DisplayName: strings.TrimSpace(identity.Name),
		},
	}
	project, ok := parseGitLabRepository(config.Repository)
	if !ok {
		return result, gitLabTestFailure(scmconnection.TestFailureRepoNotFound)
	}
	var repository struct {
		Permissions struct {
			ProjectAccess *struct {
				AccessLevel int `json:"access_level"`
			} `json:"project_access"`
			GroupAccess *struct {
				AccessLevel int `json:"access_level"`
			} `json:"group_access"`
		} `json:"permissions"`
	}
	if _, err := client.DoJSON(ctx, http.MethodGet, "/projects/"+scmgitlab.EncodedProjectPath(project), nil, nil, &repository); err != nil {
		return result, gitLabTestFailureFor(err, true)
	}
	result.Capabilities.Read = true
	accessLevel := 0
	if repository.Permissions.ProjectAccess != nil {
		accessLevel = repository.Permissions.ProjectAccess.AccessLevel
	}
	if repository.Permissions.GroupAccess != nil && repository.Permissions.GroupAccess.AccessLevel > accessLevel {
		accessLevel = repository.Permissions.GroupAccess.AccessLevel
	}
	result.Capabilities.Write = accessLevel >= gitLabDeveloperAccessLevel
	if !result.Capabilities.Write {
		return result, gitLabTestFailure(scmconnection.TestFailureWriteScopeMissing)
	}
	return result, nil
}

func parseGitLabRepository(repository string) (string, bool) {
	repository = strings.TrimSuffix(strings.TrimSpace(repository), ".git")
	parts := strings.Split(repository, "/")
	if len(parts) < 2 {
		return "", false
	}
	for _, part := range parts {
		if part == "" || part == "." || part == ".." || strings.ContainsAny(part, "\\:#!? \t\n\r") {
			return "", false
		}
	}
	return repository, true
}

func gitLabTestFailureFor(err error, repository bool) error {
	var kind scmconnection.TestFailureKind
	switch {
	case errors.Is(err, scmgitlab.ErrAuthFailed):
		kind = scmconnection.TestFailureAuth
	case errors.Is(err, scmgitlab.ErrForbidden):
		kind = scmconnection.TestFailureForbidden
	case repository && errors.Is(err, scmgitlab.ErrNotFound):
		kind = scmconnection.TestFailureRepoNotFound
	case errors.Is(err, scmgitlab.ErrRateLimited):
		kind = scmconnection.TestFailureRateLimited
	case errors.Is(err, scmgitlab.ErrTLS):
		kind = scmconnection.TestFailureTLS
	default:
		kind = scmconnection.TestFailureUnreachable
	}
	return gitLabTestFailure(kind)
}

func gitLabTestFailure(kind scmconnection.TestFailureKind) error {
	return scmconnection.NewTestFailure(kind, errors.New("GitLab connection test failed"))
}
