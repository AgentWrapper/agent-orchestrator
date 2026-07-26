package shellterm

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

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

// SessionWorkspaceLocator resolves a session id to the workspace it is
// currently running in, plus the project it belongs to. The project id lets
// the caller fall back to the project root when the session has no workspace
// of its own yet. The daemon wiring adapts the session service to it.
type SessionWorkspaceLocator interface {
	SessionWorkspace(ctx context.Context, id domain.SessionID) (workspacePath string, projectID domain.ProjectID, err error)
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
	sessions SessionWorkspaceLocator
	dataDir  string
	appRunID string
	log      *slog.Logger

	// now and newHandleID are injectable so tests can assert on exact ids and
	// timestamps without a clock or entropy dependency.
	now         func() time.Time
	newHandleID func() (string, error)

	// gatesMu guards gates and held below (the bookkeeping), not the
	// individual gate mutexes themselves.
	gatesMu sync.Mutex
	// gates holds one entry per session ever seen by BeginSessionTeardown or
	// OpenShellTerminal, for the lifetime of the daemon process. Left
	// unbounded deliberately: a session count that would make this matter is
	// not a shape AO's single-user daemon runs at.
	gates map[domain.SessionID]*sessionGate
	// held records which sessions currently have their gate mutex locked by an
	// in-flight, successful BeginSessionTeardown. There is no safe way to ask a
	// sync.Mutex "are you currently locked", so this is what makes
	// EndSessionTeardown idempotent: a caller that calls it without a matching
	// successful Begin (a caller bug, or a Begin that returned an error and
	// already released its own lock) gets a no-op instead of a double-unlock
	// panic.
	held map[domain.SessionID]bool
}

// sessionGate is the admission/teardown barrier for one session's scoped
// shell terminals. Its mutex is held for the ENTIRE span from
// BeginSessionTeardown through the matching EndSessionTeardown — deliberately
// crossing the call into Session Manager's own worktree teardown in between —
// so an OpenShellTerminal racing against that window blocks until the window
// ends, rather than slipping a new shell in against a worktree that is
// mid-removal. By the time a blocked Open acquires the lock, the teardown it
// waited on has fully finished (destroyed or preserved), so there is nothing
// left to check here: resolveShellTerminalWorkingDir's own existence check is
// what decides whether that Open lands in the worktree or falls back.
type sessionGate struct {
	mu sync.Mutex
}

// NewService builds the shell terminal service. dataDir is the fallback working
// directory for a shell opened with no project context. A nil logger falls back
// to slog.Default.
func NewService(runtime ShellRuntime, store Store, projects ProjectRootLocator, sessions SessionWorkspaceLocator, dataDir, appRunID string, log *slog.Logger) *Service {
	if log == nil {
		log = slog.Default()
	}
	return &Service{
		runtime:     runtime,
		store:       store,
		projects:    projects,
		sessions:    sessions,
		dataDir:     dataDir,
		appRunID:    appRunID,
		log:         log,
		now:         time.Now,
		newHandleID: newShellTerminalHandleID,
		gates:       map[domain.SessionID]*sessionGate{},
		held:        map[domain.SessionID]bool{},
	}
}

// sessionGateFor returns the gate for id, creating it on first use.
func (s *Service) sessionGateFor(id domain.SessionID) *sessionGate {
	s.gatesMu.Lock()
	defer s.gatesMu.Unlock()
	g, ok := s.gates[id]
	if !ok {
		g = &sessionGate{}
		s.gates[id] = g
	}
	return g
}

