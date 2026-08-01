// Package daytona implements AO's provider-neutral sandbox lifecycle using the
// Daytona platform API. No Daytona type escapes this package.
package daytona

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/url"
	"path/filepath"
	"sort"
	"strings"
	"time"

	clouddomain "github.com/aoagents/agent-orchestrator/backend/internal/cloud/domain"
	cloudsandbox "github.com/aoagents/agent-orchestrator/backend/internal/cloud/sandbox"
)

// Client implements sandbox lifecycle operations through the Daytona API.
type Client struct {
	baseURL    string
	toolboxURL string
	apiKey     string
	target     string
	client     *http.Client
}

var _ cloudsandbox.Provider = (*Client)(nil)
var _ cloudsandbox.Recreator = (*Client)(nil)

// New creates a Daytona sandbox client.
func New(baseURL, apiKey, target string, client *http.Client) *Client {
	if client == nil {
		client = &http.Client{Timeout: 2 * time.Minute}
	}
	return &Client{
		baseURL:    strings.TrimRight(baseURL, "/"),
		toolboxURL: "https://proxy.app.daytona.io/toolbox",
		apiKey:     apiKey,
		target:     target,
		client:     client,
	}
}

// WithToolboxURL overrides the Daytona Toolbox endpoint and returns c.
func (c *Client) WithToolboxURL(toolboxURL string) *Client {
	c.toolboxURL = strings.TrimRight(toolboxURL, "/")
	return c
}

type sandboxResponse struct {
	ID           string            `json:"id"`
	Name         string            `json:"name"`
	State        string            `json:"state"`
	DesiredState string            `json:"desiredState"`
	Target       string            `json:"target"`
	CPU          int               `json:"cpu"`
	Memory       int               `json:"memory"`
	Disk         int               `json:"disk"`
	Labels       map[string]string `json:"labels"`
}

// Create provisions a sandbox from spec.
func (c *Client) Create(ctx context.Context, spec cloudsandbox.Spec) (cloudsandbox.Environment, error) {
	body := map[string]any{
		"name":               spec.Name,
		"target":             c.target,
		"env":                spec.Environment,
		"labels":             spec.Labels,
		"public":             false,
		"autoStopInterval":   spec.AutoStopMinutes,
		"autoDeleteInterval": spec.AutoDeleteMinutes,
	}
	if spec.Snapshot != "" {
		body["snapshot"] = spec.Snapshot
	} else {
		image := spec.Image
		if image == "" {
			image = "ubuntu:22.04"
		}
		body["image"] = image
		body["cpu"] = spec.ResourceProfile.CPU
		body["memory"] = spec.ResourceProfile.Memory
		body["disk"] = spec.ResourceProfile.Disk
	}
	var response sandboxResponse
	if err := c.doJSON(ctx, http.MethodPost, "/sandbox", body, &response); err != nil {
		return cloudsandbox.Environment{}, fmt.Errorf("create Daytona sandbox: %w", err)
	}
	return toEnvironment(response), nil
}

// Get returns the current state of a sandbox.
func (c *Client) Get(ctx context.Context, id cloudsandbox.ID) (cloudsandbox.Environment, error) {
	var response sandboxResponse
	if err := c.doJSON(ctx, http.MethodGet, sandboxPath(id), nil, &response); err != nil {
		return cloudsandbox.Environment{}, fmt.Errorf("get Daytona sandbox: %w", err)
	}
	return toEnvironment(response), nil
}

// FindBySession finds the sandbox labeled for a cloud session.
func (c *Client) FindBySession(
	ctx context.Context,
	sessionID clouddomain.SessionID,
) (cloudsandbox.Environment, bool, error) {
	var response struct {
		Items []sandboxResponse `json:"items"`
	}
	if err := c.doJSON(ctx, http.MethodGet, "/sandbox", nil, &response); err != nil {
		return cloudsandbox.Environment{}, false, fmt.Errorf("list Daytona sandboxes: %w", err)
	}
	for _, candidate := range response.Items {
		if candidate.Labels["ao.session_id"] == string(sessionID) {
			return toEnvironment(candidate), true, nil
		}
	}
	return cloudsandbox.Environment{}, false, nil
}

// Validate checks that the configured Daytona credentials can list sandboxes.
func (c *Client) Validate(ctx context.Context) error {
	var response struct {
		Items []sandboxResponse `json:"items"`
	}
	if err := c.doJSON(ctx, http.MethodGet, "/sandbox", nil, &response); err != nil {
		return fmt.Errorf("validate Daytona connection: %w", err)
	}
	return nil
}

// Start starts a stopped sandbox.
func (c *Client) Start(ctx context.Context, id cloudsandbox.ID) error {
	return c.lifecycle(ctx, id, "start")
}

