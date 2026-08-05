// Package docker implements local contributor sandboxes through Docker.
// It is deliberately a development adapter, not a production isolation claim.
package docker

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os/exec"
	"sort"
	"strings"

	clouddomain "github.com/aoagents/agent-orchestrator/backend/internal/cloud/domain"
	cloudsandbox "github.com/aoagents/agent-orchestrator/backend/internal/cloud/sandbox"
)

const workspaceMountPath = "/workspace"

// Client implements the sandbox lifecycle through the local Docker CLI.
type Client struct {
	image string
}

var _ cloudsandbox.Provider = (*Client)(nil)
var _ cloudsandbox.Recreator = (*Client)(nil)

// New creates a local Docker sandbox provider using image.
func New(image string) *Client {
	return &Client{image: strings.TrimSpace(image)}
}

// Create starts one named container and one named workspace volume per session.
func (c *Client) Create(ctx context.Context, spec cloudsandbox.Spec) (cloudsandbox.Environment, error) {
	image := strings.TrimSpace(spec.Image)
	if image == "" {
		image = c.image
	}
	if image == "" {
		return cloudsandbox.Environment{}, errors.New("docker worker image is required")
	}
	volume := volumeName(spec.SessionID)
	if _, err := c.run(ctx, "volume", "create", volume); err != nil {
		return cloudsandbox.Environment{}, fmt.Errorf("create Docker workspace volume: %w", err)
	}

	args := []string{
		"run", "--detach", "--name", spec.Name,
		"--add-host", "host.docker.internal:host-gateway",
		"--mount", "type=volume,src=" + volume + ",dst=" + workspaceMountPath,
	}
	labelKeys := make([]string, 0, len(spec.Labels)+1)
	for key := range spec.Labels {
		labelKeys = append(labelKeys, key)
	}
	sort.Strings(labelKeys)
	for _, key := range labelKeys {
		args = append(args, "--label", key+"="+spec.Labels[key])
	}
	args = append(args, "--label", "ao.session_id="+string(spec.SessionID))
	envKeys := make([]string, 0, len(spec.Environment))
	for key := range spec.Environment {
		envKeys = append(envKeys, key)
	}
	sort.Strings(envKeys)
	for _, key := range envKeys {
		args = append(args, "--env", key+"="+containerEnvironmentValue(key, spec.Environment[key]))
	}
	args = append(args, image)
	id, err := c.run(ctx, args...)
	if err != nil {
		return cloudsandbox.Environment{}, fmt.Errorf("run Docker sandbox: %w", err)
	}
	return c.Get(ctx, cloudsandbox.ID(strings.TrimSpace(id)))
}

// Get returns Docker's observed container state.
func (c *Client) Get(ctx context.Context, id cloudsandbox.ID) (cloudsandbox.Environment, error) {
	var inspection dockerInspect
	if err := c.inspect(ctx, string(id), &inspection); err != nil {
		return cloudsandbox.Environment{}, err
	}
	return environment(inspection), nil
}

// FindBySession finds a container by its AO session label.
func (c *Client) FindBySession(ctx context.Context, sessionID clouddomain.SessionID) (cloudsandbox.Environment, bool, error) {
	ids, err := c.run(ctx, "ps", "--all", "--quiet", "--filter", "label=ao.session_id="+string(sessionID))
	if err != nil {
		return cloudsandbox.Environment{}, false, fmt.Errorf("list Docker sandboxes: %w", err)
	}
	id := strings.TrimSpace(strings.Split(ids, "\n")[0])
	if id == "" {
		return cloudsandbox.Environment{}, false, nil
	}
	value, err := c.Get(ctx, cloudsandbox.ID(id))
	return value, err == nil, err
}

// Start starts a stopped worker container.
func (c *Client) Start(ctx context.Context, id cloudsandbox.ID) error {
	_, err := c.run(ctx, "start", string(id))
	return providerError("start Docker sandbox", err)
}

// Recreate replaces a stopped worker container with fresh bootstrap
// credentials while retaining its named workspace volume.
func (c *Client) Recreate(
	ctx context.Context,
	id cloudsandbox.ID,
	spec cloudsandbox.Spec,
) (cloudsandbox.Environment, error) {
	if _, err := c.run(ctx, "rm", "--force", string(id)); err != nil {
		return cloudsandbox.Environment{}, providerError("remove stopped Docker sandbox", err)
	}
	return c.Create(ctx, spec)
}

