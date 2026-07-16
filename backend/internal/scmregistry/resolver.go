// Package scmregistry resolves project SCM configuration into connection-scoped
// provider bundles without making any provider daemon-global.
package scmregistry

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
	"time"

	scmgithub "github.com/aoagents/agent-orchestrator/backend/internal/adapters/scm/github"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	scmobserve "github.com/aoagents/agent-orchestrator/backend/internal/observe/scm"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	"github.com/aoagents/agent-orchestrator/backend/internal/service/scmconnection"
)

// Resolver errors are deliberately free of credential references and provider diagnostics.
var (
	ErrConnectionNotFound    = errors.New("SCM connection not found")
	ErrProviderMismatch      = errors.New("project SCM provider does not match connection")
	ErrProviderUnavailable   = errors.New("SCM provider is unavailable")
	ErrMissingCredential     = errors.New("SCM credential is not configured")
	ErrCredentialUnavailable = errors.New("SCM credential is unavailable")
)

const githubDefaultConnectionID = scmconnection.GitHubDefaultConnectionID

// TokenSource resolves a provider credential on demand so environment and
// credential-store rotation do not require rebuilding clients between requests.
type TokenSource interface {
	Token(ctx context.Context) (string, error)
}

// FactoryConfig is the provider-facing construction input. It intentionally
// excludes credential persistence references and raw token bytes.
type FactoryConfig struct {
	ConnectionID string
	Provider     domain.SCMProvider
	WebBaseURL   string
	APIBaseURL   string
	Token        TokenSource
}

// ProviderBundle groups the connection-scoped collaborators used by current
// SCM observation, tracker, and writer paths.
type ProviderBundle struct {
	SCM     scmobserve.Provider
	Tracker ports.Tracker
	Writer  ports.SCMWriter
}

// ProviderFactory constructs and tests one provider implementation.
type ProviderFactory interface {
	Build(ctx context.Context, config FactoryConfig) (ProviderBundle, error)
	Test(ctx context.Context, config scmconnection.ConnectionTestConfig, token []byte) (scmconnection.TestResult, error)
}

// ConnectionStore loads metadata versions used to invalidate cached bundles.
type ConnectionStore interface {
	GetSCMConnection(ctx context.Context, id string) (domain.SCMConnection, bool, error)
}

// ProjectProviderResolver is the project-scoped provider boundary consumed by
// later observer, tracker, claim, and action wiring.
type ProjectProviderResolver interface {
	Resolve(ctx context.Context, project domain.ProjectRecord) (ProviderBundle, error)
}

// Deps supplies metadata, credentials, and registered provider factories.
type Deps struct {
	Connections    ConnectionStore
	Credentials    ports.CredentialStore
	Factories      map[domain.SCMProvider]ProviderFactory
	LookupEnv      func(string) string
	GitHubFallback TokenSource
	// SkipCredentialPreflight keeps daemon startup lazy. Provider operations
	// resolve the same source on first use.
	SkipCredentialPreflight bool
}

type cacheEntry struct {
	updatedAt time.Time
	bundle    ProviderBundle
}

// Resolver caches one bundle per connection metadata version.
type Resolver struct {
	connections    ConnectionStore
	credentials    ports.CredentialStore
	factories      map[domain.SCMProvider]ProviderFactory
	lookupEnv      func(string) string
	githubFallback TokenSource
	skipPreflight  bool

	mu    sync.Mutex
	cache map[string]cacheEntry
}

var _ ProjectProviderResolver = (*Resolver)(nil)
var _ scmconnection.ConnectionTester = (*Resolver)(nil)
var _ scmconnection.CredentialOverrideChecker = (*Resolver)(nil)

// New constructs a project provider resolver.
func New(d Deps) *Resolver {
	lookupEnv := d.LookupEnv
	if lookupEnv == nil {
		lookupEnv = os.Getenv
	}
	return &Resolver{
		connections: d.Connections, credentials: d.Credentials, factories: d.Factories,
		lookupEnv: lookupEnv, githubFallback: d.GitHubFallback, skipPreflight: d.SkipCredentialPreflight,
		cache: make(map[string]cacheEntry),
	}
}

