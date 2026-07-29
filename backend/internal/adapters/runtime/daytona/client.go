package daytona

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"

	"github.com/coder/websocket"
)

// SandboxState is Daytona's sandbox state enum (the subset the adapter
// branches on; unknown values flow through unmodified).
type SandboxState string

const (
	StateCreating        SandboxState = "creating"
	StateStarting        SandboxState = "starting"
	StateStarted         SandboxState = "started"
	StateStopping        SandboxState = "stopping"
	StateStopped         SandboxState = "stopped"
	StateRestoring       SandboxState = "restoring"
	StateResuming        SandboxState = "resuming"
	StatePullingSnapshot SandboxState = "pulling_snapshot"
	StateArchiving       SandboxState = "archiving"
	StateArchived        SandboxState = "archived"
	StateError           SandboxState = "error"
	StateBuildFailed     SandboxState = "build_failed"
	StateDestroying      SandboxState = "destroying"
	StateDestroyed       SandboxState = "destroyed"
)

// Transitional reports whether the state is on its way to a steady state, so
// pollers keep waiting instead of failing.
func (s SandboxState) Transitional() bool {
	switch s {
	case StateCreating, StateStarting, StateStopping, StateRestoring,
		StateResuming, StatePullingSnapshot, StateArchiving, StateDestroying:
		return true
	}
	return false
}

// Sandbox is the subset of Daytona's sandbox object the adapter uses.
type Sandbox struct {
	ID     string            `json:"id"`
	Name   string            `json:"name"`
	State  SandboxState      `json:"state"`
	Labels map[string]string `json:"labels"`
	// ToolboxProxyURL is the base for the per-sandbox toolbox API; requests go
	// to {ToolboxProxyURL}/{ID}/... with the same bearer key.
	ToolboxProxyURL string `json:"toolboxProxyUrl"`
	ErrorReason     string `json:"errorReason"`
}

// CreateSandboxRequest mirrors Daytona's CreateSandbox body (fields we use).
type CreateSandboxRequest struct {
	Name     string            `json:"name,omitempty"`
	Snapshot string            `json:"snapshot,omitempty"`
	Env      map[string]string `json:"env,omitempty"`
	Labels   map[string]string `json:"labels,omitempty"`
	Target   string            `json:"target,omitempty"`
	CPU      int               `json:"cpu,omitempty"`
	Memory   int               `json:"memory,omitempty"`
	Disk     int               `json:"disk,omitempty"`
	// AutoStopInterval is minutes without activity before Daytona stops the
	// sandbox (0 disables). Stopping kills processes but preserves the disk —
	// this is the park mechanism in the cost model.
	AutoStopInterval    *int `json:"autoStopInterval,omitempty"`
	AutoArchiveInterval *int `json:"autoArchiveInterval,omitempty"`
	AutoDeleteInterval  *int `json:"autoDeleteInterval,omitempty"`
}

// ExecRequest is one toolbox `POST /process/execute` call: a shell command run
// inside the sandbox.
type ExecRequest struct {
	Command string `json:"command"`
	Cwd     string `json:"cwd,omitempty"`
	// TimeoutSeconds bounds the command inside the sandbox (Daytona defaults to
	// 10s when zero).
	TimeoutSeconds int `json:"timeout,omitempty"`
}

// ExecResult carries the command's combined output and exit code.
type ExecResult struct {
	ExitCode int    `json:"exitCode"`
	Result   string `json:"result"`
}

// PTYSpec asks the toolbox for a fresh interactive PTY (the sandbox user's
// shell; Daytona's PTY create takes no command).
type PTYSpec struct {
	ID   string
	Cwd  string
	Rows uint16
	Cols uint16
}

// PTYConn is one live PTY WebSocket: Read yields terminal output bytes, Write
// sends input bytes, Resize resizes the remote PTY, Close tears down the
// connection AND deletes the PTY session in the sandbox.
type PTYConn interface {
	io.ReadWriteCloser
	Resize(rows, cols uint16) error
}

