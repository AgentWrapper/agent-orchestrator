package continueagent

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/authprobe"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"

	yaml "gopkg.in/yaml.v3"
)

var _ ports.AgentAuthChecker = (*Plugin)(nil)

// AuthStatus returns the plugin's local authentication status.
func (p *Plugin) AuthStatus(ctx context.Context) (ports.AgentAuthStatus, error) {
	binary, err := p.ResolveBinary(ctx)
	if err != nil {
		return ports.AgentAuthStatusUnknown, err
	}
	if status, ok, err := continueLocalAuthStatus(ctx); err != nil {
		return ports.AgentAuthStatusUnknown, err
	} else if ok {
		return status, nil
	}
	if status, err := continuePrintAuthStatus(ctx, binary); err != nil {
		return ports.AgentAuthStatusUnknown, err
	} else if status != ports.AgentAuthStatusUnknown {
		return status, nil
	}
	return authprobe.CLIStatus(ctx, binary, nil)
}

func continueLocalAuthStatus(ctx context.Context) (ports.AgentAuthStatus, bool, error) {
	if err := ctx.Err(); err != nil {
		return ports.AgentAuthStatusUnknown, false, err
	}
	if strings.TrimSpace(os.Getenv("CONTINUE_API_KEY")) != "" {
		return ports.AgentAuthStatusAuthorized, true, nil
	}
	if home, err := os.UserHomeDir(); err == nil && home != "" {
		status, ok, err := continueConfigAuthStatus(filepath.Join(home, ".continue", "config.yaml"))
		if err != nil || ok {
			return status, ok, err
		}
	}
	return ports.AgentAuthStatusUnknown, false, nil
}

func continueConfigAuthStatus(path string) (ports.AgentAuthStatus, bool, error) {
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return ports.AgentAuthStatusUnknown, false, nil
	}
	if err != nil {
		return ports.AgentAuthStatusUnknown, false, err
	}
	if strings.TrimSpace(string(data)) == "" {
		return ports.AgentAuthStatusUnknown, false, nil
	}

	var root yaml.Node
	if err := yaml.Unmarshal(data, &root); err != nil {
		return ports.AgentAuthStatusUnknown, false, err
	}
	if continueConfigHasCredential(&root) {
		return ports.AgentAuthStatusAuthorized, true, nil
	}
	return ports.AgentAuthStatusUnknown, false, nil
}

func continueConfigHasCredential(node *yaml.Node) bool {
	if node == nil {
		return false
	}
	switch node.Kind {
	case yaml.DocumentNode, yaml.SequenceNode:
		for _, child := range node.Content {
			if continueConfigHasCredential(child) {
				return true
			}
		}
	case yaml.MappingNode:
		for i := 0; i+1 < len(node.Content); i += 2 {
			key := strings.ToLower(strings.TrimSpace(node.Content[i].Value))
			value := strings.Trim(strings.TrimSpace(node.Content[i+1].Value), `"'`)
			if (strings.Contains(key, "apikey") || strings.Contains(key, "api_key") || strings.Contains(key, "token")) &&
				value != "" &&
				!strings.EqualFold(value, "null") &&
				!strings.EqualFold(value, "none") {
				return true
			}
			if continueConfigHasCredential(node.Content[i+1]) {
				return true
			}
		}
	}
	return false
}

func continuePrintAuthStatus(ctx context.Context, binary string) (ports.AgentAuthStatus, error) {
	probeCtx, cancel := context.WithTimeout(ctx, 4*time.Second)
	defer cancel()

	out, err := authprobe.CmdRunner(probeCtx, binary, "-p", "hi")
	if probeCtx.Err() != nil {
		return ports.AgentAuthStatusUnknown, nil
	}
	if status := authprobe.StatusFromText(string(out)); status != ports.AgentAuthStatusUnknown {
		return status, nil
	}
	if err != nil {
		return ports.AgentAuthStatusUnknown, nil
	}
	if strings.TrimSpace(string(out)) != "" {
		return ports.AgentAuthStatusAuthorized, nil
	}
	return ports.AgentAuthStatusUnknown, nil
}
