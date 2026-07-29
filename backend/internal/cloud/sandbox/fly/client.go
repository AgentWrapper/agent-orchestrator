// Package fly implements AO's provider-neutral sandbox lifecycle using the
// Fly Machines API. No Fly API type escapes this package.
package fly

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	clouddomain "github.com/aoagents/agent-orchestrator/backend/internal/cloud/domain"
	cloudsandbox "github.com/aoagents/agent-orchestrator/backend/internal/cloud/sandbox"
)

const (
	// DefaultBaseURL is the public Fly Machines API endpoint.
	DefaultBaseURL = "https://api.machines.dev/v1"

	workspaceMountPath  = "/workspace"
	workspaceVolumeSize = 10
	maxResponseBytes    = 1 << 20
	maxErrorBytes       = 64 << 10
)

// Config contains the connection and placement settings for Fly Machines.
type Config struct {
	BaseURL     string
	APIToken    string
	AppName     string
	Region      string
	WorkerImage string
	HTTPClient  *http.Client
}

// Client implements sandbox lifecycle operations through the Fly Machines API.
type Client struct {
	baseURL     string
	apiToken    string
	appName     string
	region      string
	workerImage string
	client      *http.Client
}

var _ cloudsandbox.Provider = (*Client)(nil)

// New creates a Fly Machines sandbox client.
func New(config Config) *Client {
	baseURL := strings.TrimRight(config.BaseURL, "/")
	if baseURL == "" {
		baseURL = DefaultBaseURL
	}
	client := config.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: 2 * time.Minute}
	}
	return &Client{
		baseURL:     baseURL,
		apiToken:    config.APIToken,
		appName:     config.AppName,
		region:      config.Region,
		workerImage: config.WorkerImage,
		client:      client,
	}
}

type volumeResponse struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Region    string `json:"region"`
	SizeGB    int    `json:"size_gb"`
	Encrypted bool   `json:"encrypted"`
}

type machineResponse struct {
	ID     string        `json:"id"`
	Name   string        `json:"name"`
	State  string        `json:"state"`
	Region string        `json:"region"`
	Config machineConfig `json:"config"`
}

type machineConfig struct {
	Image    string            `json:"image"`
	Env      map[string]string `json:"env,omitempty"`
	Metadata map[string]string `json:"metadata,omitempty"`
	Guest    machineGuest      `json:"guest"`
	Mounts   []machineMount    `json:"mounts,omitempty"`
	Restart  machineRestart    `json:"restart"`
}

type machineGuest struct {
	CPUKind  string `json:"cpu_kind"`
	CPUs     int    `json:"cpus"`
	MemoryMB int    `json:"memory_mb"`
}

type machineMount struct {
	Volume string `json:"volume"`
	Path   string `json:"path"`
	SizeGB int    `json:"size_gb,omitempty"`
}

type machineRestart struct {
	Policy string `json:"policy"`
}

// Create provisions an encrypted workspace volume and a running Machine.
func (c *Client) Create(ctx context.Context, spec cloudsandbox.Spec) (cloudsandbox.Environment, error) {
	var volume volumeResponse
	if err := c.doJSON(ctx, http.MethodPost, c.volumesPath(), map[string]any{
		"name":      deterministicVolumeName(spec),
		"region":    c.region,
		"size_gb":   workspaceVolumeSize,
		"encrypted": true,
	}, &volume); err != nil {
		return cloudsandbox.Environment{}, fmt.Errorf("create Fly workspace volume: %w", err)
	}

	metadata := make(map[string]string, len(spec.Labels)+1)
	for key, value := range spec.Labels {
		metadata[key] = value
	}
	metadata["ao.session_id"] = string(spec.SessionID)

	body := map[string]any{
		"name":   spec.Name,
		"region": c.region,
		"config": machineConfig{
			Image:    c.workerImage,
			Env:      spec.Environment,
			Metadata: metadata,
			Guest: machineGuest{
				CPUKind:  "shared",
				CPUs:     spec.ResourceProfile.CPU,
				MemoryMB: spec.ResourceProfile.Memory * 1024,
			},
			Mounts: []machineMount{{
				Volume: volume.ID,
				Path:   workspaceMountPath,
			}},
			// AO bootstrap tickets are one-use credentials. Preserve the Machine
			// as a suspendable process instead of letting Fly restart it with a
			// consumed ticket.
			Restart: machineRestart{Policy: "no"},
		},
	}
	var machine machineResponse
	if err := c.doJSON(ctx, http.MethodPost, c.machinesPath(), body, &machine); err != nil {
		// The Machine was never created, so the new volume is safe to remove.
		_ = c.doJSON(ctx, http.MethodDelete, c.volumePath(volume.ID), nil, nil)
		return cloudsandbox.Environment{}, fmt.Errorf("create Fly machine: %w", err)
	}
	return toEnvironment(machine), nil
}

