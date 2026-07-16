package gitlab

import (
	"context"
	"errors"
	"os"
	"strings"
)

// TokenSource resolves a GitLab private token on demand.
type TokenSource interface {
	Token(ctx context.Context) (string, error)
}

type tokenInvalidator interface {
	InvalidateToken()
}

// ErrNoToken indicates that no configured source yielded a token.
var ErrNoToken = errors.New("gitlab scm: no token configured")

// StaticTokenSource is a literal token, primarily useful in tests.
type StaticTokenSource string

// Token returns the configured literal token.
func (s StaticTokenSource) Token(context.Context) (string, error) {
	token := strings.TrimSpace(string(s))
	if token == "" {
		return "", ErrNoToken
	}
	return token, nil
}

// EnvTokenSource checks project-scoped names first, then AO_GITLAB_TOKEN.
type EnvTokenSource struct {
	EnvVars []string
}

// Token returns the first configured environment token.
func (s EnvTokenSource) Token(context.Context) (string, error) {
	for _, name := range s.EnvVars {
		if token := strings.TrimSpace(os.Getenv(name)); token != "" {
			return token, nil
		}
	}
	if token := strings.TrimSpace(os.Getenv("AO_GITLAB_TOKEN")); token != "" {
		return token, nil
	}
	return "", ErrNoToken
}

// FallbackTokenSource returns the first available token in order.
type FallbackTokenSource []TokenSource

// Token queries sources in order until one returns a token.
func (s FallbackTokenSource) Token(ctx context.Context) (string, error) {
	var firstErr error
	for _, source := range s {
		if source == nil {
			continue
		}
		token, err := source.Token(ctx)
		if err == nil {
			return token, nil
		}
		if errors.Is(err, ErrNoToken) {
			continue
		}
		if firstErr == nil {
			firstErr = err
		}
	}
	if firstErr != nil {
		return "", firstErr
	}
	return "", ErrNoToken
}

// InvalidateToken forwards invalidation to cache-aware child sources.
func (s FallbackTokenSource) InvalidateToken() {
	for _, source := range s {
		if invalidator, ok := source.(tokenInvalidator); ok {
			invalidator.InvalidateToken()
		}
	}
}
