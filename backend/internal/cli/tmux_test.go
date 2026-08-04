package cli

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"testing"
)

// lookPathFor builds a LookPath stub where only the named binaries resolve.
func lookPathFor(available ...string) func(string) (string, error) {
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

// openDevNull returns /dev/null as an *os.File, standing in for the stdin a
// process gets from `docker run` without -i.
func openDevNull(t *testing.T) *os.File {
	t.Helper()
	f, err := os.Open(os.DevNull)
	if err != nil {
		t.Fatalf("open %s: %v", os.DevNull, err)
	}
	t.Cleanup(func() { _ = f.Close() })
	return f
}

// fakeTerminal makes the prompt paths reachable without a real tty: it returns
// a reader holding the typed answer and forces the terminal check to accept it.
func fakeTerminal(t *testing.T, answer string) io.Reader {
	t.Helper()
	prev := stdinIsInteractive
	stdinIsInteractive = func(io.Reader) bool { return true }
	t.Cleanup(func() { stdinIsInteractive = prev })
	return strings.NewReader(answer)
}

func TestEnsureTmuxSkipsWhenSatisfied(t *testing.T) {
	for _, tc := range []struct {
		name      string
		goos      string
		available []string
	}{
		{"tmux already installed", "linux", []string{"tmux", "apt-get", "sudo"}},
		{"windows uses conpty", "windows", nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			out := &bytes.Buffer{}
			c := &commandContext{deps: Deps{
				LookPath:       lookPathFor(tc.available...),
				RunInteractive: func(context.Context, string, ...string) error { t.Fatal("must not install"); return nil },
			}.withDefaults()}
			c.ensureTmux(context.Background(), tc.goos, &bytes.Buffer{}, out)
			if out.Len() != 0 {
				t.Fatalf("expected no output, got %q", out.String())
			}
		})
	}
}

// A missing tmux must never fail `ao start`: the launcher's job is to open the
// desktop app, which is still usable without a session runtime.
func TestEnsureTmuxWarnsWithoutInstalling(t *testing.T) {
	for _, tc := range []struct {
		name      string
		available []string
		want      string
	}{
		{"non-interactive stdin", []string{"apt-get", "sudo"}, "sudo apt-get install -y tmux"},
		{"no package manager", nil, "install it with your package manager"},
		{"unprivileged with no sudo", []string{"apt-get"}, "install it with your package manager"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if tc.name == "unprivileged with no sudo" && os.Geteuid() == 0 {
				t.Skip("running as root, so apt-get needs no sudo")
			}
			out := &bytes.Buffer{}
			c := &commandContext{deps: Deps{
				LookPath:       lookPathFor(tc.available...),
				RunInteractive: func(context.Context, string, ...string) error { t.Fatal("must not install"); return nil },
			}.withDefaults()}

			// A bytes.Buffer is not a terminal, so no prompt may be issued.
			c.ensureTmux(context.Background(), "linux", &bytes.Buffer{}, out)
			if !strings.Contains(out.String(), "Warning: tmux is not in PATH") {
				t.Fatalf("expected a warning, got %q", out.String())
			}
			if !strings.Contains(out.String(), tc.want) {
				t.Fatalf("output %q should mention %q", out.String(), tc.want)
			}
		})
	}
}

// Regression: /dev/null is a character device, so the old stdin check called it
// a terminal. `docker run` without -i hands a process exactly that, and the
// prompt then answered itself with the default and ran a package install.
func TestEnsureTmuxTreatsDevNullAsNonInteractive(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("no /dev/null")
	}
	out := &bytes.Buffer{}
	c := &commandContext{deps: Deps{
		LookPath:       lookPathFor("apt-get", "sudo"),
		RunInteractive: func(context.Context, string, ...string) error { t.Fatal("must not install"); return nil },
	}.withDefaults()}

	c.ensureTmux(context.Background(), "linux", openDevNull(t), out)
	if strings.Contains(out.String(), "Install it now") {
		t.Fatalf("prompted on a non-terminal stdin: %q", out.String())
	}
	if !strings.Contains(out.String(), "Warning: tmux is not in PATH") {
		t.Fatalf("expected a warning, got %q", out.String())
	}
}

func TestEnsureTmuxInteractiveInstalls(t *testing.T) {
	installed := false
	var ran []string
	out := &bytes.Buffer{}
	c := &commandContext{deps: Deps{
		LookPath: func(file string) (string, error) {
			if file == "tmux" && !installed {
				return "", exec.ErrNotFound
			}
			return "/usr/bin/" + file, nil
		},
		RunInteractive: func(_ context.Context, name string, args ...string) error {
			ran = append([]string{name}, args...)
			installed = true
			return nil
		},
	}.withDefaults()}

	c.ensureTmux(context.Background(), "darwin", fakeTerminal(t, ""), out)
	if got := strings.Join(ran, " "); got != "brew install tmux" {
		t.Fatalf("ran %q, want brew install tmux", got)
	}
	if !strings.Contains(out.String(), "Install it now") || !strings.Contains(out.String(), "tmux installed.") {
		t.Fatalf("expected a prompt and a success line, got %q", out.String())
	}
}

