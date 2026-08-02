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
	"strconv"
	"strings"

	"github.com/pelletier/go-toml/v2"
	yaml "gopkg.in/yaml.v3"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

const maxConfigFileSize = 4 << 20

type configSpec struct {
	paths  func(home, workingDir string) []configPath
	parser func([]byte) ([]ports.AgentModelInfo, error)
}

type configPath struct {
	root string
	name string
}

var configSpecs = map[string]configSpec{
	"crush": {
		paths: func(home, _ string) []configPath {
			dataHome := strings.TrimSpace(os.Getenv("XDG_DATA_HOME"))
			if dataHome == "" {
				dataHome = filepath.Join(home, ".local", "share")
			}
			return []configPath{{root: dataHome, name: filepath.Join("crush", "providers.json")}}
		},
		parser: parseCrushConfig,
	},
	"continue": {
		paths: func(home, workingDir string) []configPath {
			return compactPaths(
				configPath{root: home, name: filepath.Join(".continue", "config.yaml")},
				configPath{root: home, name: filepath.Join(".continue", "config.yml")},
				configPath{root: workingDir, name: filepath.Join(".continue", "config.yaml")},
				configPath{root: workingDir, name: filepath.Join(".continue", "config.yml")},
			)
		},
		parser: parseContinueConfig,
	},
	"opencode": {
		paths: func(home, workingDir string) []configPath {
			configHome := strings.TrimSpace(os.Getenv("XDG_CONFIG_HOME"))
			if configHome == "" {
				configHome = filepath.Join(home, ".config")
			}
			return compactPaths(
				configPath{root: configHome, name: filepath.Join("opencode", "opencode.json")},
				configPath{root: configHome, name: filepath.Join("opencode", "opencode.jsonc")},
				configPath{root: workingDir, name: "opencode.json"},
				configPath{root: workingDir, name: "opencode.jsonc"},
			)
		},
		parser: parseOpenCodeConfig,
	},
	"qwen": {
		paths: func(home, _ string) []configPath {
			return []configPath{{root: home, name: filepath.Join(".qwen", "settings.json")}}
		},
		parser: parseQwenConfig,
	},
	"kimi": {
		paths: func(home, _ string) []configPath {
			kimiHome := strings.TrimSpace(os.Getenv("KIMI_CODE_HOME"))
			if kimiHome == "" {
				kimiHome = filepath.Join(home, ".kimi-code")
			}
			return []configPath{{root: kimiHome, name: "config.toml"}}
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
		_, _ = io.WriteString(hash, path.root+"\x00"+path.name)
		file, found, err := openSecureConfig(path)
		if err != nil || !found {
			_, _ = io.WriteString(hash, "\x00missing\x00")
			continue
		}
		info, statErr := file.Stat()
		_ = file.Close()
		if statErr != nil || !info.Mode().IsRegular() {
			_, _ = io.WriteString(hash, "\x00missing\x00")
			continue
		}
		_, _ = io.WriteString(hash, "\x00"+strconv.FormatInt(info.Size(), 10))
		_, _ = io.WriteString(hash, "\x00"+strconv.FormatInt(info.ModTime().UnixNano(), 10)+"\x00")
	}
	return fmt.Sprintf("%x", hash.Sum(nil)[:8])
}

func configModelsFromPaths(spec configSpec, paths []configPath) ([]ports.AgentModelInfo, error) {
	var (
		models []ports.AgentModelInfo
		errs   []error
	)
	for _, path := range paths {
		data, found, err := readBoundedConfig(path)
		if err != nil {
			errs = append(errs, fmt.Errorf("read %s: %w", filepath.Base(path.name), err))
			continue
		}
		if !found {
			continue
		}
		parsed, err := spec.parser(data)
		if err != nil {
			errs = append(errs, fmt.Errorf("parse %s: %w", filepath.Base(path.name), err))
			continue
		}
		models = append(models, parsed...)
	}
	return normalize(models), errors.Join(errs...)
}

func readBoundedConfig(path configPath) ([]byte, bool, error) {
	file, found, err := openSecureConfig(path)
	if err != nil {
		return nil, false, err
	}
	if !found {
		return nil, false, nil
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

// openSecureConfig walks from an already-open trusted root, rejects symlink
// components, and verifies that the final opened file is the inode that was
// inspected. os.Root prevents a raced component from escaping the trusted tree.
func openSecureConfig(path configPath) (*os.File, bool, error) {
	if strings.TrimSpace(path.root) == "" || strings.TrimSpace(path.name) == "" || filepath.IsAbs(path.name) {
		return nil, false, errors.New("invalid config path")
	}
	clean := filepath.Clean(path.name)
	if clean == "." || clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
		return nil, false, errors.New("config path escapes trusted root")
	}
	root, err := os.OpenRoot(path.root)
	if os.IsNotExist(err) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	defer func() { _ = root.Close() }()

	parts := strings.FieldsFunc(clean, func(r rune) bool { return r == '/' || r == '\\' })
	for _, part := range parts[:len(parts)-1] {
		info, err := root.Lstat(part)
		if os.IsNotExist(err) {
			return nil, false, nil
		}
		if err != nil {
			return nil, false, err
		}
		if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
			return nil, false, errors.New("config path contains a symbolic link or non-directory component")
		}
		next, err := root.OpenRoot(part)
		if err != nil {
			return nil, false, err
		}
		openedInfo, err := next.Lstat(".")
		if err != nil || !os.SameFile(info, openedInfo) {
			_ = next.Close()
			if err != nil {
				return nil, false, err
			}
			return nil, false, errors.New("config directory changed during secure open")
		}
		if err := root.Close(); err != nil {
			_ = next.Close()
			return nil, false, err
		}
		root = next
	}

	name := parts[len(parts)-1]
	before, err := root.Lstat(name)
	if os.IsNotExist(err) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	if before.Mode()&os.ModeSymlink != 0 || !before.Mode().IsRegular() {
		return nil, false, errors.New("config is not a regular non-symlink file")
	}
	file, err := root.Open(name)
	if err != nil {
		return nil, false, err
	}
	after, err := file.Stat()
	if err != nil || !after.Mode().IsRegular() || !os.SameFile(before, after) {
		_ = file.Close()
		if err != nil {
			return nil, false, err
		}
		return nil, false, errors.New("config changed during secure open")
	}
	return file, true, nil
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

func parseKimiConfig(data []byte) ([]ports.AgentModelInfo, error) {
	var config struct {
		DefaultModel string `toml:"default_model"`
		Models       map[string]struct {
			Provider    string `toml:"provider"`
			DisplayName string `toml:"display_name"`
			Name        string `toml:"name"`
		} `toml:"models"`
	}
	if err := toml.Unmarshal(data, &config); err != nil {
		return nil, err
	}
	models := make([]ports.AgentModelInfo, 0, len(config.Models)+1)
	for id, item := range config.Models {
		label := item.DisplayName
		if label == "" {
			label = item.Name
		}
		models = append(models, ports.AgentModelInfo{
			ID:        id,
			Label:     label,
			Provider:  item.Provider,
			IsDefault: id == config.DefaultModel,
		})
	}
	if config.DefaultModel != "" {
		models = append(models, ports.AgentModelInfo{ID: config.DefaultModel, Label: config.DefaultModel, IsDefault: true})
	}
	return normalize(models), nil
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
	// A line comment is valid through EOF; only strings and block comments
	// require an explicit terminator.
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

func compactPaths(paths ...configPath) []configPath {
	out := make([]configPath, 0, len(paths))
	for _, path := range paths {
		if strings.TrimSpace(path.root) != "" && strings.TrimSpace(path.name) != "" {
			out = append(out, path)
		}
	}
	return out
}
