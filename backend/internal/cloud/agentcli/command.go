// Package agentcli implements the AO command available inside cloud workers.
// It is an authenticated client of the cloud control plane and never opens
// local daemon state.
package agentcli

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/spf13/cobra"

	clouddomain "github.com/aoagents/agent-orchestrator/backend/internal/cloud/domain"
)

// Version is the cloud-agent CLI protocol version.
const Version = "0.1.0"

type environment func(string) string

// NewCommand creates the cloud-worker AO root command.
func NewCommand(stdout, stderr io.Writer, getenv environment, httpClient *http.Client) *cobra.Command {
	if getenv == nil {
		getenv = os.Getenv
	}
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 30 * time.Second}
	}
	root := &cobra.Command{
		Use:           "ao",
		Short:         "Coordinate AO Cloud workers",
		Version:       Version,
		SilenceErrors: true,
		SilenceUsage:  true,
	}
	root.SetOut(stdout)
	root.SetErr(stderr)
	root.SetVersionTemplate("ao {{.Version}}\n")
	root.AddCommand(newSpawnCommand(getenv, httpClient), newSendCommand(getenv, httpClient), newStatusCommand(getenv, httpClient))
	return root
}

func newSpawnCommand(getenv environment, httpClient *http.Client) *cobra.Command {
	var name, prompt, harness string
	command := &cobra.Command{
		Use:   "spawn",
		Short: "Spawn a worker in this project",
		Args:  cobra.NoArgs,
		RunE: func(command *cobra.Command, _ []string) error {
			client, err := newClient(getenv, httpClient)
			if err != nil {
				return err
			}
			var result struct {
				Session clouddomain.Session `json:"session"`
				Created bool                `json:"created"`
			}
			if err := client.do(command.Context(), http.MethodPost, "/api/cloud/v1/worker/orchestrate/sessions", map[string]string{
				"displayName": name,
				"prompt":      prompt,
				"harness":     harness,
			}, &result, uuid.NewString()); err != nil {
				return err
			}
			_, err = fmt.Fprintf(command.OutOrStdout(), "%s\n", result.Session.ID)
			return err
		},
	}
	command.Flags().StringVar(&name, "name", "", "worker display name")
	command.Flags().StringVar(&prompt, "prompt", "", "worker task")
	command.Flags().StringVar(&harness, "agent", "", "coding harness (claude-code, codex, cursor)")
	command.Flags().StringVar(&harness, "harness", "", "alias for --agent")
	_ = command.MarkFlagRequired("name")
	_ = command.MarkFlagRequired("prompt")
	return command
}

func newSendCommand(getenv environment, httpClient *http.Client) *cobra.Command {
	var sessionID, message string
	command := &cobra.Command{
		Use:   "send",
		Short: "Send a prompt to a project worker",
		Args:  cobra.NoArgs,
		RunE: func(command *cobra.Command, _ []string) error {
			client, err := newClient(getenv, httpClient)
			if err != nil {
				return err
			}
			return client.do(
				command.Context(),
				http.MethodPost,
				"/api/cloud/v1/worker/orchestrate/sessions/"+sessionID+"/messages",
				map[string]string{"text": message},
				nil,
				uuid.NewString(),
			)
		},
	}
	command.Flags().StringVar(&sessionID, "session", "", "target session ID")
	command.Flags().StringVar(&message, "message", "", "message text")
	_ = command.MarkFlagRequired("session")
	_ = command.MarkFlagRequired("message")
	return command
}

func newStatusCommand(getenv environment, httpClient *http.Client) *cobra.Command {
	return &cobra.Command{
		Use:   "status",
		Short: "List sessions in this project",
		Args:  cobra.NoArgs,
		RunE: func(command *cobra.Command, _ []string) error {
			client, err := newClient(getenv, httpClient)
			if err != nil {
				return err
			}
			var result struct {
				Sessions []clouddomain.Session `json:"sessions"`
			}
			if err := client.do(command.Context(), http.MethodGet, "/api/cloud/v1/worker/orchestrate/sessions", nil, &result, ""); err != nil {
				return err
			}
			for _, session := range result.Sessions {
				if _, err := fmt.Fprintf(
					command.OutOrStdout(),
					"%s\t%s\t%s\t%s\t%s\n",
					session.ID,
					session.Status,
					session.Kind,
					session.Harness,
					session.DisplayName,
				); err != nil {
					return err
				}
			}
			return nil
		},
	}
}

type client struct {
	baseURL string
	token   string
	session string
	http    *http.Client
}

func newClient(getenv environment, httpClient *http.Client) (*client, error) {
	baseURL := strings.TrimRight(strings.TrimSpace(getenv("AO_CLOUD_PUBLIC_URL")), "/")
	token := strings.TrimSpace(getenv("AO_WORKER_TOKEN"))
	sessionID := strings.TrimSpace(getenv("AO_SESSION_ID"))
	if dataDir := strings.TrimSpace(getenv("AO_DATA_DIR")); dataDir != "" {
		if current, err := os.ReadFile(filepath.Join(dataDir, "worker-token")); err == nil &&
			strings.TrimSpace(string(current)) != "" {
			token = strings.TrimSpace(string(current))
		}
	}
	switch {
	case baseURL == "":
		return nil, errors.New("AO_CLOUD_PUBLIC_URL is required")
	case token == "":
		return nil, errors.New("AO_WORKER_TOKEN is required")
	case sessionID == "":
		return nil, errors.New("AO_SESSION_ID is required")
	}
	return &client{baseURL: baseURL, token: token, session: sessionID, http: httpClient}, nil
}

func (c *client) do(
	ctx context.Context,
	method, path string,
	input, output any,
	idempotencyKey string,
) error {
	var body io.Reader
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
	request.Header.Set("Authorization", "Worker "+c.token)
	request.Header.Set("X-AO-Session-ID", c.session)
	if input != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	if idempotencyKey != "" {
		request.Header.Set("Idempotency-Key", idempotencyKey)
	}
	response, err := c.http.Do(request)
	if err != nil {
		return fmt.Errorf("send request: %w", err)
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
		return fmt.Errorf("decode response: %w", err)
	}
	return nil
}
