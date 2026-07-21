//go:build !windows

package browserruntime

import (
	"net"
	"os"
	"path/filepath"
)

func Listen(runFilePath string) (net.Listener, string, error) {
	sockPath := filepath.Join(filepath.Dir(runFilePath), "browser.sock")
	_ = os.Remove(sockPath)
	ln, err := net.Listen("unix", sockPath)
	if err != nil {
		return nil, "", err
	}
	if err := os.Chmod(sockPath, 0o600); err != nil {
		_ = ln.Close()
		return nil, "", err
	}
	return ln, sockPath, nil
}
