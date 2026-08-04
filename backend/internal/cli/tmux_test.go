package cli

import (
	"bytes"
	"context"
	"errors"
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

func TestEnsureTmuxSkipsWhenSatisfied(t *testing.T) {
	for _, tc := range []struct {
		name      string
		goos      string
		available []string
	}{
		{"tmux already installed", "linux", []string{"tmux", "apt-get"}},
		{"windows uses conpty", "windows", nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c := &commandContext{deps: Deps{
				LookPath:       lookPathFor(tc.available...),
				RunInteractive: func(context.Context, string, ...string) error { t.Fatal("must not install"); return nil },
			}.withDefaults()}
			if err := c.ensureTmux(context.Background(), tc.goos, &bytes.Buffer{}, &bytes.Buffer{}); err != nil {
				t.Fatalf("ensureTmux: %v", err)
			}
		})
	}
}

func TestEnsureTmuxNonInteractiveReportsCommand(t *testing.T) {
	c := &commandContext{deps: Deps{
		LookPath:       lookPathFor("apt-get", "sudo"),
		RunInteractive: func(context.Context, string, ...string) error { t.Fatal("must not install"); return nil },
	}.withDefaults()}

	// A bytes.Buffer is not a terminal, so no prompt may be issued.
	err := c.ensureTmux(context.Background(), "linux", &bytes.Buffer{}, &bytes.Buffer{})
	if err == nil {
		t.Fatal("expected an error when tmux is missing")
	}
	if !strings.Contains(err.Error(), "apt-get install -y tmux") {
		t.Fatalf("error should name the install command, got %q", err)
	}
}

func TestEnsureTmuxWithoutPackageManager(t *testing.T) {
	c := &commandContext{deps: Deps{LookPath: lookPathFor()}.withDefaults()}

	err := c.ensureTmux(context.Background(), "linux", &bytes.Buffer{}, &bytes.Buffer{})
	if err == nil || !strings.Contains(err.Error(), "no supported package manager") {
		t.Fatalf("expected a no-package-manager error, got %v", err)
	}
}

// TestEnsureTmuxInteractiveInstalls drives the full prompt-and-install path.
// /dev/null is a character device, so stdinIsInteractive accepts it, and it
// reads as immediate EOF, which confirm() treats as the default (yes).
func TestEnsureTmuxInteractiveInstalls(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("no /dev/null to stand in for a terminal")
	}
	stdin, err := os.Open(os.DevNull)
	if err != nil {
		t.Fatalf("open %s: %v", os.DevNull, err)
	}
	defer func() { _ = stdin.Close() }()

	installed := false
	var ran []string
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

	out := &bytes.Buffer{}
	if err := c.ensureTmux(context.Background(), "darwin", stdin, out); err != nil {
		t.Fatalf("ensureTmux: %v", err)
	}
	if got := strings.Join(ran, " "); got != "brew install tmux" {
		t.Fatalf("ran %q, want brew install tmux", got)
	}
	if !strings.Contains(out.String(), "tmux installed.") {
		t.Fatalf("expected success output, got %q", out.String())
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
		{"linux prefers apt-get", "linux", []string{"apt-get", "dnf"}, "apt-get install -y tmux"},
		{"linux falls back to dnf", "linux", []string{"dnf"}, "dnf install -y tmux"},
		{"linux falls back to pacman", "linux", []string{"pacman"}, "pacman -S --noconfirm tmux"},
		{"linux falls back to zypper", "linux", []string{"zypper"}, "zypper install -y tmux"},
		{"linux falls back to apk", "linux", []string{"apk"}, "apk add tmux"},
		{"linux without a package manager", "linux", nil, ""},
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

// Homebrew refuses to run as root, and macOS has no sudo step here.
func TestTmuxInstallCommandNeverSudoesHomebrew(t *testing.T) {
	c := &commandContext{deps: Deps{LookPath: lookPathFor("brew", "sudo")}.withDefaults()}
	if got := strings.Join(c.tmuxInstallCommand("darwin"), " "); got != "brew install tmux" {
		t.Fatalf("got %q, want an unprivileged brew invocation", got)
	}
}

func TestTmuxInstallCommandSudoesLinuxWhenAvailable(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("running as root, so no sudo prefix is expected")
	}
	c := &commandContext{deps: Deps{LookPath: lookPathFor("apt-get", "sudo")}.withDefaults()}
	if got := strings.Join(c.tmuxInstallCommand("linux"), " "); got != "sudo apt-get install -y tmux" {
		t.Fatalf("got %q, want a sudo-prefixed invocation", got)
	}
	// Without sudo on PATH (a root-only container image) the bare command stands.
	c = &commandContext{deps: Deps{LookPath: lookPathFor("apt-get")}.withDefaults()}
	if got := strings.Join(c.tmuxInstallCommand("linux"), " "); got != "apt-get install -y tmux" {
		t.Fatalf("got %q, want a bare invocation when sudo is absent", got)
	}
}
