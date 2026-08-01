// Package droid adapts Factory Droid as an experimental host-trusted AO
// reviewer. It always runs Droid's visible, long-lived interactive TUI.
package droid

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	workerdroid "github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/droid"
	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/hookutil"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

const settingsFilename = "droid-reviewer-settings.json"

// HostTrustWarning describes the authority retained by Droid's interactive
// terminal. Spec mode and autonomy-off reduce accidental model actions but do
// not isolate the direct Bash mode or mutable slash-command surfaces.
const HostTrustWarning = "experimental host-trusted reviewer: Droid has no OS isolation; terminal users can invoke Bash mode, change interaction/autonomy settings, or enable additional integrations"

// Reviewer builds Droid's persistent interactive reviewer command.
type Reviewer struct {
	resolveBinary func(context.Context) (string, error)
}

// New returns the production Droid reviewer adapter.
func New() *Reviewer {
	return &Reviewer{resolveBinary: workerdroid.ResolveDroidBinary}
}

// Harness returns Droid's reviewer identity.
func (*Reviewer) Harness() domain.ReviewerHarness { return domain.ReviewerDroid }

var _ ports.Reviewer = (*Reviewer)(nil)
var _ ports.ReviewerCanceller = (*Reviewer)(nil)

// ReviewCommand starts only Droid's normal interactive TUI. It never uses
// `droid exec`, output formats, prompt files, or unsafe permission bypasses.
// AO injects the task after the pane starts and keeps the pane for later passes.
func (r *Reviewer) ReviewCommand(ctx context.Context, inv ports.ReviewInvocation) (ports.ReviewCommandSpec, error) {
	if err := ctx.Err(); err != nil {
		return ports.ReviewCommandSpec{}, err
	}
	binary, err := r.resolveBinary(ctx)
	if err != nil {
		return ports.ReviewCommandSpec{}, err
	}
	if !filepath.IsAbs(binary) {
		return ports.ReviewCommandSpec{}, errors.New("droid reviewer: resolved binary must be absolute")
	}
	// Preflight only needs a resolvable interactive executable.
	if strings.TrimSpace(inv.TaskPromptRoot) == "" {
		return ports.ReviewCommandSpec{Argv: []string{binary}}, nil
	}
	settingsPath, err := writeReviewerSettings(inv.TaskPromptRoot)
	if err != nil {
		return ports.ReviewCommandSpec{}, err
	}
	argv := []string{binary, "--settings", settingsPath}
	if strings.TrimSpace(inv.SystemPromptFile) != "" {
		argv = append(argv, "--append-system-prompt-file", inv.SystemPromptFile)
	}
	return ports.ReviewCommandSpec{
		Argv:           argv,
		InitialMessage: inv.Prompt,
	}, nil
}

func writeReviewerSettings(promptRoot string) (string, error) {
	if !filepath.IsAbs(promptRoot) {
		return "", errors.New("droid reviewer: absolute task prompt root is required")
	}
	if err := os.MkdirAll(promptRoot, 0o700); err != nil {
		return "", fmt.Errorf("droid reviewer: create settings directory: %w", err)
	}
	settings := map[string]any{
		"sessionDefaultSettings": map[string]any{
			"interactionMode": "spec",
			"autonomyLevel":   "off",
		},
		"cloudSessionSync":         false,
		"ideAutoConnect":           false,
		"includeCoAuthoredByDroid": false,
	}
	data, err := json.MarshalIndent(settings, "", "  ")
	if err != nil {
		return "", fmt.Errorf("droid reviewer: encode settings: %w", err)
	}
	path := filepath.Join(promptRoot, settingsFilename)
	if err := hookutil.AtomicWriteFile(path, append(data, '\n'), 0o600); err != nil {
		return "", fmt.Errorf("droid reviewer: write settings: %w", err)
	}
	return path, nil
}

// ReviewMessage reuses the same Droid TUI for subsequent review passes.
func (*Reviewer) ReviewMessage(ctx context.Context, inv ports.ReviewInvocation) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	return inv.Prompt, nil
}

// ReviewCancel sends Droid's active-operation Ctrl-C once, preserving the pane.
func (*Reviewer) ReviewCancel(ctx context.Context) (ports.ReviewCancelSpec, error) {
	if err := ctx.Err(); err != nil {
		return ports.ReviewCancelSpec{}, err
	}
	return ports.ReviewCancelSpec{Mode: ports.ReviewCancelInterrupt, Interrupts: 1}, nil
}
