// Package cloud provisions and supervises per-session cloud sandboxes (Daytona)
// so a worker agent can run remotely instead of locally, survive laptop/app
// shutdown, and be shared read-only with a teammate.
//
// Daytona ships no Go SDK, so this file is a thin REST client over the Daytona
// API. The contract mirrors the TypeScript @daytona/sdk calls the rest of the
// project already relies on (create / exec / upload / signed-preview-url).
//
// Security: the API key is read from the environment by the caller and passed
// in here; it is never logged and never written into a sandbox.
package cloud

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// DefaultDaytonaBaseURL is the Daytona SaaS API root. Overridable for tests.
const DefaultDaytonaBaseURL = "https://app.daytona.io/api"

// DaytonaClient is a minimal REST client for the subset of the Daytona API the
// cloud supervisor needs. It is safe for concurrent use.
type DaytonaClient struct {
	apiKey  string
	baseURL string
	http    *http.Client
}

// NewDaytonaClient builds a client from an API key (never logged). baseURL may
// be empty to use the SaaS default.
func NewDaytonaClient(apiKey, baseURL string) *DaytonaClient {
	if baseURL == "" {
		baseURL = DefaultDaytonaBaseURL
	}
	return &DaytonaClient{
		apiKey:  apiKey,
		baseURL: strings.TrimRight(baseURL, "/"),
		// Generous: a single call may be a ~50MB binary upload or a synchronous
		// apt-install exec that blocks server-side. Provisioning is bounded by the
		// caller's context + per-exec timeouts, not this blunt cap.
		http: &http.Client{Timeout: 300 * time.Second},
	}
}

// Name identifies this provider (SandboxProvider).
func (c *DaytonaClient) Name() string { return "daytona" }

// Sandbox is the subset of Daytona's sandbox object we care about.
type Sandbox struct {
	ID    string `json:"id"`
	State string `json:"state"`
	// ToolboxProxyURL is the base for THIS sandbox's toolbox (exec/files) calls,
	// e.g. https://proxy.app.daytona.io/toolbox — a runner proxy distinct from the
	// app API. Toolbox requests go to {ToolboxProxyURL}/{ID}/<op>.
	ToolboxProxyURL string `json:"toolboxProxyUrl"`
}

// toolboxBase is the per-sandbox base URL for toolbox operations.
func (s Sandbox) toolboxBase() string {
	return strings.TrimRight(s.ToolboxProxyURL, "/") + "/" + s.ID
}

// Running reports whether the sandbox is started/running (Daytona uses states
// like "started", "running"). Stopped/archived states need a Start() first.
func (s Sandbox) Running() bool {
	st := strings.ToLower(s.State)
	return strings.Contains(st, "start") || strings.Contains(st, "run")
}

// Stopped reports a stopped/archived sandbox that must be started before use.
func (s Sandbox) Stopped() bool {
	st := strings.ToLower(s.State)
	return strings.Contains(st, "stop") || strings.Contains(st, "archiv")
}

// CreateSandboxRequest is the POST /sandbox body (subset).
type CreateSandboxRequest struct {
	Snapshot string            `json:"snapshot,omitempty"`
	Env      map[string]string `json:"env,omitempty"`
	Labels   map[string]string `json:"labels,omitempty"`
	// DomainAllowList is a comma-separated egress allowlist (hostnames, wildcards
	// via a leading "*", max 20). When set it REPLACES Daytona's curated default,
	// so it must enumerate every host the sandbox needs. Empty ⇒ Daytona default.
	DomainAllowList    string `json:"domainAllowList,omitempty"`
	AutoStopInterval   *int   `json:"autoStopInterval,omitempty"`
	AutoDeleteInterval *int   `json:"autoDeleteInterval,omitempty"`
}

