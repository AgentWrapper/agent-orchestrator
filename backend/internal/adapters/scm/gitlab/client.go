package gitlab

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

const (
	defaultBaseURL      = "https://gitlab.com/api/v4"
	defaultUserAgent    = "ao-agent-orchestrator/scm-gitlab"
	defaultMaxJSONBytes = int64(4 << 20)
	defaultMaxRawBytes  = int64(16 << 20)
	maxPaginationPages  = 100
)

var (
	// ErrAuthFailed identifies missing or rejected GitLab credentials.
	ErrAuthFailed = errors.New("gitlab scm: authentication failed")
	// ErrForbidden identifies a credential without access to the resource.
	ErrForbidden = errors.New("gitlab scm: forbidden")
	// ErrNotFound is the provider-neutral missing-resource sentinel.
	ErrNotFound = ports.ErrSCMNotFound
	// ErrPrecondition identifies 409 and 422 action rejections.
	ErrPrecondition = errors.New("gitlab scm: precondition failed")
	// ErrRateLimited identifies a 429 response.
	ErrRateLimited = errors.New("gitlab scm: rate limited")
	// ErrNetwork identifies a redacted transport failure.
	ErrNetwork = errors.New("gitlab scm: network failure")
	// ErrTLS identifies certificate validation failures.
	ErrTLS = errors.New("gitlab scm: TLS failure")
	// ErrResponseTooLarge identifies a response over the configured limit.
	ErrResponseTooLarge = errors.New("gitlab scm: response too large")
	// ErrInvalidPagination identifies an unsafe or malformed next-page link.
	ErrInvalidPagination = errors.New("gitlab scm: invalid pagination link")
	// ErrInvalidBaseURL identifies a non-absolute or unsafe GitLab API URL.
	ErrInvalidBaseURL = errors.New("gitlab scm: invalid base URL")
)

// RateLimitError carries GitLab's Retry-After backoff hint.
type RateLimitError struct {
	RetryAfter time.Duration
}

func (e *RateLimitError) Error() string { return ErrRateLimited.Error() }

// Is makes RateLimitError match ErrRateLimited.
func (e *RateLimitError) Is(target error) bool { return target == ErrRateLimited }

// RateLimitDelay returns the provider-requested delay for observer backoff.
func (e *RateLimitError) RateLimitDelay(time.Time) time.Duration {
	if e == nil {
		return 0
	}
	return e.RetryAfter
}

// PreconditionError identifies an action rejected with 409 or 422.
type PreconditionError struct {
	StatusCode int
}

func (e *PreconditionError) Error() string { return ErrPrecondition.Error() }

// Is makes PreconditionError match ErrPrecondition.
func (e *PreconditionError) Is(target error) bool { return target == ErrPrecondition }

// ResponseTooLargeError reports the enforced byte limit without response data.
type ResponseTooLargeError struct {
	Limit int64
}

func (e *ResponseTooLargeError) Error() string { return ErrResponseTooLarge.Error() }

// Is makes ResponseTooLargeError match ErrResponseTooLarge.
func (e *ResponseTooLargeError) Is(target error) bool { return target == ErrResponseTooLarge }

// ClientOptions configures a GitLab REST client.
type ClientOptions struct {
	HTTPClient   *http.Client
	Token        TokenSource
	BaseURL      string
	UserAgent    string
	MaxJSONBytes int64
	MaxRawBytes  int64
	Now          func() time.Time
}

// Client is the bounded, redacted GitLab REST transport shared by adapters.
type Client struct {
	http         *http.Client
	tokens       TokenSource
	baseURL      *url.URL
	baseErr      error
	userAgent    string
	maxJSONBytes int64
	maxRawBytes  int64
	now          func() time.Time
}

// Response exposes bounded response metadata needed for pagination.
type Response struct {
	StatusCode int
	Header     http.Header
	Body       []byte
}

