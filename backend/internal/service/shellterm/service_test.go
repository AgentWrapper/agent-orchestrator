package shellterm

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apierr"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

const testAppRunID = "app-run-current"

func testLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// fakeShellRuntime records every runtime call so tests can assert on what was
// spawned and what was torn down.
type fakeShellRuntime struct {
	created   []ports.RuntimeConfig
	destroyed []string

	createErr  error
	destroyErr error
	// aliveByHandle answers IsAlive; a handle absent from the map is dead.
	aliveByHandle map[string]bool
	aliveErr      error
}

func newFakeShellRuntime() *fakeShellRuntime {
	return &fakeShellRuntime{aliveByHandle: map[string]bool{}}
}

func (f *fakeShellRuntime) Create(_ context.Context, cfg ports.RuntimeConfig) (ports.RuntimeHandle, error) {
	if f.createErr != nil {
		return ports.RuntimeHandle{}, f.createErr
	}
	f.created = append(f.created, cfg)
	f.aliveByHandle[string(cfg.SessionID)] = true
	return ports.RuntimeHandle{ID: string(cfg.SessionID)}, nil
}

func (f *fakeShellRuntime) Destroy(_ context.Context, handle ports.RuntimeHandle) error {
	f.destroyed = append(f.destroyed, handle.ID)
	delete(f.aliveByHandle, handle.ID)
	return f.destroyErr
}

func (f *fakeShellRuntime) IsAlive(_ context.Context, handle ports.RuntimeHandle) (bool, error) {
	if f.aliveErr != nil {
		return false, f.aliveErr
	}
	return f.aliveByHandle[handle.ID], nil
}

// fakeShellTerminalStore is an in-memory Store keyed by handle id.
type fakeShellTerminalStore struct {
	records   []ShellTerminalRecord
	insertErr error
}

func (f *fakeShellTerminalStore) InsertShellTerminal(_ context.Context, rec ShellTerminalRecord) error {
	if f.insertErr != nil {
		return f.insertErr
	}
	f.records = append(f.records, rec)
	return nil
}

func (f *fakeShellTerminalStore) SelectShellTerminalsByAppRunID(_ context.Context, appRunID string) ([]ShellTerminalRecord, error) {
	var out []ShellTerminalRecord
	for _, rec := range f.records {
		if rec.AppRunID == appRunID {
			out = append(out, rec)
		}
	}
	return out, nil
}

func (f *fakeShellTerminalStore) SelectShellTerminalsFromPreviousAppRuns(_ context.Context, appRunID string) ([]ShellTerminalRecord, error) {
	var out []ShellTerminalRecord
	for _, rec := range f.records {
		if rec.AppRunID != appRunID {
			out = append(out, rec)
		}
	}
	return out, nil
}

func (f *fakeShellTerminalStore) DeleteShellTerminalByHandleID(_ context.Context, handleID string) (bool, error) {
	for i, rec := range f.records {
		if rec.HandleID == handleID {
			f.records = append(f.records[:i], f.records[i+1:]...)
			return true, nil
		}
	}
	return false, nil
}

func (f *fakeShellTerminalStore) DeleteShellTerminalsFromPreviousAppRuns(_ context.Context, appRunID string) (int64, error) {
	kept := make([]ShellTerminalRecord, 0, len(f.records))
	var cleared int64
	for _, rec := range f.records {
		if rec.AppRunID == appRunID {
			kept = append(kept, rec)
			continue
		}
		cleared++
	}
	f.records = kept
	return cleared, nil
}

type fakeProjectRootLocator struct {
	roots map[domain.ProjectID]string
	err   error
}

func (f *fakeProjectRootLocator) ProjectRoot(_ context.Context, id domain.ProjectID) (string, error) {
	if f.err != nil {
		return "", f.err
	}
	return f.roots[id], nil
}

