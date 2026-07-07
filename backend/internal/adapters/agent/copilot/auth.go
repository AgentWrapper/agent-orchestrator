package copilot

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/authprobe"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

var _ ports.AgentAuthChecker = (*Plugin)(nil)

// AuthStatus returns the plugin's local authentication status.
func (p *Plugin) AuthStatus(ctx context.Context) (ports.AgentAuthStatus, error) {
	binary, err := p.ResolveBinary(ctx)
	if err != nil {
		return ports.AgentAuthStatusUnknown, err
	}
	if status, ok, err := copilotLocalAuthStatus(ctx); err != nil {
		return ports.AgentAuthStatusUnknown, err
	} else if ok {
		return status, nil
	}
	return authprobe.CLIStatus(ctx, binary, nil)
}

var copilotTokenEnvVars = []string{
	"COPILOT_GITHUB_TOKEN",
	"GH_TOKEN",
	"GITHUB_TOKEN",
}

func copilotLocalAuthStatus(ctx context.Context) (ports.AgentAuthStatus, bool, error) {
	if err := ctx.Err(); err != nil {
		return ports.AgentAuthStatusUnknown, false, err
	}
	for _, name := range copilotTokenEnvVars {
		if strings.TrimSpace(os.Getenv(name)) != "" {
			return ports.AgentAuthStatusAuthorized, true, nil
		}
	}

	home, err := os.UserHomeDir()
	if err != nil {
		return ports.AgentAuthStatusUnknown, false, err
	}
	if home == "" {
		return ports.AgentAuthStatusUnknown, false, nil
	}
	configStatus, configOK, err := copilotConfigAuthStatus(filepath.Join(home, ".copilot", "config.json"))
	if err != nil {
		return ports.AgentAuthStatusUnknown, false, err
	}
	if configOK {
		return configStatus, true, nil
	}
	if status, ok, err := copilotSessionStateAuthStatus(ctx, filepath.Join(home, ".copilot", "session-state")); err != nil || ok {
		return status, ok, err
	}
	if status, ok, err := copilotGHAuthStatus(ctx); err != nil || ok {
		return status, ok, err
	}
	return ports.AgentAuthStatusUnknown, false, nil
}

func copilotConfigAuthStatus(path string) (ports.AgentAuthStatus, bool, error) {
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return ports.AgentAuthStatusUnknown, false, nil
	}
	if err != nil {
		return ports.AgentAuthStatusUnknown, false, err
	}
	text := strings.TrimSpace(string(data))
	if text == "" {
		return ports.AgentAuthStatusUnauthorized, true, nil
	}
	if textContainsTokenAssignment(text) {
		return ports.AgentAuthStatusAuthorized, true, nil
	}
	return ports.AgentAuthStatusUnknown, false, nil
}

func copilotSessionStateAuthStatus(ctx context.Context, dir string) (ports.AgentAuthStatus, bool, error) {
	if err := ctx.Err(); err != nil {
		return ports.AgentAuthStatusUnknown, false, err
	}
	paths, err := filepath.Glob(filepath.Join(dir, "*", "events.jsonl"))
	if err != nil {
		return ports.AgentAuthStatusUnknown, false, err
	}
	for _, path := range paths {
		if err := ctx.Err(); err != nil {
			return ports.AgentAuthStatusUnknown, false, err
		}
		data, err := os.ReadFile(path)
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			return ports.AgentAuthStatusUnknown, false, err
		}
		if copilotEventsShowModelUse(string(data)) {
			return ports.AgentAuthStatusAuthorized, true, nil
		}
	}
	return ports.AgentAuthStatusUnknown, false, nil
}

func copilotEventsShowModelUse(text string) bool {
	return strings.Contains(text, `"model":`) ||
		strings.Contains(text, `"type":"tool.execution_complete"`) ||
		strings.Contains(text, `"type":"message"`)
}

func copilotGHAuthStatus(ctx context.Context) (ports.AgentAuthStatus, bool, error) {
	probeCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()

	out, err := exec.CommandContext(probeCtx, "gh", "auth", "token").CombinedOutput()
	if probeCtx.Err() != nil {
		return ports.AgentAuthStatusUnknown, false, probeCtx.Err()
	}
	text := strings.TrimSpace(string(out))
	if err == nil && text != "" {
		return ports.AgentAuthStatusAuthorized, true, nil
	}
	if strings.Contains(strings.ToLower(text), "no oauth token") || strings.Contains(strings.ToLower(text), "not logged") {
		return ports.AgentAuthStatusUnknown, false, nil
	}
	return ports.AgentAuthStatusUnknown, false, nil
}

func textContainsTokenAssignment(text string) bool {
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "//") || strings.HasPrefix(line, "#") {
			continue
		}
		lower := strings.ToLower(line)
		if !strings.Contains(lower, "token") && !strings.Contains(lower, "auth") {
			continue
		}
		for _, sep := range []string{":", "="} {
			_, after, ok := strings.Cut(line, sep)
			if !ok {
				continue
			}
			value := strings.Trim(strings.TrimSpace(strings.TrimRight(after, ",")), `"'`)
			if value != "" && !strings.EqualFold(value, "null") && !strings.EqualFold(value, "none") {
				return true
			}
		}
	}
	return false
}
