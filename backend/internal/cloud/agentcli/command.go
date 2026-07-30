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
	"net/url"
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
	root.AddCommand(
		newSpawnCommand(getenv, httpClient),
		newSendCommand(getenv, httpClient),
		newStatusCommand(getenv, httpClient),
		newInspectCommand(getenv, httpClient),
		newWaitCommand(getenv, httpClient),
		newResultCommand(getenv, httpClient),
	)
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

type inspection struct {
	Session         clouddomain.Session `json:"session"`
	Turn            *clouddomain.Turn   `json:"turn"`
	Result          string              `json:"result"`
	ResultAvailable bool                `json:"resultAvailable"`
}

func newInspectCommand(getenv environment, httpClient *http.Client) *cobra.Command {
	return &cobra.Command{
		Use:   "inspect <worker>",
		Short: "Inspect a project worker and its latest turn",
		Args:  cobra.ExactArgs(1),
		RunE: func(command *cobra.Command, args []string) error {
			client, err := newClient(getenv, httpClient)
			if err != nil {
				return err
			}
			worker, err := client.resolveWorker(command.Context(), args[0])
			if err != nil {
				return err
			}
			inspection, err := client.inspectWorker(command.Context(), worker.ID)
			if err != nil {
				return err
			}
			turnState := "none"
			attempts := 0
			if inspection.Turn != nil {
				turnState = inspection.Turn.State
				attempts = inspection.Turn.AttemptCount
			}
			resultState := "none"
			if inspection.Turn != nil {
				if inspection.ResultAvailable {
					resultState = "available"
				} else {
					resultState = "pending"
				}
			}
			_, err = fmt.Fprintf(
				command.OutOrStdout(),
				"id: %s\nname: %s\nstatus: %s\nruntime: %s\nturn: %s\nattempts: %d\nresult: %s\n",
				inspection.Session.ID,
				inspection.Session.DisplayName,
				inspection.Session.Status,
				connectedLabel(inspection.Session.RuntimeConnected),
				turnState,
				attempts,
				resultState,
			)
			return err
		},
	}
}

func newResultCommand(getenv environment, httpClient *http.Client) *cobra.Command {
	return &cobra.Command{
		Use:   "result <worker>",
		Short: "Print a worker's complete latest answer",
		Args:  cobra.ExactArgs(1),
		RunE: func(command *cobra.Command, args []string) error {
			client, err := newClient(getenv, httpClient)
			if err != nil {
				return err
			}
			worker, err := client.resolveWorker(command.Context(), args[0])
			if err != nil {
				return err
			}
			current, err := client.inspectWorker(command.Context(), worker.ID)
			if err != nil {
				return err
			}
			return printWorkerResult(command.OutOrStdout(), current)
		},
	}
}

func newWaitCommand(getenv environment, httpClient *http.Client) *cobra.Command {
	var timeout, interval time.Duration
	command := &cobra.Command{
		Use:   "wait <worker>",
		Short: "Wait for a worker and print its complete answer",
		Args:  cobra.ExactArgs(1),
		RunE: func(command *cobra.Command, args []string) error {
			client, err := newClient(getenv, httpClient)
			if err != nil {
				return err
			}
			worker, err := client.resolveWorker(command.Context(), args[0])
			if err != nil {
				return err
			}
			if timeout <= 0 {
				return errors.New("timeout must be positive")
			}
			if interval < 100*time.Millisecond {
				return errors.New("poll interval must be at least 100ms")
			}
			ctx, cancel := context.WithTimeout(command.Context(), timeout)
			defer cancel()
			for {
				current, inspectErr := client.inspectWorker(ctx, worker.ID)
				if inspectErr != nil {
					var responseErr *responseError
					if errors.As(inspectErr, &responseErr) &&
						responseErr.statusCode >= http.StatusBadRequest &&
						responseErr.statusCode < http.StatusInternalServerError {
						return inspectErr
					}
					if waitErr := waitForPoll(ctx, interval, worker.ID); waitErr != nil {
						return waitErr
					}
					continue
				}
				if current.ResultAvailable {
					return printWorkerResult(command.OutOrStdout(), current)
				}
				if current.Turn == nil {
					return fmt.Errorf("worker %s has no turn to wait for", worker.ID)
				}
				if waitErr := waitForPoll(ctx, interval, worker.ID); waitErr != nil {
					return waitErr
				}
			}
		},
	}
	command.Flags().DurationVar(&timeout, "timeout", 30*time.Minute, "maximum wait time")
	command.Flags().DurationVar(&interval, "poll", time.Second, "status polling interval")
	return command
}

