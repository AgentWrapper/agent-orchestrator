package modelcatalog

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"

	yaml "gopkg.in/yaml.v3"
)

const maxConfigFileSize = 4 << 20

type configSpec struct {
	paths  func(home, workingDir string) []string
	parser func([]byte) ([]ports.AgentModelInfo, error)
}

var configSpecs = map[string]configSpec{
	"crush": {
		paths: func(home, _ string) []string {
			dataHome := strings.TrimSpace(os.Getenv("XDG_DATA_HOME"))
			if dataHome == "" {
				dataHome = filepath.Join(home, ".local", "share")
			}
			return []string{filepath.Join(dataHome, "crush", "providers.json")}
		},
		parser: parseCrushConfig,
	},
	"continue": {
		paths: func(home, workingDir string) []string {
			return compactPaths(
				filepath.Join(home, ".continue", "config.yaml"),
				filepath.Join(home, ".continue", "config.yml"),
				joinIfSet(workingDir, ".continue", "config.yaml"),
				joinIfSet(workingDir, ".continue", "config.yml"),
			)
		},
		parser: parseContinueConfig,
	},
	"opencode": {
		paths: func(home, workingDir string) []string {
			configHome := strings.TrimSpace(os.Getenv("XDG_CONFIG_HOME"))
			if configHome == "" {
				configHome = filepath.Join(home, ".config")
			}
			return compactPaths(
				filepath.Join(configHome, "opencode", "opencode.json"),
				filepath.Join(configHome, "opencode", "opencode.jsonc"),
				joinIfSet(workingDir, "opencode.json"),
				joinIfSet(workingDir, "opencode.jsonc"),
			)
		},
		parser: parseOpenCodeConfig,
	},
	"qwen": {
		paths: func(home, _ string) []string {
			return []string{filepath.Join(home, ".qwen", "settings.json")}
		},
		parser: parseQwenConfig,
	},
	"kimi": {
		paths: func(home, _ string) []string {
			kimiHome := strings.TrimSpace(os.Getenv("KIMI_CODE_HOME"))
			if kimiHome == "" {
				kimiHome = filepath.Join(home, ".kimi-code")
			}
			return []string{filepath.Join(kimiHome, "config.toml")}
		},
		parser: parseKimiConfig,
	},
}

// ConfigModels reads only declarative, bounded agent configuration files. It
// never expands references, executes plugins, or retains unrelated fields.
func ConfigModels(agentID, workingDir string) ([]ports.AgentModelInfo, error) {
	spec, ok := configSpecs[agentID]
	if !ok {
		return nil, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, fmt.Errorf("resolve user home: %w", err)
	}
	return configModelsFromPaths(spec, spec.paths(home, workingDir))
}

// ConfigVersion returns a non-sensitive fingerprint of the config files that
// can affect a catalog. It uses path, size, and modification time only; config
// contents and credentials are never hashed into or exposed through the API.
func ConfigVersion(agentID, workingDir string) string {
	spec, ok := configSpecs[agentID]
	if !ok {
		return ""
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	hash := sha256.New()
	for _, path := range spec.paths(home, workingDir) {
		_, _ = io.WriteString(hash, path)
		info, err := os.Lstat(path)
		if err != nil || !info.Mode().IsRegular() {
			_, _ = io.WriteString(hash, "\x00missing\x00")
			continue
		}
		_, _ = io.WriteString(hash, "\x00"+strconv.FormatInt(info.Size(), 10))
		_, _ = io.WriteString(hash, "\x00"+strconv.FormatInt(info.ModTime().UnixNano(), 10)+"\x00")
	}
	return fmt.Sprintf("%x", hash.Sum(nil)[:8])
}

func configModelsFromPaths(spec configSpec, paths []string) ([]ports.AgentModelInfo, error) {
	var (
		models []ports.AgentModelInfo
		errs   []error
	)
	for _, path := range paths {
		data, found, err := readBoundedConfig(path)
		if err != nil {
			errs = append(errs, fmt.Errorf("read %s: %w", filepath.Base(path), err))
			continue
		}
		if !found {
			continue
		}
		parsed, err := spec.parser(data)
		if err != nil {
			errs = append(errs, fmt.Errorf("parse %s: %w", filepath.Base(path), err))
			continue
		}
		models = append(models, parsed...)
	}
	return normalize(models), errors.Join(errs...)
}

func readBoundedConfig(path string) ([]byte, bool, error) {
	linkInfo, err := os.Lstat(path)
	if os.IsNotExist(err) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	if linkInfo.Mode()&os.ModeSymlink != 0 {
		return nil, false, errors.New("symbolic links are not read")
	}
	file, err := os.Open(path) //nolint:gosec // paths are fixed per adapter and never supplied by an API caller
	if err != nil {
		return nil, false, err
	}
	defer func() { _ = file.Close() }()
	info, err := file.Stat()
	if err != nil {
		return nil, false, err
	}
	if !info.Mode().IsRegular() {
		return nil, false, errors.New("not a regular file")
	}
	if info.Size() > maxConfigFileSize {
		return nil, false, fmt.Errorf("file exceeds %d bytes", maxConfigFileSize)
	}
	data, err := io.ReadAll(io.LimitReader(file, maxConfigFileSize+1))
	if err != nil {
		return nil, false, err
	}
	if len(data) > maxConfigFileSize {
		return nil, false, fmt.Errorf("file exceeds %d bytes", maxConfigFileSize)
	}
	return data, true, nil
}

func parseCrushConfig(data []byte) ([]ports.AgentModelInfo, error) {
	var providers []struct {
		ID                string `json:"id"`
		DefaultLargeModel string `json:"default_large_model_id"`
		DefaultSmallModel string `json:"default_small_model_id"`
		Models            []struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		} `json:"models"`
	}
	if err := json.Unmarshal(data, &providers); err != nil {
		return nil, err
	}
	var models []ports.AgentModelInfo
	for _, provider := range providers {
		for _, item := range provider.Models {
			models = append(models, ports.AgentModelInfo{
				ID:        item.ID,
				Label:     item.Name,
				Provider:  provider.ID,
				IsDefault: item.ID != "" && (item.ID == provider.DefaultLargeModel || item.ID == provider.DefaultSmallModel),
			})
		}
	}
	return normalize(models), nil
}