// Get returns the current state of a Machine.
func (c *Client) Get(ctx context.Context, id cloudsandbox.ID) (cloudsandbox.Environment, error) {
	machine, err := c.getMachine(ctx, id)
	if err != nil {
		return cloudsandbox.Environment{}, fmt.Errorf("get Fly machine: %w", err)
	}
	return toEnvironment(machine), nil
}

// FindBySession finds the Machine carrying a cloud session metadata label.
func (c *Client) FindBySession(
	ctx context.Context,
	sessionID clouddomain.SessionID,
) (cloudsandbox.Environment, bool, error) {
	var machines []machineResponse
	if err := c.doJSON(ctx, http.MethodGet, c.machinesPath(), nil, &machines); err != nil {
		return cloudsandbox.Environment{}, false, fmt.Errorf("list Fly machines: %w", err)
	}
	for _, machine := range machines {
		if machine.Config.Metadata["ao.session_id"] == string(sessionID) {
			return toEnvironment(machine), true, nil
		}
	}
	return cloudsandbox.Environment{}, false, nil
}

// Validate verifies that the configured token can access the configured app.
func (c *Client) Validate(ctx context.Context) error {
	if err := c.doJSON(ctx, http.MethodGet, c.appPath(), nil, nil); err != nil {
		return fmt.Errorf("validate Fly connection: %w", err)
	}
	return nil
}

// Start starts a stopped Machine.
func (c *Client) Start(ctx context.Context, id cloudsandbox.ID) error {
	return c.lifecycle(ctx, id, "start")
}

// Stop suspends a running Machine so its bootstrapped worker process can resume
// without attempting to reuse a one-time bootstrap ticket.
func (c *Client) Stop(ctx context.Context, id cloudsandbox.ID) error {
	return c.lifecycle(ctx, id, "suspend")
}

// Pause suspends a running Machine.
func (c *Client) Pause(ctx context.Context, id cloudsandbox.ID) error {
	return c.lifecycle(ctx, id, "suspend")
}

// Resume starts a suspended Machine.
func (c *Client) Resume(ctx context.Context, id cloudsandbox.ID) error {
	return c.lifecycle(ctx, id, "start")
}

// Delete force-deletes a Machine and then removes each volume it had mounted.
func (c *Client) Delete(ctx context.Context, id cloudsandbox.ID) error {
	machine, err := c.getMachine(ctx, id)
	if err != nil {
		return fmt.Errorf("get Fly machine before delete: %w", err)
	}
	if err := c.doJSON(ctx, http.MethodDelete, c.machinePath(id)+"?force=true", nil, nil); err != nil {
		return fmt.Errorf("delete Fly machine: %w", err)
	}

	var deleteErrors []error
	seen := make(map[string]struct{}, len(machine.Config.Mounts))
	for _, mount := range machine.Config.Mounts {
		if mount.Volume == "" {
			continue
		}
		if _, exists := seen[mount.Volume]; exists {
			continue
		}
		seen[mount.Volume] = struct{}{}
		if err := c.doJSON(ctx, http.MethodDelete, c.volumePath(mount.Volume), nil, nil); err != nil {
			deleteErrors = append(deleteErrors, fmt.Errorf("delete Fly volume %q: %w", mount.Volume, err))
		}
	}
	return errors.Join(deleteErrors...)
}

func (c *Client) getMachine(ctx context.Context, id cloudsandbox.ID) (machineResponse, error) {
	var machine machineResponse
	err := c.doJSON(ctx, http.MethodGet, c.machinePath(id), nil, &machine)
	return machine, err
}

