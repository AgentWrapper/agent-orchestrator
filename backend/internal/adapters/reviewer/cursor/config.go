package cursor

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/hookutil"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

const (
	cursorDataDirEnv     = "CURSOR_DATA_DIR"
	cursorConfigFileName = "cli-config.json"
)

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
}

type reviewerConfig struct {
	Version     int                 `json:"version"`
	AuthInfo    map[string]any      `json:"authInfo,omitempty"`
	Permissions reviewerPermissions `json:"permissions"`
}

type reviewerPermissions struct {
	Allow []string `json:"allow"`
	Deny  []string `json:"deny"`
}

func reviewerEnv(inv ports.ReviewInvocation) map[string]string {
	profileDir := reviewerProfileDir(inv)
	if profileDir == "" {
		return nil
	}
	return map[string]string{cursorDataDirEnv: profileDir}
}

func reviewerProfileDir(inv ports.ReviewInvocation) string {
	dataDir := strings.TrimSpace(inv.DataDir)
	if dataDir == "" {
		return ""
	}
	sum := sha256.Sum256([]byte(inv.ReviewerID))
	return filepath.Join(dataDir, "cursor-reviewers", hex.EncodeToString(sum[:8]))
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

	authInfo, err := hostCursorAuthInfo()
	if err != nil {
		return fmt.Errorf("cursor reviewer: read host auth info: %w", err)
	}
	config := reviewerConfig{
		Version:  1,
		AuthInfo: authInfo,
		Permissions: reviewerPermissions{
			Allow: reviewerAllowList(inv.TaskPromptRoot),
			Deny:  append([]string(nil), reviewerDeniedPermissions...),
		},
	}
	data, err := json.MarshalIndent(config, "", "  ")
	if err != nil {
		return fmt.Errorf("cursor reviewer: encode configuration: %w", err)
	}
	data = append(data, '\n')
	configPath := filepath.Join(profileDir, cursorConfigFileName)
	if err := hookutil.AtomicWriteFile(configPath, data, 0o600); err != nil {
		return fmt.Errorf("cursor reviewer: write configuration: %w", err)
	}
	return nil
}

func hostCursorAuthInfo() (map[string]any, error) {
	home, err := os.UserHomeDir()
	if err == nil {
		home = strings.TrimSpace(home)
	}
	if home == "" {
		return nil, nil
	}
	data, err := os.ReadFile(filepath.Join(home, ".cursor", cursorConfigFileName))
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(string(data)) == "" {
		return nil, nil
	}
	type cursorConfig struct {
		AuthInfo map[string]any `json:"authInfo"`
	}
	var configs []cursorConfig
	if err := json.Unmarshal(data, &configs); err != nil {
		var config cursorConfig
		if err := json.Unmarshal(data, &config); err != nil {
			return nil, err
		}
		configs = []cursorConfig{config}
	}
	for _, config := range configs {
		if cursorAuthInfoHasIdentity(config.AuthInfo) {
			return config.AuthInfo, nil
		}
	}
	return nil, nil
}

func cursorAuthInfoHasIdentity(info map[string]any) bool {
	if len(info) == 0 {
		return false
	}
	for _, key := range []string{"userId", "authId", "email", "displayName"} {
		value, ok := info[key]
		if !ok {
			continue
		}
		switch v := value.(type) {
		case string:
			if strings.TrimSpace(v) != "" {
				return true
			}
		case nil:
		default:
			return true
		}
	}
	return false
}

func reviewerAllowList(taskPromptRoot string) []string {
	allow := append([]string(nil), reviewerAllowedPermissions...)
	if root := strings.TrimSpace(taskPromptRoot); root != "" {
		allow = append(allow, "Read("+filepath.ToSlash(filepath.Join(root, "**"))+")")
	}
	return allow
}
