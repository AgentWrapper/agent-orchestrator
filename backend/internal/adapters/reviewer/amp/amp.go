// Package amp adapts Amp's normal interactive TUI for AO reviews.
package amp

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	workeramp "github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/amp"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

type Reviewer struct{}

func New() *Reviewer { return &Reviewer{} }

func (*Reviewer) Harness() domain.ReviewerHarness { return domain.ReviewerAmp }

var _ ports.Reviewer = (*Reviewer)(nil)
var _ ports.ReviewerCanceller = (*Reviewer)(nil)

// ReviewCommand launches Amp's permanent interactive TUI. AO never uses
// --execute; the review task is injected after the pane starts.
func (*Reviewer) ReviewCommand(ctx context.Context, inv ports.ReviewInvocation) (ports.ReviewCommandSpec, error) {
	binary, err := workeramp.ResolveAmpBinary(ctx)
	if err != nil {
		return ports.ReviewCommandSpec{}, err
	}
	if inv.TaskPromptRoot == "" {
		return ports.ReviewCommandSpec{Argv: []string{binary}}, nil
	}
	settingsPath, err := writeReviewerSettings(inv.TaskPromptRoot)
	if err != nil {
		return ports.ReviewCommandSpec{}, err
	}
	message := inv.Prompt
	if inv.SystemPromptFile != "" {
		message = fmt.Sprintf("First read and follow the reviewer role in `%s`. Then %s", filepath.ToSlash(inv.SystemPromptFile), inv.Prompt)
	}
	return ports.ReviewCommandSpec{
		Argv:           []string{binary, "--settings-file", settingsPath},
		InitialMessage: message,
	}, nil
}

func writeReviewerSettings(root string) (string, error) {
	if err := os.MkdirAll(root, 0o700); err != nil {
		return "", fmt.Errorf("create amp reviewer settings directory: %w", err)
	}
	settings := map[string]any{
		"amp.dangerouslyAllowAll":          false,
		"amp.remoteThreadCreation.enabled": false,
		"amp.updates.mode":                 "disabled",
		"amp.mcpServers":                   map[string]any{},
		"amp.permissions": []map[string]any{
			{"tool": "Read", "action": "allow"},
			{"tool": "Grep", "action": "allow"},
			{"tool": "Glob", "action": "allow"},
			{"tool": "Bash", "action": "ask"},
			{"tool": "Edit", "action": "reject"},
			{"tool": "Write", "action": "reject"},
			{"tool": "*", "action": "reject"},
		},
	}
	data, err := json.Marshal(settings)
	if err != nil {
		return "", fmt.Errorf("encode amp reviewer settings: %w", err)
	}
	path := filepath.Join(root, "amp-settings.json")
	if err := os.WriteFile(path, append(data, '\n'), 0o600); err != nil {
		return "", fmt.Errorf("write amp reviewer settings: %w", err)
	}
	return path, nil
}

func (*Reviewer) ReviewMessage(_ context.Context, inv ports.ReviewInvocation) (string, error) {
	return inv.Prompt, nil
}

func (*Reviewer) ReviewCancel(context.Context) (ports.ReviewCancelSpec, error) {
	return ports.ReviewCancelSpec{Mode: ports.ReviewCancelInterrupt, Interrupts: 2}, nil
}
