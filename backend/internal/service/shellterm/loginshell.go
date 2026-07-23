package shellterm

import (
	"os"
	"os/exec"
	"runtime"
)

// resolveUserLoginShell returns the argv a standalone terminal launches.
//
// Unlike an agent session — where the argv is a specific CLI the adapter
// resolved and the runtime must be able to prove exists — a shell terminal
// wants whatever shell the user already lives in. $SHELL (unix) and ComSpec
// (Windows) are the values the OS itself uses for that question, so they are
// preferred over probing PATH for a hardcoded list.
//
// The fallbacks are last-resort only: an empty argv would be rejected by the
// runtime adapters, so a terminal that cannot name a shell must not open at
// all rather than open something unusable.
func resolveUserLoginShell() []string {
	if runtime.GOOS == "windows" {
		return resolveWindowsShell()
	}
	if shell := os.Getenv("SHELL"); shell != "" {
		return []string{shell}
	}
	for _, candidate := range []string{"zsh", "bash", "sh"} {
		if path, err := exec.LookPath(candidate); err == nil {
			return []string{path}
		}
	}
	return nil
}

// resolveWindowsShell prefers PowerShell (what the app's own terminals and the
// tooling assume) and falls back to ComSpec, which is always set on Windows.
func resolveWindowsShell() []string {
	for _, candidate := range []string{"pwsh.exe", "powershell.exe"} {
		if path, err := exec.LookPath(candidate); err == nil {
			return []string{path, "-NoLogo"}
		}
	}
	if comSpec := os.Getenv("ComSpec"); comSpec != "" {
		return []string{comSpec}
	}
	if path, err := exec.LookPath("cmd.exe"); err == nil {
		return []string{path}
	}
	return nil
}
