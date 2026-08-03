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
	"runtime"
	"strconv"
	"strings"

	"github.com/pelletier/go-toml/v2"
	yaml "gopkg.in/yaml.v3"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

const maxConfigFileSize = 4 << 20

type configSpec struct {
	paths  func(configPathContext) []configPath
	parser func([]byte) ([]ports.AgentModelInfo, error)
}

type configPathContext struct {
	home       string
	workingDir string
	goos       string
	getenv     func(string) string
}

type configPath struct {
	root string
	name string
}

var configSpecs = map[string]configSpec{
	"crush": {
		paths:  crushConfigPaths,
		parser: parseCrushConfig,
	},
	"continue": {
		paths: func(ctx configPathContext) []configPath {
			return compactPaths(
				configPath{root: ctx.home, name: filepath.Join(".continue", "config.yaml")},
				configPath{root: ctx.home, name: filepath.Join(".continue", "config.yml")},
				configPath{root: ctx.workingDir, name: filepath.Join(".continue", "config.yaml")},
				configPath{root: ctx.workingDir, name: filepath.Join(".continue", "config.yml")},
			)
		},
		parser: parseContinueConfig,
	},
	"opencode": {
		paths:  openCodeConfigPaths,
		parser: parseOpenCodeConfig,
	},
	"qwen": {
		paths:  qwenConfigPaths,
		parser: parseQwenConfig,
	},
	"kimi": {
		paths: func(ctx configPathContext) []configPath {
			kimiHome := envValue(ctx, "KIMI_CODE_HOME")
			if kimiHome == "" {
				kimiHome = filepath.Join(ctx.home, ".kimi-code")
			} else {
				kimiHome = resolveConfigLocation(ctx, kimiHome)
			}
			return []configPath{{root: kimiHome, name: "config.toml"}}
		},
		parser: parseKimiConfig,
	},
}

func defaultConfigPathContext(home, workingDir string) configPathContext {
	return configPathContext{
		home:       home,
		workingDir: workingDir,
		goos:       runtime.GOOS,
		getenv:     os.Getenv,
	}
}

func crushConfigPaths(ctx configPathContext) []configPath {
	configHome := envValue(ctx, "XDG_CONFIG_HOME")
	if configHome == "" {
		configHome = filepath.Join(ctx.home, ".config")
	}
	dataHome := envValue(ctx, "XDG_DATA_HOME")
	if dataHome == "" {
		if ctx.goos == "windows" {
			dataHome = localAppData(ctx)
		} else {
			dataHome = filepath.Join(ctx.home, ".local", "share")
		}
	}

	globalConfigDir := envValue(ctx, "CRUSH_GLOBAL_CONFIG")
	if globalConfigDir == "" {
		globalConfigDir = filepath.Join(configHome, "crush")
	} else {
		globalConfigDir = resolveConfigLocation(ctx, globalConfigDir)
	}
	globalDataDir := envValue(ctx, "CRUSH_GLOBAL_DATA")
	if globalDataDir == "" {
		globalDataDir = filepath.Join(dataHome, "crush")
	} else {
		globalDataDir = resolveConfigLocation(ctx, globalDataDir)
	}

	paths := []configPath{
		{root: globalConfigDir, name: "crush.json"},
		{root: globalDataDir, name: "crush.json"},
		// providers.json is the Catwalk model cache used by both current
		// releases and older Crush installations.
		{root: filepath.Join(dataHome, "crush"), name: "providers.json"},
	}
	if legacyDataDir := envValue(ctx, "CRUSH_DATA_DIR"); legacyDataDir != "" {
		paths = append(paths, configPath{root: resolveConfigLocation(ctx, legacyDataDir), name: "providers.json"})
	}
	for _, dir := range projectConfigDirs(ctx.workingDir) {
		// Crush loads the hidden file after crush.json, so keep it last.
		paths = append(paths,
			configPath{root: dir, name: "crush.json"},
			configPath{root: dir, name: ".crush.json"},
		)
	}
	return compactPaths(paths...)
}

