package worker

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"

	cloudpostgres "github.com/aoagents/agent-orchestrator/backend/internal/cloud/postgres"
	cloudworkerhub "github.com/aoagents/agent-orchestrator/backend/internal/cloud/workerhub"
)

// BootstrapResponse contains worker credentials and the session launch specification.
type BootstrapResponse struct {
	WorkerToken string                         `json:"workerToken"`
	WorkerID    string                         `json:"workerId"`
	Epoch       int64                          `json:"epoch"`
	ExpiresIn   int                            `json:"expiresIn"`
	SessionID   string                         `json:"sessionId"`
	Launch      cloudpostgres.WorkerLaunchSpec `json:"launch"`
}

// Client communicates with the AO Cloud worker API.
type Client struct {
	baseURL string
	http    *http.Client
	mu      sync.RWMutex
	token   string
}

// NewClient creates a cloud worker API client.
func NewClient(baseURL string, client *http.Client) *Client {
	if client == nil {
		client = &http.Client{Timeout: 30 * time.Second}
	}
	return &Client{baseURL: strings.TrimRight(baseURL, "/"), http: client}
}

// Bootstrap exchanges a one-time ticket for worker credentials and launch data.
func (c *Client) Bootstrap(
	ctx context.Context,
	bootstrapToken, version string,
	capabilities []string,
) (BootstrapResponse, error) {
	var response BootstrapResponse
	err := c.do(ctx, http.MethodPost, "/api/cloud/v1/worker/bootstrap", "", map[string]any{
		"bootstrapToken": bootstrapToken,
		"version":        version,
		"capabilities":   capabilities,
	}, &response)
	if err != nil {
		return BootstrapResponse{}, err
	}
	c.setToken(response.WorkerToken)
	return response, nil
}

// Heartbeat refreshes the worker lease and authentication token.
func (c *Client) Heartbeat(ctx context.Context, version string, capabilities []string) error {
	var response struct {
		WorkerToken string `json:"workerToken"`
	}
	if err := c.do(ctx, http.MethodPost, "/api/cloud/v1/worker/heartbeat", c.getToken(), map[string]any{
		"version":      version,
		"capabilities": capabilities,
	}, &response); err != nil {
		return err
	}
	if response.WorkerToken != "" {
		c.setToken(response.WorkerToken)
	}
	return nil
}

// Event publishes a worker event to AO Cloud.
func (c *Client) Event(ctx context.Context, eventType string, payload any) error {
	return c.do(ctx, http.MethodPost, "/api/cloud/v1/worker/events", c.getToken(), map[string]any{
		"type":    eventType,
		"payload": payload,
	}, nil)
}

// RunCommandStream receives commands until the stream or handler fails.
func (c *Client) RunCommandStream(
	ctx context.Context,
	handle func(cloudworkerhub.Command) error,
) error {
	endpoint, err := url.Parse(c.baseURL)
	if err != nil {
		return fmt.Errorf("parse cloud worker URL: %w", err)
	}
	switch endpoint.Scheme {
	case "http":
		endpoint.Scheme = "ws"
	case "https":
		endpoint.Scheme = "wss"
	}
	endpoint.Path = strings.TrimRight(endpoint.Path, "/") + "/api/cloud/v1/worker/connect"
	headers := http.Header{}
	headers.Set("Authorization", "Worker "+c.getToken())
	socket, response, err := websocket.Dial(ctx, endpoint.String(), &websocket.DialOptions{
		HTTPHeader:      headers,
		CompressionMode: websocket.CompressionDisabled,
	})
	if response != nil && response.Body != nil {
		defer func() { _ = response.Body.Close() }()
	}
	if err != nil {
		return fmt.Errorf("connect worker command stream: %w", err)
	}
	defer func() { _ = socket.Close(websocket.StatusNormalClosure, "worker stopping") }()
	for {
		_, data, err := socket.Read(ctx)
		if err != nil {
			return err
		}
		var command cloudworkerhub.Command
		if err := json.Unmarshal(data, &command); err != nil {
			return fmt.Errorf("decode worker command: %w", err)
		}
		if err := handle(command); err != nil {
			return err
		}
	}
}

// SetToken replaces the worker authentication token.
func (c *Client) SetToken(token string) {
	c.setToken(token)
}

func (c *Client) do(ctx context.Context, method, path, workerToken string, input, output any) error {
	encoded, err := json.Marshal(input)
	if err != nil {
		return fmt.Errorf("encode cloud worker request: %w", err)
	}
	request, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, bytes.NewReader(encoded))
	if err != nil {
		return fmt.Errorf("build cloud worker request: %w", err)
	}
	request.Header.Set("Content-Type", "application/json")
	if workerToken != "" {
		request.Header.Set("Authorization", "Worker "+workerToken)
	}
	response, err := c.http.Do(request)
	if err != nil {
		return fmt.Errorf("send cloud worker request: %w", err)
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		payload, _ := io.ReadAll(io.LimitReader(response.Body, 64<<10))
		return fmt.Errorf("AO Cloud returned %s: %s", response.Status, strings.TrimSpace(string(payload)))
	}
	if output == nil || response.StatusCode == http.StatusNoContent {
		_, _ = io.Copy(io.Discard, response.Body)
		return nil
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(output); err != nil {
		return fmt.Errorf("decode cloud worker response: %w", err)
	}
	return nil
}

func (c *Client) setToken(token string) {
	c.mu.Lock()
	c.token = token
	c.mu.Unlock()
}

func (c *Client) getToken() string {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.token
}

// Version is the cloud worker protocol version.
const Version = "0.1.0"

// DefaultCapabilities lists the protocol features supported by this worker.
var DefaultCapabilities = []string{"pty.v1", "events.v1", "heartbeat.v1", "git.v1"}
