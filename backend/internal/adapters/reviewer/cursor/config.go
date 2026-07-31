package cursor

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/hookutil"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

const (
	cursorConfigDirEnv        = "CURSOR_CONFIG_DIR"
	cursorDataDirEnv          = "CURSOR_DATA_DIR"
	cursorConfigFileName      = "cli-config.json"
	cursorConfigMarkerName    = ".ao-reviewer-config"
	cursorConfigMarkerContent = "agent-orchestrator: managed Cursor reviewer configuration\n"
)

var reviewerIDUnsafe = regexp.MustCompile(`[^A-Za-z0-9._-]+`)

var reviewerAllowedPermissions = []string{
	"Read(**)",
	"Shell(git)",
	"Shell(gh)",
	"Shell(ao)",
	"Shell(printf)",
}

var reviewerDeniedPermissions = []string{
	"Write(**)",
	"Shell(rm)",
	"Shell(mv)",
	"Shell(cp)",
	"Shell(sed)",
	"Shell(python)",
	"Shell(node)",
	"Shell(perl)",
}

func reviewerEnv(inv ports.ReviewInvocation) map[string]string {
	profileDir := reviewerProfileDir(inv)
	if profileDir == "" {
		return nil
	}
	return map[string]string{
		cursorConfigDirEnv: profileDir,
		cursorDataDirEnv:   profileDir,
	}
}

func reviewerProfileDir(inv ports.ReviewInvocation) string {
	dataDir := strings.TrimSpace(inv.DataDir)
	if dataDir == "" {
		return ""
	}
	reviewerID := reviewerIDUnsafe.ReplaceAllString(strings.TrimSpace(inv.ReviewerID), "-")
	reviewerID = strings.Trim(reviewerID, "-.")
	if reviewerID == "" {
		reviewerID = "reviewer"
	}
	return filepath.Join(dataDir, "cursor", "reviewers", reviewerID)
}

func installReviewerConfig(ctx context.Context, inv ports.ReviewInvocation) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	profileDir := reviewerProfileDir(inv)
	if profileDir == "" {
		return errors.New("cursor reviewer: AO data directory is required")
	}
	if err := os.MkdirAll(profileDir, 0o700); err != nil {
		return fmt.Errorf("cursor reviewer: create profile: %w", err)
	}

	configPath := filepath.Join(profileDir, cursorConfigFileName)
	markerPath := filepath.Join(profileDir, cursorConfigMarkerName)
	managed, err := reviewerConfigManaged(markerPath)
	if err != nil {
		return err
	}
	if !managed {
		if _, err := os.Stat(configPath); err == nil {
			return fmt.Errorf("cursor reviewer: refusing to overwrite non-AO configuration at %s", configPath)
		} else if !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("cursor reviewer: stat configuration: %w", err)
		}
	}

	config, err := reviewerConfigSeed(configPath, managed)
	if err != nil {
		return err
	}
	config["permissions"] = map[string]any{
		"allow": reviewerAllowList(inv.TaskPromptRoot),
		"deny":  append([]string(nil), reviewerDeniedPermissions...),
	}
	// Cursor 2.5 forces Ask mode into its workspace_readonly sandbox. Keeping
	// sandbox mode enabled here and on argv prevents a copied user preference
	// from disabling that boundary. There is no supported local config token
	// for subcommand-granular git writes.
	sandbox, _ := config["sandbox"].(map[string]any)
	if sandbox == nil {
		sandbox = map[string]any{}
	}
	sandbox["mode"] = "enabled"
	if _, ok := sandbox["networkAccess"]; !ok {
		sandbox["networkAccess"] = "user_config_with_defaults"
	}
	config["sandbox"] = sandbox
	config["approvalMode"] = "allowlist"

	data, err := json.MarshalIndent(config, "", "  ")
	if err != nil {
		return fmt.Errorf("cursor reviewer: encode configuration: %w", err)
	}
	data = append(data, '\n')
	if err := hookutil.AtomicWriteFile(markerPath, []byte(cursorConfigMarkerContent), 0o600); err != nil {
		return fmt.Errorf("cursor reviewer: write ownership marker: %w", err)
	}
	if err := hookutil.AtomicWriteFile(configPath, data, 0o600); err != nil {
		return fmt.Errorf("cursor reviewer: write configuration: %w", err)
	}
	return nil
}

func reviewerConfigManaged(markerPath string) (bool, error) {
	data, err := os.ReadFile(markerPath)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("cursor reviewer: read ownership marker: %w", err)
	}
	if string(data) != cursorConfigMarkerContent {
		return false, fmt.Errorf("cursor reviewer: refusing invalid ownership marker at %s", markerPath)
	}
	return true, nil
}

func reviewerConfigSeed(configPath string, managed bool) (map[string]any, error) {
	path := configPath
	if !managed {
		var err error
		path, err = userCursorConfigPath()
		if err != nil {
			return nil, err
		}
	}
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return map[string]any{"version": 1}, nil
	}
	if err != nil {
		return nil, fmt.Errorf("cursor reviewer: read configuration seed: %w", err)
	}
	var config map[string]any
	if err := json.Unmarshal(data, &config); err != nil {
		return nil, fmt.Errorf("cursor reviewer: decode configuration seed: %w", err)
	}
	return config, nil
}

func userCursorConfigPath() (string, error) {
	if dir := strings.TrimSpace(os.Getenv(cursorConfigDirEnv)); dir != "" {
		return filepath.Join(dir, cursorConfigFileName), nil
	}
	if dir := strings.TrimSpace(os.Getenv("XDG_CONFIG_HOME")); dir != "" {
		return filepath.Join(dir, "cursor", cursorConfigFileName), nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("cursor reviewer: resolve user config: %w", err)
	}
	return filepath.Join(home, ".cursor", cursorConfigFileName), nil
}

func reviewerAllowList(taskPromptRoot string) []string {
	allow := append([]string(nil), reviewerAllowedPermissions...)
	if root := strings.TrimSpace(taskPromptRoot); root != "" {
		allow = append(allow, "Read("+filepath.ToSlash(filepath.Join(root, "**"))+")")
	}
	return allow
}