// NewClient creates a bounded GitLab REST client.
func NewClient(opts ClientOptions) *Client {
	httpClient := hardenedHTTPClient(opts.HTTPClient)
	base := strings.TrimSpace(opts.BaseURL)
	if base == "" {
		base = defaultBaseURL
	}
	parsed, err := url.Parse(base)
	if err == nil {
		err = validateBaseURL(parsed)
	}
	userAgent := opts.UserAgent
	if userAgent == "" {
		userAgent = defaultUserAgent
	}
	maxJSON := opts.MaxJSONBytes
	if maxJSON <= 0 {
		maxJSON = defaultMaxJSONBytes
	}
	maxRaw := opts.MaxRawBytes
	if maxRaw <= 0 {
		maxRaw = defaultMaxRawBytes
	}
	now := opts.Now
	if now == nil {
		now = time.Now
	}
	return &Client{
		http: httpClient, tokens: opts.Token, baseURL: parsed, baseErr: err, userAgent: userAgent,
		maxJSONBytes: maxJSON, maxRawBytes: maxRaw, now: now,
	}
}

// EncodedProjectPath returns the URL-segment form GitLab expects for a full path.
func EncodedProjectPath(project string) string {
	project = strings.TrimSuffix(strings.TrimSpace(project), ".git")
	return url.PathEscape(project)
}

// DoJSON sends one JSON request and optionally decodes a bounded JSON response.
func (c *Client) DoJSON(ctx context.Context, method, path string, query url.Values, body, out any) (Response, error) {
	return c.doJSONWithHeaders(ctx, method, path, query, nil, body, out)
}

func (c *Client) doJSONWithHeaders(ctx context.Context, method, path string, query url.Values, headers http.Header, body, out any) (Response, error) {
	var reader io.Reader = http.NoBody
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return Response{}, errors.New("gitlab scm: encode request body")
		}
		reader = bytes.NewReader(encoded)
	}
	endpoint, err := c.requestURL(path, query)
	if err != nil {
		if errors.Is(err, ErrInvalidBaseURL) {
			return Response{}, err
		}
		return Response{}, errors.New("gitlab scm: invalid request path")
	}
	response, err := c.do(ctx, method, endpoint, reader, "application/json", c.maxJSONBytes, headers)
	if err != nil {
		return response, err
	}
	if out != nil && len(response.Body) != 0 {
		if err := json.Unmarshal(response.Body, out); err != nil {
			return response, errors.New("gitlab scm: decode JSON response")
		}
	}
	return response, nil
}

// GetRaw fetches a bounded raw response such as a job trace or diff.
func (c *Client) GetRaw(ctx context.Context, path string, query url.Values) ([]byte, error) {
	endpoint, err := c.requestURL(path, query)
	if err != nil {
		if errors.Is(err, ErrInvalidBaseURL) {
			return nil, err
		}
		return nil, errors.New("gitlab scm: invalid request path")
	}
	response, err := c.do(ctx, http.MethodGet, endpoint, http.NoBody, "*/*", c.maxRawBytes, nil)
	if err != nil {
		return nil, err
	}
	return response.Body, nil
}

// GetJSONPages follows RFC Link pagination, then X-Next-Page as fallback.
func (c *Client) GetJSONPages(ctx context.Context, path string, query url.Values, consume func([]byte) error) error {
	endpoint, err := c.requestURL(path, query)
	if err != nil {
		return ErrInvalidPagination
	}
	for page := 0; endpoint != nil; page++ {
		if page >= maxPaginationPages {
			return ErrInvalidPagination
		}
		response, err := c.do(ctx, http.MethodGet, endpoint, http.NoBody, "application/json", c.maxJSONBytes, nil)
		if err != nil {
			return err
		}
		if consume != nil {
			if err := consume(response.Body); err != nil {
				return err
			}
		}
		endpoint, err = c.nextPageURL(endpoint, response.Header)
		if err != nil {
			return err
		}
	}
	return nil
}