// Stop stops a worker container without deleting its workspace volume.
func (c *Client) Stop(ctx context.Context, id cloudsandbox.ID) error {
	_, err := c.run(ctx, "stop", "--time", "10", string(id))
	return providerError("stop Docker sandbox", err)
}

// Pause pauses all processes in a worker container.
func (c *Client) Pause(ctx context.Context, id cloudsandbox.ID) error {
	_, err := c.run(ctx, "pause", string(id))
	return providerError("pause Docker sandbox", err)
}

// Resume unpauses a worker container.
func (c *Client) Resume(ctx context.Context, id cloudsandbox.ID) error {
	_, err := c.run(ctx, "unpause", string(id))
	return providerError("resume Docker sandbox", err)
}

// Delete removes both the container and its session workspace volume.
func (c *Client) Delete(ctx context.Context, id cloudsandbox.ID) error {
	var inspection dockerInspect
	if err := c.inspect(ctx, string(id), &inspection); err != nil {
		if errors.Is(err, cloudsandbox.ErrNotFound) {
			return err
		}
		return fmt.Errorf("inspect Docker sandbox for delete: %w", err)
	}
	if _, err := c.run(ctx, "rm", "--force", string(id)); err != nil {
		return providerError("remove Docker sandbox", err)
	}
	for _, mount := range inspection.Mounts {
		if mount.Type != "volume" || mount.Destination != workspaceMountPath || mount.Name == "" {
			continue
		}
		if _, err := c.run(ctx, "volume", "rm", mount.Name); err != nil {
			return fmt.Errorf("remove Docker workspace volume: %w", err)
		}
	}
	return nil
}

type dockerInspect struct {
	ID     string `json:"Id"`
	Name   string `json:"Name"`
	Config struct {
		Labels map[string]string `json:"Labels"`
	} `json:"Config"`
	State struct {
		Status string `json:"Status"`
	} `json:"State"`
	Mounts []struct {
		Type        string `json:"Type"`
		Name        string `json:"Name"`
		Destination string `json:"Destination"`
	} `json:"Mounts"`
}

func (c *Client) inspect(ctx context.Context, id string, output *dockerInspect) error {
	raw, err := c.run(ctx, "inspect", id)
	if err != nil {
		if dockerNotFound(err) {
			return cloudsandbox.ErrNotFound
		}
		return fmt.Errorf("inspect Docker sandbox: %w", err)
	}
	var values []dockerInspect
	if err := json.Unmarshal([]byte(raw), &values); err != nil {
		return fmt.Errorf("decode Docker inspection: %w", err)
	}
	if len(values) != 1 {
		return cloudsandbox.ErrNotFound
	}
	*output = values[0]
	return nil
}

func environment(value dockerInspect) cloudsandbox.Environment {
	state := value.State.Status
	switch state {
	case "running":
		state = "running"
	case "paused":
		state = "paused"
	case "created":
		state = "creating"
	case "exited", "dead":
		state = "stopped"
	default:
		state = "provisioning"
	}
	return cloudsandbox.Environment{
		ID:    cloudsandbox.ID(value.ID),
		Name:  strings.TrimPrefix(value.Name, "/"),
		State: state,
	}
}

func volumeName(sessionID clouddomain.SessionID) string {
	return "ao-workspace-" + strings.ReplaceAll(string(sessionID), "_", "-")
}

func containerEnvironmentValue(key, value string) string {
	if key != "AO_CLOUD_PUBLIC_URL" {
		return value
	}
	value = strings.Replace(value, "://127.0.0.1", "://host.docker.internal", 1)
	return strings.Replace(value, "://localhost", "://host.docker.internal", 1)
}

func (c *Client) run(ctx context.Context, arguments ...string) (string, error) {
	command := exec.CommandContext(ctx, "docker", arguments...)
	output, err := command.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("%w: %s", err, strings.TrimSpace(string(output)))
	}
	return string(output), nil
}

func providerError(operation string, err error) error {
	if err == nil {
		return nil
	}
	if dockerNotFound(err) {
		return cloudsandbox.ErrNotFound
	}
	return fmt.Errorf("%s: %w", operation, err)
}

func dockerNotFound(err error) bool {
	return strings.Contains(strings.ToLower(err.Error()), "no such container") ||
		strings.Contains(strings.ToLower(err.Error()), "not found")
}