func openCodeConfigPaths(ctx configPathContext) []configPath {
	configHome := envValue(ctx, "XDG_CONFIG_HOME")
	if configHome == "" {
		configHome = filepath.Join(ctx.home, ".config")
	}
	paths := []configPath{
		{root: filepath.Join(configHome, "opencode"), name: "opencode.json"},
		{root: filepath.Join(configHome, "opencode"), name: "opencode.jsonc"},
	}
	if custom := configFileFromEnv(ctx, "OPENCODE_CONFIG"); custom.name != "" {
		paths = append(paths, custom)
	}

	dirs := projectConfigDirs(ctx.workingDir)
	for _, dir := range dirs {
		paths = append(paths,
			configPath{root: dir, name: "opencode.json"},
			configPath{root: dir, name: "opencode.jsonc"},
		)
	}
	for _, dir := range dirs {
		paths = append(paths,
			configPath{root: filepath.Join(dir, ".opencode"), name: "opencode.json"},
			configPath{root: filepath.Join(dir, ".opencode"), name: "opencode.jsonc"},
		)
	}
	if customDir := envValue(ctx, "OPENCODE_CONFIG_DIR"); customDir != "" {
		customDir = resolveConfigLocation(ctx, customDir)
		paths = append(paths,
			configPath{root: customDir, name: "opencode.json"},
			configPath{root: customDir, name: "opencode.jsonc"},
		)
	}
	if managed := openCodeManagedConfigDir(ctx); managed != "" {
		paths = append(paths,
			configPath{root: managed, name: "opencode.json"},
			configPath{root: managed, name: "opencode.jsonc"},
		)
	}
	return compactPaths(paths...)
}

func qwenConfigPaths(ctx configPathContext) []configPath {
	paths := make([]configPath, 0, 5)
	if defaults := configFileFromEnv(ctx, "QWEN_CODE_SYSTEM_DEFAULTS_PATH"); defaults.name != "" {
		paths = append(paths, defaults)
	} else if root := qwenSystemConfigDir(ctx); root != "" {
		paths = append(paths, configPath{root: root, name: "system-defaults.json"})
	}

	qwenHome := envValue(ctx, "QWEN_HOME")
	if qwenHome == "" {
		qwenHome = filepath.Join(ctx.home, ".qwen")
	} else {
		qwenHome = resolveConfigLocation(ctx, qwenHome)
	}
	paths = append(paths, configPath{root: qwenHome, name: "settings.json"})
	if ctx.workingDir != "" {
		paths = append(paths, configPath{root: ctx.workingDir, name: filepath.Join(".qwen", "settings.json")})
	}

	if settings := configFileFromEnv(ctx, "QWEN_CODE_SYSTEM_SETTINGS_PATH"); settings.name != "" {
		paths = append(paths, settings)
	} else if root := qwenSystemConfigDir(ctx); root != "" {
		paths = append(paths, configPath{root: root, name: "settings.json"})
	}
	return compactPaths(paths...)
}

func openCodeManagedConfigDir(ctx configPathContext) string {
	switch ctx.goos {
	case "darwin":
		return filepath.Join(string(filepath.Separator), "Library", "Application Support", "opencode")
	case "linux":
		return filepath.Join(string(filepath.Separator), "etc", "opencode")
	case "windows":
		programData := envValue(ctx, "ProgramData")
		if programData == "" {
			programData = `C:\ProgramData`
		}
		return filepath.Join(programData, "opencode")
	default:
		return ""
	}
}

func qwenSystemConfigDir(ctx configPathContext) string {
	switch ctx.goos {
	case "darwin":
		return filepath.Join(string(filepath.Separator), "Library", "Application Support", "QwenCode")
	case "linux":
		return filepath.Join(string(filepath.Separator), "etc", "qwen-code")
	case "windows":
		programData := envValue(ctx, "ProgramData")
		if programData == "" {
			programData = `C:\ProgramData`
		}
		return filepath.Join(programData, "qwen-code")
	default:
		return ""
	}
}

func localAppData(ctx configPathContext) string {
	if dir := envValue(ctx, "LOCALAPPDATA"); dir != "" {
		return dir
	}
	return filepath.Join(ctx.home, "AppData", "Local")
}