func connectedLabel(connected bool) string {
	if connected {
		return "connected"
	}
	return "offline"
}

func waitForPoll(
	ctx context.Context,
	interval time.Duration,
	workerID clouddomain.SessionID,
) error {
	timer := time.NewTimer(interval)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return fmt.Errorf("timed out waiting for worker %s", workerID)
		}
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func printWorkerResult(output io.Writer, current inspection) error {
	if current.Turn == nil {
		return fmt.Errorf("worker %s has no result", current.Session.ID)
	}
	if !current.ResultAvailable {
		return fmt.Errorf(
			"worker %s is still %s; use ao wait %s",
			current.Session.ID,
			current.Turn.State,
			current.Session.ID,
		)
	}
	if current.Result != "" {
		if _, err := fmt.Fprintln(output, current.Result); err != nil {
			return err
		}
	}
	if current.Turn.State == "failed" {
		reason := strings.TrimSpace(current.Turn.ErrorMessage)
		if reason == "" {
			reason = "worker turn failed"
		}
		return fmt.Errorf("worker %s failed: %s", current.Session.ID, reason)
	}
	return nil
}

type client struct {
	baseURL string
	token   string
	session string
	http    *http.Client
}

type responseError struct {
	statusCode int
	status     string
	body       string
}

func (e *responseError) Error() string {
	return fmt.Sprintf("AO Cloud returned %s: %s", e.status, e.body)
}

func (c *client) listSessions(ctx context.Context) ([]clouddomain.Session, error) {
	var result struct {
		Sessions []clouddomain.Session `json:"sessions"`
	}
	if err := c.do(ctx, http.MethodGet, "/api/cloud/v1/worker/orchestrate/sessions", nil, &result, ""); err != nil {
		return nil, err
	}
	return result.Sessions, nil
}

func (c *client) resolveWorker(ctx context.Context, reference string) (clouddomain.Session, error) {
	sessions, err := c.listSessions(ctx)
	if err != nil {
		return clouddomain.Session{}, err
	}
	reference = strings.TrimSpace(reference)
	for _, session := range sessions {
		if session.Kind == "worker" && string(session.ID) == reference {
			return session, nil
		}
	}
	matches := make([]clouddomain.Session, 0, 1)
	for _, session := range sessions {
		if session.Kind != "worker" {
			continue
		}
		if session.DisplayName == reference || strings.HasPrefix(string(session.ID), reference) {
			matches = append(matches, session)
		}
	}
	switch len(matches) {
	case 0:
		return clouddomain.Session{}, fmt.Errorf("project worker %q was not found", reference)
	case 1:
		return matches[0], nil
	default:
		return clouddomain.Session{}, fmt.Errorf("project worker %q is ambiguous; use its full session ID", reference)
	}
}

func (c *client) inspectWorker(
	ctx context.Context,
	sessionID clouddomain.SessionID,
) (inspection, error) {
	var result inspection
	err := c.do(
		ctx,
		http.MethodGet,
		"/api/cloud/v1/worker/orchestrate/sessions/"+url.PathEscape(string(sessionID))+"/inspection",
		nil,
		&result,
		"",
	)
	return result, err
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
		return &responseError{
			statusCode: response.StatusCode,
			status:     response.Status,
			body:       strings.TrimSpace(string(payload)),
		}
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
