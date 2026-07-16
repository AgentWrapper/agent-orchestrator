package scmregistry

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"time"

	scmgithub "github.com/aoagents/agent-orchestrator/backend/internal/adapters/scm/github"
	trackergithub "github.com/aoagents/agent-orchestrator/backend/internal/adapters/tracker/github"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/service/scmconnection"
)

// GitHubFactoryOptions supplies production GitHub adapter dependencies.
type GitHubFactoryOptions struct {
	HTTPClient *http.Client
	Logger     *slog.Logger
}

type githubFactory struct {
	httpClient *http.Client
	logger     *slog.Logger
}

// NewGitHubFactory registers the existing GitHub SCM and tracker adapters
// behind the provider-neutral construction and connection-test boundary.
func NewGitHubFactory(opts GitHubFactoryOptions) ProviderFactory {
	return &githubFactory{httpClient: opts.HTTPClient, logger: opts.Logger}
}

func (f *githubFactory) Build(_ context.Context, config FactoryConfig) (ProviderBundle, error) {
	graphqlURL := strings.TrimRight(config.APIBaseURL, "/") + "/graphql"
	scmProvider, err := scmgithub.NewProvider(scmgithub.ProviderOptions{
		HTTPClient: f.httpClient, Token: config.Token, SkipTokenPreflight: true,
		RESTBase: config.APIBaseURL, GraphQLURL: graphqlURL, Logger: f.logger,
	})
	if err != nil {
		return ProviderBundle{}, err
	}
	tracker, err := trackergithub.New(trackergithub.Options{
		Token: config.Token, HTTPClient: f.httpClient, BaseURL: config.APIBaseURL,
		SkipTokenPreflight: true,
	})
	if err != nil {
		return ProviderBundle{}, err
	}
	return ProviderBundle{SCM: scmProvider, Tracker: tracker}, nil
}

func (f *githubFactory) Test(ctx context.Context, config scmconnection.ConnectionTestConfig, token []byte) (scmconnection.TestResult, error) {
	if config.Provider != domain.SCMProviderGitHub || strings.TrimSpace(string(token)) == "" {
		return scmconnection.TestResult{}, githubTestFailure(scmconnection.TestFailureAuth)
	}
	baseURL := strings.TrimRight(config.APIBaseURL, "/")
	if baseURL == "" {
		baseURL = "https://api.github.com"
	}
	var identity struct {
		Login string `json:"login"`
		Name  string `json:"name"`
	}
	resp, err := f.githubTestGet(ctx, baseURL+"/user", token, &identity)
	if err != nil {
		return scmconnection.TestResult{}, err
	}
	if resp.statusCode < http.StatusOK || resp.statusCode >= http.StatusMultipleChoices {
		return scmconnection.TestResult{}, githubTestFailure(githubFailureKind(resp.statusCode, resp.header))
	}
	if identity.Login == "" {
		return scmconnection.TestResult{}, githubTestFailure(scmconnection.TestFailureUnreachable)
	}
	result := scmconnection.TestResult{
		Status:   scmconnection.StatusConnected,
		Identity: scmconnection.Identity{Username: identity.Login, DisplayName: identity.Name},
	}
	owner, repo, ok := parseGitHubRepository(config.Repository)
	if !ok {
		return result, githubTestFailure(scmconnection.TestFailureRepoNotFound)
	}
	var repository struct {
		Permissions struct {
			Pull     bool `json:"pull"`
			Push     bool `json:"push"`
			Admin    bool `json:"admin"`
			Maintain bool `json:"maintain"`
		} `json:"permissions"`
	}
	resp, err = f.githubTestGet(ctx, baseURL+"/repos/"+url.PathEscape(owner)+"/"+url.PathEscape(repo), token, &repository)
	if err != nil {
		return result, err
	}
	if resp.statusCode == http.StatusNotFound {
		return result, githubTestFailure(scmconnection.TestFailureRepoNotFound)
	}
	if resp.statusCode < http.StatusOK || resp.statusCode >= http.StatusMultipleChoices {
		return result, githubTestFailure(githubFailureKind(resp.statusCode, resp.header))
	}
	result.Capabilities.Read = true
	result.Capabilities.Write = repository.Permissions.Push || repository.Permissions.Admin || repository.Permissions.Maintain
	if !result.Capabilities.Write {
		return result, githubTestFailure(scmconnection.TestFailureWriteScopeMissing)
	}
	return result, nil
}

type githubTestResponse struct {
	statusCode int
	header     http.Header
}

func (f *githubFactory) githubTestGet(ctx context.Context, endpoint string, token []byte, out any) (githubTestResponse, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, http.NoBody)
	if err != nil {
		return githubTestResponse{}, githubTestFailure(scmconnection.TestFailureUnreachable)
	}
	req.Header.Set("Authorization", "Bearer "+string(token))
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	req.Header.Set("User-Agent", "ao-agent-orchestrator/scm-connection-test")
	client := f.httpClient
	if client == nil {
		client = &http.Client{Timeout: 30 * time.Second}
	}
	resp, err := client.Do(req)
	if err != nil {
		if isTLSFailure(err) {
			return githubTestResponse{}, githubTestFailure(scmconnection.TestFailureTLS)
		}
		return githubTestResponse{}, githubTestFailure(scmconnection.TestFailureUnreachable)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode >= http.StatusOK && resp.StatusCode < http.StatusMultipleChoices {
		if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(out); err != nil {
			return githubTestResponse{}, githubTestFailure(scmconnection.TestFailureUnreachable)
		}
	}
	return githubTestResponse{statusCode: resp.StatusCode, header: resp.Header.Clone()}, nil
}

func parseGitHubRepository(repository string) (string, string, bool) {
	parts := strings.Split(strings.TrimSpace(repository), "/")
	if len(parts) != 2 || strings.TrimSpace(parts[0]) == "" || strings.TrimSpace(parts[1]) == "" {
		return "", "", false
	}
	return strings.TrimSpace(parts[0]), strings.TrimSpace(parts[1]), true
}

func isTLSFailure(err error) bool {
	var verification *tls.CertificateVerificationError
	var unknownAuthority x509.UnknownAuthorityError
	var hostname x509.HostnameError
	var invalid x509.CertificateInvalidError
	return errors.As(err, &verification) || errors.As(err, &unknownAuthority) ||
		errors.As(err, &hostname) || errors.As(err, &invalid)
}

func githubFailureKind(statusCode int, header http.Header) scmconnection.TestFailureKind {
	switch statusCode {
	case http.StatusUnauthorized:
		return scmconnection.TestFailureAuth
	case http.StatusForbidden:
		if header.Get("X-RateLimit-Remaining") == "0" {
			return scmconnection.TestFailureRateLimited
		}
		return scmconnection.TestFailureForbidden
	case http.StatusTooManyRequests:
		return scmconnection.TestFailureRateLimited
	default:
		return scmconnection.TestFailureUnreachable
	}
}

func githubTestFailure(kind scmconnection.TestFailureKind) error {
	return scmconnection.NewTestFailure(kind, errors.New("GitHub connection test failed"))
}
