// Package binaryutil centralizes the "find an agent's CLI binary" search that
// every adapter otherwise reimplements. Adapters differ only in the binary
// name(s) and the well-known install locations to probe, so they describe those
// with a BinarySpec and share the identical PATH-then-candidates iteration.
package binaryutil

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"

	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/hookutil"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// BinarySpec describes where one agent's CLI binary can live. ResolveBinary
// searches PATH (via the platform's name list) first, then the platform's
// candidate install paths in order, returning the first hit.
//
// Path components are given as string slices joined onto their base directory,
// so a spec stays OS-agnostic and never hard-codes a separator. env-derived
// bases (APPDATA, LOCALAPPDATA, home) that are unset simply skip their
// candidates.
type BinarySpec struct {
	// Label prefixes the ErrAgentBinaryNotFound error, e.g. "claude".
	Label string

	// Names are the binary names looked up on PATH on non-Windows, in order.
	Names []string
	// WinNames are the binary names looked up on PATH on Windows, in order.
	// Empty means the Windows branch does no PATH lookup.
	WinNames []string

	// UnixPaths are absolute candidate paths probed on non-Windows, in order.
	UnixPaths []string
	// UnixHomePaths are candidate paths under the user's home dir on
	// non-Windows; each entry is the components to join onto $HOME.
	UnixHomePaths [][]string

	// WinPaths are candidate paths probed on Windows, in the exact order given.
	// Each entry names the base directory (%APPDATA%, %LOCALAPPDATA%, or home) it
	// is joined onto. Order is significant: a native installer location listed
	// before an npm shim wins when both are present, so it is spelled out here
	// rather than assumed. Entries whose base env is unset are skipped.
	WinPaths []WinPath
}

// WinBase names the base directory a Windows candidate path is joined onto.
type WinBase int

// The base directories a Windows candidate path can resolve against.
const (
	WinAppData      WinBase = iota // %APPDATA%
	WinLocalAppData                // %LOCALAPPDATA%
	WinHome                        // the user's home directory
)

// WinPath is one Windows candidate: Parts joined onto Base's directory.
type WinPath struct {
	Base  WinBase
	Parts []string
}

// ResolveBinary returns the path to spec's binary, searching PATH then the
// platform's candidate install locations. It returns a wrapped
// ports.ErrAgentBinaryNotFound when nothing matches, so callers surface a clear
// "command not found" rather than launching an empty argv. ctx cancellation is
// honored between probes.
func ResolveBinary(ctx context.Context, spec BinarySpec) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}

	names := spec.Names
	var candidates []string
	if runtime.GOOS == "windows" {
		names = spec.WinNames
		home, _ := os.UserHomeDir()
		appData := os.Getenv("APPDATA")
		localAppData := os.Getenv("LOCALAPPDATA")
		for _, wp := range spec.WinPaths {
			var base string
			switch wp.Base {
			case WinAppData:
				base = appData
			case WinLocalAppData:
				base = localAppData
			case WinHome:
				base = home
			}
			if base == "" {
				continue
			}
			candidates = append(candidates, filepath.Join(append([]string{base}, wp.Parts...)...))
		}
	} else {
		candidates = append(candidates, spec.UnixPaths...)
		if home, err := os.UserHomeDir(); err == nil {
			candidates = append(candidates, joinAll(home, spec.UnixHomePaths)...)
		}
	}

	for _, name := range names {
		if err := ctx.Err(); err != nil {
			return "", err
		}
		if path, err := exec.LookPath(name); err == nil && path != "" {
			return path, nil
		}
	}

	for _, candidate := range candidates {
		if err := ctx.Err(); err != nil {
			return "", err
		}
		if hookutil.FileExists(candidate) {
			return candidate, nil
		}
	}

	return "", fmt.Errorf("%s: %w", spec.Label, ports.ErrAgentBinaryNotFound)
}

// joinAll joins each component slice onto base into an absolute candidate path.
func joinAll(base string, entries [][]string) []string {
	out := make([]string, 0, len(entries))
	for _, parts := range entries {
		out = append(out, filepath.Join(append([]string{base}, parts...)...))
	}
	return out
}
