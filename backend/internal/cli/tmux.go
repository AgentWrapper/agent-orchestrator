package cli

import (
	"context"
	"fmt"
	"io"
	"os"
	"strings"
)

// ensureTmux satisfies the tmux runtime prerequisite before the desktop app is
// launched, instead of letting the user discover it as an opaque
// RUNTIME_PREREQUISITE_MISSING error on their first spawn. On an interactive
// terminal it offers to run the platform package manager for them; otherwise it
// fails with the exact command to run by hand.
//
// This mirrors the pre-rewrite TypeScript ensureTmux(): prompt once, install
// once, verify. tmux is deliberately not bundled with AO (version conflicts with
// an already-installed tmux, plus an ongoing patching burden).
func (c *commandContext) ensureTmux(ctx context.Context, goos string, in io.Reader, out io.Writer) error {
	// Windows uses the ConPTY runtime, which needs no tmux.
	if goos == "windows" || c.haveTmux() {
		return nil
	}

	argv := c.tmuxInstallCommand(goos)
	if len(argv) == 0 {
		return fmt.Errorf("tmux is required on %s but is not in PATH, and no supported package manager was found; install tmux, then re-run `ao start`", goos)
	}
	pretty := strings.Join(argv, " ")

	if !stdinIsInteractive(in) {
		return fmt.Errorf("tmux is required on %s but is not in PATH; install it with `%s`, then re-run `ao start`", goos, pretty)
	}

	_, _ = fmt.Fprintf(out, "tmux is required to run agent sessions on %s, but it is not in your PATH.\n", goos)
	ok, err := confirm(in, out, fmt.Sprintf("Install it now with `%s`?", pretty), true)
	if err != nil {
		return err
	}
	if !ok {
		return fmt.Errorf("tmux is required; install it with `%s`, then re-run `ao start`", pretty)
	}
	return c.installTmux(ctx, out, argv)
}

// installTmux runs the resolved install command and verifies tmux actually
// landed on PATH afterwards. A package manager can exit 0 and still leave
// nothing runnable (wrong repo, install into a dir not on PATH), so the
// re-check is the real success signal.
func (c *commandContext) installTmux(ctx context.Context, out io.Writer, argv []string) error {
	pretty := strings.Join(argv, " ")
	_, _ = fmt.Fprintf(out, "Running %s...\n", pretty)
	if err := c.deps.RunInteractive(ctx, argv[0], argv[1:]...); err != nil {
		return fmt.Errorf("install tmux with `%s`: %w", pretty, err)
	}
	if !c.haveTmux() {
		return fmt.Errorf("`%s` finished but tmux is still not in PATH; install it manually, then re-run `ao start`", pretty)
	}
	_, _ = fmt.Fprintln(out, "tmux installed.")
	return nil
}

func (c *commandContext) haveTmux() bool {
	path, err := c.deps.LookPath("tmux")
	return err == nil && path != ""
}

// tmuxInstallCommand returns the install argv for the first known package
// manager present on PATH, or nil when none of them are.
func (c *commandContext) tmuxInstallCommand(goos string) []string {
	var candidates [][]string
	switch goos {
	case "darwin":
		candidates = [][]string{{"brew", "install", "tmux"}}
	case "linux":
		candidates = [][]string{
			{"apt-get", "install", "-y", "tmux"},
			{"dnf", "install", "-y", "tmux"},
			{"pacman", "-S", "--noconfirm", "tmux"},
			{"zypper", "install", "-y", "tmux"},
			{"apk", "add", "tmux"},
		}
	default:
		return nil
	}
	for _, argv := range candidates {
		if path, err := c.deps.LookPath(argv[0]); err != nil || path == "" {
			continue
		}
		return c.withPrivilege(goos, argv)
	}
	return nil
}

// withPrivilege prefixes sudo for the Linux package managers, which write to
// system paths. Homebrew must not run as root, and a shell already running as
// root (containers, CI images) has no need for sudo and often no sudo binary.
func (c *commandContext) withPrivilege(goos string, argv []string) []string {
	if goos != "linux" || os.Geteuid() == 0 {
		return argv
	}
	if path, err := c.deps.LookPath("sudo"); err != nil || path == "" {
		return argv
	}
	return append([]string{"sudo"}, argv...)
}
