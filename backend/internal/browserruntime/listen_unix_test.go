//go:build !windows

package browserruntime

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestListenUnixUsesShortAliasForLongDataPath(t *testing.T) {
	runtimeDir := filepath.Join(t.TempDir(), strings.Repeat("long-data-directory-", 6))
	runFilePath := filepath.Join(runtimeDir, "running.json")
	aliasRoot := t.TempDir()

	ln, address, err := listenUnix(runFilePath, aliasRoot)
	if err != nil {
		t.Fatalf("listenUnix: %v", err)
	}
	aliasPath := filepath.Dir(address)
	if len([]byte(address)) > maxUnixSocketPathBytes {
		t.Fatalf("socket path = %d bytes, maximum %d: %q", len([]byte(address)), maxUnixSocketPathBytes, address)
	}
	if strings.Contains(address, runtimeDir) {
		t.Fatalf("socket address retained long runtime path: %q", address)
	}
	if target, err := os.Readlink(aliasPath); err != nil || target != runtimeDir {
		t.Fatalf("alias target = %q, err=%v; want %q", target, err, runtimeDir)
	}

	if err := ln.Close(); err != nil {
		t.Fatalf("close listener: %v", err)
	}
	if _, err := os.Lstat(aliasPath); !os.IsNotExist(err) {
		t.Fatalf("runtime alias was not removed on close: %v", err)
	}
}
