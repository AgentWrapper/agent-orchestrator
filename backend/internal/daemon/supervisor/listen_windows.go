//go:build windows

package supervisor

import (
	"net"
	"path/filepath"
	"regexp"

	"github.com/Microsoft/go-winio"
)

var unsafePipeChars = regexp.MustCompile(`[^a-zA-Z0-9\-]`)

// pipeNameFromRunFile derives a per-instance named-pipe path from the
// run-file's parent directory, mirroring the Unix supervise.sock placement.
// ~/.ao/running.json  → \\.\pipe\ao-supervise          (default, backward-compatible)
// ~/.ao/dev/running.json → \\.\pipe\ao-supervise-dev   (dev isolation)
func pipeNameFromRunFile(runFilePath string) string {
	if runFilePath == "" {
		return `\\.\pipe\ao-supervise`
	}
	dir := filepath.Base(filepath.Dir(runFilePath))
	if dir == ".ao" || dir == "." || dir == "" {
		return `\\.\pipe\ao-supervise`
	}
	return `\\.\pipe\ao-supervise-` + unsafePipeChars.ReplaceAllString(dir, "-")
}

// Listen creates a Windows named pipe listener for the supervisor watchdog.
// The pipe name is derived from runFilePath so dev and installed-app instances
// use separate pipes and cannot collide.
func Listen(runFilePath string) (net.Listener, string, error) {
	name := pipeNameFromRunFile(runFilePath)
	ln, err := winio.ListenPipe(name, nil)
	if err != nil {
		return nil, "", err
	}
	return ln, name, nil
}