// Stop stops a running sandbox.
func (c *Client) Stop(ctx context.Context, id cloudsandbox.ID) error {
	return c.lifecycle(ctx, id, "stop")
}

// Pause pauses a running sandbox.
func (c *Client) Pause(ctx context.Context, id cloudsandbox.ID) error {
	return c.lifecycle(ctx, id, "pause")
}

// Resume resumes a paused sandbox.
func (c *Client) Resume(ctx context.Context, id cloudsandbox.ID) error {
	return c.lifecycle(ctx, id, "resume")
}

// Delete removes a sandbox.
func (c *Client) Delete(ctx context.Context, id cloudsandbox.ID) error {
	if err := c.doJSON(ctx, http.MethodDelete, sandboxPath(id), nil, nil); err != nil {
		return fmt.Errorf("delete Daytona sandbox: %w", err)
	}
	return nil
}

// Recreate restarts a sandbox with fresh worker credentials while retaining
// Daytona's persistent sandbox filesystem.
func (c *Client) Recreate(
	ctx context.Context,
	id cloudsandbox.ID,
	spec cloudsandbox.Spec,
) (cloudsandbox.Environment, error) {
	environment, err := c.Get(ctx, id)
	if err != nil {
		return cloudsandbox.Environment{}, err
	}
	switch environment.State {
	case "paused":
		if err := c.Resume(ctx, id); err != nil {
			return cloudsandbox.Environment{}, err
		}
		if err := c.Stop(ctx, id); err != nil {
			return cloudsandbox.Environment{}, err
		}
		if err := c.Start(ctx, id); err != nil {
			return cloudsandbox.Environment{}, err
		}
	case "stopped", "archived":
		if err := c.Start(ctx, id); err != nil {
			return cloudsandbox.Environment{}, err
		}
	default:
		if err := c.Stop(ctx, id); err != nil {
			return cloudsandbox.Environment{}, err
		}
		if err := c.Start(ctx, id); err != nil {
			return cloudsandbox.Environment{}, err
		}
	}
	if err := c.launchWorker(
		ctx,
		id,
		"/usr/local/bin/ao-worker",
		spec.Environment,
	); err != nil {
		return cloudsandbox.Environment{}, err
	}
	return c.Get(ctx, id)
}

// BootstrapWorker uploads and launches an AO worker in a sandbox.
func (c *Client) BootstrapWorker(
	ctx context.Context,
	id cloudsandbox.ID,
	spec cloudsandbox.WorkerBootstrap,
) error {
	if len(spec.Binary) == 0 {
		return errors.New("worker binary is empty")
	}
	destination := spec.Destination
	if destination == "" {
		destination = "/home/ao/.local/bin/ao-worker"
	}
	var prepareResponse struct {
		ExitCode int    `json:"exitCode"`
		Result   string `json:"result"`
	}
	if err := c.doToolboxJSON(ctx, id, http.MethodPost, "/process/execute", map[string]any{
		"command": "mkdir -p " + shellQuote(filepath.Dir(destination)) +
			" /home/ao/.ao/worker /workspace",
		"timeout": 10,
	}, &prepareResponse); err != nil {
		return fmt.Errorf("prepare AO worker directories: %w", err)
	}
	if prepareResponse.ExitCode != 0 {
		return fmt.Errorf("prepare AO worker directories exited %d: %s", prepareResponse.ExitCode, prepareResponse.Result)
	}
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	part, err := writer.CreateFormFile("file", filepath.Base(destination))
	if err != nil {
		return fmt.Errorf("create worker upload: %w", err)
	}
	if _, err := part.Write(spec.Binary); err != nil {
		return fmt.Errorf("write worker upload: %w", err)
	}
	if err := writer.Close(); err != nil {
		return fmt.Errorf("close worker upload: %w", err)
	}
	uploadPath := "/files/upload?path=" + url.QueryEscape(destination)
	if err := c.doToolbox(ctx, id, http.MethodPost, uploadPath, writer.FormDataContentType(), &body, nil); err != nil {
		return fmt.Errorf("upload AO worker: %w", err)
	}
	return c.launchWorker(ctx, id, destination, spec.Environment)
}

func (c *Client) launchWorker(
	ctx context.Context,
	id cloudsandbox.ID,
	destination string,
	environment map[string]string,
) error {
	command := ""
	if destination != "/usr/local/bin/ao-worker" {
		command = "chmod 0755 " + shellQuote(destination) + " && "
	}
	command += shellEnvironment(environment) + "nohup " + shellQuote(destination) +
		" >/home/ao/.ao/worker.log 2>&1 </dev/null &"
	var executeResponse struct {
		ExitCode int    `json:"exitCode"`
		Result   string `json:"result"`
	}
	if err := c.doToolboxJSON(ctx, id, http.MethodPost, "/process/execute", map[string]any{
		"command": command,
		"env":     environment,
		"timeout": 10,
	}, &executeResponse); err != nil {
		return fmt.Errorf("launch AO worker: %w", err)
	}
	if executeResponse.ExitCode != 0 {
		return fmt.Errorf("launch AO worker exited %d: %s", executeResponse.ExitCode, executeResponse.Result)
	}
	return nil
}

