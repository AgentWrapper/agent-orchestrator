package linear

import (
	"context"
	"errors"
	"os"
	"strings"
)

// TokenSource yields a Linear API token on demand. Mirrors the shape used by
// the GitHub adapter so wiring code can swap them out behind the same surface.
type TokenSource interface {
	Token(ctx context.Context) (string, error)
}

// ErrNoToken is returned when no token source could yield a non-empty token.
var ErrNoToken = errors.New("linear tracker: no token configured")

// StaticTokenSource is a literal token, typically used in tests.
type StaticTokenSource string

// Token returns the literal token, or ErrNoToken if it is blank.
func (s StaticTokenSource) Token(context.Context) (string, error) {
	t := strings.TrimSpace(string(s))
	if t == "" {
		return "", ErrNoToken
	}
	return t, nil
}

// EnvTokenSource reads the first non-empty value from the listed env vars,
// falling back to LINEAR_API_KEY. The order matters: AO_LINEAR_TOKEN wins so
// users can scope a token to AO without disturbing other Linear tooling.
type EnvTokenSource struct {
	EnvVars []string
}

// Token returns the first non-empty configured env var (falling back to
// LINEAR_API_KEY), or ErrNoToken if none is set.
func (s EnvTokenSource) Token(context.Context) (string, error) {
	for _, name := range s.EnvVars {
		if v := strings.TrimSpace(os.Getenv(name)); v != "" {
			return v, nil
		}
	}
	if v := strings.TrimSpace(os.Getenv("LINEAR_API_KEY")); v != "" {
		return v, nil
	}
	return "", ErrNoToken
}