// Client is the adapter's seam onto Daytona. The production implementation is
// apiClient (thin REST); tests substitute a fake.
type Client interface {
	CreateSandbox(ctx context.Context, req CreateSandboxRequest) (Sandbox, error)
	// GetSandbox returns ErrSandboxNotFound (wrapped) when no sandbox has that id.
	GetSandbox(ctx context.Context, id string) (Sandbox, error)
	// ListSandboxes returns sandboxes carrying every given label.
	ListSandboxes(ctx context.Context, labels map[string]string) ([]Sandbox, error)
	StartSandbox(ctx context.Context, id string) error
	StopSandbox(ctx context.Context, id string) error
	DeleteSandbox(ctx context.Context, id string) error
	// Exec runs a shell command in the sandbox via the toolbox API. A non-zero
	// exit code is returned in ExecResult with err == nil; err reports
	// transport/API failures only, so callers can tell "command failed"
	// (definitive) from "probe failed" (inconclusive).
	Exec(ctx context.Context, sandboxID string, req ExecRequest) (ExecResult, error)
	// OpenPTY creates a PTY session in the sandbox and dials its WebSocket.
	OpenPTY(ctx context.Context, sandboxID string, spec PTYSpec) (PTYConn, error)
	// GitClone clones a repository inside the sandbox via the toolbox git API
	// (credentials travel in the request body, never on a command line).
	GitClone(ctx context.Context, sandboxID string, req GitCloneRequest) error
}

// GitCloneRequest mirrors the toolbox `POST /git/clone` body (fields we use).
type GitCloneRequest struct {
	URL      string `json:"url"`
	Path     string `json:"path"`
	Branch   string `json:"branch,omitempty"`
	Username string `json:"username,omitempty"`
	Password string `json:"password,omitempty"`
}

// ErrSandboxNotFound reports a sandbox id/name Daytona does not know (404) —
// a definitive "gone", distinct from transport failures.
var ErrSandboxNotFound = errors.New("daytona: sandbox not found")

// DefaultAPIURL is Daytona's public platform API base.
const DefaultAPIURL = "https://app.daytona.io/api"

// ClientOptions configures the REST client. APIKey is required; APIURL
// defaults to DefaultAPIURL; HTTPClient defaults to http.DefaultClient.
type ClientOptions struct {
	APIKey     string
	APIURL     string
	HTTPClient *http.Client
}

// NewClient builds the production REST client for Daytona's platform and
// toolbox APIs.
func NewClient(opts ClientOptions) (*apiClient, error) {
	if strings.TrimSpace(opts.APIKey) == "" {
		return nil, errors.New("daytona: api key is required")
	}
	base := strings.TrimRight(opts.APIURL, "/")
	if base == "" {
		base = DefaultAPIURL
	}
	httpClient := opts.HTTPClient
	if httpClient == nil {
		httpClient = http.DefaultClient
	}
	return &apiClient{apiURL: base, apiKey: opts.APIKey, http: httpClient}, nil
}

// apiClient is the thin REST implementation of Client.
type apiClient struct {
	apiURL string
	apiKey string
	http   *http.Client
}

var _ Client = (*apiClient)(nil)

// apiError is a non-2xx platform/toolbox response.
type apiError struct {
	Status int
	Body   string
}

func (e *apiError) Error() string {
	body := e.Body
	if len(body) > 512 {
		body = body[:512] + "…"
	}
	return fmt.Sprintf("daytona: HTTP %d: %s", e.Status, body)
}

func (c *apiClient) do(ctx context.Context, method, urlStr string, body, out any) error {
	var reader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("daytona: marshal request: %w", err)
		}
		reader = bytes.NewReader(data)
	}
	req, err := http.NewRequestWithContext(ctx, method, urlStr, reader)
	if err != nil {
		return fmt.Errorf("daytona: build request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+c.apiKey)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("daytona: %s %s: %w", method, urlStr, err)
	}
	defer func() { _ = resp.Body.Close() }()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return fmt.Errorf("daytona: read response: %w", err)
	}
	if resp.StatusCode == http.StatusNotFound {
		return fmt.Errorf("%w: %s %s", ErrSandboxNotFound, method, urlStr)
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return &apiError{Status: resp.StatusCode, Body: string(data)}
	}
	if out != nil && len(data) > 0 {
		if err := json.Unmarshal(data, out); err != nil {
			return fmt.Errorf("daytona: decode response: %w", err)
		}
	}
	return nil
}

func (c *apiClient) platformURL(parts ...string) string {
	escaped := make([]string, len(parts))
	for i, p := range parts {
		escaped[i] = url.PathEscape(p)
	}
	return c.apiURL + "/" + strings.Join(escaped, "/")
}