// newTestService wires a service with deterministic ids so assertions can name
// exact handles instead of matching on a prefix.
func newTestService(rt *fakeShellRuntime, st *fakeShellTerminalStore, projects ProjectRootLocator) *Service {
	svc := NewService(rt, st, projects, "/data/dir", testAppRunID, testLogger())
	var n int
	svc.newHandleID = func() (string, error) {
		n++
		return "shellterm-test" + string(rune('0'+n)), nil
	}
	svc.now = func() time.Time { return time.Date(2026, 7, 20, 12, 0, 0, 0, time.UTC) }
	return svc
}

func TestOpenShellTerminalStartsLoginShellInProjectRoot(t *testing.T) {
	rt := newFakeShellRuntime()
	st := &fakeShellTerminalStore{}
	projects := &fakeProjectRootLocator{roots: map[domain.ProjectID]string{"portfolio": "/repos/portfolio"}}
	svc := newTestService(rt, st, projects)

	term, err := svc.OpenShellTerminal(context.Background(), OpenShellTerminalInput{ProjectID: "portfolio"})
	if err != nil {
		t.Fatalf("OpenShellTerminal: %v", err)
	}

	if len(rt.created) != 1 {
		t.Fatalf("runtime creates = %d, want 1", len(rt.created))
	}
	if got := rt.created[0].WorkspacePath; got != "/repos/portfolio" {
		t.Errorf("workspace path = %q, want the project root", got)
	}
	if len(rt.created[0].Argv) == 0 {
		t.Error("argv is empty; a shell terminal must launch a resolved shell")
	}
	if term.WorkingDir != "/repos/portfolio" {
		t.Errorf("working dir = %q, want the project root", term.WorkingDir)
	}
	if term.Title != "portfolio" {
		t.Errorf("title = %q, want the working dir's base name", term.Title)
	}
	if len(st.records) != 1 || st.records[0].AppRunID != testAppRunID {
		t.Fatalf("record not persisted against the current app run: %+v", st.records)
	}
}

func TestOpenShellTerminalFallsBackToDataDirWhenNoProjectGiven(t *testing.T) {
	rt := newFakeShellRuntime()
	svc := newTestService(rt, &fakeShellTerminalStore{}, &fakeProjectRootLocator{})

	term, err := svc.OpenShellTerminal(context.Background(), OpenShellTerminalInput{})
	if err != nil {
		t.Fatalf("OpenShellTerminal: %v", err)
	}
	if term.WorkingDir != "/data/dir" {
		t.Errorf("working dir = %q, want the daemon data dir", term.WorkingDir)
	}
	if term.ProjectID != "" {
		t.Errorf("project id = %q, want empty", term.ProjectID)
	}
}

func TestOpenShellTerminalReturnsNotFoundForUnknownProject(t *testing.T) {
	rt := newFakeShellRuntime()
	svc := newTestService(rt, &fakeShellTerminalStore{}, &fakeProjectRootLocator{roots: map[domain.ProjectID]string{}})

	_, err := svc.OpenShellTerminal(context.Background(), OpenShellTerminalInput{ProjectID: "ghost"})

	var apiErr *apierr.Error
	if !errors.As(err, &apiErr) || apiErr.Kind != apierr.KindNotFound {
		t.Fatalf("error = %v, want a not-found apierr", err)
	}
	if len(rt.created) != 0 {
		t.Error("a runtime was spawned for an unknown project")
	}
}

// A row that names a PTY nobody spawned would be re-attached forever after a
// restart, so a failed insert must take the runtime down with it.
func TestOpenShellTerminalDestroysRuntimeWhenPersistFails(t *testing.T) {
	rt := newFakeShellRuntime()
	st := &fakeShellTerminalStore{insertErr: errors.New("disk full")}
	svc := newTestService(rt, st, &fakeProjectRootLocator{})

	if _, err := svc.OpenShellTerminal(context.Background(), OpenShellTerminalInput{}); err == nil {
		t.Fatal("OpenShellTerminal succeeded despite a failed insert")
	}
	if len(rt.destroyed) != 1 {
		t.Fatalf("destroyed runtimes = %v, want the spawned PTY rolled back", rt.destroyed)
	}
	if rt.destroyed[0] != string(rt.created[0].SessionID) {
		t.Errorf("destroyed %q, want the handle that was just created", rt.destroyed[0])
	}
}

