//go:build windows

package supervisor

import (
	"net"

	"github.com/Microsoft/go-winio"
)

const pipeName = `\\.\pipe\ao-supervise`

// Listen creates a Windows named pipe listener for the supervisor watchdog.
// runFilePath is ignored on Windows: named pipes are global and identified
// by name only.
// ponytail: global pipe name; add a per-instance suffix if multiple daemons must coexist on one machine.
func Listen(_ string) (net.Listener, string, error) {
	ln, err := winio.ListenPipe(pipeName, nil)
	if err != nil {
		return nil, "", err
	}
	return ln, pipeName, nil
}
