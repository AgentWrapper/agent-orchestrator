package codex

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/hookutil"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

const codexAOProfileMarker = "# AO-managed Codex session profile; do not edit."

// codexSessionProfileName derives a plain, collision-resistant profile name
// from the AO data root plus stable session identity. Session ids are unique
// only inside one AO database, while development and packaged AO instances can
// share a CODEX_HOME, so the data root must participate in the namespace.
func codexSessionProfileName(dataDir, sessionID string) (string, bool) {
	sessionID = strings.TrimSpace(sessionID)
	if sessionID == "" {
		return "", false
	}
	identity := sessionID
	if dataDir = strings.TrimSpace(dataDir); dataDir != "" {
		identity = filepath.Clean(dataDir) + "\x00" + sessionID
	}
	sum := sha256.Sum256([]byte(identity))
	return fmt.Sprintf("ao-%x", sum[:16]), true
}

func codexProfileHeader(profileName string) string {
	return codexAOProfileMarker + "\n# profile: " + profileName + "\n"
}

func hasCodexStandingInstructions(systemPrompt, systemPromptFile string) bool {
	return systemPrompt != "" || systemPromptFile != ""
}

// appendCodexStandingInstructions selects a named AO profile when a stable AO
// session id and AO data root are available. developer_instructions in that
// profile layers onto Codex's built-in instructions, unlike
// model_instructions_file, which replaces them. Direct adapter callers without
// prepared AO session state retain the inline fallback.
func appendCodexStandingInstructions(cmd *[]string, dataDir, sessionID, systemPrompt, systemPromptFile string) error {
	if strings.TrimSpace(dataDir) != "" && hasCodexStandingInstructions(systemPrompt, systemPromptFile) {
		if profileName, ok := codexSessionProfileName(dataDir, sessionID); ok {
			*cmd = append(*cmd, "--profile", profileName)
			return nil
		}
	}

	prompt, err := codexSystemPromptText(systemPrompt, systemPromptFile)
	if err != nil {
		return err
	}
	if prompt != "" {
		*cmd = append(*cmd, "-c", "developer_instructions="+codexTOMLConfigString(prompt))
	}
	return nil
}

func codexSystemPromptText(systemPrompt, systemPromptFile string) (string, error) {
	if systemPromptFile == "" {
		return systemPrompt, nil
	}
	info, err := os.Stat(systemPromptFile)
	if err != nil {
		return "", fmt.Errorf("codex: inspect system prompt file: %w", err)
	}
	if !info.Mode().IsRegular() {
		return "", fmt.Errorf("codex: system prompt file %q is not a regular file", systemPromptFile)
	}
	data, err := os.ReadFile(systemPromptFile) //nolint:gosec // path is AO-owned launch config
	if err != nil {
		return "", fmt.Errorf("codex: read system prompt file: %w", err)
	}
	return strings.TrimRight(string(data), "\n"), nil
}

func readOwnedCodexProfile(path, header, operation string) (os.FileInfo, bool, error) {
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, fmt.Errorf("codex: inspect existing profile: %w", err)
	}
	// Lstat deliberately rejects symlinks before any read. Besides preventing
	// AO from claiming a user-owned target, it keeps a FIFO at this predictable
	// path from blocking the daemon during preflight or cleanup.
	if !info.Mode().IsRegular() || (runtime.GOOS != "windows" && info.Mode().Perm() != 0o600) {
		return nil, true, fmt.Errorf("codex: refusing to %s non-AO profile at %s", operation, path)
	}
	data, err := os.ReadFile(path) //nolint:gosec // Lstat-validated deterministic path under Codex config root
	if err != nil {
		return nil, true, fmt.Errorf("codex: read existing profile: %w", err)
	}
	if !bytes.HasPrefix(data, []byte(header)) {
		return nil, true, fmt.Errorf("codex: refusing to %s non-AO profile at %s", operation, path)
	}
	return info, true, nil
}

func (p *Plugin) installSessionProfile(ctx context.Context, cfg ports.WorkspaceHookConfig) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	profileName, ok := codexSessionProfileName(cfg.DataDir, cfg.SessionID)
	if !ok || !hasCodexStandingInstructions(cfg.SystemPrompt, cfg.SystemPromptFile) {
		return nil
	}
	prompt, err := codexSystemPromptText(cfg.SystemPrompt, cfg.SystemPromptFile)
	if err != nil {
		return err
	}
	configDir, err := p.NativeSessionConfigDir(ctx, cfg.DataDir, cfg.Env)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(configDir, 0o700); err != nil {
		return fmt.Errorf("codex: create profile directory: %w", err)
	}
	profilePath := filepath.Join(configDir, profileName+".config.toml")
	header := codexProfileHeader(profileName)
	if _, _, err := readOwnedCodexProfile(profilePath, header, "overwrite"); err != nil {
		return err
	}
	contents := header + "developer_instructions = " + codexTOMLConfigString(prompt) + "\n"
	if err := hookutil.AtomicWriteFile(profilePath, []byte(contents), 0o600); err != nil {
		return fmt.Errorf("codex: write session profile: %w", err)
	}
	return nil
}

// PrepareSessionState materializes the additive profile before an agent switch
// crosses its source-stop boundary. Ordinary spawn/restore paths call the same
// operation through GetAgentHooks before starting Codex.
func (p *Plugin) PrepareSessionState(ctx context.Context, cfg ports.WorkspaceHookConfig) error {
	return p.installSessionProfile(ctx, cfg)
}

// CleanupSessionState removes only the exact AO-owned profile for this AO data
// root and session. Provider transcripts and other Codex configuration remain
// untouched, so a later switch back can recreate the profile and resume the
// retained native conversation.
func (p *Plugin) CleanupSessionState(ctx context.Context, cfg ports.WorkspaceHookConfig) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	profileName, ok := codexSessionProfileName(cfg.DataDir, cfg.SessionID)
	if !ok {
		return nil
	}
	configDir, err := p.NativeSessionConfigDir(ctx, cfg.DataDir, cfg.Env)
	if err != nil {
		return err
	}
	profilePath := filepath.Join(configDir, profileName+".config.toml")
	header := codexProfileHeader(profileName)
	originalInfo, exists, err := readOwnedCodexProfile(profilePath, header, "remove")
	if err != nil {
		return err
	}
	if !exists {
		return nil
	}
	currentInfo, err := os.Lstat(profilePath)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("codex: inspect session profile for cleanup: %w", err)
	}
	if !os.SameFile(originalInfo, currentInfo) {
		return fmt.Errorf("codex: refusing to remove profile replaced during cleanup at %s", profilePath)
	}
	if err := os.Remove(profilePath); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("codex: remove session profile: %w", err)
	}
	return nil
}