func TestCloseShellTerminalDestroysRuntimeAndDeletesRecord(t *testing.T) {
	rt := newFakeShellRuntime()
	st := &fakeShellTerminalStore{}
	svc := newTestService(rt, st, &fakeProjectRootLocator{})

	term, err := svc.OpenShellTerminal(context.Background(), OpenShellTerminalInput{})
	if err != nil {
		t.Fatalf("OpenShellTerminal: %v", err)
	}
	if err := svc.CloseShellTerminal(context.Background(), term.HandleID); err != nil {
		t.Fatalf("CloseShellTerminal: %v", err)
	}

	if len(st.records) != 0 {
		t.Errorf("records = %+v, want the row deleted", st.records)
	}
	if len(rt.destroyed) != 1 || rt.destroyed[0] != term.HandleID {
		t.Errorf("destroyed = %v, want %q", rt.destroyed, term.HandleID)
	}
}

func TestCloseShellTerminalReturnsNotFoundForUnknownHandle(t *testing.T) {
	svc := newTestService(newFakeShellRuntime(), &fakeShellTerminalStore{}, &fakeProjectRootLocator{})

	err := svc.CloseShellTerminal(context.Background(), "shellterm-missing")

	var apiErr *apierr.Error
	if !errors.As(err, &apiErr) || apiErr.Kind != apierr.KindNotFound {
		t.Fatalf("error = %v, want a not-found apierr", err)
	}
}

// The daemon may restart under a live app; the shells it left behind are still
// running and must come back as attachable tabs.
func TestListShellTerminalsForCurrentAppRunReturnsSurvivingTerminals(t *testing.T) {
	rt := newFakeShellRuntime()
	st := &fakeShellTerminalStore{}
	svc := newTestService(rt, st, &fakeProjectRootLocator{})
	term, err := svc.OpenShellTerminal(context.Background(), OpenShellTerminalInput{})
	if err != nil {
		t.Fatalf("OpenShellTerminal: %v", err)
	}

	// A fresh Service over the SAME store and runtime stands in for the daemon
	// coming back up within one app run.
	restarted := NewService(rt, st, &fakeProjectRootLocator{}, "/data/dir", testAppRunID, testLogger())
	got, err := restarted.ListShellTerminalsForCurrentAppRun(context.Background())
	if err != nil {
		t.Fatalf("ListShellTerminalsForCurrentAppRun: %v", err)
	}
	if len(got) != 1 || got[0].HandleID != term.HandleID {
		t.Fatalf("terminals = %+v, want the surviving handle %q", got, term.HandleID)
	}
}

func TestListShellTerminalsForCurrentAppRunPrunesTerminalsWhoseShellExited(t *testing.T) {
	rt := newFakeShellRuntime()
	st := &fakeShellTerminalStore{}
	svc := newTestService(rt, st, &fakeProjectRootLocator{})
	term, err := svc.OpenShellTerminal(context.Background(), OpenShellTerminalInput{})
	if err != nil {
		t.Fatalf("OpenShellTerminal: %v", err)
	}
	delete(rt.aliveByHandle, term.HandleID) // the user typed `exit`

	got, err := svc.ListShellTerminalsForCurrentAppRun(context.Background())
	if err != nil {
		t.Fatalf("ListShellTerminalsForCurrentAppRun: %v", err)
	}
	if len(got) != 0 {
		t.Errorf("terminals = %+v, want the dead shell pruned", got)
	}
	if len(st.records) != 0 {
		t.Errorf("records = %+v, want the dead row deleted", st.records)
	}
}

