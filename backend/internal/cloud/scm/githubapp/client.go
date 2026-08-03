// Package githubapp provides a standalone GitHub App API client. It keeps App
// signing and short-lived installation credentials in memory and does not
// persist or log them.
package githubapp

import (
	"bytes"
	"context"
	"crypto/rsa"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

const (
	// DefaultAPIBaseURL is GitHub's public REST API endpoint.
	DefaultAPIBaseURL = "https://api.github.com"
	// DefaultGraphQLURL is GitHub's public GraphQL API endpoint.
	DefaultGraphQLURL = "https://api.github.com/graphql"
	// APIVersion is the GitHub REST API version requested by this client.
	APIVersion = "2022-11-28"

	defaultRequestTimeout     = 15 * time.Second
	defaultMaxResponseBytes   = int64(4 << 20)
	defaultMaxErrorBytes      = int64(64 << 10)
	defaultMaxPaginationPages = 1000
)

// Config configures a GitHub App client.
type Config struct {
	// ClientID is used as the issuer of App JWTs.
	ClientID string
	// PrivateKeyPEM is an unencrypted RSA private key in PKCS#1 or PKCS#8 PEM form.
	PrivateKeyPEM []byte

	// APIBaseURL and GraphQLURL may be overridden for GitHub Enterprise or tests.
	APIBaseURL string
	GraphQLURL string
	HTTPClient *http.Client

	RequestTimeout     time.Duration
	MaxResponseBytes   int64
	MaxErrorBytes      int64
	MaxPaginationPages int
	UserAgent          string

	// Now is an optional clock used when creating JWTs.
	Now func() time.Time
}

// Client signs GitHub App requests and performs bounded REST and GraphQL calls.
type Client struct {
	clientID          string
	privateKey        *rsa.PrivateKey
	apiBaseURL        *url.URL
	graphQLURL        *url.URL
	http              *http.Client
	requestTimeout    time.Duration
	maxResponseBytes  int64
	maxErrorBytes     int64
	maxPaginationPage int
	userAgent         string
	now               func() time.Time
}

// New creates a GitHub App client.
func New(config Config) (*Client, error) {
	clientID := strings.TrimSpace(config.ClientID)
	if clientID == "" {
		return nil, errors.New("GitHub App client ID is required")
	}
	key, err := ParseRSAPrivateKey(config.PrivateKeyPEM)
	if err != nil {
		return nil, err
	}

	apiBaseURL, err := parseBaseURL(config.APIBaseURL, DefaultAPIBaseURL, "GitHub API base")
	if err != nil {
		return nil, err
	}
	graphQLURL, err := parseBaseURL(config.GraphQLURL, DefaultGraphQLURL, "GitHub GraphQL")
	if err != nil {
		return nil, err
	}

	httpClient := config.HTTPClient
	if httpClient == nil {
		httpClient = &http.Client{}
	}
	requestTimeout := config.RequestTimeout
	if requestTimeout == 0 {
		requestTimeout = defaultRequestTimeout
	}
	if requestTimeout < 0 {
		return nil, errors.New("GitHub request timeout must not be negative")
	}
	maxResponseBytes := config.MaxResponseBytes
	if maxResponseBytes == 0 {
		maxResponseBytes = defaultMaxResponseBytes
	}
	if maxResponseBytes < 0 {
		return nil, errors.New("GitHub maximum response size must not be negative")
	}
	maxErrorBytes := config.MaxErrorBytes
	if maxErrorBytes == 0 {
		maxErrorBytes = defaultMaxErrorBytes
	}
	if maxErrorBytes < 0 {
		return nil, errors.New("GitHub maximum error size must not be negative")
	}
	maxPaginationPages := config.MaxPaginationPages
	if maxPaginationPages == 0 {
		maxPaginationPages = defaultMaxPaginationPages
	}
	if maxPaginationPages < 0 {
		return nil, errors.New("GitHub maximum pagination pages must not be negative")
	}
	userAgent := strings.TrimSpace(config.UserAgent)
	if userAgent == "" {
		userAgent = "agent-orchestrator"
	}
	now := config.Now
	if now == nil {
		now = time.Now
	}

	return &Client{
		clientID:          clientID,
		privateKey:        key,
		apiBaseURL:        apiBaseURL,
		graphQLURL:        graphQLURL,
		http:              httpClient,
		requestTimeout:    requestTimeout,
		maxResponseBytes:  maxResponseBytes,
		maxErrorBytes:     maxErrorBytes,
		maxPaginationPage: maxPaginationPages,
		userAgent:         userAgent,
		now:               now,
	}, nil
}

func parseBaseURL(value, fallback, label string) (*url.URL, error) {
	if strings.TrimSpace(value) == "" {
		value = fallback
	}
	parsed, err := url.Parse(value)
	if err != nil {
		return nil, fmt.Errorf("parse %s URL: %w", label, err)
	}
	if (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
		return nil, fmt.Errorf("%s URL must be an absolute HTTP(S) URL", label)
	}
	if parsed.RawQuery != "" || parsed.Fragment != "" {
		return nil, fmt.Errorf("%s URL must not contain a query or fragment", label)
	}
	parsed.Path = strings.TrimRight(parsed.Path, "/")
	return parsed, nil
}

// Account is immutable GitHub account metadata attached to an installation or
// repository owner.
type Account struct {
	ID        int64  `json:"id"`
	NodeID    string `json:"node_id"`
	Login     string `json:"login"`
	Type      string `json:"type"`
	AvatarURL string `json:"avatar_url"`
	HTMLURL   string `json:"html_url"`
}

// Installation describes a GitHub App installation.
type Installation struct {
	ID                     int64             `json:"id"`
	NodeID                 string            `json:"node_id"`
	Account                Account           `json:"account"`
	RepositorySelection    string            `json:"repository_selection"`
	AccessTokensURL        string            `json:"access_tokens_url"`
	RepositoriesURL        string            `json:"repositories_url"`
	HTMLURL                string            `json:"html_url"`
	AppID                  int64             `json:"app_id"`
	ClientID               string            `json:"client_id"`
	TargetID               int64             `json:"target_id"`
	TargetType             string            `json:"target_type"`
	Permissions            map[string]string `json:"permissions"`
	Events                 []string          `json:"events"`
	CreatedAt              time.Time         `json:"created_at"`
	UpdatedAt              time.Time         `json:"updated_at"`
	SuspendedAt            *time.Time        `json:"suspended_at"`
	SuspendedBy            *Account          `json:"suspended_by"`
	SingleFileName         string            `json:"single_file_name"`
	HasMultipleSingleFiles bool              `json:"has_multiple_single_files"`
}

// GetInstallation returns one installation using App authentication.
func (c *Client) GetInstallation(ctx context.Context, installationID int64) (Installation, error) {
	if installationID <= 0 {
		return Installation{}, errors.New("GitHub installation ID must be positive")
	}
	var installation Installation
	err := c.DoAppREST(
		ctx,
		http.MethodGet,
		"/app/installations/"+strconv.FormatInt(installationID, 10),
		nil,
		&installation,
	)
	if err != nil {
		return Installation{}, fmt.Errorf("get GitHub App installation: %w", err)
	}
	return installation, nil
}

// Permissions explicitly downscopes an installation token.
type Permissions map[string]string

// InstallationToken is a short-lived credential. Its value is deliberately
// unexported and redacted from fmt and JSON output.
type InstallationToken struct {
	value               string
	ExpiresAt           time.Time         `json:"expires_at"`
	Permissions         map[string]string `json:"permissions"`
	RepositorySelection string            `json:"repository_selection"`
}

// Token returns the credential for an immediate operation. Callers must not
// persist or log the returned value.
func (token InstallationToken) Token() string {
	return token.value
}

// String redacts the credential from formatted output.
func (InstallationToken) String() string {
	return "[REDACTED GitHub installation token]"
}

// GoString redacts the credential from Go-syntax formatted output.
func (InstallationToken) GoString() string {
	return "[REDACTED GitHub installation token]"
}

// MintInstallationToken creates a short-lived token restricted to exactly one
// repository ID and the supplied explicit permissions.
func (c *Client) MintInstallationToken(
	ctx context.Context,
	installationID, repositoryID int64,
	permissions Permissions,
) (InstallationToken, error) {
	if installationID <= 0 {
		return InstallationToken{}, errors.New("GitHub installation ID must be positive")
	}
	if repositoryID <= 0 {
		return InstallationToken{}, errors.New("GitHub repository ID must be positive")
	}
	if err := validatePermissions(permissions); err != nil {
		return InstallationToken{}, err
	}
	token, err := c.mintInstallationToken(
		ctx,
		installationID,
		[]int64{repositoryID},
		permissions,
	)
	if err != nil {
		return InstallationToken{}, fmt.Errorf("mint GitHub installation token: %w", err)
	}
	return token, nil
}

func (c *Client) mintInstallationToken(
	ctx context.Context,
	installationID int64,
	repositoryIDs []int64,
	permissions Permissions,
) (InstallationToken, error) {
	request := struct {
		RepositoryIDs []int64     `json:"repository_ids,omitempty"`
		Permissions   Permissions `json:"permissions"`
	}{
		RepositoryIDs: append([]int64(nil), repositoryIDs...),
		Permissions:   clonePermissions(permissions),
	}
	var response struct {
		Token               string            `json:"token"`
		ExpiresAt           time.Time         `json:"expires_at"`
		Permissions         map[string]string `json:"permissions"`
		RepositorySelection string            `json:"repository_selection"`
	}
	err := c.DoAppREST(
		ctx,
		http.MethodPost,
		"/app/installations/"+strconv.FormatInt(installationID, 10)+"/access_tokens",
		request,
		&response,
	)
	if err != nil {
		return InstallationToken{}, err
	}
	if strings.TrimSpace(response.Token) == "" {
		return InstallationToken{}, errors.New("GitHub returned an empty installation token")
	}
	return InstallationToken{
		value:               response.Token,
		ExpiresAt:           response.ExpiresAt,
		Permissions:         cloneStringMap(response.Permissions),
		RepositorySelection: response.RepositorySelection,
	}, nil
}

func validatePermissions(permissions Permissions) error {
	if len(permissions) == 0 {
		return errors.New("at least one explicit GitHub installation permission is required")
	}
	for name, level := range permissions {
		if strings.TrimSpace(name) == "" || strings.TrimSpace(level) == "" {
			return errors.New("GitHub installation permission names and levels must not be empty")
		}
	}
	return nil
}

func clonePermissions(input Permissions) Permissions {
	result := make(Permissions, len(input))
	for key, value := range input {
		result[key] = value
	}
	return result
}

func cloneStringMap(input map[string]string) map[string]string {
	result := make(map[string]string, len(input))
	for key, value := range input {
		result[key] = value
	}
	return result
}

// Repository contains immutable GitHub IDs and repository metadata returned by
// an installation-scoped repository listing.
type Repository struct {
	ID            int64           `json:"id"`
	NodeID        string          `json:"node_id"`
	Name          string          `json:"name"`
	FullName      string          `json:"full_name"`
	Private       bool            `json:"private"`
	Owner         Account         `json:"owner"`
	HTMLURL       string          `json:"html_url"`
	URL           string          `json:"url"`
	CloneURL      string          `json:"clone_url"`
	SSHURL        string          `json:"ssh_url"`
	DefaultBranch string          `json:"default_branch"`
	Archived      bool            `json:"archived"`
	Disabled      bool            `json:"disabled"`
	Visibility    string          `json:"visibility"`
	IsTemplate    bool            `json:"is_template"`
	Permissions   map[string]bool `json:"permissions"`
	CreatedAt     time.Time       `json:"created_at"`
	UpdatedAt     time.Time       `json:"updated_at"`
	PushedAt      time.Time       `json:"pushed_at"`
}

// ListInstallationRepositories mints an ephemeral metadata-only installation
// token and lists every repository selected for the installation. The
// enumeration token is neither returned nor retained.
func (c *Client) ListInstallationRepositories(
	ctx context.Context,
	installationID int64,
) ([]Repository, error) {
	if installationID <= 0 {
		return nil, errors.New("GitHub installation ID must be positive")
	}
	token, err := c.mintInstallationToken(ctx, installationID, nil, Permissions{
		"metadata": "read",
	})
	if err != nil {
		return nil, fmt.Errorf("mint GitHub repository-list token: %w", err)
	}
	return c.ListRepositories(ctx, token)
}

// ListRepositories lists every repository visible to an existing installation
// token, following GitHub pagination links within the configured API origin.
func (c *Client) ListRepositories(
	ctx context.Context,
	token InstallationToken,
) ([]Repository, error) {
	if token.value == "" {
		return nil, errors.New("GitHub installation token is empty")
	}
	next, err := c.restURL("/installation/repositories?per_page=100&page=1")
	if err != nil {
		return nil, err
	}
	repositories := make([]Repository, 0)
	seen := make(map[string]struct{})
	for page := 1; next != ""; page++ {
		if page > c.maxPaginationPage {
			return nil, fmt.Errorf("GitHub repository pagination exceeded %d pages", c.maxPaginationPage)
		}
		if _, ok := seen[next]; ok {
			return nil, errors.New("GitHub repository pagination repeated a page")
		}
		seen[next] = struct{}{}

		var payload struct {
			TotalCount   int          `json:"total_count"`
			Repositories []Repository `json:"repositories"`
		}
		headers, err := c.doURL(ctx, http.MethodGet, next, token.value, nil, &payload)
		if err != nil {
			return nil, fmt.Errorf("list GitHub installation repositories: %w", err)
		}
		repositories = append(repositories, payload.Repositories...)

		next, err = c.nextPageURL(headers.Get("Link"))
		if err != nil {
			return nil, fmt.Errorf("parse GitHub repository pagination: %w", err)
		}
		if next == "" && payload.TotalCount > len(repositories) {
			next, err = c.restURL(fmt.Sprintf(
				"/installation/repositories?per_page=100&page=%d",
				page+1,
			))
			if err != nil {
				return nil, err
			}
		}
	}
	return repositories, nil
}

func (c *Client) nextPageURL(linkHeader string) (string, error) {
	for _, link := range strings.Split(linkHeader, ",") {
		parts := strings.Split(strings.TrimSpace(link), ";")
		if len(parts) < 2 {
			continue
		}
		isNext := false
		for _, parameter := range parts[1:] {
			if strings.TrimSpace(parameter) == `rel="next"` {
				isNext = true
				break
			}
		}
		if !isNext {
			continue
		}
		target := strings.TrimSpace(parts[0])
		if len(target) < 3 || target[0] != '<' || target[len(target)-1] != '>' {
			return "", errors.New("invalid next Link target")
		}
		parsed, err := url.Parse(target[1 : len(target)-1])
		if err != nil {
			return "", err
		}
		if !parsed.IsAbs() {
			parsed = c.apiBaseURL.ResolveReference(parsed)
		}
		if !sameOrigin(parsed, c.apiBaseURL) {
			return "", errors.New("next Link target is outside the configured GitHub API origin")
		}
		parsed.Fragment = ""
		return parsed.String(), nil
	}
	return "", nil
}

func sameOrigin(left, right *url.URL) bool {
	return strings.EqualFold(left.Scheme, right.Scheme) &&
		strings.EqualFold(left.Host, right.Host)
}

// DoAppREST performs a JSON REST operation authenticated as the GitHub App.
func (c *Client) DoAppREST(
	ctx context.Context,
	method, path string,
	input, output any,
) error {
	token, err := c.AppJWT()
	if err != nil {
		return err
	}
	target, err := c.restURL(path)
	if err != nil {
		return err
	}
	_, err = c.doURL(ctx, method, target, token, input, output)
	return err
}

// DoInstallationREST performs a JSON REST operation authenticated with a
// short-lived installation token.
func (c *Client) DoInstallationREST(
	ctx context.Context,
	token InstallationToken,
	method, path string,
	input, output any,
) error {
	if token.value == "" {
		return errors.New("GitHub installation token is empty")
	}
	target, err := c.restURL(path)
	if err != nil {
		return err
	}
	_, err = c.doURL(ctx, method, target, token.value, input, output)
	return err
}

// GraphQLError is one error returned in a GitHub GraphQL response.
type GraphQLError struct {
	Message    string         `json:"message"`
	Type       string         `json:"type"`
	Path       []any          `json:"path"`
	Locations  []GraphQLPoint `json:"locations"`
	Extensions map[string]any `json:"extensions"`
}

// GraphQLPoint identifies a source location in a GraphQL query.
type GraphQLPoint struct {
	Line   int `json:"line"`
	Column int `json:"column"`
}

// GraphQLResponseError reports a successful HTTP response containing GraphQL
// operation errors.
type GraphQLResponseError struct {
	Errors []GraphQLError
}

func (err *GraphQLResponseError) Error() string {
	if len(err.Errors) == 0 {
		return "GitHub GraphQL returned errors"
	}
	return "GitHub GraphQL returned errors: " + err.Errors[0].Message
}

// DoInstallationGraphQL performs an installation-authenticated GraphQL query
// or mutation. This supports issue/PR observation, checks/status operations,
// merges, and review-thread resolution without exposing the credential.
func (c *Client) DoInstallationGraphQL(
	ctx context.Context,
	token InstallationToken,
	query string,
	variables map[string]any,
	output any,
) error {
	if token.value == "" {
		return errors.New("GitHub installation token is empty")
	}
	if strings.TrimSpace(query) == "" {
		return errors.New("GitHub GraphQL query is empty")
	}
	var raw json.RawMessage
	_, err := c.doURL(ctx, http.MethodPost, c.graphQLURL.String(), token.value, struct {
		Query     string         `json:"query"`
		Variables map[string]any `json:"variables,omitempty"`
	}{
		Query:     query,
		Variables: variables,
	}, &raw)
	if err != nil {
		return err
	}
	var envelope struct {
		Errors []GraphQLError `json:"errors"`
	}
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return fmt.Errorf("decode GitHub GraphQL envelope: %w", err)
	}
	if len(envelope.Errors) > 0 {
		return &GraphQLResponseError{Errors: envelope.Errors}
	}
	if output == nil {
		return nil
	}
	if err := json.Unmarshal(raw, output); err != nil {
		return fmt.Errorf("decode GitHub GraphQL response: %w", err)
	}
	return nil
}

