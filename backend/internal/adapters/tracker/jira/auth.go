package jira

import (
	"context"
	"errors"
	"os"
	"strings"
)

// CredentialSource yields Jira Cloud Basic-auth credentials (email + API
// token). Jira's REST API does not accept bearer tokens for cloud accounts;
// every request is `Authorization: Basic base64(email:token)`.
type CredentialSource interface {
	Credentials(ctx context.Context) (email, token string, err error)
}

// ErrNoCredentials is returned when no email/token pair can be obtained.
var ErrNoCredentials = errors.New("jira tracker: no credentials configured")

// StaticCredentials are literal values, typically used in tests.
type StaticCredentials struct {
	Email string
	Token string
}

// Credentials returns the literal pair, or ErrNoCredentials if either is blank.
func (s StaticCredentials) Credentials(context.Context) (string, string, error) {
	email := strings.TrimSpace(s.Email)
	token := strings.TrimSpace(s.Token)
	if email == "" || token == "" {
		return "", "", ErrNoCredentials
	}
	return email, token, nil
}

// EnvCredentials reads Jira email/token pairs from env vars. Email and Token
// each accept a list of var names to support overlay scopes (project-specific
// vars beat the global default).
type EnvCredentials struct {
	EmailVars []string
	TokenVars []string
}

// Credentials returns the first non-empty value from each var list, with
// AO_JIRA_EMAIL / AO_JIRA_TOKEN as defaults.
func (s EnvCredentials) Credentials(context.Context) (string, string, error) {
	email := firstNonEmpty(s.EmailVars, "AO_JIRA_EMAIL")
	token := firstNonEmpty(s.TokenVars, "AO_JIRA_TOKEN")
	if email == "" || token == "" {
		return "", "", ErrNoCredentials
	}
	return email, token, nil
}

func firstNonEmpty(names []string, fallback string) string {
	for _, name := range names {
		if v := strings.TrimSpace(os.Getenv(name)); v != "" {
			return v
		}
	}
	return strings.TrimSpace(os.Getenv(fallback))
}