func (c *Client) lifecycle(ctx context.Context, id cloudsandbox.ID, action string) error {
	if err := c.doJSON(ctx, http.MethodPost, c.machinePath(id)+"/"+action, nil, nil); err != nil {
		return fmt.Errorf("%s Fly machine: %w", action, err)
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
	request.Header.Set("Authorization", "Bearer "+c.apiToken)
	if input != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := c.client.Do(request)
	if err != nil {
		return err
	}
	defer func() { _ = response.Body.Close() }()

	if response.StatusCode == http.StatusNotFound {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, maxErrorBytes))
		return cloudsandbox.ErrNotFound
	}
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		payload, _ := io.ReadAll(io.LimitReader(response.Body, maxErrorBytes))
		return &HTTPError{
			StatusCode: response.StatusCode,
			Body:       strings.TrimSpace(string(payload)),
		}
	}
	if output == nil || response.StatusCode == http.StatusNoContent {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, maxResponseBytes))
		return nil
	}

	payload, err := io.ReadAll(io.LimitReader(response.Body, maxResponseBytes+1))
	if err != nil {
		return fmt.Errorf("read response: %w", err)
	}
	if len(payload) > maxResponseBytes {
		return fmt.Errorf("decode response: response exceeds %d bytes", maxResponseBytes)
	}
	if err := json.Unmarshal(payload, output); err != nil {
		return fmt.Errorf("decode response: %w", err)
	}
	return nil
}

func (c *Client) appPath() string {
	return "/apps/" + url.PathEscape(c.appName)
}

func (c *Client) machinesPath() string {
	return c.appPath() + "/machines"
}

func (c *Client) machinePath(id cloudsandbox.ID) string {
	return c.machinesPath() + "/" + url.PathEscape(string(id))
}

func (c *Client) volumesPath() string {
	return c.appPath() + "/volumes"
}

func (c *Client) volumePath(id string) string {
	return c.volumesPath() + "/" + url.PathEscape(id)
}

func deterministicVolumeName(spec cloudsandbox.Spec) string {
	key := string(spec.SessionID)
	if key == "" {
		key = spec.Name
	}
	sum := sha256.Sum256([]byte(key))
	return "ao_" + hex.EncodeToString(sum[:8])
}

func toEnvironment(machine machineResponse) cloudsandbox.Environment {
	disk := 0
	if len(machine.Config.Mounts) > 0 {
		disk = workspaceVolumeSize
		if machine.Config.Mounts[0].SizeGB > 0 {
			disk = machine.Config.Mounts[0].SizeGB
		}
	}
	state := translateState(machine.State)
	return cloudsandbox.Environment{
		ID:           cloudsandbox.ID(machine.ID),
		Name:         machine.Name,
		State:        state,
		DesiredState: desiredState(machine.State),
		Target:       machine.Region,
		Resource: clouddomain.ResourceProfile{
			CPU:    machine.Config.Guest.CPUs,
			Memory: machine.Config.Guest.MemoryMB / 1024,
			Disk:   disk,
		},
	}
}

func translateState(state string) string {
	switch strings.ToLower(state) {
	case "created":
		return "creating"
	case "suspended":
		return "paused"
	case "suspending":
		return "pausing"
	case "destroying":
		return "deleting"
	case "destroyed":
		return "deleted"
	default:
		return strings.ToLower(state)
	}
}

func desiredState(state string) string {
	switch strings.ToLower(state) {
	case "created", "starting", "started":
		return "started"
	case "stopping", "stopped":
		return "stopped"
	case "suspending", "suspended":
		return "paused"
	case "destroying", "destroyed":
		return "deleted"
	default:
		return strings.ToLower(state)
	}
}

// HTTPError reports a non-successful Fly Machines API response.
type HTTPError struct {
	StatusCode int
	Body       string
}

// Error formats the Fly Machines API response failure.
func (e *HTTPError) Error() string {
	if e.Body == "" {
		return fmt.Sprintf("Fly Machines API returned HTTP %d", e.StatusCode)
	}
	return fmt.Sprintf("Fly Machines API returned HTTP %d: %s", e.StatusCode, e.Body)
}

// ErrNotFound indicates that a Fly Machine or volume does not exist.
var ErrNotFound = cloudsandbox.ErrNotFound