// Resolve returns the bundle selected by one project's SCM configuration.
func (r *Resolver) Resolve(ctx context.Context, project domain.ProjectRecord) (ProviderBundle, error) {
	config := project.Config.SCM.WithDefaults()
	factory, ok := r.factories[config.Provider]
	if !ok || factory == nil {
		return ProviderBundle{}, fmt.Errorf("%w: %s", ErrProviderUnavailable, config.Provider)
	}

	connection, err := r.connection(ctx, config)
	if err != nil {
		return ProviderBundle{}, err
	}
	if connection.Provider != config.Provider {
		return ProviderBundle{}, ErrProviderMismatch
	}

	r.mu.Lock()
	entry, cached := r.cache[connection.ID]
	if cached && entry.updatedAt.Equal(connection.UpdatedAt) {
		r.mu.Unlock()
		return entry.bundle, nil
	}
	r.mu.Unlock()

	tokens := r.tokenSource(connection)
	providerTokens := tokens
	if !r.skipPreflight {
		token, err := tokens.Token(ctx)
		if err != nil {
			return ProviderBundle{}, err
		}
		providerTokens = &primedTokenSource{token: token, next: tokens}
	}
	bundle, err := factory.Build(ctx, FactoryConfig{
		ConnectionID: connection.ID,
		Provider:     connection.Provider,
		WebBaseURL:   connection.WebBaseURL,
		APIBaseURL:   connection.APIBaseURL,
		Token:        providerTokens,
	})
	if err != nil {
		return ProviderBundle{}, redactFactoryError(err)
	}

	r.mu.Lock()
	if current, ok := r.cache[connection.ID]; ok {
		if current.updatedAt.Equal(connection.UpdatedAt) {
			bundle = current.bundle
		} else if !current.updatedAt.After(connection.UpdatedAt) {
			r.cache[connection.ID] = cacheEntry{updatedAt: connection.UpdatedAt, bundle: bundle}
		}
	} else {
		r.cache[connection.ID] = cacheEntry{updatedAt: connection.UpdatedAt, bundle: bundle}
	}
	r.mu.Unlock()
	return bundle, nil
}

// Test dispatches connection validation to the registered provider factory.
func (r *Resolver) Test(ctx context.Context, config scmconnection.ConnectionTestConfig) (scmconnection.TestResult, error) {
	connection, err := r.connection(ctx, domain.SCMProjectConfig{Provider: config.Provider, ConnectionID: config.ID})
	if err != nil || connection.Provider != config.Provider {
		return scmconnection.TestResult{}, scmconnection.NewTestFailure(scmconnection.TestFailureUnreachable, ErrConnectionNotFound)
	}
	factory, ok := r.factories[connection.Provider]
	if !ok || factory == nil {
		return scmconnection.TestResult{}, scmconnection.NewTestFailure(scmconnection.TestFailureUnreachable, ErrProviderUnavailable)
	}
	config.Provider = connection.Provider
	config.WebBaseURL = connection.WebBaseURL
	config.APIBaseURL = connection.APIBaseURL
	effective, err := r.testCredentialBytes(ctx, connection)
	if err != nil {
		if errors.Is(err, ErrMissingCredential) {
			return scmconnection.TestResult{Status: scmconnection.StatusMissingCredential}, nil
		}
		return scmconnection.TestResult{}, ErrCredentialUnavailable
	}
	defer zero(effective)
	return factory.Test(ctx, config, effective)
}

// CredentialOverrideConfigured reports environment or legacy gh credentials
// that take precedence over a connection's vault entry.
func (r *Resolver) CredentialOverrideConfigured(ctx context.Context, config scmconnection.ConnectionTestConfig) (bool, error) {
	for _, name := range providerEnvVars(config.Provider) {
		if strings.TrimSpace(r.lookupEnv(name)) != "" {
			return true, nil
		}
	}
	if config.Provider == domain.SCMProviderGitHub && config.ID == githubDefaultConnectionID && r.githubFallback != nil {
		token, err := r.githubFallback.Token(ctx)
		if err == nil {
			return strings.TrimSpace(token) != "", nil
		}
		if !isMissingTokenError(err) {
			return false, ErrCredentialUnavailable
		}
	}
	return false, nil
}

func (r *Resolver) testCredentialBytes(ctx context.Context, connection domain.SCMConnection) ([]byte, error) {
	for _, name := range providerEnvVars(connection.Provider) {
		if token := strings.TrimSpace(r.lookupEnv(name)); token != "" {
			return []byte(token), nil
		}
	}
	if r.credentials != nil && connection.CredentialRef != "" {
		secret, ok, err := r.credentials.Get(ctx, connection.CredentialRef)
		if err != nil {
			zero(secret)
			return nil, ErrCredentialUnavailable
		}
		var token []byte
		if ok {
			token = append([]byte(nil), bytes.TrimSpace(secret)...)
		}
		zero(secret)
		if len(token) != 0 {
			return token, nil
		}
		zero(token)
	}
	if connection.Provider == domain.SCMProviderGitHub && connection.ID == githubDefaultConnectionID && r.githubFallback != nil {
		token, err := r.githubFallback.Token(ctx)
		if err == nil && strings.TrimSpace(token) != "" {
			return []byte(strings.TrimSpace(token)), nil
		}
		if err != nil && !isMissingTokenError(err) {
			return nil, ErrCredentialUnavailable
		}
	}
	return nil, ErrMissingCredential
}

