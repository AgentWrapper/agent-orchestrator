// Package prereq resolves host prerequisites for the session runtimes and, when
// one is missing, the command that installs it.
//
// It is the single source of truth for two callers with different powers: the
// CLI, which has a terminal and can therefore run a privileged install, and the
// daemon, which runs inside the desktop app with no terminal at all and can only
// run an install that never prompts.
package prereq

import "os/exec"

// LookPathFunc resolves a binary name to a path. It is injected so both callers
// and their tests can substitute a PATH.
type LookPathFunc func(file string) (string, error)

// Status describes one prerequisite and the route to satisfying it.
type Status struct {
	// Satisfied reports whether the prerequisite is already met.
	Satisfied bool
	// Manager is the package manager that would install it ("brew", "apt-get",
	// ...), or "" when none of the known ones is on PATH.
	Manager string
	// Command is the unprivileged install argv, e.g. {"apt-get", "install",
	// "-y", "tmux"}. Callers that can escalate add their own prefix.
	Command []string
	// NeedsRoot reports whether Command must run as root. Homebrew must not; the
	// Linux managers must. A caller with no terminal cannot answer a password
	// prompt, so this doubles as "do not run this yourself".
	NeedsRoot bool
}

// tmuxManagers is the ordered candidate list per GOOS. First one on PATH wins.
var tmuxManagers = map[string][][]string{
	"darwin": {
		{"brew", "install", "tmux"},
	},
	"linux": {
		{"apt-get", "install", "-y", "tmux"},
		{"dnf", "install", "-y", "tmux"},
		{"pacman", "-S", "--noconfirm", "tmux"},
		{"zypper", "install", "-y", "tmux"},
		{"apk", "add", "tmux"},
	},
}

// Tmux reports whether tmux is available for the session runtime on goos, and
// how to install it if not. Windows uses the ConPTY runtime and needs no tmux,
// so it is always satisfied.
func Tmux(goos string, lookPath LookPathFunc) Status {
	if goos == "windows" || found(lookPath, "tmux") {
		return Status{Satisfied: true}
	}
	for _, argv := range tmuxManagers[goos] {
		if !found(lookPath, argv[0]) {
			continue
		}
		return Status{Manager: argv[0], Command: argv, NeedsRoot: goos == "linux"}
	}
	return Status{}
}

func found(lookPath LookPathFunc, file string) bool {
	if lookPath == nil {
		lookPath = exec.LookPath
	}
	path, err := lookPath(file)
	return err == nil && path != ""
}
