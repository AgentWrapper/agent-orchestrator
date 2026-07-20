package tmux

import (
	"fmt"
	"io/fs"
	"os"
	"os/exec"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// Source identifies where a resolved tmux binary came from.
type Source string

const (
	// SourceOverride is an explicit AO_TMUX_BIN override.
	SourceOverride Source = "AO_TMUX_BIN"
	// SourceSystem is a tmux found on PATH.
	SourceSystem Source = "PATH"
	// SourceBundled is the app-bundled fallback binary.
	SourceBundled Source = "bundled"
)

// BinaryResolver resolves the tmux binary path at use time. Implementations
// re-check PATH and the bundled candidate on every call, so a tmux installed
// after daemon start wins on the next resolution.
type BinaryResolver func() (string, error)

// ResolveBinary picks the tmux binary in fixed order: explicit override
// (AO_TMUX_BIN) → system PATH → bundled fallback → ports.ErrRuntimePrerequisite.
//
// A set-but-broken override fails loudly rather than falling through: the user
// asked for that exact binary, so silently using another would be misleading.
// The bundled candidate is accepted only if it is an executable regular file,
// rejecting corrupt or half-copied payloads before tmux errors opaquely
// mid-spawn. lookPath and stat default to exec.LookPath and os.Stat when nil.
func ResolveBinary(override, bundled string, lookPath func(string) (string, error), stat func(string) (fs.FileInfo, error)) (string, Source, error) {
	if lookPath == nil {
		lookPath = exec.LookPath
	}
	if stat == nil {
		stat = os.Stat
	}
	if override != "" {
		if err := checkExecutable(stat, override); err != nil {
			return "", "", fmt.Errorf("%w: AO_TMUX_BIN=%q is not an executable file: %v", ports.ErrRuntimePrerequisite, override, err)
		}
		return override, SourceOverride, nil
	}
	if path, err := lookPath("tmux"); err == nil && path != "" {
		return path, SourceSystem, nil
	}
	if bundled != "" {
		if err := checkExecutable(stat, bundled); err == nil {
			return bundled, SourceBundled, nil
		}
		return "", "", fmt.Errorf("%w: tmux not found in PATH and bundled tmux at %s is not executable", ports.ErrRuntimePrerequisite, bundled)
	}
	return "", "", fmt.Errorf("%w: tmux not found in PATH and no bundled tmux available (install tmux or set AO_TMUX_BIN)", ports.ErrRuntimePrerequisite)
}

// NewResolver returns a BinaryResolver closed over the configured override and
// bundled paths. PATH lookup and file checks run on every call.
func NewResolver(override, bundled string) BinaryResolver {
	return func() (string, error) {
		path, _, err := ResolveBinary(override, bundled, nil, nil)
		return path, err
	}
}

func checkExecutable(stat func(string) (fs.FileInfo, error), path string) error {
	info, err := stat(path)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return fmt.Errorf("not a regular file")
	}
	if info.Mode().Perm()&0o111 == 0 {
		return fmt.Errorf("no execute permission")
	}
	return nil
}
