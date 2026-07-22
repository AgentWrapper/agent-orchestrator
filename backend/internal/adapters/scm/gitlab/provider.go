package gitlab

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"sync"
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
}

// Provider implements the provider-neutral scm.Provider interface for GitLab.
// It supports multiple GitLab hosts (gitlab.com + self-managed) by maintaining
// a per-host Client map, so a self-managed host's REST base resolves from its
// hostname rather than being hardcoded to gitlab.com.
type Provider struct {
	client *Client // default client (gitlab.com)
	logger *slog.Logger

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
	return &Provider{
		client: c,
		logger: logger,
		hostClientCfg: ClientOptions{
			HTTPClient: opts.HTTPClient,
			Token:      opts.Token,
			UserAgent:  opts.UserAgent,
			RESTBase:   opts.RESTBase,
		},
		hostClients: map[string]*Client{},
	}, nil
}

// clientForHost returns the client whose REST base matches the given host.
// The default client (gitlab.com) is used for gitlab.com; self-managed hosts
// get a lazily-created client with RESTBase derived as https://<host>/api/v4
// . For gitlab.com hosts that don't match the default
// client's REST base (e.g. tests using a test server), the default client is
// returned so tests keep working.
func (p *Provider) clientForHost(host string) *Client {
	// Empty host (e.g. test repos without Host set) falls back to the default
	// client so tests using a test-server RESTBase keep working.
	if host == "" {
		return p.client
	}
	if p.client != nil && hostMatchesRESTBase(p.client.restBase, host) {
		return p.client
	}
	p.hostMu.Lock()
	defer p.hostMu.Unlock()
	if c, ok := p.hostClients[host]; ok {
		return c
	}
	// For gitlab.com (which doesn't match the default client's REST base,
	// e.g. in tests using a test server), fall back to the default client.
	if host == "gitlab.com" || host == "www.gitlab.com" {
		return p.client
	}
	cfg := p.hostClientCfg
	cfg.RESTBase = "https://" + host + "/api/v4"
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
