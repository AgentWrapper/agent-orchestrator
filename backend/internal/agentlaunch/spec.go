// Package agentlaunch persists the exact argv a runtime should execute.
package agentlaunch

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"runtime"
)

// ResolveEntrypoint verifies the daemon executable used for the internal
// `ao launch` trampoline exists and is executable enough to start.
func ResolveEntrypoint(executable func() (string, error)) (string, error) {
	path, err := executable()
	if err != nil {
		return "", fmt.Errorf("resolve launcher entrypoint: %w", err)
	}
	if path == "" {
		return "", errors.New("resolve launcher entrypoint: empty executable path")
	}
	info, err := os.Stat(path)
	if err != nil {
		return "", fmt.Errorf("launcher entrypoint %q: %w", path, err)
	}
	if info.IsDir() {
		return "", fmt.Errorf("launcher entrypoint %q is a directory", path)
	}
	if runtime.GOOS != "windows" && info.Mode().Perm()&0o111 == 0 {
		return "", fmt.Errorf("launcher entrypoint %q is not executable", path)
	}
	return path, nil
}

// EnvSpecPath is the environment variable that holds the path to the launch spec file.
const EnvSpecPath = "AO_LAUNCH_SPEC"

// Spec describes the agent process the launcher trampoline should exec.
type Spec struct {
	WorkspacePath string   `json:"workspacePath"`
	Argv          []string `json:"argv"`
	FallbackArgv  []string `json:"fallbackArgv,omitempty"`
}

// WriteTemp serialises spec to a temporary JSON file and returns its path.
func WriteTemp(spec Spec) (string, error) {
	file, err := os.CreateTemp(os.TempDir(), "ao-launch-*.json")
	if err != nil {
		return "", fmt.Errorf("create launch spec: %w", err)
	}
	path := file.Name()
	enc := json.NewEncoder(file)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(spec); err != nil {
		_ = file.Close()
		_ = os.Remove(path)
		return "", fmt.Errorf("write launch spec: %w", err)
	}
	if err := file.Close(); err != nil {
		_ = os.Remove(path)
		return "", fmt.Errorf("close launch spec: %w", err)
	}
	return path, nil
}

// ReadAndRemove reads and deletes the spec file at path, returning its contents.
func ReadAndRemove(path string) (Spec, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return Spec{}, fmt.Errorf("read launch spec: %w", err)
	}
	_ = os.Remove(path)

	var spec Spec
	if err := json.Unmarshal(raw, &spec); err != nil {
		return Spec{}, fmt.Errorf("parse launch spec: %w", err)
	}
	if len(spec.Argv) == 0 {
		return Spec{}, fmt.Errorf("launch spec: argv is required")
	}
	return spec, nil
}
