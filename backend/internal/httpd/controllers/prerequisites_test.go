package controllers_test

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/controllers"
	"github.com/aoagents/agent-orchestrator/backend/internal/prereq"
)

func prereqLookPathFor(available ...string) prereq.LookPathFunc {
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

func prereqRouter(t *testing.T, c *controllers.PrerequisitesController) http.Handler {
	t.Helper()
	r := chi.NewRouter()
	c.Register(r)
	return r
}

func prereqRequest(t *testing.T, h http.Handler, method, path string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(method, path, nil))
	return rec
}

func TestListPrerequisites(t *testing.T) {
	for _, tc := range []struct {
		name        string
		goos        string
		available   []string
		satisfied   bool
		command     string
		installable bool
	}{
		{name: "tmux present", goos: "darwin", available: []string{"tmux", "brew"}, satisfied: true},
		{name: "windows never needs tmux", goos: "windows", satisfied: true},
		{name: "macOS can install for the user", goos: "darwin", available: []string{"brew"}, command: "brew install tmux", installable: true},
		{name: "linux shows a sudo command it cannot run", goos: "linux", available: []string{"apt-get"}, command: "sudo apt-get install -y tmux"},
		{name: "no package manager", goos: "linux"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := prereqRouter(t, &controllers.PrerequisitesController{GOOS: tc.goos, LookPath: prereqLookPathFor(tc.available...)})
			rec := prereqRequest(t, h, http.MethodGet, "/prerequisites")
			if rec.Code != http.StatusOK {
				t.Fatalf("status = %d, want 200", rec.Code)
			}
			var body controllers.ListPrerequisitesResponse
			if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
				t.Fatalf("decode: %v (%s)", err, rec.Body)
			}
			if body.Tmux.Name != "tmux" {
				t.Fatalf("name = %q", body.Tmux.Name)
			}
			if body.Tmux.Satisfied != tc.satisfied {
				t.Fatalf("satisfied = %v, want %v", body.Tmux.Satisfied, tc.satisfied)
			}
			if body.Tmux.InstallCommand != tc.command {
				t.Fatalf("installCommand = %q, want %q", body.Tmux.InstallCommand, tc.command)
			}
			if body.Tmux.Installable != tc.installable {
				t.Fatalf("installable = %v, want %v", body.Tmux.Installable, tc.installable)
			}
		})
	}
}

func TestInstallTmuxRunsHomebrew(t *testing.T) {
	installed := false
	var ran []string
	h := prereqRouter(t, &controllers.PrerequisitesController{
		GOOS: "darwin",
		LookPath: func(file string) (string, error) {
			if file == "tmux" && !installed {
				return "", exec.ErrNotFound
			}
			return "/usr/bin/" + file, nil
		},
		Runner: func(_ context.Context, name string, args ...string) ([]byte, error) {
			ran = append([]string{name}, args...)
			installed = true
			return []byte("==> Pouring tmux"), nil
		},
	})

	rec := prereqRequest(t, h, http.MethodPost, "/prerequisites/tmux/install")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	if got := strings.Join(ran, " "); got != "brew install tmux" {
		t.Fatalf("ran %q, want brew install tmux", got)
	}
	var body controllers.InstallPrerequisiteResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !body.Prerequisite.Satisfied {
		t.Fatal("expected the prerequisite to be satisfied after installing")
	}
}

// The daemon has no terminal, so a command needing a password must never be run
// on the user's behalf, however the request arrives.
func TestInstallTmuxRefusesWhatItCannotRun(t *testing.T) {
	for _, tc := range []struct {
		name      string
		goos      string
		available []string
		runner    controllers.PrerequisiteRunner
		want      int
		wantCode  string
	}{
		{
			name: "needs root", goos: "linux", available: []string{"apt-get", "sudo"},
			want: http.StatusBadRequest, wantCode: "PREREQUISITE_NOT_INSTALLABLE",
		},
		{
			name: "no package manager", goos: "darwin",
			want: http.StatusBadRequest, wantCode: "PREREQUISITE_NOT_INSTALLABLE",
		},
		{
			name: "no runner wired", goos: "darwin", available: []string{"brew"},
			want: http.StatusNotImplemented, wantCode: "PREREQUISITE_INSTALL_UNAVAILABLE",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := prereqRouter(t, &controllers.PrerequisitesController{
				GOOS:     tc.goos,
				LookPath: prereqLookPathFor(tc.available...),
				Runner: func(context.Context, string, ...string) ([]byte, error) {
					t.Fatal("must not run an install")
					return nil, nil
				},
			})
			if tc.name == "no runner wired" {
				h = prereqRouter(t, &controllers.PrerequisitesController{GOOS: tc.goos, LookPath: prereqLookPathFor(tc.available...)})
			}
			rec := prereqRequest(t, h, http.MethodPost, "/prerequisites/tmux/install")
			if rec.Code != tc.want {
				t.Fatalf("status = %d, want %d (%s)", rec.Code, tc.want, rec.Body)
			}
			if !strings.Contains(rec.Body.String(), tc.wantCode) {
				t.Fatalf("body %s should carry %s", rec.Body, tc.wantCode)
			}
		})
	}
}

func TestInstallTmuxFailures(t *testing.T) {
	for _, tc := range []struct {
		name      string
		runErr    error
		out       string
		installed bool
		wantCode  string
		wantText  string
	}{
		{
			name: "command fails", runErr: errors.New("exit status 1"), out: "Error: No available formula",
			wantCode: "PREREQUISITE_INSTALL_FAILED", wantText: "No available formula",
		},
		{
			name: "exits 0 without producing tmux", installed: false,
			wantCode: "PREREQUISITE_INSTALL_INCOMPLETE", wantText: "still not in PATH",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := prereqRouter(t, &controllers.PrerequisitesController{
				GOOS:     "darwin",
				LookPath: prereqLookPathFor("brew"),
				Runner: func(context.Context, string, ...string) ([]byte, error) {
					return []byte(tc.out), tc.runErr
				},
			})
			rec := prereqRequest(t, h, http.MethodPost, "/prerequisites/tmux/install")
			if rec.Code != http.StatusInternalServerError {
				t.Fatalf("status = %d, want 500", rec.Code)
			}
			if !strings.Contains(rec.Body.String(), tc.wantCode) {
				t.Fatalf("body %s should carry %s", rec.Body, tc.wantCode)
			}
			if !strings.Contains(rec.Body.String(), tc.wantText) {
				t.Fatalf("body %s should mention %q", rec.Body, tc.wantText)
			}
		})
	}
}

// A second click, or a manual install in another window, is a success not an error.
func TestInstallTmuxAlreadySatisfied(t *testing.T) {
	h := prereqRouter(t, &controllers.PrerequisitesController{
		GOOS:     "darwin",
		LookPath: prereqLookPathFor("tmux", "brew"),
		Runner: func(context.Context, string, ...string) ([]byte, error) {
			t.Fatal("must not reinstall")
			return nil, nil
		},
	})
	rec := prereqRequest(t, h, http.MethodPost, "/prerequisites/tmux/install")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
}