func (c *apiClient) CreateSandbox(ctx context.Context, req CreateSandboxRequest) (Sandbox, error) {
	var sb Sandbox
	err := c.do(ctx, http.MethodPost, c.platformURL("sandbox"), req, &sb)
	return sb, err
}

func (c *apiClient) GetSandbox(ctx context.Context, id string) (Sandbox, error) {
	var sb Sandbox
	err := c.do(ctx, http.MethodGet, c.platformURL("sandbox", id), nil, &sb)
	return sb, err
}

// ListSandboxes filters by labels using the platform list endpoint's
// JSON-encoded `labels` query parameter.
func (c *apiClient) ListSandboxes(ctx context.Context, labels map[string]string) ([]Sandbox, error) {
	u := c.platformURL("sandbox")
	if len(labels) > 0 {
		encoded, err := json.Marshal(labels)
		if err != nil {
			return nil, fmt.Errorf("daytona: encode labels: %w", err)
		}
		u += "?labels=" + url.QueryEscape(string(encoded))
	}
	// The list endpoint may respond either with a bare array or a paginated
	// {items: []} envelope depending on API version; accept both.
	var raw json.RawMessage
	if err := c.do(ctx, http.MethodGet, u, nil, &raw); err != nil {
		return nil, err
	}
	var list []Sandbox
	if err := json.Unmarshal(raw, &list); err == nil {
		return list, nil
	}
	var envelope struct {
		Items []Sandbox `json:"items"`
	}
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return nil, fmt.Errorf("daytona: decode sandbox list: %w", err)
	}
	return envelope.Items, nil
}

func (c *apiClient) StartSandbox(ctx context.Context, id string) error {
	return c.do(ctx, http.MethodPost, c.platformURL("sandbox", id, "start"), nil, nil)
}

func (c *apiClient) StopSandbox(ctx context.Context, id string) error {
	return c.do(ctx, http.MethodPost, c.platformURL("sandbox", id, "stop"), nil, nil)
}

func (c *apiClient) DeleteSandbox(ctx context.Context, id string) error {
	return c.do(ctx, http.MethodDelete, c.platformURL("sandbox", id), nil, nil)
}

// toolboxURL resolves the sandbox's toolbox base ({toolboxProxyUrl}/{id})
// and appends the path parts.
func (c *apiClient) toolboxURL(ctx context.Context, sandboxID string, parts ...string) (string, error) {
	sb, err := c.GetSandbox(ctx, sandboxID)
	if err != nil {
		return "", err
	}
	if sb.ToolboxProxyURL == "" {
		return "", fmt.Errorf("daytona: sandbox %s has no toolbox proxy url", sandboxID)
	}
	base := strings.TrimRight(sb.ToolboxProxyURL, "/") + "/" + url.PathEscape(sb.ID)
	for _, p := range parts {
		base += "/" + p
	}
	return base, nil
}

func (c *apiClient) Exec(ctx context.Context, sandboxID string, req ExecRequest) (ExecResult, error) {
	u, err := c.toolboxURL(ctx, sandboxID, "process", "execute")
	if err != nil {
		return ExecResult{}, err
	}
	var res ExecResult
	if err := c.do(ctx, http.MethodPost, u, req, &res); err != nil {
		return ExecResult{}, err
	}
	return res, nil
}

func (c *apiClient) GitClone(ctx context.Context, sandboxID string, req GitCloneRequest) error {
	u, err := c.toolboxURL(ctx, sandboxID, "git", "clone")
	if err != nil {
		return err
	}
	return c.do(ctx, http.MethodPost, u, req, nil)
}

// ptyExitControlSubprotocol asks Daytona's PTY WebSocket to send a JSON
// control frame carrying the exit code when the PTY process ends.
const ptyExitControlSubprotocol = "X-Daytona-Pty-Exit-Control"