func (c *Client) restURL(path string) (string, error) {
	relative, err := url.Parse(path)
	if err != nil {
		return "", fmt.Errorf("parse GitHub REST path: %w", err)
	}
	if relative.IsAbs() || relative.Host != "" || relative.Fragment != "" {
		return "", errors.New("GitHub REST path must be relative to the configured API base")
	}
	target := *c.apiBaseURL
	target.Path = strings.TrimRight(c.apiBaseURL.Path, "/") + "/" + strings.TrimLeft(relative.Path, "/")
	target.RawPath = ""
	target.RawQuery = relative.RawQuery
	return target.String(), nil
}

func (c *Client) doURL(
	ctx context.Context,
	method, target, token string,
	input, output any,
) (http.Header, error) {
	var body io.Reader = http.NoBody
	if input != nil {
		encoded, err := json.Marshal(input)
		if err != nil {
			return nil, fmt.Errorf("encode GitHub request: %w", err)
		}
		body = bytes.NewReader(encoded)
	}

	requestCtx := ctx
	cancel := func() {}
	if c.requestTimeout > 0 {
		requestCtx, cancel = context.WithTimeout(ctx, c.requestTimeout)
	}
	defer cancel()

	request, err := http.NewRequestWithContext(requestCtx, method, target, body)
	if err != nil {
		return nil, fmt.Errorf("build GitHub request: %w", err)
	}
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Accept", "application/vnd.github+json")
	request.Header.Set("X-GitHub-Api-Version", APIVersion)
	request.Header.Set("User-Agent", c.userAgent)
	if input != nil {
		request.Header.Set("Content-Type", "application/json")
	}

	response, err := c.http.Do(request)
	if err != nil {
		return nil, fmt.Errorf("perform GitHub request: %w", err)
	}
	defer func() { _ = response.Body.Close() }()

	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		return response.Header.Clone(), c.decodeAPIError(response)
	}
	if output == nil || response.StatusCode == http.StatusNoContent {
		return response.Header.Clone(), nil
	}
	payload, tooLarge, err := readBounded(response.Body, c.maxResponseBytes)
	if err != nil {
		return response.Header.Clone(), fmt.Errorf("read GitHub response: %w", err)
	}
	if tooLarge {
		return response.Header.Clone(), &ResponseTooLargeError{Limit: c.maxResponseBytes}
	}
	if err := json.Unmarshal(payload, output); err != nil {
		return response.Header.Clone(), fmt.Errorf("decode GitHub response: %w", err)
	}
	return response.Header.Clone(), nil
}

