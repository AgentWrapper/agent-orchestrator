//go:build windows

package browserruntime

import (
	"net"
	"path/filepath"
	"regexp"

	"github.com/Microsoft/go-winio"
)

var unsafePipeChars = regexp.MustCompile(`[^a-zA-Z0-9\-]`)

func pipeNameFromRunFile(runFilePath string) string {
	if runFilePath == "" {
		return `\\.\pipe\ao-browser`
	}
	dir := filepath.Base(filepath.Dir(runFilePath))
	if dir == ".ao" || dir == "." || dir == "" {
		return `\\.\pipe\ao-browser`
	}
	return `\\.\pipe\ao-browser-` + unsafePipeChars.ReplaceAllString(dir, "-")
}

// Listen creates the local daemon-to-Electron browser bridge listener.
func Listen(runFilePath string) (net.Listener, string, error) {
	name := pipeNameFromRunFile(runFilePath)
	ln, err := winio.ListenPipe(name, nil)
	if err != nil {
		return nil, "", err
	}
	return ln, name, nil
}
