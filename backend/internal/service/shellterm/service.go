package shellterm

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"log/slog"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apierr"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// ShellRuntime is the slice of the runtime adapter a shell terminal needs:
// spawn a PTY around an argv, tear it down, and answer whether it is still
// alive. It is deliberately narrower than ports.Runtime — a shell terminal
// never reads captured output the way the activity observer does.
type ShellRuntime interface {
	Create(ctx context.Context, cfg ports.RuntimeConfig) (ports.RuntimeHandle, error)
	Destroy(ctx context.Context, handle ports.RuntimeHandle) error
	IsAlive(ctx context.Context, handle ports.RuntimeHandle) (bool, error)
}

// ProjectRootLocator resolves a project id to the directory a shell should
// start in. The daemon wiring adapts the project service to it.
type ProjectRootLocator interface {
	ProjectRoot(ctx context.Context, id domain.ProjectID) (string, error)
}

// Service opens, lists, and closes standalone shell terminals.
//
// appRunID is minted once per desktop-app launch and is the mechanism behind
// the feature's lifetime rule: shells must survive a DAEMON restart but die
// with the APP. Rows tagged with the current run are re-attachable; rows tagged
// with any other run are orphans from an app that exited without closing them
// (a crash or force-kill, where the clean shutdown path never ran) and are
// destroyed at boot by ReapShellTerminalsFromPreviousAppRuns.
type Service struct {
	runtime  ShellRuntime
	store    Store
	projects ProjectRootLocator
	dataDir  string
	appRunID string
	log      *slog.Logger

	// now and newHandleID are injectable so tests can assert on exact ids and
	// timestamps without a clock or entropy dependency.
	now         func() time.Time
	newHandleID func() (string, error)
}

// NewService builds the shell terminal service. dataDir is the fallback working
// directory for a shell opened with no project context. A nil logger falls back
// to slog.Default.
func NewService(runtime ShellRuntime, store Store, projects ProjectRootLocator, dataDir, appRunID string, log *slog.Logger) *Service {
	if log == nil {
		log = slog.Default()
	}
	return &Service{
		runtime:     runtime,
		store:       store,
		projects:    projects,
		dataDir:     dataDir,
		appRunID:    appRunID,
		log:         log,
		now:         time.Now,
		newHandleID: newShellTerminalHandleID,
	}
}

// OpenShellTerminal spawns a shell PTY and records it against the current app
// run. The runtime is created BEFORE the row is written, and rolled back if the
// write fails, so a persisted row always names a PTY that actually exists —
// otherwise a restart would try to re-attach to a handle that was never spawned.
func (s *Service) OpenShellTerminal(ctx context.Context, in OpenShellTerminalInput) (ShellTerminal, error) {
	workingDir, err := s.resolveShellTerminalWorkingDir(ctx, in.ProjectID)
	if err != nil {
		return ShellTerminal{}, err
	}
	argv := resolveUserLoginShell()
	if len(argv) == 0 {
		return ShellTerminal{}, apierr.Internal("SHELL_TERMINAL_NO_SHELL",
			"Could not determine a shell to launch. Set SHELL (macOS/Linux) or ComSpec (Windows).")
	}
	handleID, err := s.newHandleID()
	if err != nil {
		return ShellTerminal{}, fmt.Errorf("open shell terminal: handle id: %w", err)
	}

	// SessionID is the runtime adapters' name for "what to call this PTY"; it
	// is not a session row and no sessions record is ever created. The
	// shellterm- prefix keeps the two namespaces disjoint.
	handle, err := s.runtime.Create(ctx, ports.RuntimeConfig{
		SessionID:     domain.SessionID(handleID),
		WorkspacePath: workingDir,
		Argv:          argv,
	})
	if err != nil {
		return ShellTerminal{}, fmt.Errorf("open shell terminal %s: runtime: %w", handleID, err)
	}

	rec := ShellTerminalRecord{
		HandleID:   handle.ID,
		ProjectID:  in.ProjectID,
		WorkingDir: workingDir,
		Title:      shellTerminalTitle(workingDir),
		AppRunID:   s.appRunID,
		CreatedAt:  s.now().UTC(),
	}
	if err := s.store.InsertShellTerminal(ctx, rec); err != nil {
		// Roll back the PTY: an unrecorded runtime would never be reaped,
		// leaking a tmux session / pty-host for the life of the machine.
		if destroyErr := s.runtime.Destroy(context.WithoutCancel(ctx), handle); destroyErr != nil {
			s.log.Warn("shell terminal rollback failed; runtime may be orphaned",
				"handleId", handle.ID, "error", destroyErr)
		}
		return ShellTerminal{}, fmt.Errorf("open shell terminal %s: persist: %w", handle.ID, err)
	}

	s.log.Info("shell terminal opened", "handleId", handle.ID, "workingDir", workingDir)
	return shellTerminalFromRecord(rec), nil
}

// CloseShellTerminal destroys a shell's PTY and forgets it. The row is deleted
// even when the runtime teardown fails: the PTY may already be gone (the user
// typed `exit`), and keeping an undeletable row would strand the tab forever.
func (s *Service) CloseShellTerminal(ctx context.Context, handleID string) error {
	if handleID == "" {
		return apierr.Invalid("SHELL_TERMINAL_ID_REQUIRED", "A shell terminal id is required", nil)
	}
	deleted, err := s.store.DeleteShellTerminalByHandleID(ctx, handleID)
	if err != nil {
		return fmt.Errorf("close shell terminal %s: %w", handleID, err)
	}
	if !deleted {
		return apierr.NotFound("SHELL_TERMINAL_NOT_FOUND", "No such shell terminal: "+handleID)
	}
	if err := s.runtime.Destroy(ctx, ports.RuntimeHandle{ID: handleID}); err != nil {
		s.log.Warn("shell terminal runtime teardown failed", "handleId", handleID, "error", err)
	}
	return nil
}

