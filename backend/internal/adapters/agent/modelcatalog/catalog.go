// Package modelcatalog normalizes the heterogeneous model-list surfaces
// exposed by supported agent CLIs.
package modelcatalog

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os/exec"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

const commandTimeout = 8 * time.Second

type commandSpec struct {
	args []string
	json bool
}

var ansiPattern = regexp.MustCompile(`\x1b\[[0-9;]*[[:alpha:]]`)

var commandSpecs = map[string]commandSpec{
	"opencode": {args: []string{"models"}},
	"grok":     {args: []string{"models"}},
	"cursor":   {args: []string{"models"}},
	"agy":      {args: []string{"models"}},
	"aider":    {args: []string{"--list-models", ""}},
	"kilocode": {args: []string{"models"}},
	"pi":       {args: []string{"--list-models"}},
	"autohand": {args: []string{"models", "list"}},
	"kimi":     {args: []string{"provider", "list", "--json"}, json: true},
	"auggie":   {args: []string{"models", "list", "--json"}, json: true},
	"devin":    {args: []string{"models", "list", "--format", "json"}, json: true},
	"kiro":     {args: []string{"chat", "--list-models", "--format", "json"}, json: true},
}

// Base returns the picker behavior AO can provide without executing a CLI.
func Base(agentID string) ports.AgentModelCatalog {
	now := time.Now().UTC()
	switch agentID {
	case "claude-code":
		return catalog(agentID, "official-aliases", true, now,
			model("sonnet", "Sonnet", false),
			model("opus", "Opus", false),
			model("haiku", "Haiku", false),
		)
	case "codex":
		return catalog(agentID, "official-catalog", true, now,
			model("gpt-5.6-sol", "GPT-5.6 Sol", true),
			model("gpt-5.6-terra", "GPT-5.6 Terra", false),
			model("gpt-5.6-luna", "GPT-5.6 Luna", false),
			model("gpt-5.5", "GPT-5.5", false),
			model("gpt-5.4", "GPT-5.4", false),
			model("gpt-5.4-mini", "GPT-5.4 mini", false),
			model("gpt-5.3-codex", "GPT-5.3-Codex", false),
		)
	case "amp":
		c := catalog(agentID, "official-modes", false, now,
			model("low", "Low", false),
			model("medium", "Medium", true),
			model("high", "High", false),
			model("ultra", "Ultra", false),
		)
		c.SelectionMode = ports.ModelSelectionModeList
		return c
	default:
		if _, ok := commandSpecs[agentID]; ok {
			return ports.AgentModelCatalog{
				AgentID:       agentID,
				SelectionMode: ports.ModelSelectionCatalog,
				Models:        []ports.AgentModelInfo{},
				AllowCustom:   true,
				Source:        "cli",
				FetchedAt:     now,
			}
		}
		return ports.AgentModelCatalog{
			AgentID:       agentID,
			SelectionMode: ports.ModelSelectionText,
			Models:        []ports.AgentModelInfo{},
			AllowCustom:   true,
			Source:        "manual",
			FetchedAt:     now,
		}
	}
}

// Discover executes a documented non-interactive model-list command when the
// agent exposes one. Static catalogs are returned without executing the binary.
func Discover(ctx context.Context, agentID, binary string) (ports.AgentModelCatalog, error) {
	base := Base(agentID)
	spec, ok := commandSpecs[agentID]
	if !ok {
		return base, nil
	}
	if strings.TrimSpace(binary) == "" {
		return base, errors.New("agent binary is not installed")
	}
	runCtx, cancel := context.WithTimeout(ctx, commandTimeout)
	defer cancel()
	output, err := exec.CommandContext(runCtx, binary, spec.args...).CombinedOutput() //nolint:gosec // binary is adapter-resolved, args are static
	if err != nil {
		return base, fmt.Errorf("%s model discovery: %w", agentID, err)
	}
	var models []ports.AgentModelInfo
	if spec.json {
		models, err = parseJSONModels(output)
	} else {
		models = parseTextModels(string(output))
	}
	if err != nil {
		return base, fmt.Errorf("%s model discovery: %w", agentID, err)
	}
	if len(models) == 0 {
		return base, fmt.Errorf("%s model discovery returned no models", agentID)
	}
	base.Models = models
	base.Source = "cli"
	base.FetchedAt = time.Now().UTC()
	return base, nil
}

