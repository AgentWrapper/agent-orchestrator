package cli

import (
	"context"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/aoagents/agent-orchestrator/backend/internal/prereq"
)

// ensureTmux satisfies the tmux runtime prerequisite before the desktop app is
// launched, instead of letting the user discover it as an opaque
// RUNTIME_PREREQUISITE_MISSING error on their first spawn. On an interactive
// terminal it offers to run the platform package manager for them; otherwise it
// prints the exact command to run by hand.
//
// This mirrors the pre-rewrite TypeScript ensureTmux(): prompt once, install
// once, verify. tmux is deliberately not bundled with AO (version conflicts with
// an already-installed tmux, plus an ongoing patching burden).
//
// It never blocks `ao start`. Back when ensureTmux() ran in the CLI, `ao start`
// WAS the daemon, so no tmux meant nothing could work. It is now only the
// desktop-app launcher, and the app is still usable without a session runtime,
// so an unmet prerequisite is a warning here and remains a hard error at spawn.
func (c *commandContext) ensureTmux(ctx context.Context, goos string, in io.Reader, out io.Writer) {
	// Windows uses the ConPTY runtime, which needs no tmux.
	if goos == "windows" || c.haveTmux() {
		return
	}

	argv := c.tmuxInstallCommand(goos)
	if len(argv) == 0 {
		c.warnTmuxMissing(out, goos, "install it with your package manager")
		return
	}
	pretty := strings.Join(argv, " ")

	if !stdinIsInteractive(in) {
		c.warnTmuxMissing(out, goos, fmt.Sprintf("install it with `%s`", pretty))
		return
	}

	_, _ = fmt.Fprintf(out, "tmux is required to run agent sessions on %s, but it is not in your PATH.\n", goos)
	ok, err := confirm(in, out, fmt.Sprintf("Install it now with `%s`?", pretty), true)
	if err != nil || !ok {
		c.warnTmuxMissing(out, goos, fmt.Sprintf("install it with `%s`", pretty))
		return
	}
	if err := c.installTmux(ctx, out, argv); err != nil {
		_, _ = fmt.Fprintf(out, "Warning: %v\n", err)
		c.warnTmuxMissing(out, goos, fmt.Sprintf("install it with `%s`", pretty))
	}
}

// warnTmuxMissing states the consequence and the remedy, and is the only thing
// a user gets when we cannot install for them.
func (c *commandContext) warnTmuxMissing(out io.Writer, goos, remedy string) {
	_, _ = fmt.Fprintf(out, "Warning: tmux is not in PATH, so agent sessions will fail to start on %s. To fix it, %s.\n", goos, remedy)
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
	// goos is irrelevant here: callers have already excluded Windows, and this
	// asks the narrower question of whether the binary exists.
	path, err := c.deps.LookPath("tmux")
	return err == nil && path != ""
}

// tmuxInstallCommand returns the install argv for the first known package
// manager present on PATH, or nil when there is none or we cannot get the
// privilege it needs.
func (c *commandContext) tmuxInstallCommand(goos string) []string {
	status := prereq.Tmux(goos, c.deps.LookPath)
	if len(status.Command) == 0 {
		return nil
	}
	return c.withPrivilege(status)
}

// withPrivilege prefixes sudo for the package managers that write to system
// paths. Homebrew must not run as root. It returns nil when the command needs
// root that we cannot get: an unprivileged account in an image with no sudo
// (the CLI smoke container is exactly this) would otherwise run a doomed
// `apt-get install` and fail on the dpkg lock.
func (c *commandContext) withPrivilege(status prereq.Status) []string {
	if !status.NeedsRoot || os.Geteuid() == 0 {
		return status.Command
	}
	if path, err := c.deps.LookPath("sudo"); err != nil || path == "" {
		return nil
	}
	return append([]string{"sudo"}, status.Command...)
}