// OpenShellTerminal spawns a shell PTY and records it against the current app
// run. The runtime is created BEFORE the row is written, and rolled back if the
// write fails, so a persisted row always names a PTY that actually exists —
// otherwise a restart would try to re-attach to a handle that was never spawned.
//
// A session-scoped open holds that session's gate for the whole call: without
// this, a shell could be inserted between BeginSessionTeardown's snapshot read
// and Session Manager's own worktree destroy a moment later, landing a fresh
// shell in a directory that is about to disappear. Holding the gate here means
// the open either runs entirely before a teardown starts, or blocks until the
// teardown (and the gate) releases — at which point resolveShellTerminalWorkingDir's
// existence check sees the worktree is gone and falls back to the project root.
func (s *Service) OpenShellTerminal(ctx context.Context, in OpenShellTerminalInput) (ShellTerminal, error) {
	if in.SessionID != "" {
		gate := s.sessionGateFor(in.SessionID)
		gate.mu.Lock()
		defer gate.mu.Unlock()
	}
	workingDir, err := s.resolveShellTerminalWorkingDir(ctx, in.ProjectID, in.SessionID)
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
		SessionID:  in.SessionID,
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

// maxShellTerminalTitleLen bounds a user-supplied tab name. Tabs are truncated
// in the UI anyway; this only stops an unbounded string reaching the DB.
const maxShellTerminalTitleLen = 80

// RenameShellTerminal sets a shell terminal's tab title. The title is trimmed
// and must be non-empty and within the length bound; an unknown handle is a 404.
func (s *Service) RenameShellTerminal(ctx context.Context, handleID, title string) (ShellTerminal, error) {
	if handleID == "" {
		return ShellTerminal{}, apierr.Invalid("SHELL_TERMINAL_ID_REQUIRED", "A shell terminal id is required", nil)
	}
	title = strings.TrimSpace(title)
	if title == "" {
		return ShellTerminal{}, apierr.Invalid("SHELL_TERMINAL_TITLE_REQUIRED", "A shell terminal title is required", nil)
	}
	if utf8.RuneCountInString(title) > maxShellTerminalTitleLen {
		return ShellTerminal{}, apierr.Invalid("SHELL_TERMINAL_TITLE_TOO_LONG",
			fmt.Sprintf("A shell terminal title must be at most %d characters", maxShellTerminalTitleLen), nil)
	}
	rec, found, err := s.store.UpdateShellTerminalTitle(ctx, handleID, title)
	if err != nil {
		return ShellTerminal{}, fmt.Errorf("rename shell terminal %s: %w", handleID, err)
	}
	if !found {
		return ShellTerminal{}, apierr.NotFound("SHELL_TERMINAL_NOT_FOUND", "No such shell terminal: "+handleID)
	}
	s.log.Info("shell terminal renamed", "handleId", handleID)
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

// BeginSessionTeardown drains every shell terminal scoped to a session and
// locks out new ones, ahead of Session Manager tearing down the session's
// worktree (Kill, Cleanup, RetireForReplacement, the reconcile/shutdown
// save-and-teardown path). It is the write side of the same gate
// OpenShellTerminal reads: acquiring sessionGate.mu here is what makes a
// concurrent Open either finish first or block until EndSessionTeardown, so
// nothing can insert a new shell terminal into a worktree that is about to
// disappear.
//
// A runtime that cannot be confirmed dead is NOT deleted — its row survives so
// the terminal is still visible/re-attachable — and its error is folded into
// the returned aggregate. On error the gate is released and the caller MUST
// NOT touch the worktree: some scoped shell may still be reading or writing
// under it. On success the gate stays held; the caller MUST call
// EndSessionTeardown (typically via defer) once its own worktree work
// finishes, whatever the outcome, or the session's shell terminals stay
// gated shut forever.
func (s *Service) BeginSessionTeardown(ctx context.Context, sessionID domain.SessionID) error {
	gate := s.sessionGateFor(sessionID)
	gate.mu.Lock()

	recs, err := s.store.SelectShellTerminalsBySessionID(ctx, sessionID)
	if err != nil {
		gate.mu.Unlock()
		return fmt.Errorf("close shell terminals for session %s: %w", sessionID, err)
	}

	var stillAlive []error
	for _, rec := range recs {
		if destroyErr := s.runtime.Destroy(ctx, ports.RuntimeHandle{ID: rec.HandleID}); destroyErr != nil {
			// A destroy error alone isn't proof the shell survived — some
			// runtimes error on an already-gone handle. Confirm via IsAlive
			// before deciding whether the worktree can safely go away.
			alive, aliveErr := s.runtime.IsAlive(ctx, ports.RuntimeHandle{ID: rec.HandleID})
			if aliveErr != nil || alive {
				s.log.Warn("close shell terminal for session: runtime still alive after destroy",
					"sessionID", sessionID, "handleId", rec.HandleID, "error", destroyErr)
				stillAlive = append(stillAlive, fmt.Errorf("%s: %w", rec.HandleID, destroyErr))
				continue
			}
		}
		if _, delErr := s.store.DeleteShellTerminalByHandleID(ctx, rec.HandleID); delErr != nil {
			s.log.Warn("close shell terminal for session: delete row failed",
				"sessionID", sessionID, "handleId", rec.HandleID, "error", delErr)
		}
	}

	if len(stillAlive) > 0 {
		gate.mu.Unlock()
		return fmt.Errorf("close shell terminals for session %s: %d still alive: %w",
			sessionID, len(stillAlive), errors.Join(stillAlive...))
	}
	s.gatesMu.Lock()
	s.held[sessionID] = true
	s.gatesMu.Unlock()
	return nil
}

// EndSessionTeardown releases the gate a successful BeginSessionTeardown
// took, letting OpenShellTerminal proceed again for this session. Safe to
// call even without a matching successful Begin (a caller bug, or a Begin
// that already failed and released its own lock) — it is a no-op unless held
// says this session's gate is genuinely still locked.
func (s *Service) EndSessionTeardown(sessionID domain.SessionID) {
	s.gatesMu.Lock()
	gate, ok := s.gates[sessionID]
	wasHeld := s.held[sessionID]
	if wasHeld {
		s.held[sessionID] = false
	}
	s.gatesMu.Unlock()
	if !ok || !wasHeld {
		return
	}
	gate.mu.Unlock()
}

// resolveShellTerminalWorkingDir picks where the shell starts. A session id
// takes precedence: the shell lands in that session's live workspace (its
// worktree), so it stays colocated with the agent even though that worktree
// differs from the project's registered root. A session with no workspace yet
// (or no session id at all) falls back to the project root, then the daemon's
// data dir.
func (s *Service) resolveShellTerminalWorkingDir(ctx context.Context, projectID domain.ProjectID, sessionID domain.SessionID) (string, error) {
	if sessionID != "" {
		if s.sessions == nil {
			return "", apierr.Internal("SHELL_TERMINAL_NO_SESSION_LOOKUP", "Session lookup is unavailable")
		}
		workspacePath, sessionProjectID, err := s.sessions.SessionWorkspace(ctx, sessionID)
		if err != nil {
			return "", fmt.Errorf("open shell terminal: resolve session %s: %w", sessionID, err)
		}
		if workspacePath != "" {
			return workspacePath, nil
		}
		projectID = sessionProjectID
	}
	return s.resolveProjectRootOrDataDir(ctx, projectID)
}

// resolveProjectRootOrDataDir picks the project root when a project is named,
// else the daemon's data dir.
func (s *Service) resolveProjectRootOrDataDir(ctx context.Context, projectID domain.ProjectID) (string, error) {
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
		SessionID:  rec.SessionID,
		WorkingDir: rec.WorkingDir,
		Title:      rec.Title,
		CreatedAt:  rec.CreatedAt,
	}
}