func (c *Client) do(ctx context.Context, method string, endpoint *url.URL, body io.Reader, accept string, limit int64, headers http.Header) (Response, error) {
	req, err := http.NewRequestWithContext(ctx, method, endpoint.String(), body)
	if err != nil {
		return Response{}, errors.New("gitlab scm: build request")
	}
	if body != http.NoBody {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("Accept", accept)
	req.Header.Set("User-Agent", c.userAgent)
	for key, values := range headers {
		for _, value := range values {
			req.Header.Add(key, value)
		}
	}
	if err := c.authorize(ctx, req); err != nil {
		return Response{}, err
	}
	resp, err := c.http.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return Response{}, ctx.Err()
		}
		if isTLSError(err) {
			return Response{}, ErrTLS
		}
		return Response{}, ErrNetwork
	}
	defer func() { _ = resp.Body.Close() }()
	responseBody, err := readBounded(resp.Body, limit)
	response := Response{StatusCode: resp.StatusCode, Header: resp.Header.Clone(), Body: responseBody}
	if resp.StatusCode == http.StatusNotModified {
		response.Body = nil
		return response, nil
	}
	if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
		classified := c.classify(resp)
		if errors.Is(classified, ErrAuthFailed) {
			c.invalidateToken()
		}
		response.Body = nil
		response.Header = nil
		return response, classified
	}
	if err != nil {
		return Response{StatusCode: resp.StatusCode}, err
	}
	return response, nil
}

func (c *Client) authorize(ctx context.Context, req *http.Request) error {
	if c.tokens == nil {
		return fmt.Errorf("%w: %w", ErrAuthFailed, ErrNoToken)
	}
	token, err := c.tokens.Token(ctx)
	if err != nil {
		if errors.Is(err, ErrNoToken) {
			return fmt.Errorf("%w: %w", ErrAuthFailed, ErrNoToken)
		}
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			return err
		}
		return ErrAuthFailed
	}
	if strings.TrimSpace(token) == "" {
		return fmt.Errorf("%w: %w", ErrAuthFailed, ErrNoToken)
	}
	req.Header.Set("PRIVATE-TOKEN", token)
	return nil
}

func (c *Client) invalidateToken() {
	if invalidator, ok := c.tokens.(tokenInvalidator); ok {
		invalidator.InvalidateToken()
	}
}

func (c *Client) classify(resp *http.Response) error {
	switch resp.StatusCode {
	case http.StatusUnauthorized:
		return ErrAuthFailed
	case http.StatusForbidden:
		return ErrForbidden
	case http.StatusNotFound:
		return ErrNotFound
	case http.StatusConflict, http.StatusUnprocessableEntity:
		return &PreconditionError{StatusCode: resp.StatusCode}
	case http.StatusTooManyRequests:
		return &RateLimitError{RetryAfter: parseRetryAfter(resp.Header.Get("Retry-After"), c.now())}
	default:
		return fmt.Errorf("gitlab scm: request failed with status %d", resp.StatusCode)
	}
}

func (c *Client) requestURL(path string, query url.Values) (*url.URL, error) {
	if c.baseErr != nil || c.baseURL == nil {
		return nil, ErrInvalidBaseURL
	}
	result := *c.baseURL
	requestedRawPath := path
	if !strings.HasPrefix(requestedRawPath, "/") {
		requestedRawPath = "/" + requestedRawPath
	}
	rawPath := strings.TrimSuffix(c.baseURL.EscapedPath(), "/") + requestedRawPath
	decodedPath, err := url.PathUnescape(rawPath)
	if err != nil {
		return nil, err
	}
	result.Path = decodedPath
	result.RawPath = rawPath
	result.RawQuery = cloneValues(query).Encode()
	result.Fragment = ""
	return &result, nil
}

