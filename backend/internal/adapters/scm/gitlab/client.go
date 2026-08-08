package gitlab

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

var (
	// ErrNotFound is returned when a GitLab API resource does not exist.
	ErrNotFound = ports.ErrSCMNotFound
	// ErrRateLimited is returned when GitLab responds with HTTP 429.
	ErrRateLimited = fmt.Errorf("gitlab scm: rate limited")
)

const (
	defaultRESTBaseURL = "https://gitlab.com/api/v4"
	cacheMaxEntries    = 512
	defaultUserAgent   = "ao-gitlab-scm/1"
)

// RESTResponse is the normalised result of a GitLab REST call.
type RESTResponse struct {
	StatusCode  int
	NotModified bool
	ETag        string
	Body        []byte
}

// ClientOptions configures the GitLab HTTP client.
type ClientOptions struct {
	HTTPClient *http.Client
	Token      TokenSource
	RESTBase   string
	UserAgent  string
}

// Client wraps the GitLab REST API v4. It handles auth, ETag caching, and
// error classification.
type Client struct {
	http      *http.Client
	tokens    TokenSource
	restBase  string
	userAgent string

	mu       sync.Mutex
	etagOut  map[string]string
	bodyOut  map[string][]byte
	cacheLRU []string
}

// NewClient creates a new GitLab REST client.
func NewClient(opts ClientOptions) *Client {
	hc := opts.HTTPClient
	if hc == nil {
		hc = http.DefaultClient
	}
	base := opts.RESTBase
	if base == "" {
		base = defaultRESTBaseURL
	}
	base = strings.TrimRight(base, "/")
	ua := opts.UserAgent
	if ua == "" {
		ua = defaultUserAgent
	}
	return &Client{
		http:      hc,
		tokens:    opts.Token,
		restBase:  base,
		userAgent: ua,
		etagOut:   make(map[string]string, cacheMaxEntries),
		bodyOut:   make(map[string][]byte, cacheMaxEntries),
	}
}

// doRESTWithETag performs a GET with an externally-managed ETag. It does NOT
// use the client's internal cache (the observer manages its own ETags).
func (c *Client) doRESTWithETag(ctx context.Context, path string, q url.Values, etag string) (RESTResponse, error) {
	u := c.restURL(path, q)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, http.NoBody)
	if err != nil {
		return RESTResponse{}, err
	}
	if err := c.authorize(ctx, req); err != nil {
		return RESTResponse{}, err
	}
	req.Header.Set("User-Agent", c.userAgent)
	if etag != "" {
		req.Header.Set("If-None-Match", etag)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return RESTResponse{}, err
	}
	defer func() { _ = resp.Body.Close() }()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode == http.StatusNotModified {
		return RESTResponse{StatusCode: 304, NotModified: true, ETag: etag}, nil
	}
	if resp.StatusCode >= 400 {
		return RESTResponse{StatusCode: resp.StatusCode}, classifyError(resp, body)
	}
	return RESTResponse{
		StatusCode: resp.StatusCode,
		ETag:       resp.Header.Get("ETag"),
		Body:       body,
	}, nil
}

// doGET performs a GET request using the client's internal ETag cache.
func (c *Client) doGET(ctx context.Context, path string, q url.Values) (RESTResponse, error) {
	u := c.restURL(path, q)
	cacheKey := u
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, http.NoBody)
	if err != nil {
		return RESTResponse{}, err
	}
	if err := c.authorize(ctx, req); err != nil {
		return RESTResponse{}, err
	}
	req.Header.Set("User-Agent", c.userAgent)

	c.mu.Lock()
	if etag, ok := c.etagOut[cacheKey]; ok {
		req.Header.Set("If-None-Match", etag)
	}
	c.mu.Unlock()

	resp, err := c.http.Do(req)
	if err != nil {
		return RESTResponse{}, err
	}
	defer func() { _ = resp.Body.Close() }()
	body, _ := io.ReadAll(resp.Body)

	if resp.StatusCode == http.StatusNotModified {
		c.mu.Lock()
		cached := c.bodyOut[cacheKey]
		c.mu.Unlock()
		return RESTResponse{StatusCode: 200, NotModified: true, ETag: resp.Header.Get("ETag"), Body: cached}, nil
	}
	if resp.StatusCode >= 400 {
		return RESTResponse{StatusCode: resp.StatusCode}, classifyError(resp, body)
	}
	if etag := resp.Header.Get("ETag"); etag != "" {
		c.storeCacheEntry(cacheKey, etag, body)
	}
	return RESTResponse{
		StatusCode: resp.StatusCode,
		ETag:       resp.Header.Get("ETag"),
		Body:       body,
	}, nil
}

// doGETRaw performs a GET and returns the raw body bytes (e.g. job trace).
func (c *Client) doGETRaw(ctx context.Context, path string, q url.Values) ([]byte, error) {
	u := c.restURL(path, q)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, http.NoBody)
	if err != nil {
		return nil, err
	}
	if err := c.authorize(ctx, req); err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", c.userAgent)
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 400 {
		return nil, classifyError(resp, body)
	}
	return body, nil
}

func (c *Client) storeCacheEntry(cacheKey, etag string, body []byte) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.etagOut[cacheKey] = etag
	c.bodyOut[cacheKey] = body
	c.cacheLRU = append(c.cacheLRU, cacheKey)
	for len(c.cacheLRU) > cacheMaxEntries {
		evict := c.cacheLRU[0]
		c.cacheLRU = c.cacheLRU[1:]
		delete(c.etagOut, evict)
		delete(c.bodyOut, evict)
	}
}

func (c *Client) authorize(ctx context.Context, req *http.Request) error {
	if c.tokens == nil {
		return nil
	}
	tok, err := c.tokens.Token(ctx)
	if err != nil {
		return err
	}
	// Use Authorization: Bearer instead of PRIVATE-TOKEN because Bearer works
	// for both OAuth2 tokens (from `glab auth login` OAuth flow) and personal
	// access tokens, while PRIVATE-TOKEN only works with personal access tokens.
	req.Header.Set("Authorization", "Bearer "+tok)
	return nil
}

func (c *Client) restURL(path string, q url.Values) string {
	u := c.restBase + path
	if len(q) > 0 {
		u += "?" + q.Encode()
	}
	return u
}

func classifyError(resp *http.Response, body []byte) error {
	switch resp.StatusCode {
	case http.StatusNotFound:
		return ErrNotFound
	case http.StatusUnauthorized, http.StatusForbidden:
		return ErrAuthFailed
	case http.StatusTooManyRequests:
		return ErrRateLimited
	default:
		msg := gitlabMessage(body)
		if msg == "" {
			msg = resp.Status
		}
		return fmt.Errorf("gitlab scm: %s", msg)
	}
}

func gitlabMessage(body []byte) string {
	var v struct {
		Message string `json:"message"`
		Error   string `json:"error"`
	}
	if json.Unmarshal(body, &v) == nil {
		if v.Message != "" {
			return v.Message
		}
		return v.Error
	}
	return ""
}

// projectPath encodes owner/name for GitLab API URL path segments.
func projectPath(owner, name string) string {
	return url.PathEscape(owner + "/" + name)
}