func parseContinueConfig(data []byte) ([]ports.AgentModelInfo, error) {
	var root yaml.Node
	if err := yaml.Unmarshal(data, &root); err != nil {
		return nil, err
	}
	var models []ports.AgentModelInfo
	walkYAMLMaps(&root, func(node *yaml.Node) {
		modelID := yamlMapString(node, "model")
		if modelID == "" {
			return
		}
		label := yamlMapString(node, "name")
		if label == "" {
			label = yamlMapString(node, "title")
		}
		models = append(models, ports.AgentModelInfo{
			ID:       modelID,
			Label:    label,
			Provider: yamlMapString(node, "provider"),
		})
	})
	return normalize(models), nil
}

func walkYAMLMaps(node *yaml.Node, visit func(*yaml.Node)) {
	if node == nil {
		return
	}
	if node.Kind == yaml.MappingNode {
		visit(node)
	}
	for _, child := range node.Content {
		walkYAMLMaps(child, visit)
	}
}

func yamlMapString(node *yaml.Node, wanted string) string {
	if node == nil || node.Kind != yaml.MappingNode {
		return ""
	}
	for i := 0; i+1 < len(node.Content); i += 2 {
		if node.Content[i].Value == wanted && node.Content[i+1].Kind == yaml.ScalarNode {
			return strings.TrimSpace(node.Content[i+1].Value)
		}
	}
	return ""
}

func parseOpenCodeConfig(data []byte) ([]ports.AgentModelInfo, error) {
	root, err := parseJSONObject(data)
	if err != nil {
		return nil, err
	}
	var models []ports.AgentModelInfo
	if selected := firstString(root, "model"); selected != "" {
		models = append(models, ports.AgentModelInfo{ID: selected, Label: selected, IsDefault: true})
	}
	providers, _ := root["provider"].(map[string]any)
	for providerID, rawProvider := range providers {
		provider, _ := rawProvider.(map[string]any)
		configured, _ := provider["models"].(map[string]any)
		for modelID, rawModel := range configured {
			item, _ := rawModel.(map[string]any)
			id := providerID + "/" + modelID
			label := firstString(item, "name", "label", "displayName", "display_name")
			models = append(models, ports.AgentModelInfo{ID: id, Label: label, Provider: providerID})
		}
	}
	return normalize(models), nil
}

func parseQwenConfig(data []byte) ([]ports.AgentModelInfo, error) {
	root, err := parseJSONObject(data)
	if err != nil {
		return nil, err
	}
	var models []ports.AgentModelInfo
	if selected := firstString(root, "defaultModel"); selected != "" {
		models = append(models, ports.AgentModelInfo{ID: selected, Label: selected, IsDefault: true})
	}
	if selected, ok := root["model"].(map[string]any); ok {
		if id := firstString(selected, "id", "model"); id != "" {
			models = append(models, ports.AgentModelInfo{ID: id, Label: firstString(selected, "name", "label"), IsDefault: true})
		}
	}
	providers, _ := root["modelProviders"].(map[string]any)
	for providerID, rawModels := range providers {
		items, ok := rawModels.([]any)
		if !ok {
			continue
		}
		for _, rawItem := range items {
			item, _ := rawItem.(map[string]any)
			id := firstString(item, "id", "model", "modelId", "model_id")
			if id == "" {
				continue
			}
			models = append(models, ports.AgentModelInfo{
				ID:       id,
				Label:    firstString(item, "name", "label", "displayName", "display_name"),
				Provider: providerID,
			})
		}
	}
	return normalize(models), nil
}

var kimiModelSection = regexp.MustCompile(`^\s*\[models\.(?:"([^"]+)"|'([^']+)'|([^\]]+))\]\s*(?:#.*)?$`)