func (c *Client) lifecycle(ctx context.Context, id cloudsandbox.ID, action string) error {
	if err := c.doJSON(ctx, http.MethodPost, sandboxPath(id)+"/"+action, map[string]any{}, nil); err != nil {
		return fmt.Errorf("%s Daytona sandbox: %w", action, err)
	}
	return nil
}

func (c *Client) doJSON(ctx context.Context, method, path string, input, output any) error {
	var body io.Reader = http.NoBody
	if input != nil {
		encoded, err := json.Marshal(input)
		if err != nil {
			return fmt.Errorf("encode request: %w", err)
		}
		body = bytes.NewReader(encoded)
	}
	request, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, body)
	if err != nil {
		return fmt.Errorf("build request: %w", err)
	}
	request.Header.Set("Authorization", "Bearer "+c.apiKey)
	if input != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := c.client.Do(request)
	if err != nil {
		return err
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode == http.StatusNotFound {
		_, _ = io.Copy(io.Discard, response.Body)
		return ErrNotFound
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		payload, _ := io.ReadAll(io.LimitReader(response.Body, 64<<10))
		return &HTTPError{StatusCode: response.StatusCode, Body: strings.TrimSpace(string(payload))}
	}
	if output == nil || response.StatusCode == http.StatusNoContent {
		_, _ = io.Copy(io.Discard, response.Body)
		return nil
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(output); err != nil {
		return fmt.Errorf("decode response: %w", err)
	}
	return nil
}

func (c *Client) doToolboxJSON(
	ctx context.Context,
	id cloudsandbox.ID,
	method, path string,
	input, output any,
) error {
	encoded, err := json.Marshal(input)
	if err != nil {
		return err
	}
	return c.doToolbox(ctx, id, method, path, "application/json", bytes.NewReader(encoded), output)
}

func (c *Client) doToolbox(
	ctx context.Context,
	id cloudsandbox.ID,
	method, path, contentType string,
	body io.Reader,
	output any,
) error {
	endpoint := c.toolboxURL + "/" + url.PathEscape(string(id)) + path
	request, err := http.NewRequestWithContext(ctx, method, endpoint, body)
	if err != nil {
		return err
	}
	request.Header.Set("Authorization", "Bearer "+c.apiKey)
	if contentType != "" {
		request.Header.Set("Content-Type", contentType)
	}
	response, err := c.client.Do(request)
	if err != nil {
		return err
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		payload, _ := io.ReadAll(io.LimitReader(response.Body, 64<<10))
		return &HTTPError{StatusCode: response.StatusCode, Body: strings.TrimSpace(string(payload))}
	}
	if output == nil {
		_, _ = io.Copy(io.Discard, response.Body)
		return nil
	}
	return json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(output)
}

func sandboxPath(id cloudsandbox.ID) string {
	return "/sandbox/" + url.PathEscape(string(id))
}

func toEnvironment(response sandboxResponse) cloudsandbox.Environment {
	return cloudsandbox.Environment{
		ID:           cloudsandbox.ID(response.ID),
		Name:         response.Name,
		State:        response.State,
		DesiredState: response.DesiredState,
		Target:       response.Target,
		Resource: clouddomain.ResourceProfile{
			CPU:    response.CPU,
			Memory: response.Memory,
			Disk:   response.Disk,
		},
	}
}

func shellQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "'\"'\"'") + "'"
}

func shellEnvironment(values map[string]string) string {
	if len(values) == 0 {
		return ""
	}
	names := make([]string, 0, len(values))
	for name := range values {
		names = append(names, name)
	}
	sort.Strings(names)
	arguments := make([]string, 0, len(names))
	for _, name := range names {
		arguments = append(arguments, shellQuote(name+"="+values[name]))
	}
	return "env " + strings.Join(arguments, " ") + " "
}

// HTTPError reports a non-successful Daytona API response.
type HTTPError struct {
	StatusCode int
	Body       string
}

// Error formats the Daytona response failure.
func (e *HTTPError) Error() string {
	if e.Body == "" {
		return fmt.Sprintf("daytona API returned HTTP %d", e.StatusCode)
	}
	return fmt.Sprintf("daytona API returned HTTP %d: %s", e.StatusCode, e.Body)
}

// ErrNotFound indicates that a Daytona sandbox does not exist.
var ErrNotFound = cloudsandbox.ErrNotFound