func (r *Resolver) connection(ctx context.Context, config domain.SCMProjectConfig) (domain.SCMConnection, error) {
	if config.Provider == domain.SCMProviderGitHub && config.ConnectionID == githubDefaultConnectionID {
		return domain.SCMConnection{
			ID: githubDefaultConnectionID, Provider: domain.SCMProviderGitHub,
			WebBaseURL: "https://github.com", APIBaseURL: "https://api.github.com",
		}, nil
	}
	if r.connections == nil {
		return domain.SCMConnection{}, ErrConnectionNotFound
	}
	connection, ok, err := r.connections.GetSCMConnection(ctx, config.ConnectionID)
	if err != nil {
		return domain.SCMConnection{}, fmt.Errorf("load SCM connection: %w", ErrConnectionNotFound)
	}
	if !ok {
		return domain.SCMConnection{}, ErrConnectionNotFound
	}
	return connection, nil
}

func (r *Resolver) tokenSource(connection domain.SCMConnection) TokenSource {
	return &connectionTokenSource{
		envVars: providerEnvVars(connection.Provider), lookupEnv: r.lookupEnv, credentials: r.credentials,
		credentialRef: connection.CredentialRef,
		fallback: func() TokenSource {
			if connection.ID == githubDefaultConnectionID {
				return r.githubFallback
			}
			return nil
		}(),
	}
}

func providerEnvVars(provider domain.SCMProvider) []string {
	switch provider {
	case domain.SCMProviderGitHub:
		return []string{"AO_GITHUB_TOKEN", "GITHUB_TOKEN"}
	case domain.SCMProviderGitLab:
		return []string{"AO_GITLAB_TOKEN"}
	default:
		return nil
	}
}

type connectionTokenSource struct {
	envVars       []string
	lookupEnv     func(string) string
	credentials   ports.CredentialStore
	credentialRef string
	fallback      TokenSource
}

func (s *connectionTokenSource) Token(ctx context.Context) (string, error) {
	for _, name := range s.envVars {
		if token := strings.TrimSpace(s.lookupEnv(name)); token != "" {
			return token, nil
		}
	}
	if s.credentials != nil && s.credentialRef != "" {
		secret, ok, err := s.credentials.Get(ctx, s.credentialRef)
		if err != nil {
			zero(secret)
			return "", ErrCredentialUnavailable
		}
		token := strings.TrimSpace(string(secret))
		zero(secret)
		if ok && token != "" {
			return token, nil
		}
	}
	if s.fallback != nil {
		token, err := s.fallback.Token(ctx)
		if err == nil && strings.TrimSpace(token) != "" {
			return token, nil
		}
		if err != nil && !isMissingTokenError(err) {
			return "", ErrCredentialUnavailable
		}
	}
	return "", ErrMissingCredential
}

func (s *connectionTokenSource) InvalidateToken() {
	if invalidator, ok := s.fallback.(interface{ InvalidateToken() }); ok {
		invalidator.InvalidateToken()
	}
}

type primedTokenSource struct {
	mu    sync.Mutex
	token string
	next  TokenSource
}

func (s *primedTokenSource) Token(ctx context.Context) (string, error) {
	s.mu.Lock()
	if s.token != "" {
		token := s.token
		s.token = ""
		s.mu.Unlock()
		return token, nil
	}
	s.mu.Unlock()
	return s.next.Token(ctx)
}

func (s *primedTokenSource) InvalidateToken() {
	s.mu.Lock()
	s.token = ""
	s.mu.Unlock()
	if invalidator, ok := s.next.(interface{ InvalidateToken() }); ok {
		invalidator.InvalidateToken()
	}
}

func isMissingTokenError(err error) bool {
	return errors.Is(err, ErrMissingCredential) || errors.Is(err, scmgithub.ErrNoToken)
}

func redactFactoryError(error) error { return ErrProviderUnavailable }

func zero(secret []byte) {
	for i := range secret {
		secret[i] = 0
	}
}
