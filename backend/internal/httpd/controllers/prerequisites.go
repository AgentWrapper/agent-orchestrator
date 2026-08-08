package controllers

import (
	"context"
	"net/http"
	"runtime"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/envelope"
	"github.com/aoagents/agent-orchestrator/backend/internal/prereq"
)

// PrerequisiteRunner runs an install command to completion and returns its
// combined output. The daemon has no terminal, so a command that prompts would
// hang: only commands reported as not needing root are ever handed to it.
type PrerequisiteRunner func(ctx context.Context, name string, args ...string) ([]byte, error)

// PrerequisitesController reports missing host prerequisites and, where it can
// be done without a password prompt, installs them.
//
// This exists because the daemon runs inside the desktop app, where a missing
// tmux otherwise surfaces only as a spawn-time error with no way to act on it.
// The CLI covers the same ground for `ao start` (see internal/cli/tmux.go).
type PrerequisitesController struct {
	// GOOS defaults to the host's when empty; tests set it to exercise the
	// per-platform answers.
	GOOS string
	// LookPath defaults to exec.LookPath when nil.
	LookPath prereq.LookPathFunc
	// Runner is nil when installs are unavailable, which makes every install
	// request a 501 rather than a panic.
	Runner PrerequisiteRunner
}

// Register mounts the prerequisite routes on the supplied router.
func (c *PrerequisitesController) Register(r chi.Router) {
	r.Get("/prerequisites", c.list)
	r.Post("/prerequisites/tmux/install", c.installTmux)
}

func (c *PrerequisitesController) goos() string {
	if c.GOOS != "" {
		return c.GOOS
	}
	return runtime.GOOS
}

// tmuxStatus converts the resolved prerequisite into its wire form.
func (c *PrerequisitesController) tmuxStatus() PrerequisiteStatus {
	status := prereq.Tmux(c.goos(), c.LookPath)
	out := PrerequisiteStatus{
		Name:      "tmux",
		Satisfied: status.Satisfied,
	}
	if status.Satisfied || len(status.Command) == 0 {
		return out
	}
	// Show the command the user would actually type, sudo and all. Installable
	// is deliberately false for anything needing root: the app cannot answer a
	// password prompt, so offering a button that hangs would be worse than
	// showing the line to copy.
	out.InstallCommand = strings.Join(status.Command, " ")
	if status.NeedsRoot {
		out.InstallCommand = "sudo " + out.InstallCommand
		return out
	}
	out.Installable = true
	return out
}

func (c *PrerequisitesController) list(w http.ResponseWriter, _ *http.Request) {
	envelope.WriteJSON(w, http.StatusOK, ListPrerequisitesResponse{Tmux: c.tmuxStatus()})
}

func (c *PrerequisitesController) installTmux(w http.ResponseWriter, r *http.Request) {
	status := c.tmuxStatus()
	switch {
	case status.Satisfied:
		// Already done, most likely by a second click or a manual install in
		// another window. Report success with the current state.
		envelope.WriteJSON(w, http.StatusOK, InstallPrerequisiteResponse{Prerequisite: status})
		return
	case !status.Installable:
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "PREREQUISITE_NOT_INSTALLABLE",
			"tmux cannot be installed from the app on this platform; run the install command yourself", nil)
		return
	case c.Runner == nil:
		envelope.WriteAPIError(w, r, http.StatusNotImplemented, "not_implemented", "PREREQUISITE_INSTALL_UNAVAILABLE",
			"this daemon cannot run installs", nil)
		return
	}

	argv := strings.Fields(status.InstallCommand)
	out, err := c.Runner(r.Context(), argv[0], argv[1:]...)
	if err != nil {
		envelope.WriteAPIError(w, r, http.StatusInternalServerError, "internal", "PREREQUISITE_INSTALL_FAILED",
			installFailureMessage(status.InstallCommand, out, err), nil)
		return
	}
	// A package manager can exit 0 and still leave nothing runnable, so the
	// re-check is the success signal, not the exit code.
	if after := c.tmuxStatus(); !after.Satisfied {
		envelope.WriteAPIError(w, r, http.StatusInternalServerError, "internal", "PREREQUISITE_INSTALL_INCOMPLETE",
			"`"+status.InstallCommand+"` finished but tmux is still not in PATH", nil)
		return
	}
	envelope.WriteJSON(w, http.StatusOK, InstallPrerequisiteResponse{Prerequisite: c.tmuxStatus()})
}

// installFailureMessage keeps the package manager's own diagnosis, which is
// usually the actionable part ("No available formula", a network failure),
// trimmed so one bad install cannot flood the UI.
func installFailureMessage(command string, out []byte, err error) string {
	msg := "`" + command + "` failed: " + err.Error()
	detail := strings.TrimSpace(string(out))
	if detail == "" {
		return msg
	}
	const maxDetail = 2000
	if len(detail) > maxDetail {
		detail = detail[len(detail)-maxDetail:]
	}
	return msg + "\n" + detail
}