// BinaryVersion returns a short best-effort version string for cache
// invalidation. Version probing failure is non-fatal.
func BinaryVersion(ctx context.Context, binary string) string {
	if strings.TrimSpace(binary) == "" {
		return ""
	}
	runCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	output, err := exec.CommandContext(runCtx, binary, "--version").CombinedOutput() //nolint:gosec // adapter-resolved binary
	if err != nil {
		return ""
	}
	line := strings.TrimSpace(string(output))
	if i := strings.IndexByte(line, '\n'); i >= 0 {
		line = line[:i]
	}
	if len(line) > 160 {
		line = line[:160]
	}
	return line
}

func catalog(agentID, source string, allowCustom bool, at time.Time, models ...ports.AgentModelInfo) ports.AgentModelCatalog {
	return ports.AgentModelCatalog{
		AgentID:       agentID,
		SelectionMode: ports.ModelSelectionCatalog,
		Models:        models,
		AllowCustom:   allowCustom,
		Source:        source,
		FetchedAt:     at,
	}
}

func model(id, label string, isDefault bool) ports.AgentModelInfo {
	return ports.AgentModelInfo{ID: id, Label: label, IsDefault: isDefault}
}

func parseTextModels(output string) []ports.AgentModelInfo {
	output = ansiPattern.ReplaceAllString(output, "")
	var models []ports.AgentModelInfo
	for _, line := range strings.Split(output, "\n") {
		line = strings.TrimSpace(strings.TrimLeft(line, "•*-✓>│├└ "))
		if line == "" {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) == 0 {
			continue
		}
		id := strings.Trim(fields[0], "`\"'[](),:")
		lower := strings.ToLower(id)
		if id == "" || lower == "model" || lower == "models" || lower == "provider" || strings.HasPrefix(lower, "available") {
			continue
		}
		models = append(models, ports.AgentModelInfo{ID: id, Label: id})
	}
	return normalize(models)
}

func parseJSONModels(output []byte) ([]ports.AgentModelInfo, error) {
	var root any
	if err := json.Unmarshal(output, &root); err != nil {
		return nil, err
	}
	var models []ports.AgentModelInfo
	var walk func(any)
	walk = func(value any) {
		switch node := value.(type) {
		case []any:
			for _, item := range node {
				walk(item)
			}
		case map[string]any:
			id := firstString(node, "modelId", "model_id", "slug", "model")
			if id == "" {
				if _, isProviderContainer := node["models"]; !isProviderContainer {
					id = firstString(node, "id")
				}
			}
			if id != "" {
				label := firstString(node, "displayName", "display_name", "label", "name")
				if label == "" {
					label = id
				}
				models = append(models, ports.AgentModelInfo{
					ID:        id,
					Label:     label,
					Provider:  firstString(node, "provider", "providerId", "provider_id"),
					IsDefault: firstBool(node, "isDefault", "is_default", "default"),
				})
			}
			for _, child := range node {
				walk(child)
			}
		}
	}
	walk(root)
	return normalize(models), nil
}

func firstString(node map[string]any, keys ...string) string {
	for _, key := range keys {
		if value, ok := node[key].(string); ok && strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func firstBool(node map[string]any, keys ...string) bool {
	for _, key := range keys {
		if value, ok := node[key].(bool); ok {
			return value
		}
	}
	return false
}

func normalize(models []ports.AgentModelInfo) []ports.AgentModelInfo {
	byID := make(map[string]ports.AgentModelInfo, len(models))
	for _, item := range models {
		item.ID = strings.TrimSpace(item.ID)
		if item.ID == "" {
			continue
		}
		if strings.TrimSpace(item.Label) == "" {
			item.Label = item.ID
		}
		if previous, ok := byID[item.ID]; ok {
			if previous.Label == previous.ID && item.Label != item.ID {
				byID[item.ID] = item
			}
			continue
		}
		byID[item.ID] = item
	}
	out := make([]ports.AgentModelInfo, 0, len(byID))
	for _, item := range byID {
		out = append(out, item)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].IsDefault != out[j].IsDefault {
			return out[i].IsDefault
		}
		return strings.ToLower(out[i].Label) < strings.ToLower(out[j].Label)
	})
	return out
}
