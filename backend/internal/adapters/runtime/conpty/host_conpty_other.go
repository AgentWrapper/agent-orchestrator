//go:build !windows

package conpty

import "errors"

// newConPTY is a stub on non-Windows platforms. The serve engine (host.go) and
// tests use a fake ptyConn; this stub only exists to keep the package buildable
// on Darwin/Linux so the engine can be imported and tested without Windows.
func newConPTY(cwd, shellCmd string, shellArgs []string, env map[string]string) (ptyConn, error) {
	return nil, errors.New("conpty: unsupported on this OS")
}