func TestEnsureTmuxDeclinedInstallWarns(t *testing.T) {
	out := &bytes.Buffer{}
	c := &commandContext{deps: Deps{
		LookPath:       lookPathFor("brew"),
		RunInteractive: func(context.Context, string, ...string) error { t.Fatal("must not install"); return nil },
	}.withDefaults()}

	c.ensureTmux(context.Background(), "darwin", fakeTerminal(t, "n\n"), out)
	if !strings.Contains(out.String(), "Warning: tmux is not in PATH") {
		t.Fatalf("expected a warning after declining, got %q", out.String())
	}
}

// A failed install warns rather than aborting the launch.
func TestEnsureTmuxFailedInstallWarns(t *testing.T) {
	out := &bytes.Buffer{}
	c := &commandContext{deps: Deps{
		LookPath:       lookPathFor("brew"),
		RunInteractive: func(context.Context, string, ...string) error { return errors.New("exit status 100") },
	}.withDefaults()}

	c.ensureTmux(context.Background(), "darwin", fakeTerminal(t, ""), out)
	if !strings.Contains(out.String(), "exit status 100") {
		t.Fatalf("expected the install failure to be reported, got %q", out.String())
	}
	if !strings.Contains(out.String(), "Warning: tmux is not in PATH") {
		t.Fatalf("expected a warning after a failed install, got %q", out.String())
	}
}

func TestInstallTmuxFailures(t *testing.T) {
	boom := errors.New("exit status 100")
	for _, tc := range []struct {
		name      string
		runErr    error
		installed bool
		want      string
	}{
		{"install command fails", boom, false, "exit status 100"},
		{"install succeeds but tmux is still absent", nil, false, "still not in PATH"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c := &commandContext{deps: Deps{
				LookPath: func(file string) (string, error) {
					if file == "tmux" && !tc.installed {
						return "", exec.ErrNotFound
					}
					return "/usr/bin/" + file, nil
				},
				RunInteractive: func(context.Context, string, ...string) error { return tc.runErr },
			}.withDefaults()}

			err := c.installTmux(context.Background(), &bytes.Buffer{}, []string{"brew", "install", "tmux"})
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("got %v, want an error containing %q", err, tc.want)
			}
		})
	}
}

func TestTmuxInstallCommand(t *testing.T) {
	for _, tc := range []struct {
		name      string
		goos      string
		available []string
		want      string // "" means no command
	}{
		{"darwin uses homebrew", "darwin", []string{"brew"}, "brew install tmux"},
		{"darwin without homebrew", "darwin", nil, ""},
		{"linux prefers apt-get", "linux", []string{"apt-get", "dnf", "sudo"}, "apt-get install -y tmux"},
		{"linux falls back to dnf", "linux", []string{"dnf", "sudo"}, "dnf install -y tmux"},
		{"linux falls back to pacman", "linux", []string{"pacman", "sudo"}, "pacman -S --noconfirm tmux"},
		{"linux falls back to zypper", "linux", []string{"zypper", "sudo"}, "zypper install -y tmux"},
		{"linux falls back to apk", "linux", []string{"apk", "sudo"}, "apk add tmux"},
		{"linux without a package manager", "linux", []string{"sudo"}, ""},
		{"unsupported platform", "plan9", []string{"apt-get", "brew"}, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c := &commandContext{deps: Deps{LookPath: lookPathFor(tc.available...)}.withDefaults()}
			got := strings.Join(c.tmuxInstallCommand(tc.goos), " ")
			if tc.want == "" {
				if got != "" {
					t.Fatalf("got %q, want no command", got)
				}
				return
			}
			// The sudo prefix depends on the euid the test runs under, so assert
			// on the package-manager invocation itself.
			if !strings.HasSuffix(got, tc.want) {
				t.Fatalf("got %q, want it to end with %q", got, tc.want)
			}
		})
	}
}

// Homebrew refuses to run as root, and macOS needs no sudo step here.
func TestTmuxInstallCommandNeverSudoesHomebrew(t *testing.T) {
	c := &commandContext{deps: Deps{LookPath: lookPathFor("brew", "sudo")}.withDefaults()}
	if got := strings.Join(c.tmuxInstallCommand("darwin"), " "); got != "brew install tmux" {
		t.Fatalf("got %q, want an unprivileged brew invocation", got)
	}
}

func TestTmuxInstallCommandNeedsRootOnLinux(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("running as root, so no sudo prefix is expected")
	}
	c := &commandContext{deps: Deps{LookPath: lookPathFor("apt-get", "sudo")}.withDefaults()}
	if got := strings.Join(c.tmuxInstallCommand("linux"), " "); got != "sudo apt-get install -y tmux" {
		t.Fatalf("got %q, want a sudo-prefixed invocation", got)
	}
	// Unprivileged with no sudo: the install is impossible, so offer nothing
	// rather than run apt-get into a dpkg permission error.
	c = &commandContext{deps: Deps{LookPath: lookPathFor("apt-get")}.withDefaults()}
	if got := c.tmuxInstallCommand("linux"); got != nil {
		t.Fatalf("got %q, want no command when root is unreachable", got)
	}
}