func (c *apiClient) OpenPTY(ctx context.Context, sandboxID string, spec PTYSpec) (PTYConn, error) {
	createURL, err := c.toolboxURL(ctx, sandboxID, "process", "pty")
	if err != nil {
		return nil, err
	}
	createBody := map[string]any{
		"id":   spec.ID,
		"cols": int(spec.Cols),
		"rows": int(spec.Rows),
	}
	if spec.Cwd != "" {
		createBody["cwd"] = spec.Cwd
	}
	var created struct {
		SessionID string `json:"sessionId"`
	}
	if err := c.do(ctx, http.MethodPost, createURL, createBody, &created); err != nil {
		return nil, err
	}
	sessionID := created.SessionID
	if sessionID == "" {
		sessionID = spec.ID
	}

	connectURL, err := c.toolboxURL(ctx, sandboxID, "process", "pty", url.PathEscape(sessionID), "connect")
	if err != nil {
		return nil, err
	}
	wsURL := strings.Replace(strings.Replace(connectURL, "https://", "wss://", 1), "http://", "ws://", 1)
	//nolint:bodyclose // coder/websocket owns the hijacked connection; resp body is drained internally.
	conn, _, err := websocket.Dial(ctx, wsURL, &websocket.DialOptions{
		HTTPClient:   c.http,
		HTTPHeader:   http.Header{"Authorization": {"Bearer " + c.apiKey}},
		Subprotocols: []string{ptyExitControlSubprotocol},
	})
	if err != nil {
		c.deletePTY(ctx, sandboxID, sessionID)
		return nil, fmt.Errorf("daytona: dial pty %s: %w", sessionID, err)
	}
	// Terminal streams are unbounded; do not cap reads at the library default.
	conn.SetReadLimit(-1)
	return &ptyConn{
		client:    c,
		sandboxID: sandboxID,
		sessionID: sessionID,
		conn:      conn,
	}, nil
}

// deletePTY best-effort removes a PTY session; failures are dropped (the
// sandbox reaps dead PTYs with the process tree).
func (c *apiClient) deletePTY(ctx context.Context, sandboxID, sessionID string) {
	u, err := c.toolboxURL(ctx, sandboxID, "process", "pty", url.PathEscape(sessionID))
	if err != nil {
		return
	}
	_ = c.do(ctx, http.MethodDelete, u, nil, nil)
}

// ptyConn adapts the Daytona PTY WebSocket to PTYConn. Binary frames carry
// terminal bytes in both directions; JSON text control frames
// ({type:"control", status:"connected"|"exited"}) are consumed internally.
type ptyConn struct {
	client    *apiClient
	sandboxID string
	sessionID string
	conn      *websocket.Conn
	// buf holds the unread tail of the last frame.
	buf []byte
}

var _ PTYConn = (*ptyConn)(nil)

func (p *ptyConn) Read(b []byte) (int, error) {
	for len(p.buf) == 0 {
		typ, data, err := p.conn.Read(context.Background())
		if err != nil {
			status := websocket.CloseStatus(err)
			if status == websocket.StatusNormalClosure || status == websocket.StatusGoingAway {
				return 0, io.EOF
			}
			return 0, err
		}
		if typ == websocket.MessageText && isControlFrame(data) {
			var ctrl struct {
				Status string `json:"status"`
			}
			if json.Unmarshal(data, &ctrl) == nil && ctrl.Status == "exited" {
				return 0, io.EOF
			}
			continue
		}
		p.buf = data
	}
	n := copy(b, p.buf)
	p.buf = p.buf[n:]
	return n, nil
}

// isControlFrame reports whether a text frame is a Daytona control message
// rather than terminal output that happened to arrive as text.
func isControlFrame(data []byte) bool {
	var ctrl struct {
		Type string `json:"type"`
	}
	return json.Unmarshal(data, &ctrl) == nil && ctrl.Type == "control"
}

func (p *ptyConn) Write(b []byte) (int, error) {
	if err := p.conn.Write(context.Background(), websocket.MessageBinary, b); err != nil {
		return 0, err
	}
	return len(b), nil
}

func (p *ptyConn) Resize(rows, cols uint16) error {
	ctx, cancel := context.WithTimeout(context.Background(), resizeTimeout)
	defer cancel()
	u, err := p.client.toolboxURL(ctx, p.sandboxID, "process", "pty", url.PathEscape(p.sessionID), "resize")
	if err != nil {
		return err
	}
	body := map[string]int{"rows": int(rows), "cols": int(cols)}
	return p.client.do(ctx, http.MethodPost, u, body, nil)
}

func (p *ptyConn) Close() error {
	err := p.conn.Close(websocket.StatusNormalClosure, "detach")
	ctx, cancel := context.WithTimeout(context.Background(), resizeTimeout)
	defer cancel()
	p.client.deletePTY(ctx, p.sandboxID, p.sessionID)
	return err
}