func parseKimiConfig(data []byte) ([]ports.AgentModelInfo, error) {
	var (
		models      []ports.AgentModelInfo
		current     *ports.AgentModelInfo
		defaultID   string
		sectionSeen bool
	)
	flush := func() {
		if current != nil {
			models = append(models, *current)
			current = nil
		}
	}
	for _, rawLine := range strings.Split(string(data), "\n") {
		line := strings.TrimSpace(rawLine)
		if matches := kimiModelSection.FindStringSubmatch(line); matches != nil {
			flush()
			sectionSeen = true
			id := firstNonEmpty(matches[1:]...)
			current = &ports.AgentModelInfo{ID: strings.TrimSpace(id), Label: strings.TrimSpace(id)}
			continue
		}
		if strings.HasPrefix(line, "[") {
			flush()
			sectionSeen = false
			continue
		}
		key, value, ok := parseTOMLStringAssignment(line)
		if !ok {
			continue
		}
		if !sectionSeen && key == "default_model" {
			defaultID = value
		}
		if current == nil {
			continue
		}
		switch key {
		case "display_name", "name":
			current.Label = value
		case "provider":
			current.Provider = value
		}
	}
	flush()
	if defaultID != "" {
		models = append(models, ports.AgentModelInfo{ID: defaultID, Label: defaultID, IsDefault: true})
	}
	for i := range models {
		models[i].IsDefault = models[i].IsDefault || models[i].ID == defaultID
	}
	return normalize(models), nil
}

func parseTOMLStringAssignment(line string) (string, string, bool) {
	if line == "" || strings.HasPrefix(line, "#") {
		return "", "", false
	}
	key, raw, ok := strings.Cut(line, "=")
	if !ok {
		return "", "", false
	}
	key = strings.TrimSpace(key)
	raw = strings.TrimSpace(raw)
	if len(raw) < 2 || (raw[0] != '"' && raw[0] != '\'') {
		return "", "", false
	}
	quote := raw[0]
	var value strings.Builder
	escaped := false
	for i := 1; i < len(raw); i++ {
		char := raw[i]
		if escaped {
			value.WriteByte(char)
			escaped = false
			continue
		}
		if quote == '"' && char == '\\' {
			escaped = true
			continue
		}
		if char == quote {
			return key, value.String(), true
		}
		value.WriteByte(char)
	}
	return "", "", false
}

func parseJSONObject(data []byte) (map[string]any, error) {
	var root map[string]any
	if err := json.Unmarshal(data, &root); err == nil {
		return root, nil
	}
	cleaned, err := stripJSONC(data)
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(cleaned, &root); err != nil {
		return nil, err
	}
	return root, nil
}

func stripJSONC(data []byte) ([]byte, error) {
	var out bytes.Buffer
	inString, escaped, lineComment, blockComment := false, false, false, false
	for i := 0; i < len(data); i++ {
		char := data[i]
		if lineComment {
			if char == '\n' {
				lineComment = false
				out.WriteByte(char)
			}
			continue
		}
		if blockComment {
			if char == '*' && i+1 < len(data) && data[i+1] == '/' {
				blockComment = false
				i++
			} else if char == '\n' {
				out.WriteByte(char)
			}
			continue
		}
		if inString {
			out.WriteByte(char)
			if escaped {
				escaped = false
			} else if char == '\\' {
				escaped = true
			} else if char == '"' {
				inString = false
			}
			continue
		}
		switch {
		case char == '"':
			inString = true
			out.WriteByte(char)
		case char == '/' && i+1 < len(data) && data[i+1] == '/':
			lineComment = true
			i++
		case char == '/' && i+1 < len(data) && data[i+1] == '*':
			blockComment = true
			i++
		default:
			out.WriteByte(char)
		}
	}
	if inString || blockComment {
		return nil, errors.New("unterminated JSONC string or comment")
	}
	return removeJSONCTrailingCommas(out.Bytes()), nil
}

func removeJSONCTrailingCommas(data []byte) []byte {
	out := make([]byte, 0, len(data))
	inString, escaped := false, false
	for i := 0; i < len(data); i++ {
		char := data[i]
		if inString {
			out = append(out, char)
			if escaped {
				escaped = false
			} else if char == '\\' {
				escaped = true
			} else if char == '"' {
				inString = false
			}
			continue
		}
		if char == '"' {
			inString = true
			out = append(out, char)
			continue
		}
		if char == ',' {
			next := i + 1
			for next < len(data) && strings.ContainsRune(" \t\r\n", rune(data[next])) {
				next++
			}
			if next < len(data) && (data[next] == '}' || data[next] == ']') {
				continue
			}
		}
		out = append(out, char)
	}
	return out
}

func joinIfSet(root string, parts ...string) string {
	if strings.TrimSpace(root) == "" {
		return ""
	}
	return filepath.Join(append([]string{root}, parts...)...)
}

func compactPaths(paths ...string) []string {
	out := make([]string, 0, len(paths))
	for _, path := range paths {
		if strings.TrimSpace(path) != "" {
			out = append(out, path)
		}
	}
	return out
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}
