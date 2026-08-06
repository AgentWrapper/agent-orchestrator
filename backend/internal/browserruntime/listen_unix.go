//go:build !windows

package browserruntime

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"sync"
)

// Darwin's sockaddr_un.sun_path is 104 bytes including the trailing NUL. Keep
// the address at or below 103 bytes so the same path is valid on macOS and
// Linux regardless of the user's home/data-directory length.
const maxUnixSocketPathBytes = 103

// Listen creates the local daemon-to-Electron browser bridge listener.
func Listen(runFilePath string) (net.Listener, string, error) {
	aliasRoot := os.TempDir()
	if info, err := os.Stat("/tmp"); err == nil && info.IsDir() {
		// os.TempDir can inherit an arbitrarily long TMPDIR. /tmp is the stable,
		// short spelling needed for sockaddr_un (including on macOS, where it is
		// normally a symlink to /private/tmp).
		aliasRoot = "/tmp"
	}
	return listenUnix(runFilePath, aliasRoot)
}

func listenUnix(runFilePath, aliasRoot string) (net.Listener, string, error) {
	runtimeDir, err := filepath.Abs(filepath.Dir(runFilePath))
	if err != nil {
		return nil, "", fmt.Errorf("resolve browser runtime directory: %w", err)
	}
	if err := os.MkdirAll(runtimeDir, 0o700); err != nil {
		return nil, "", fmt.Errorf("create browser runtime directory: %w", err)
	}

	aliasPath, err := createRuntimeAlias(aliasRoot, runtimeDir)
	if err != nil {
		return nil, "", err
	}
	sockPath := filepath.Join(aliasPath, "browser.sock")
	if len([]byte(sockPath)) > maxUnixSocketPathBytes {
		_ = os.Remove(aliasPath)
		return nil, "", fmt.Errorf("browser runtime socket path is %d bytes; maximum is %d", len([]byte(sockPath)), maxUnixSocketPathBytes)
	}
	_ = os.Remove(filepath.Join(runtimeDir, "browser.sock"))
	ln, err := net.Listen("unix", sockPath)
	if err != nil {
		_ = os.Remove(aliasPath)
		return nil, "", err
	}
	wrapped := &cleanupUnixListener{Listener: ln, socketPath: sockPath, aliasPath: aliasPath}
	if err := os.Chmod(sockPath, 0o600); err != nil {
		_ = wrapped.Close()
		return nil, "", err
	}
	return wrapped, sockPath, nil
}

func createRuntimeAlias(root, runtimeDir string) (string, error) {
	for range 16 {
		random := make([]byte, 8)
		if _, err := rand.Read(random); err != nil {
			return "", fmt.Errorf("generate browser runtime alias: %w", err)
		}
		aliasPath := filepath.Join(root, "ao-br-"+hex.EncodeToString(random))
		if err := os.Symlink(runtimeDir, aliasPath); err == nil {
			return aliasPath, nil
		} else if !os.IsExist(err) {
			return "", fmt.Errorf("create browser runtime alias: %w", err)
		}
	}
	return "", fmt.Errorf("create browser runtime alias: exhausted random names")
}

type cleanupUnixListener struct {
	net.Listener
	socketPath string
	aliasPath  string
	once       sync.Once
}

func (l *cleanupUnixListener) Close() error {
	err := l.Listener.Close()
	l.once.Do(func() {
		_ = os.Remove(l.socketPath)
		_ = os.Remove(l.aliasPath)
	})
	return err
}
