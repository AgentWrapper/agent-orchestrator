package prereq_test

import (
	"os/exec"
	"strings"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/prereq"
)

func lookPathFor(available ...string) prereq.LookPathFunc {
	set := make(map[string]bool, len(available))
	for _, name := range available {
		set[name] = true
	}
	return func(file string) (string, error) {
		if set[file] {
			return "/usr/bin/" + file, nil
		}
		return "", exec.ErrNotFound
	}
}

func TestTmux(t *testing.T) {
	for _, tc := range []struct {
		name      string
		goos      string
		available []string
		satisfied bool
		command   string
		needsRoot bool
	}{
		{name: "already installed", goos: "linux", available: []string{"tmux", "apt-get"}, satisfied: true},
		{name: "windows needs no tmux", goos: "windows", satisfied: true},
		{name: "darwin uses homebrew", goos: "darwin", available: []string{"brew"}, command: "brew install tmux"},
		{name: "darwin without homebrew", goos: "darwin"},
		{name: "linux prefers apt-get", goos: "linux", available: []string{"dnf", "apt-get"}, command: "apt-get install -y tmux", needsRoot: true},
		{name: "linux falls back to dnf", goos: "linux", available: []string{"dnf"}, command: "dnf install -y tmux", needsRoot: true},
		{name: "linux falls back to pacman", goos: "linux", available: []string{"pacman"}, command: "pacman -S --noconfirm tmux", needsRoot: true},
		{name: "linux falls back to zypper", goos: "linux", available: []string{"zypper"}, command: "zypper install -y tmux", needsRoot: true},
		{name: "linux falls back to apk", goos: "linux", available: []string{"apk"}, command: "apk add tmux", needsRoot: true},
		{name: "linux without a package manager", goos: "linux"},
		{name: "unsupported platform", goos: "plan9", available: []string{"brew", "apt-get"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := prereq.Tmux(tc.goos, lookPathFor(tc.available...))
			if got.Satisfied != tc.satisfied {
				t.Fatalf("Satisfied = %v, want %v", got.Satisfied, tc.satisfied)
			}
			if cmd := strings.Join(got.Command, " "); cmd != tc.command {
				t.Fatalf("Command = %q, want %q", cmd, tc.command)
			}
			if got.NeedsRoot != tc.needsRoot {
				t.Fatalf("NeedsRoot = %v, want %v", got.NeedsRoot, tc.needsRoot)
			}
		})
	}
}

// Homebrew refuses to run as root, so a macOS install must never be flagged as
// needing it. That flag is what lets the daemon run the install itself.
func TestTmuxHomebrewNeverNeedsRoot(t *testing.T) {
	if got := prereq.Tmux("darwin", lookPathFor("brew")); got.NeedsRoot {
		t.Fatal("brew install must not be flagged as needing root")
	}
}