// ListShellTerminalsForCurrentAppRun returns the shells the running app owns,
// dropping any whose PTY has died (the user typed `exit`, or the machine
// rebooted out from under a persisted row). Dead rows are deleted as they are
// found, so the list the UI renders only ever contains attachable panes.
//
// A liveness probe that ERRORS is not treated as proof of death — the same rule
// internal/terminal applies on attach — so a transient runtime hiccup cannot
// silently delete a working terminal.
func (s *Service) ListShellTerminalsForCurrentAppRun(ctx context.Context) ([]ShellTerminal, error) {
	recs, err := s.store.SelectShellTerminalsByAppRunID(ctx, s.appRunID)
	if err != nil {
		return nil, fmt.Errorf("list shell terminals: %w", err)
	}
	out := make([]ShellTerminal, 0, len(recs))
	for _, rec := range recs {
		alive, err := s.runtime.IsAlive(ctx, ports.RuntimeHandle{ID: rec.HandleID})
		if err != nil {
			s.log.Warn("shell terminal liveness probe failed; keeping row",
				"handleId", rec.HandleID, "error", err)
			out = append(out, shellTerminalFromRecord(rec))
			continue
		}
		if !alive {
			if _, delErr := s.store.DeleteShellTerminalByHandleID(ctx, rec.HandleID); delErr != nil {
				s.log.Warn("pruning dead shell terminal failed", "handleId", rec.HandleID, "error", delErr)
			}
			continue
		}
		out = append(out, shellTerminalFromRecord(rec))
	}
	return out, nil
}

// ReapShellTerminalsFromPreviousAppRuns destroys shells left behind by an
// earlier app run and returns how many rows it cleared. This is the half of the
// lifetime rule the clean shutdown path cannot cover: when the app crashes or
// is force-killed, nothing gets to close its terminals, so they are swept here
// on the next boot instead of leaking forever.
//
// Runtime teardown is best-effort per handle — one un-destroyable PTY must not
// prevent the rest from being reaped, and the rows are cleared regardless so a
// permanently unkillable handle cannot wedge every future boot.
func (s *Service) ReapShellTerminalsFromPreviousAppRuns(ctx context.Context) (int64, error) {
	orphans, err := s.store.SelectShellTerminalsFromPreviousAppRuns(ctx, s.appRunID)
	if err != nil {
		return 0, fmt.Errorf("reap shell terminals: %w", err)
	}
	for _, rec := range orphans {
		if err := s.runtime.Destroy(ctx, ports.RuntimeHandle{ID: rec.HandleID}); err != nil {
			s.log.Warn("reaping orphaned shell terminal failed",
				"handleId", rec.HandleID, "appRunId", rec.AppRunID, "error", err)
		}
	}
	cleared, err := s.store.DeleteShellTerminalsFromPreviousAppRuns(ctx, s.appRunID)
	if err != nil {
		return 0, fmt.Errorf("reap shell terminals: clear rows: %w", err)
	}
	if cleared > 0 {
		s.log.Info("reaped shell terminals from previous app runs", "count", cleared)
	}
	return cleared, nil
}

// resolveShellTerminalWorkingDir picks where the shell starts: the project root
// when a project is named, else the daemon's data dir.
func (s *Service) resolveShellTerminalWorkingDir(ctx context.Context, projectID domain.ProjectID) (string, error) {
	if projectID == "" {
		if s.dataDir == "" {
			return "", apierr.Internal("SHELL_TERMINAL_NO_WORKING_DIR",
				"No project selected and the daemon has no data dir to fall back to")
		}
		return s.dataDir, nil
	}
	if s.projects == nil {
		return "", apierr.Internal("SHELL_TERMINAL_NO_PROJECT_LOOKUP",
			"Project lookup is unavailable")
	}
	root, err := s.projects.ProjectRoot(ctx, projectID)
	if err != nil {
		return "", fmt.Errorf("open shell terminal: resolve project %s: %w", projectID, err)
	}
	if root == "" {
		return "", apierr.NotFound("SHELL_TERMINAL_PROJECT_NOT_FOUND",
			"No such project: "+string(projectID))
	}
	return root, nil
}

// newShellTerminalHandleID mints a runtime handle id for a shell pane.
//
// The shellterm- prefix keeps shell handles trivially distinguishable from
// session handles in logs, the DB, and the mux. The character set is
// constrained by the runtime adapters, which are stricter than they look:
// conpty rejects anything outside ^[a-zA-Z0-9_-]+$ and tmux uses the id as a
// session name — so hex, not base64.
func newShellTerminalHandleID() (string, error) {
	buf := make([]byte, 8)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return "shellterm-" + hex.EncodeToString(buf), nil
}

func shellTerminalFromRecord(rec ShellTerminalRecord) ShellTerminal {
	return ShellTerminal{
		HandleID:   rec.HandleID,
		ProjectID:  rec.ProjectID,
		WorkingDir: rec.WorkingDir,
		Title:      rec.Title,
		CreatedAt:  rec.CreatedAt,
	}
}