// ResponseTooLargeError indicates that a successful response exceeded the
// configured decoding bound.
type ResponseTooLargeError struct {
	Limit int64
}

func (err *ResponseTooLargeError) Error() string {
	return fmt.Sprintf("GitHub response exceeds %d bytes", err.Limit)
}

// APIError is a bounded GitHub REST error response.
type APIError struct {
	StatusCode       int
	Status           string
	Message          string
	DocumentationURL string
	RequestID        string
	Body             string
	Truncated        bool
}

func (err *APIError) Error() string {
	if err.Message == "" {
		return "GitHub API returned " + err.Status
	}
	return "GitHub API returned " + err.Status + ": " + err.Message
}

func (c *Client) decodeAPIError(response *http.Response) error {
	payload, truncated, readErr := readBounded(response.Body, c.maxErrorBytes)
	if readErr != nil {
		return fmt.Errorf("GitHub API returned %s and its error body could not be read: %w", response.Status, readErr)
	}
	apiError := &APIError{
		StatusCode: response.StatusCode,
		Status:     response.Status,
		RequestID:  response.Header.Get("X-GitHub-Request-Id"),
		Body:       string(payload),
		Truncated:  truncated,
	}
	var envelope struct {
		Message          string `json:"message"`
		DocumentationURL string `json:"documentation_url"`
	}
	if json.Unmarshal(payload, &envelope) == nil {
		apiError.Message = envelope.Message
		apiError.DocumentationURL = envelope.DocumentationURL
	}
	if apiError.Message == "" {
		apiError.Message = strings.TrimSpace(string(payload))
	}
	if truncated {
		apiError.Message = strings.TrimSpace(apiError.Message) + " (truncated)"
	}
	return apiError
}

func readBounded(reader io.Reader, limit int64) ([]byte, bool, error) {
	payload, err := io.ReadAll(io.LimitReader(reader, limit+1))
	if err != nil {
		return nil, false, err
	}
	if int64(len(payload)) > limit {
		return payload[:limit], true, nil
	}
	return payload, false, nil
}
