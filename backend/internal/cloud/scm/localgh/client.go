// Package localgh provides the explicitly development-only GitHub credential
// source backed by the host's existing gh login.
package localgh

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os/exec"
	"strings"
	"time"
)

// TokenSource obtains a GitHub token from the local gh CLI.
type TokenSource struct{}

// Token returns the current gh authentication token.
func (TokenSource) Token(ctx context.Context) (string, error) {
	command := exec.CommandContext(ctx, "gh", "auth", "token")
	output, err := command.Output()
	if err != nil {
		return "", fmt.Errorf("read local gh credential: %w", err)
	}
	token := strings.TrimSpace(string(output))
	if token == "" {
		return "", errors.New("local gh credential is empty")
	}
	return token, nil
}

// StaticTokenSource supplies an explicitly configured GitHub token.
type StaticTokenSource string

// Token returns the configured token without exposing it to sandboxes.
func (s StaticTokenSource) Token(context.Context) (string, error) {
	token := strings.TrimSpace(string(s))
	if token == "" {
		return "", fmt.Errorf("configured GitHub token is empty")
	}
	return token, nil
}

// Repository describes a GitHub repository available to the current user.
type Repository struct {
	FullName      string `json:"fullName"`
	URL           string `json:"url"`
	DefaultBranch string `json:"defaultBranch"`
	Private       bool   `json:"private"`
}

// Client reads GitHub state using a local gh credential source.
type Client struct {
	tokens tokenSource
	http   *http.Client
}

type tokenSource interface {
	Token(context.Context) (string, error)
}

// New creates a local GitHub client backed by the gh CLI.
func New(client *http.Client) *Client {
	if client == nil {
		client = &http.Client{Timeout: 15 * time.Second}
	}
	return &Client{tokens: TokenSource{}, http: client}
}

// NewWithTokenSource creates a local GitHub client with an injected token source.
func NewWithTokenSource(tokens tokenSource, client *http.Client) *Client {
	if client == nil {
		client = &http.Client{Timeout: 15 * time.Second}
	}
	return &Client{tokens: tokens, http: client}
}

// Token returns the current local GitHub credential. Callers must keep the
// value scoped to explicitly local development flows.
func (c *Client) Token(ctx context.Context) (string, error) {
	return c.tokens.Token(ctx)
}

// ListRepositories returns repositories available to the authenticated user.
func (c *Client) ListRepositories(ctx context.Context) ([]Repository, error) {
	token, err := c.tokens.Token(ctx)
	if err != nil {
		return nil, err
	}
	request, err := http.NewRequestWithContext(
		ctx,
		http.MethodGet,
		"https://api.github.com/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member",
		http.NoBody,
	)
	if err != nil {
		return nil, fmt.Errorf("build GitHub repositories request: %w", err)
	}
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Accept", "application/vnd.github+json")
	request.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	response, err := c.http.Do(request)
	if err != nil {
		return nil, fmt.Errorf("list GitHub repositories: %w", err)
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode != http.StatusOK {
		_, _ = io.Copy(io.Discard, response.Body)
		return nil, fmt.Errorf("GitHub repository list returned %s", response.Status)
	}
	var payload []struct {
		FullName      string `json:"full_name"`
		HTMLURL       string `json:"html_url"`
		DefaultBranch string `json:"default_branch"`
		Private       bool   `json:"private"`
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 4<<20)).Decode(&payload); err != nil {
		return nil, fmt.Errorf("decode GitHub repositories: %w", err)
	}
	repositories := make([]Repository, 0, len(payload))
	for _, repository := range payload {
		repositories = append(repositories, Repository{
			FullName:      repository.FullName,
			URL:           repository.HTMLURL,
			DefaultBranch: repository.DefaultBranch,
			Private:       repository.Private,
		})
	}
	return repositories, nil
}
