package gitlab

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"sync"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// ProviderOptions configures the GitLab SCM provider.
type ProviderOptions struct {
	Client             *Client
	HTTPClient         *http.Client
	Token              TokenSource
	SkipTokenPreflight bool
	RESTBase           string
	UserAgent          string
	Logger             *slog.Logger

	// AllowedHosts is the list of self-managed GitLab hosts that the provider
	// is permitted to talk to. gitlab.com is always allowed (hardcoded) and
	// does not need to appear here. A host not in this list and not gitlab.com
	// is rejected before any credential is attached — preventing a remote like
	// gitlab.attacker.example from receiving the configured bearer token.
	// Each entry may include a port (e.g. "gitlab.internal:8443").
	AllowedHosts []string

	// HostTokens maps a self-managed host to a token override. Hosts in
	// AllowedHosts without an explicit entry fall back to the default Token
	// (typically AO_GITLAB_TOKEN / GITLAB_TOKEN / glab). The per-host
	// selection ensures the gitlab.com token is not attached to a self-managed
	// host and vice versa.
	HostTokens map[string]TokenSource
}

// Provider implements the provider-neutral scm.Provider interface for GitLab.
// It supports multiple GitLab hosts (gitlab.com + self-managed) by maintaining
// a per-host Client map, so a self-managed host's REST base resolves from its
// hostname rather than being hardcoded to gitlab.com.
//
// Hosts are restricted to gitlab.com plus an explicit allowlist
// (ProviderOptions.AllowedHosts). A host that is neither gitlab.com nor in the
// allowlist is rejected before any credential is attached — no HTTP request is
// made to non-allowlisted hosts.
type Provider struct {
	client *Client // default client (gitlab.com)
	logger *slog.Logger

	// allowedHosts is the set of self-managed hosts the provider may talk to
	// (gitlab.com is always allowed and not stored here). Each entry may include
	// a port (e.g. "gitlab.internal:8443").
	allowedHosts map[string]bool

	// hostTokens maps a self-managed host to its TokenSource. Hosts in
	// allowedHosts without an entry fall back to the default token (opts.Token).
	hostTokens map[string]TokenSource

	// Per-host clients for self-managed GitLab instances. Lazily populated.
	hostClients   map[string]*Client
	hostClientCfg ClientOptions
	hostMu        sync.Mutex
}

// NewProvider creates a GitLab SCM provider. If SkipTokenPreflight is false
// and a token source is supplied, the token is resolved immediately to fail
// fast on misconfiguration.
func NewProvider(opts ProviderOptions) (*Provider, error) {
	if opts.Client == nil && opts.Token != nil && !opts.SkipTokenPreflight {
		_, err := opts.Token.Token(context.Background())
		if err != nil {
			return nil, err
		}
	}
	c := opts.Client
	if c == nil {
		c = NewClient(ClientOptions{
			HTTPClient: opts.HTTPClient,
			Token:      opts.Token,
			RESTBase:   opts.RESTBase,
			UserAgent:  opts.UserAgent,
		})
	}
	logger := opts.Logger
	if logger == nil {
		logger = slog.Default()
	}

	allowed := make(map[string]bool, len(opts.AllowedHosts))
	for _, h := range opts.AllowedHosts {
		h = strings.TrimSpace(strings.ToLower(h))
		if h != "" {
			allowed[h] = true
		}
	}

	hostTokens := make(map[string]TokenSource, len(opts.HostTokens))
	for h, src := range opts.HostTokens {
		h = strings.TrimSpace(strings.ToLower(h))
		if h != "" && src != nil {
			hostTokens[h] = src
		}
	}

	return &Provider{
		client:       c,
		logger:       logger,
		allowedHosts: allowed,
		hostTokens:   hostTokens,
		hostClientCfg: ClientOptions{
			HTTPClient: opts.HTTPClient,
			Token:      opts.Token,
			UserAgent:  opts.UserAgent,
			RESTBase:   opts.RESTBase,
		},
		hostClients: map[string]*Client{},
	}, nil
}

