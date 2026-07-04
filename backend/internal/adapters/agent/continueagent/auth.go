package continueagent

import (
	"context"
	"os"
	"path/filepath"
	"strings"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"

	yaml "gopkg.in/yaml.v3"
)

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
