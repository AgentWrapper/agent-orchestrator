package linear

import (
	"context"
	"errors"
	"os"
	"strings"
)

// TokenSource yields a Linear API key on demand.
type TokenSource interface {
	Token(ctx context.Context) (string, error)
}

// ErrNoToken is returned when no Linear API key is configured.
var ErrNoToken = errors.New("linear tracker: no api key configured")

// StaticTokenSource is a literal API key, typically used in tests.
type StaticTokenSource string

// Token returns the literal key, or ErrNoToken if it is blank.
func (s StaticTokenSource) Token(context.Context) (string, error) {
	t := strings.TrimSpace(string(s))
	if t == "" {
		return "", ErrNoToken
	}
	return t, nil
}

// EnvTokenSource reads LINEAR_API_KEY by default, or the first configured
// non-empty env var.
type EnvTokenSource struct {
	EnvVars []string
}

// Token returns the first non-empty configured env var, or ErrNoToken.
func (s EnvTokenSource) Token(context.Context) (string, error) {
	names := s.EnvVars
	if len(names) == 0 {
		names = []string{"LINEAR_API_KEY"}
	}
	for _, name := range names {
		if v := strings.TrimSpace(os.Getenv(name)); v != "" {
			return v, nil
		}
	}
	return "", ErrNoToken
}