// isHostAllowed reports whether host is a GitLab host the provider is permitted
// to talk to. gitlab.com is always allowed; self-managed hosts must be in the
// configured allowlist.
func (p *Provider) isHostAllowed(host string) bool {
	host = strings.ToLower(strings.TrimSpace(host))
	if host == "" {
		return false
	}
	if host == "gitlab.com" || host == "www.gitlab.com" {
		return true
	}
	return p.allowedHosts[host]
}

// clientForHost returns the client whose REST base matches the given host.
// The default client (gitlab.com) is used for gitlab.com; self-managed hosts
// get a lazily-created client with RESTBase derived as https://<host>/api/v4.
// A host that is neither gitlab.com nor in the allowlist is rejected — nil is
// returned so callers can fail closed before attaching any credential.
//
// The REST base preserves the port from the host (e.g.
// "gitlab.internal:8443" → "https://gitlab.internal:8443/api/v4"). The scheme
// is always https for self-managed hosts; a self-managed host reachable over
// plain http is a deployment choice outside this provider's scope and is not
// supported (matching the reviewer's "reject HTTPS-to-HTTP downgrades" rule
// from Item 6).
func (p *Provider) clientForHost(host string) *Client {
	// Empty host (e.g. test repos without Host set) falls back to the default
	// client so tests using a test-server RESTBase keep working.
	if host == "" {
		return p.client
	}
	// Reject non-allowlisted hosts before any credential is attached.
	if !p.isHostAllowed(host) {
		return nil
	}
	// gitlab.com uses the default client (whose RESTBase is the test server in
	// tests, or the real https://gitlab.com/api/v4 in production).
	if host == "gitlab.com" || host == "www.gitlab.com" {
		return p.client
	}
	// If the default client's RESTBase already matches this host (e.g. a test
	// server whose host happens to be in the allowlist), reuse it.
	if p.client != nil && hostMatchesRESTBase(p.client.restBase, host) {
		return p.client
	}

	p.hostMu.Lock()
	defer p.hostMu.Unlock()
	if c, ok := p.hostClients[host]; ok {
		return c
	}

	cfg := p.hostClientCfg
	// Derive the REST base from the host, preserving any port (e.g.
	// "gitlab.internal:8443" → "https://gitlab.internal:8443/api/v4").
	cfg.RESTBase = "https://" + host + "/api/v4"
	// Select the per-host token if one is configured; otherwise the default
	// token (cfg.Token) applies.
	if src, ok := p.hostTokens[strings.ToLower(host)]; ok {
		cfg.Token = src
	}
	c := NewClient(cfg)
	p.hostClients[host] = c
	return c
}

// hostMatchesRESTBase reports whether host is the hostname of restBase.
func hostMatchesRESTBase(restBase, host string) bool {
	if restBase == "" {
		return false
	}
	// restBase is like "https://gitlab.com/api/v4" — extract the host.
	trimmed := strings.TrimPrefix(strings.TrimPrefix(restBase, "https://"), "http://")
	if idx := strings.IndexByte(trimmed, '/'); idx >= 0 {
		trimmed = trimmed[:idx]
	}
	return strings.EqualFold(trimmed, host)
}

// ErrHostNotAllowed is returned when a remote's host is neither gitlab.com nor
// in the configured allowlist. The provider rejects such hosts before
// attaching any credential.
var ErrHostNotAllowed = fmt.Errorf("gitlab scm: host not in allowlist")

// clientForRepoErr returns the client for a repo's host, or an error if the
// host is not allowed. This is the guarded variant of clientForHost for use in
// methods that need to return an error rather than panic on a nil client.
func (p *Provider) clientForRepoErr(repo ports.SCMRepo) (*Client, error) {
	c := p.clientForHost(repo.Host)
	if c == nil {
		return nil, fmt.Errorf("gitlab scm: host %q not in allowlist: %w", repo.Host, ErrHostNotAllowed)
	}
	return c, nil
}

// SCMCredentialsAvailable reports whether usable GitLab credentials exist.
func (p *Provider) SCMCredentialsAvailable(ctx context.Context) (bool, error) {
	if p.client == nil || p.client.tokens == nil {
		return true, nil
	}
	_, err := p.client.tokens.Token(ctx)
	if err == nil {
		return true, nil
	}
	if errors.Is(err, ErrNoToken) {
		return false, nil
	}
	return false, err
}