// A probe ERROR is not proof of death — the same rule internal/terminal applies
// on attach. A transient runtime hiccup must not delete a working terminal.
func TestListShellTerminalsForCurrentAppRunKeepsTerminalWhenLivenessProbeErrors(t *testing.T) {
	rt := newFakeShellRuntime()
	st := &fakeShellTerminalStore{}
	svc := newTestService(rt, st, &fakeProjectRootLocator{})
	if _, err := svc.OpenShellTerminal(context.Background(), OpenShellTerminalInput{}); err != nil {
		t.Fatalf("OpenShellTerminal: %v", err)
	}
	rt.aliveErr = errors.New("tmux server unreachable")

	got, err := svc.ListShellTerminalsForCurrentAppRun(context.Background())
	if err != nil {
		t.Fatalf("ListShellTerminalsForCurrentAppRun: %v", err)
	}
	if len(got) != 1 {
		t.Errorf("terminals = %+v, want the row kept through a failed probe", got)
	}
	if len(st.records) != 1 {
		t.Errorf("records = %+v, want the row kept through a failed probe", st.records)
	}
}

// The app was force-killed, so nothing closed its shells. The next boot must
// sweep them rather than leak PTYs, while leaving the new run's shells alone.
func TestReapShellTerminalsFromPreviousAppRunsDestroysOrphansOnly(t *testing.T) {
	rt := newFakeShellRuntime()
	st := &fakeShellTerminalStore{records: []ShellTerminalRecord{
		{HandleID: "shellterm-orphan1", AppRunID: "app-run-crashed", WorkingDir: "/a"},
		{HandleID: "shellterm-orphan2", AppRunID: "app-run-crashed", WorkingDir: "/b"},
		{HandleID: "shellterm-current", AppRunID: testAppRunID, WorkingDir: "/c"},
	}}
	svc := newTestService(rt, st, &fakeProjectRootLocator{})

	cleared, err := svc.ReapShellTerminalsFromPreviousAppRuns(context.Background())
	if err != nil {
		t.Fatalf("ReapShellTerminalsFromPreviousAppRuns: %v", err)
	}
	if cleared != 2 {
		t.Errorf("cleared = %d, want 2", cleared)
	}
	if len(rt.destroyed) != 2 {
		t.Errorf("destroyed = %v, want both orphaned PTYs torn down", rt.destroyed)
	}
	if len(st.records) != 1 || st.records[0].HandleID != "shellterm-current" {
		t.Errorf("records = %+v, want only the current run's shell kept", st.records)
	}
}

// One un-destroyable PTY must not wedge the sweep: the rows are cleared anyway,
// or every future boot would retry the same failure forever.
func TestReapShellTerminalsFromPreviousAppRunsClearsRowsWhenDestroyFails(t *testing.T) {
	rt := newFakeShellRuntime()
	rt.destroyErr = errors.New("tmux: no such session")
	st := &fakeShellTerminalStore{records: []ShellTerminalRecord{
		{HandleID: "shellterm-orphan", AppRunID: "app-run-crashed", WorkingDir: "/a"},
	}}
	svc := newTestService(rt, st, &fakeProjectRootLocator{})

	cleared, err := svc.ReapShellTerminalsFromPreviousAppRuns(context.Background())
	if err != nil {
		t.Fatalf("ReapShellTerminalsFromPreviousAppRuns: %v", err)
	}
	if cleared != 1 {
		t.Errorf("cleared = %d, want the row cleared despite the destroy failure", cleared)
	}
	if len(st.records) != 0 {
		t.Errorf("records = %+v, want cleared", st.records)
	}
}

func TestShellTerminalTitleFallsBackForRootlessPaths(t *testing.T) {
	if got := shellTerminalTitle(""); got != "Shell" {
		t.Errorf("title for empty path = %q, want %q", got, "Shell")
	}
	if got := shellTerminalTitle("/repos/portfolio"); got != "portfolio" {
		t.Errorf("title = %q, want %q", got, "portfolio")
	}
}
