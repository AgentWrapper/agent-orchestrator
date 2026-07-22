package gitlab

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
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
type Provider struct {
	client *Client
	logger *slog.Logger
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
	return &Provider{client: c, logger: logger}, nil
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
