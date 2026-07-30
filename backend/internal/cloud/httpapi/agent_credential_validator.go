package httpapi

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

const defaultAnthropicAPIURL = "https://api.anthropic.com"

type agentCredentialValidator struct {
	client           *http.Client
	anthropicBaseURL string
}

func newAgentCredentialValidator(client *http.Client) *agentCredentialValidator {
	if client == nil {
		client = &http.Client{Timeout: 10 * time.Second}
	}
	return &agentCredentialValidator{
		client:           client,
		anthropicBaseURL: defaultAnthropicAPIURL,
	}
}

func normalizeAgentCredentialSecret(value string) []byte {
	return []byte(strings.Join(strings.Fields(value), ""))
}

func (v *agentCredentialValidator) Validate(
	ctx context.Context,
	agent, credentialType string,
	secret []byte,
) error {
	if agent != "claude-code" {
		return nil
	}
	// #nosec G101 -- this compares a public credential-kind label, not a credential value.
	if credentialType == "oauth_token" {
		token := string(secret)
		if !strings.HasPrefix(token, "sk-ant-oat01-") || len(token) < 80 {
			return errInvalidAgentCredential
		}
		return nil
	}
	request, err := http.NewRequestWithContext(
		ctx,
		http.MethodPost,
		strings.TrimRight(v.anthropicBaseURL, "/")+"/v1/messages",
		bytes.NewReader([]byte(`{}`)),
	)
	if err != nil {
		return fmt.Errorf("build Claude credential validation request: %w", err)
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("anthropic-version", "2023-06-01")
	request.Header.Set("User-Agent", "claude-code/2.1.220")
	switch credentialType {
	case "api_key":
		request.Header.Set("x-api-key", string(secret))
	default:
		return errInvalidAgentCredential
	}
	response, err := v.client.Do(request)
	if err != nil {
		return fmt.Errorf("validate Claude credential: %w", err)
	}
	defer func() { _ = response.Body.Close() }()
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 64<<10))
	switch response.StatusCode {
	case http.StatusUnauthorized, http.StatusForbidden:
		return errInvalidAgentCredential
	case http.StatusOK, http.StatusBadRequest, http.StatusTooManyRequests:
		return nil
	default:
		return fmt.Errorf("validate Claude credential: provider returned HTTP %d", response.StatusCode)
	}
}

var errInvalidAgentCredential = errors.New("coding-agent credential is invalid or expired")