func configFileFromEnv(ctx configPathContext, name string) configPath {
	value := envValue(ctx, name)
	if value == "" {
		return configPath{}
	}
	value = resolveConfigLocation(ctx, value)
	return configPath{root: filepath.Dir(value), name: filepath.Base(value)}
}

func resolveConfigLocation(ctx configPathContext, value string) string {
	value = strings.TrimSpace(value)
	if value == "~" {
		return ctx.home
	}
	if strings.HasPrefix(value, "~/") || strings.HasPrefix(value, `~\`) {
		return filepath.Join(ctx.home, value[2:])
	}
	if !filepath.IsAbs(value) && ctx.workingDir != "" {
		return filepath.Join(ctx.workingDir, value)
	}
	return value
}

func envValue(ctx configPathContext, name string) string {
	if ctx.getenv == nil {
		return ""
	}
	return strings.TrimSpace(ctx.getenv(name))
}

// projectConfigDirs mirrors agents that walk upward only within the current
// Git worktree. If no worktree marker is found, it intentionally returns the
// working directory alone rather than adopting unrelated parent configs.
func projectConfigDirs(workingDir string) []string {
	if strings.TrimSpace(workingDir) == "" {
		return nil
	}
	start, err := filepath.Abs(workingDir)
	if err != nil {
		start = filepath.Clean(workingDir)
	}
	boundary := start
	for dir := start; ; dir = filepath.Dir(dir) {
		if _, err := os.Lstat(filepath.Join(dir, ".git")); err == nil {
			boundary = dir
			break
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
	}

	var reversed []string
	for dir := start; ; dir = filepath.Dir(dir) {
		reversed = append(reversed, dir)
		if dir == boundary {
			break
		}
	}
	for left, right := 0, len(reversed)-1; left < right; left, right = left+1, right-1 {
		reversed[left], reversed[right] = reversed[right], reversed[left]
	}
	return reversed
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
	return configModelsFromPaths(spec, spec.paths(defaultConfigPathContext(home, workingDir)))
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
	for _, path := range spec.paths(defaultConfigPathContext(home, workingDir)) {
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

// openSecureConfig resolves platform path aliases, opens the configured root
// without trusting its pathname after resolution, rejects symlink components,
// and verifies that the final opened file is the inode that was inspected.
func openSecureConfig(path configPath) (*os.File, bool, error) {
	if strings.TrimSpace(path.root) == "" || strings.TrimSpace(path.name) == "" || filepath.IsAbs(path.name) {
		return nil, false, errors.New("invalid config path")
	}
	clean := filepath.Clean(path.name)
	if clean == "." || clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
		return nil, false, errors.New("config path escapes trusted root")
	}
	root, err := openSecureConfigRoot(path.root)
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

func openSecureConfigRoot(name string) (*os.Root, error) {
	info, err := os.Lstat(name)
	if err != nil {
		return nil, err
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		return nil, errors.New("config root is not a non-symlink directory")
	}

	// Resolve parent aliases such as macOS /var -> /private/var once, then walk
	// the resolved absolute path through directory handles. Subsequent pathname
	// swaps cannot redirect traversal outside an already-open parent.
	resolved, err := filepath.EvalSymlinks(name)
	if err != nil {
		return nil, err
	}
	resolved, err = filepath.Abs(resolved)
	if err != nil {
		return nil, err
	}
	volume := filepath.VolumeName(resolved)
	rootName := volume + string(filepath.Separator)
	root, err := os.OpenRoot(rootName)
	if err != nil {
		return nil, err
	}
	relative := strings.TrimPrefix(resolved, rootName)
	parts := strings.FieldsFunc(relative, func(r rune) bool { return r == '/' || r == '\\' })
	for _, part := range parts {
		before, err := root.Lstat(part)
		if err != nil {
			_ = root.Close()
			return nil, err
		}
		if before.Mode()&os.ModeSymlink != 0 || !before.IsDir() {
			_ = root.Close()
			return nil, errors.New("config root contains a symbolic link or non-directory component")
		}
		next, err := root.OpenRoot(part)
		if err != nil {
			_ = root.Close()
			return nil, err
		}
		after, err := next.Lstat(".")
		if err != nil || !os.SameFile(before, after) {
			_ = next.Close()
			_ = root.Close()
			if err != nil {
				return nil, err
			}
			return nil, errors.New("config root changed during secure open")
		}
		if err := root.Close(); err != nil {
			_ = next.Close()
			return nil, err
		}
		root = next
	}
	opened, err := root.Lstat(".")
	if err != nil || !os.SameFile(info, opened) {
		_ = root.Close()
		if err != nil {
			return nil, err
		}
		return nil, errors.New("config root changed during secure open")
	}
	return root, nil
}

func parseCrushConfig(data []byte) ([]ports.AgentModelInfo, error) {
	trimmed := bytes.TrimSpace(data)
	if len(trimmed) == 0 {
		return nil, nil
	}
	if trimmed[0] == '{' {
		return parseCurrentCrushConfig(trimmed)
	}
	return parseLegacyCrushProviders(trimmed)
}

func parseLegacyCrushProviders(data []byte) ([]ports.AgentModelInfo, error) {
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
			id := qualifyModelID(provider.ID, item.ID)
			models = append(models, ports.AgentModelInfo{
				ID:        id,
				Label:     item.Name,
				Provider:  provider.ID,
				IsDefault: item.ID != "" && (item.ID == provider.DefaultLargeModel || item.ID == provider.DefaultSmallModel || id == provider.DefaultLargeModel || id == provider.DefaultSmallModel),
			})
		}
	}
	return normalize(models), nil
}

func parseCurrentCrushConfig(data []byte) ([]ports.AgentModelInfo, error) {
	var config struct {
		Providers map[string]struct {
			Name   string `json:"name"`
			Models []struct {
				ID   string `json:"id"`
				Name string `json:"name"`
			} `json:"models"`
		} `json:"providers"`
		Models map[string]struct {
			Provider string `json:"provider"`
			Model    string `json:"model"`
		} `json:"models"`
	}
	if err := json.Unmarshal(data, &config); err != nil {
		return nil, err
	}
	defaults := make(map[string]bool, len(config.Models))
	var models []ports.AgentModelInfo
	for _, selected := range config.Models {
		id := qualifyModelID(selected.Provider, selected.Model)
		if id == "" {
			continue
		}
		defaults[id] = true
		models = append(models, ports.AgentModelInfo{ID: id, Label: id, Provider: selected.Provider, IsDefault: true})
	}
	for providerID, provider := range config.Providers {
		for _, item := range provider.Models {
			id := qualifyModelID(providerID, item.ID)
			models = append(models, ports.AgentModelInfo{
				ID:        id,
				Label:     item.Name,
				Provider:  providerID,
				IsDefault: defaults[id],
			})
		}
	}
	return normalize(models), nil
}

func qualifyModelID(provider, model string) string {
	provider = strings.Trim(strings.TrimSpace(provider), "/")
	model = strings.Trim(strings.TrimSpace(model), "/")
	if model == "" {
		return ""
	}
	if provider == "" || strings.HasPrefix(model, provider+"/") {
		return model
	}
	return provider + "/" + model
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
		if id := firstString(selected, "id", "model", "name"); id != "" {
			models = append(models, ports.AgentModelInfo{ID: id, Label: firstString(selected, "name", "label"), IsDefault: true})
		}
	}
	providers, _ := root["modelProviders"].(map[string]any)
	for providerID, rawProvider := range providers {
		// Current Qwen uses {protocol, models:[...]}; older releases used
		// modelProviders.<provider> as the model array directly.
		rawModels := rawProvider
		if provider, ok := rawProvider.(map[string]any); ok {
			rawModels = provider["models"]
		}
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
	seen := make(map[string]struct{}, len(paths))
	for _, path := range paths {
		path.root = strings.TrimSpace(path.root)
		path.name = strings.TrimSpace(path.name)
		if path.root == "" || path.name == "" {
			continue
		}
		key := filepath.Clean(path.root) + "\x00" + filepath.Clean(path.name)
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, path)
	}
	return out
}
