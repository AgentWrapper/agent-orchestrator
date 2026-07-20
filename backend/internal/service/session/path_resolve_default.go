//go:build !windows

package session

import "path/filepath"

func resolvedFilesystemPath(path string) (string, error) {
	return filepath.EvalSymlinks(path)
}