// Create provisions a new sandbox (POST /sandbox).
func (c *DaytonaClient) Create(ctx context.Context, req CreateSandboxRequest) (*Sandbox, error) {
	var out Sandbox
	if err := c.doJSON(ctx, http.MethodPost, "/sandbox", req, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Get fetches a sandbox by id (GET /sandbox/{id}).
func (c *DaytonaClient) Get(ctx context.Context, id string) (*Sandbox, error) {
	var out Sandbox
	if err := c.doJSON(ctx, http.MethodGet, "/sandbox/"+url.PathEscape(id), nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Start starts a stopped/archived sandbox (POST /sandbox/{id}/start).
func (c *DaytonaClient) Start(ctx context.Context, id string) error {
	return c.doJSON(ctx, http.MethodPost, "/sandbox/"+url.PathEscape(id)+"/start", nil, nil)
}

// Delete tears a sandbox down (DELETE /sandbox/{id}?force=true).
func (c *DaytonaClient) Delete(ctx context.Context, id string) error {
	return c.doJSON(ctx, http.MethodDelete, "/sandbox/"+url.PathEscape(id)+"?force=true", nil, nil)
}

// List returns all sandboxes (GET /sandbox). Daytona may return either a bare
// array or an {items:[...]} envelope, so both are accepted.
func (c *DaytonaClient) List(ctx context.Context) ([]Sandbox, error) {
	raw, err := c.do(ctx, http.MethodGet, "/sandbox", nil, "")
	if err != nil {
		return nil, err
	}
	var arr []Sandbox
	if err := json.Unmarshal(raw, &arr); err == nil {
		return arr, nil
	}
	var env struct {
		Items []Sandbox `json:"items"`
	}
	if err := json.Unmarshal(raw, &env); err != nil {
		return nil, fmt.Errorf("cloud: decode sandbox list: %w", err)
	}
	return env.Items, nil
}

// ExecuteRequest is the toolbox process/execute body.
type ExecuteRequest struct {
	Command string `json:"command"`
	Cwd     string `json:"cwd,omitempty"`
	Timeout int    `json:"timeout,omitempty"` // seconds
}

// ExecuteResponse is the toolbox process/execute result.
type ExecuteResponse struct {
	ExitCode int    `json:"exitCode"`
	Result   string `json:"result"`
}

// Exec runs a command synchronously inside the sandbox via its toolbox proxy
// (POST {toolboxProxyUrl}/{id}/process/execute).
func (c *DaytonaClient) Exec(ctx context.Context, box Sandbox, req ExecuteRequest) (*ExecuteResponse, error) {
	buf, err := json.Marshal(req)
	if err != nil {
		return nil, err
	}
	raw, err := c.doAbs(ctx, http.MethodPost, box.toolboxBase()+"/process/execute", bytes.NewReader(buf), "application/json")
	if err != nil {
		return nil, err
	}
	var out ExecuteResponse
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// UploadFile writes data to remotePath inside the sandbox via its toolbox proxy
// (POST {toolboxProxyUrl}/{id}/files/upload?path=..., multipart field "file").
func (c *DaytonaClient) UploadFile(ctx context.Context, box Sandbox, remotePath string, data []byte) error {
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	part, err := mw.CreateFormFile("file", "upload")
	if err != nil {
		return err
	}
	if _, err := part.Write(data); err != nil {
		return err
	}
	if err := mw.Close(); err != nil {
		return err
	}
	dst := box.toolboxBase() + "/files/upload?path=" + url.QueryEscape(remotePath)
	_, err = c.doAbs(ctx, http.MethodPost, dst, &body, mw.FormDataContentType())
	return err
}

// SignedPreviewURL is the browser-usable preview link (token embedded in URL).
type SignedPreviewURL struct {
	SandboxID string `json:"sandboxId"`
	Port      int    `json:"port"`
	Token     string `json:"token"`
	URL       string `json:"url"`
}

// SignedPreview mints a signed, browser-usable preview URL for a port. The token
// is embedded in the returned URL, so fetch/WebSocket/SSE reach it with no custom
// header — that is why we use the SIGNED variant, not /preview-url.
func (c *DaytonaClient) SignedPreview(ctx context.Context, id string, port, ttlSeconds int) (*SignedPreviewURL, error) {
	path := fmt.Sprintf("/sandbox/%s/ports/%d/signed-preview-url?expiresInSeconds=%d",
		url.PathEscape(id), port, ttlSeconds)
	var out SignedPreviewURL
	if err := c.doJSON(ctx, http.MethodGet, path, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// doJSON sends an optional JSON body and decodes an optional JSON response.
func (c *DaytonaClient) doJSON(ctx context.Context, method, path string, in, out any) error {
	var body io.Reader
	contentType := ""
	if in != nil {
		buf, err := json.Marshal(in)
		if err != nil {
			return err
		}
		body = bytes.NewReader(buf)
		contentType = "application/json"
	}
	raw, err := c.do(ctx, method, path, body, contentType)
	if err != nil {
		return err
	}
	if out == nil || len(bytes.TrimSpace(raw)) == 0 {
		return nil
	}
	return json.Unmarshal(raw, out)
}

// do performs an authenticated request against the app API base + path.
func (c *DaytonaClient) do(ctx context.Context, method, path string, body io.Reader, contentType string) ([]byte, error) {
	return c.doAbs(ctx, method, c.baseURL+path, body, contentType)
}

// doAbs performs an authenticated request to an ABSOLUTE url (used for toolbox
// calls, which target a per-sandbox proxy host rather than the app API base),
// returning the raw body and turning any non-2xx into an error. The API key is
// sent as a bearer token and never logged.
func (c *DaytonaClient) doAbs(ctx context.Context, method, absURL string, body io.Reader, contentType string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, method, absURL, body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+c.apiKey)
	req.Header.Set("Accept", "application/json")
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("cloud: %s %s: %w", method, redactPath(absURL), err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("cloud: %s %s -> %d: %s", method, redactPath(absURL), resp.StatusCode, truncate(raw, 300))
	}
	return raw, nil
}

// redactPath strips a query string so a signed-preview token never lands in an
// error/log line.
func redactPath(path string) string {
	if i := strings.IndexByte(path, '?'); i >= 0 {
		return path[:i]
	}
	return path
}

func truncate(b []byte, n int) string {
	if len(b) <= n {
		return string(b)
	}
	return string(b[:n])
}