func hardenedHTTPClient(source *http.Client) *http.Client {
	client := &http.Client{}
	if source != nil {
		*client = *source
	}
	if client.Timeout <= 0 {
		client.Timeout = 30 * time.Second
	}
	previous := client.CheckRedirect
	client.CheckRedirect = func(req *http.Request, via []*http.Request) error {
		if len(via) == 0 || !sameOrigin(via[0].URL, req.URL) {
			return errors.New("gitlab scm: unsafe redirect")
		}
		if previous != nil {
			return previous(req, via)
		}
		if len(via) >= 10 {
			return errors.New("gitlab scm: too many redirects")
		}
		return nil
	}
	return client
}

func validateBaseURL(base *url.URL) error {
	if base == nil || !base.IsAbs() || base.Host == "" || base.User != nil || base.RawQuery != "" || base.ForceQuery || base.Fragment != "" {
		return ErrInvalidBaseURL
	}
	switch strings.ToLower(base.Scheme) {
	case "https":
		return nil
	case "http":
		host := base.Hostname()
		ip := net.ParseIP(host)
		if strings.EqualFold(host, "localhost") || (ip != nil && ip.IsLoopback()) {
			return nil
		}
	}
	return ErrInvalidBaseURL
}

func (c *Client) nextPageURL(current *url.URL, header http.Header) (*url.URL, error) {
	if raw := linkNext(header.Get("Link")); raw != "" {
		next, err := current.Parse(raw)
		if err != nil || !sameOrigin(c.baseURL, next) {
			return nil, ErrInvalidPagination
		}
		return next, nil
	}
	nextPage := strings.TrimSpace(header.Get("X-Next-Page"))
	if nextPage == "" {
		return nil, nil
	}
	page, err := strconv.Atoi(nextPage)
	if err != nil || page <= 0 {
		return nil, ErrInvalidPagination
	}
	next := *current
	query := next.Query()
	query.Set("page", nextPage)
	next.RawQuery = query.Encode()
	return &next, nil
}

func linkNext(header string) string {
	for _, part := range strings.Split(header, ",") {
		part = strings.TrimSpace(part)
		if !strings.HasPrefix(part, "<") {
			continue
		}
		end := strings.Index(part, ">")
		if end < 0 {
			continue
		}
		for _, parameter := range strings.Split(part[end+1:], ";") {
			name, value, ok := strings.Cut(strings.TrimSpace(parameter), "=")
			if ok && strings.EqualFold(name, "rel") {
				for _, relation := range strings.Fields(strings.Trim(value, `"`)) {
					if strings.EqualFold(relation, "next") {
						return part[1:end]
					}
				}
			}
		}
	}
	return ""
}

func sameOrigin(base, other *url.URL) bool {
	return base != nil && other != nil && strings.EqualFold(base.Scheme, other.Scheme) && strings.EqualFold(base.Host, other.Host)
}

func readBounded(reader io.Reader, limit int64) ([]byte, error) {
	body, err := io.ReadAll(io.LimitReader(reader, limit+1))
	if err != nil {
		return nil, errors.New("gitlab scm: read response")
	}
	if int64(len(body)) > limit {
		return nil, &ResponseTooLargeError{Limit: limit}
	}
	return body, nil
}

func parseRetryAfter(raw string, now time.Time) time.Duration {
	if seconds, err := strconv.Atoi(strings.TrimSpace(raw)); err == nil && seconds >= 0 {
		return time.Duration(seconds) * time.Second
	}
	if when, err := http.ParseTime(raw); err == nil && when.After(now) {
		return when.Sub(now)
	}
	return 0
}

func isTLSError(err error) bool {
	var verificationPtr *tls.CertificateVerificationError
	var unknown x509.UnknownAuthorityError
	var hostname x509.HostnameError
	var invalid x509.CertificateInvalidError
	return errors.As(err, &verificationPtr) || errors.As(err, &unknown) ||
		errors.As(err, &hostname) || errors.As(err, &invalid)
}

func cloneValues(values url.Values) url.Values {
	cloned := make(url.Values, len(values))
	for key, entries := range values {
		cloned[key] = append([]string(nil), entries...)
	}
	return cloned
}
