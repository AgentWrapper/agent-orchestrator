package sessionmanager

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

var ctx = context.Background()

// candidateHealthSink captures telemetry events so worker-mix candidate-health
// tests can assert the shared alerting path fired.
type candidateHealthSink struct {
	mu     sync.Mutex
	events []ports.TelemetryEvent
}

func (s *candidateHealthSink) Emit(_ context.Context, ev ports.TelemetryEvent) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.events = append(s.events, ev)
}

func (s *candidateHealthSink) Close(context.Context) error { return nil }

func (s *candidateHealthSink) named(name string) []ports.TelemetryEvent {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []ports.TelemetryEvent
	for _, ev := range s.events {
		if ev.Name == name {
			out = append(out, ev)
		}
	}
	return out
}

type fakeStore struct {
	sessions           map[domain.SessionID]domain.SessionRecord
	pr                 map[domain.SessionID]domain.PRFacts
	projects           map[string]domain.ProjectRecord
	workspaceRepo      map[string][]domain.WorkspaceRepoRecord
	num                int
	deleteErr          error
	upsertWTErr        error
	updateSessionCalls int
	renameSessionCalls int
	setIssueCalls      int
	// worktrees maps session ID to its saved worktree rows (shutdown-saved marker).
	worktrees map[domain.SessionID][]domain.SessionWorktreeRecord
	// sharedLog, when non-nil, receives an ordered call entry for each
	// UpsertSessionWorktree invocation so ordering tests can compare across fakes.
	sharedLog *[]string
	// beforeClearDecision, when non-nil, runs at the top of
	// ClearSessionPendingDecision — race tests use it to replace the stored
	// decision between AnswerDecision's read and its CAS claim.
	beforeClearDecision func(*fakeStore)
}

func newFakeStore() *fakeStore {
	return &fakeStore{
		sessions:      map[domain.SessionID]domain.SessionRecord{},
		pr:            map[domain.SessionID]domain.PRFacts{},
		projects:      map[string]domain.ProjectRecord{},
		workspaceRepo: map[string][]domain.WorkspaceRepoRecord{},
		worktrees:     map[domain.SessionID][]domain.SessionWorktreeRecord{},
	}
}
func (f *fakeStore) GetProject(_ context.Context, id string) (domain.ProjectRecord, bool, error) {
	r, ok := f.projects[id]
	return r, ok, nil
}
func (f *fakeStore) ListWorkspaceRepos(_ context.Context, projectID string) ([]domain.WorkspaceRepoRecord, error) {
	return f.workspaceRepo[projectID], nil
}
func (f *fakeStore) CreateSession(_ context.Context, rec domain.SessionRecord) (domain.SessionRecord, error) {
	f.num++
	rec.ID = domain.SessionID(fmt.Sprintf("%s-%d", rec.ProjectID, f.num))
	f.sessions[rec.ID] = rec
	return rec, nil
}
func (f *fakeStore) UpdateSession(_ context.Context, rec domain.SessionRecord) error {
	f.updateSessionCalls++
	f.sessions[rec.ID] = rec
	return nil
}
func (f *fakeStore) ClearSessionPendingDecision(_ context.Context, id domain.SessionID, revision string, updatedAt time.Time) (bool, error) {
	if f.beforeClearDecision != nil {
		f.beforeClearDecision(f)
	}
	rec, ok := f.sessions[id]
	if !ok {
		return false, nil
	}
	// Mirror the store's compare-and-swap: only the exact answered revision may
	// be cleared.
	if rec.Metadata.PendingDecision == nil || rec.Metadata.PendingDecision.Revision != revision || revision == "" {
		return false, nil
	}
	rec.Metadata.PendingDecision = nil
	rec.UpdatedAt = updatedAt
	f.sessions[id] = rec
	return true, nil
}
func (f *fakeStore) RestoreSessionPendingDecision(_ context.Context, id domain.SessionID, decision domain.PendingDecision, updatedAt time.Time) (bool, error) {
	rec, ok := f.sessions[id]
	if !ok || rec.Metadata.PendingDecision != nil {
		return false, nil
	}
	rec.Metadata.PendingDecision = &decision
	rec.UpdatedAt = updatedAt
	f.sessions[id] = rec
	return true, nil
}
func (f *fakeStore) RenameSession(_ context.Context, id domain.SessionID, displayName string, updatedAt time.Time) (bool, error) {
	f.renameSessionCalls++
	rec, ok := f.sessions[id]
	if !ok {
		return false, nil
	}
	rec.DisplayName = displayName
	rec.UpdatedAt = updatedAt
	f.sessions[id] = rec
	return true, nil
}
func (f *fakeStore) SetSessionIssue(_ context.Context, id domain.SessionID, issueID domain.IssueID, displayName string, updatedAt time.Time) (bool, error) {
	f.setIssueCalls++
	rec, ok := f.sessions[id]
	if !ok {
		return false, nil
	}
	rec.IssueID = issueID
	rec.DisplayName = displayName
	rec.UpdatedAt = updatedAt
	f.sessions[id] = rec
	return true, nil
}
func (f *fakeStore) GetSession(_ context.Context, id domain.SessionID) (domain.SessionRecord, bool, error) {
	r, ok := f.sessions[id]
	return r, ok, nil
}
func (f *fakeStore) ListSessions(_ context.Context, p domain.ProjectID) ([]domain.SessionRecord, error) {
	var out []domain.SessionRecord
	for _, r := range f.sessions {
		if r.ProjectID == p {
			out = append(out, r)
		}
	}
	return out, nil
}
func (f *fakeStore) ListAllSessions(context.Context) ([]domain.SessionRecord, error) {
	var out []domain.SessionRecord
	for _, r := range f.sessions {
		out = append(out, r)
	}
	return out, nil
}
func (f *fakeStore) DeleteSession(_ context.Context, id domain.SessionID) (bool, error) {
	if f.deleteErr != nil {
		return false, f.deleteErr
	}
	rec, ok := f.sessions[id]
	if !ok {
		return false, nil
	}
	// Mirror the sqlite gate: only delete rows still in seed state.
	if rec.IsTerminated || rec.Metadata.WorkspacePath != "" || rec.Metadata.RuntimeHandleID != "" || rec.Metadata.AgentSessionID != "" || rec.Metadata.Prompt != "" {
		return false, nil
	}
	delete(f.sessions, id)
	return true, nil
}
func (f *fakeStore) GetDisplayPRFactsForSession(_ context.Context, id domain.SessionID) (domain.PRFacts, bool, error) {
	if pr := f.pr[id]; pr.URL != "" {
		return pr, true, nil
	}
	return domain.PRFacts{}, false, nil
}
func (f *fakeStore) UpsertSessionWorktree(_ context.Context, row domain.SessionWorktreeRecord) error {
	if f.upsertWTErr != nil {
		return f.upsertWTErr
	}
	if f.sharedLog != nil {
		*f.sharedLog = append(*f.sharedLog, "UpsertSessionWorktree:"+string(row.SessionID))
	}
	rows := f.worktrees[row.SessionID]
	for i, r := range rows {
		if r.RepoName == row.RepoName {
			rows[i] = row
			f.worktrees[row.SessionID] = rows
			return nil
		}
	}
	f.worktrees[row.SessionID] = append(rows, row)
	return nil
}
func (f *fakeStore) ListSessionWorktrees(_ context.Context, id domain.SessionID) ([]domain.SessionWorktreeRecord, error) {
	return f.worktrees[id], nil
}
func (f *fakeStore) DeleteSessionWorktrees(_ context.Context, id domain.SessionID) error {
	if f.sharedLog != nil {
		*f.sharedLog = append(*f.sharedLog, "DeleteSessionWorktrees:"+string(id))
	}
	delete(f.worktrees, id)
	return nil
}

type fakeLCM struct {
	store     *fakeStore
	completed int
	// terminated counts MarkTerminated calls per session id.
	terminated map[domain.SessionID]int
	// terminatedReason records the last cause the intent mark OWNED per id.
	terminatedReason map[domain.SessionID]string
	// intents mirrors the lifecycle manager's recorded teardown intents.
	intents map[domain.SessionID]string
	// canceledIntents counts CancelTerminationIntent calls that voided a live intent.
	canceledIntents int
	// switched counts MarkSwitched calls; switching tracks the in-flight guard.
	switched      int
	switching     map[domain.SessionID]bool
	onBeginSwitch func()
}

func (l *fakeLCM) MarkSpawned(_ context.Context, id domain.SessionID, metadata domain.SessionMetadata) error {
	l.completed++
	rec := l.store.sessions[id]
	rec.IsTerminated = false
	rec.Activity = domain.Activity{State: domain.ActivityIdle, LastActivityAt: time.Now()}
	rec.Metadata = metadata
	l.store.sessions[id] = rec
	return nil
}
func (l *fakeLCM) MarkTerminated(_ context.Context, id domain.SessionID) error {
	if l.terminated == nil {
		l.terminated = map[domain.SessionID]int{}
	}
	l.terminated[id]++
	rec := l.store.sessions[id]
	if rec.IsTerminated {
		return nil
	}
	rec.IsTerminated = true
	rec.TerminalFailureReason = ""
	rec.Activity = domain.Activity{State: domain.ActivityExited, LastActivityAt: time.Now()}
	l.store.sessions[id] = rec
	return nil
}

// RecordTerminationIntent / MarkTerminatedIntent mirror the real lifecycle
// manager's intent contract: no intent for an already-terminated session, and
// the final mark owns the cause only while its token matches.
func (l *fakeLCM) RecordTerminationIntent(_ context.Context, id domain.SessionID, cause string) (string, error) {
	rec, ok := l.store.sessions[id]
	if !ok || rec.IsTerminated {
		return "", nil
	}
	if l.intents == nil {
		l.intents = map[domain.SessionID]string{}
	}
	token := fmt.Sprintf("intent-%s-%d", id, len(l.intents)+1)
	l.intents[id] = token + "\x00" + cause
	return token, nil
}
func (l *fakeLCM) CancelTerminationIntent(id domain.SessionID, token string) {
	if token == "" {
		return
	}
	if stored, ok := l.intents[id]; ok && strings.HasPrefix(stored, token+"\x00") {
		delete(l.intents, id)
		l.canceledIntents++
	}
}
func (l *fakeLCM) MarkTerminatedIntent(_ context.Context, id domain.SessionID, token, cause string) error {
	if l.terminated == nil {
		l.terminated = map[domain.SessionID]int{}
	}
	l.terminated[id]++
	if l.terminatedReason == nil {
		l.terminatedReason = map[domain.SessionID]string{}
	}
	stored := l.intents[id]
	owns := token != "" && stored != "" && stored == token+"\x00"+cause
	if owns {
		delete(l.intents, id)
	}
	l.terminatedReason[id] = ""
	rec := l.store.sessions[id]
	if rec.IsTerminated {
		if owns && rec.TerminalFailureReason != cause {
			rec.TerminalFailureReason = cause
			l.terminatedReason[id] = cause
			l.store.sessions[id] = rec
		}
		return nil
	}
	rec.IsTerminated = true
	if owns {
		rec.TerminalFailureReason = cause
		l.terminatedReason[id] = cause
	} else {
		rec.TerminalFailureReason = ""
	}
	rec.Activity = domain.Activity{State: domain.ActivityExited, LastActivityAt: time.Now()}
	l.store.sessions[id] = rec
	return nil
}
func (l *fakeLCM) MarkSwitched(_ context.Context, id domain.SessionID, harness domain.AgentHarness, metadata domain.SessionMetadata) error {
	l.switched++
	rec := l.store.sessions[id]
	rec.Harness = harness
	rec.IsTerminated = false
	rec.Activity = domain.Activity{State: domain.ActivityIdle, LastActivityAt: time.Now()}
	rec.Metadata.RuntimeHandleID = metadata.RuntimeHandleID
	rec.Metadata.RuntimeToken = metadata.RuntimeToken
	if metadata.WorkspacePath != "" {
		rec.Metadata.WorkspacePath = metadata.WorkspacePath
	}
	if metadata.Branch != "" {
		rec.Metadata.Branch = metadata.Branch
	}
	rec.Metadata.Prompt = metadata.Prompt
	rec.Metadata.Model = metadata.Model
	if metadata.LaunchedHarnesses != nil {
		rec.Metadata.LaunchedHarnesses = metadata.LaunchedHarnesses
	}
	if metadata.AgentSessionIDs != nil {
		rec.Metadata.AgentSessionIDs = metadata.AgentSessionIDs
	}
	rec.Metadata.AgentSessionID = metadata.AgentSessionID
	l.store.sessions[id] = rec
	return nil
}
func (l *fakeLCM) TryBeginSwitch(id domain.SessionID) bool {
	if l.switching == nil {
		l.switching = map[domain.SessionID]bool{}
	}
	if l.switching[id] {
		return false
	}
	l.switching[id] = true
	if l.onBeginSwitch != nil {
		l.onBeginSwitch()
	}
	return true
}
func (l *fakeLCM) EndSwitch(id domain.SessionID) { delete(l.switching, id) }
func (l *fakeLCM) IsSwitching(id domain.SessionID) bool {
	return l.switching[id]
}

type fakeRuntime struct {
	createErr          error
	destroyErr         error
	sendErr            error
	created, destroyed int
	lastCfg            ports.RuntimeConfig
	sent               []string
	// aliveByHandle maps a RuntimeHandle.ID to its liveness; missing = false.
	aliveByHandle map[string]bool
	aliveErr      error
	// processAliveByHandle maps a RuntimeHandle.ID to whether the pane still
	// appears to be running the launched agent command; missing = true.
	processAliveByHandle map[string]bool
	processAliveSeq      []bool
	processAliveErr      error
	destroyedIDs         []string
	// blankReads is how many GetOutput calls return empty before the pane
	// "renders"; getOutputCallsAtSend records how many reads had happened when
	// each SendMessage went out, so a test can prove the write waited.
	blankReads           int
	outputErr            error
	getOutputCalls       int
	getOutputCallsAtSend []int
	onSend               func()
}

func (r *fakeRuntime) Create(_ context.Context, cfg ports.RuntimeConfig) (ports.RuntimeHandle, error) {
	if r.createErr != nil {
		return ports.RuntimeHandle{}, r.createErr
	}
	r.lastCfg = cfg
	r.created++
	return ports.RuntimeHandle{ID: "h1"}, nil
}
func (r *fakeRuntime) Destroy(_ context.Context, handle ports.RuntimeHandle) error {
	r.destroyed++
	r.destroyedIDs = append(r.destroyedIDs, handle.ID)
	return r.destroyErr
}
func (r *fakeRuntime) IsAlive(_ context.Context, handle ports.RuntimeHandle) (bool, error) {
	if r.aliveErr != nil {
		return false, r.aliveErr
	}
	return r.aliveByHandle[handle.ID], nil
}
func (r *fakeRuntime) IsRunningCommand(_ context.Context, handle ports.RuntimeHandle, _ string) (bool, error) {
	if r.processAliveErr != nil {
		return false, r.processAliveErr
	}
	if len(r.processAliveSeq) > 0 {
		alive := r.processAliveSeq[0]
		r.processAliveSeq = r.processAliveSeq[1:]
		return alive, nil
	}
	if r.processAliveByHandle == nil {
		return true, nil
	}
	alive, ok := r.processAliveByHandle[handle.ID]
	if !ok {
		return true, nil
	}
	return alive, nil
}
func (r *fakeRuntime) SendMessage(_ context.Context, _ ports.RuntimeHandle, msg string) error {
	if r.sendErr != nil {
		return r.sendErr
	}
	if r.onSend != nil {
		r.onSend()
	}
	r.sent = append(r.sent, msg)
	r.getOutputCallsAtSend = append(r.getOutputCallsAtSend, r.getOutputCalls)
	return nil
}

// GetOutput models a pane that prints nothing until the harness TUI has drawn:
// the first blankReads calls return empty, then it reports output. outputErr
// models a runtime that cannot capture at all.
func (r *fakeRuntime) GetOutput(_ context.Context, _ ports.RuntimeHandle, _ int) (string, error) {
	r.getOutputCalls++
	if r.outputErr != nil {
		return "", r.outputErr
	}
	if r.getOutputCalls <= r.blankReads {
		return "", nil
	}
	return "harness ready >", nil
}

type fakeAgent struct{}

func (fakeAgent) GetConfigSpec(context.Context) (ports.ConfigSpec, error) {
	return ports.ConfigSpec{}, nil
}
func (fakeAgent) GetLaunchCommand(context.Context, ports.LaunchConfig) ([]string, error) {
	return []string{"launch"}, nil
}
func (fakeAgent) GetPromptDeliveryStrategy(context.Context, ports.LaunchConfig) (ports.PromptDeliveryStrategy, error) {
	return ports.PromptDeliveryInCommand, nil
}
func (fakeAgent) GetAgentHooks(context.Context, ports.WorkspaceHookConfig) error { return nil }
func (fakeAgent) GetRestoreCommand(_ context.Context, cfg ports.RestoreConfig) ([]string, bool, error) {
	if id := cfg.Session.Metadata[ports.MetadataKeyAgentSessionID]; id != "" {
		return []string{"resume", id}, true, nil
	}
	return nil, false, nil
}
func (fakeAgent) SessionInfo(context.Context, ports.SessionRef) (ports.SessionInfo, bool, error) {
	return ports.SessionInfo{}, false, nil
}

// fakeAgents resolves every harness to the same fakeAgent.
type fakeAgents struct{}

func (fakeAgents) Agent(domain.AgentHarness) (ports.Agent, bool) { return fakeAgent{}, true }

// recordingAgent captures the LaunchConfig it is handed so a test can assert the
// session manager resolved and forwarded a project's agent config.
type recordingAgent struct {
	fakeAgent
	lastConfig  ports.AgentConfig
	lastLaunch  ports.LaunchConfig
	lastRestore ports.RestoreConfig
}

func (a *recordingAgent) GetLaunchCommand(_ context.Context, cfg ports.LaunchConfig) ([]string, error) {
	a.lastConfig = cfg.Config
	a.lastLaunch = cfg
	return []string{"launch"}, nil
}

func (a *recordingAgent) GetRestoreCommand(_ context.Context, cfg ports.RestoreConfig) ([]string, bool, error) {
	a.lastConfig = cfg.Config
	a.lastRestore = cfg
	// Mirror real adapters: with no native agent-session id to resume, signal
	// "cannot restore" so the manager falls back to a fresh launch.
	if cfg.Session.Metadata[ports.MetadataKeyAgentSessionID] == "" {
		return nil, false, nil
	}
	return []string{"resume"}, true, nil
}

type afterStartAgent struct {
	*recordingAgent
}

func (a afterStartAgent) GetPromptDeliveryStrategy(context.Context, ports.LaunchConfig) (ports.PromptDeliveryStrategy, error) {
	return ports.PromptDeliveryAfterStart, nil
}

type modelFailAgent struct {
	recordingAgent
	failModel string
	err       error
}

func (a *modelFailAgent) GetLaunchCommand(ctx context.Context, cfg ports.LaunchConfig) ([]string, error) {
	if cfg.Config.Model == a.failModel {
		return nil, a.err
	}
	return a.recordingAgent.GetLaunchCommand(ctx, cfg)
}

// launchTitleAgent mirrors the real claude-code/codex adapters: the argv slot
// always carries the prompt, and the title is applied by the in-harness rename
// after start. Their only post-start write is the title.
type launchTitleAgent struct {
	recordingAgent
}

func (a *launchTitleAgent) GetPromptDeliveryStrategy(_ context.Context, _ ports.LaunchConfig) (ports.PromptDeliveryStrategy, error) {
	return ports.PromptDeliveryInCommand, nil
}

// afterStartTitleAgent is a title-capable harness that cannot carry the prompt
// in argv, so both writes happen after start. It keeps deliverInitialPrompt's
// AfterStart branch covered now that the shipped adapters no longer use it.
type afterStartTitleAgent struct {
	launchTitleAgent
}

func (a *afterStartTitleAgent) GetPromptDeliveryStrategy(_ context.Context, cfg ports.LaunchConfig) (ports.PromptDeliveryStrategy, error) {
	if cfg.Prompt != "" {
		return ports.PromptDeliveryAfterStart, nil
	}
	return ports.PromptDeliveryInCommand, nil
}
func (a *launchTitleAgent) InHarnessTitleCommand(title string) (string, bool) {
	title = strings.TrimSpace(title)
	if title == "" {
		return "", false
	}
	return "/rename " + title, true
}

type singleAgent struct{ agent ports.Agent }

func (s singleAgent) Agent(domain.AgentHarness) (ports.Agent, bool) { return s.agent, true }

// alwaysResumeAgent mimics Claude Code: it pins a deterministic session id, so
// GetRestoreCommand can resume any session even with no captured agentSessionId
// and no prompt.
type alwaysResumeAgent struct{ fakeAgent }

func (alwaysResumeAgent) GetRestoreCommand(_ context.Context, cfg ports.RestoreConfig) ([]string, bool, error) {
	return []string{"resume", cfg.Session.ID}, true, nil
}

// missingAgents resolves no harness, simulating a typo'd or unregistered agent.
type missingAgents struct{}

func (missingAgents) Agent(domain.AgentHarness) (ports.Agent, bool) { return nil, false }

type fakeWorkspace struct {
	createErr         error
	destroyErr        error
	destroyed         int
	lastCfg           ports.WorkspaceConfig
	projectErr        error
	projectDestroyed  int
	lastProjectCfg    ports.WorkspaceProjectConfig
	projectCreateInfo ports.WorkspaceProjectInfo
	// path, when set, is returned as the workspace path so provisioning tests
	// can point at a real temp directory.
	path string
	// inPlacePath, when set, is returned as the workspace path in in-place mode
	// (standing in for the resolved project repo root). Empty derives it from the
	// project id, mirroring the real adapter resolving RepoPath(projectID).
	inPlacePath string
	// stashRef is returned by StashUncommitted (empty means clean worktree).
	stashRef        string
	stashErr        error
	restoreErr      error
	applyErr        error
	forceDestroyErr error
	// stashCalls counts StashUncommitted invocations.
	stashCalls int
	// calls records the sequence of workspace method calls for ordering assertions.
	calls []string
	// sharedLog, when non-nil, receives entries alongside calls so ordering
	// tests can compare workspace calls against store calls in one sequence.
	sharedLog *[]string
}

func (w *fakeWorkspace) Create(_ context.Context, cfg ports.WorkspaceConfig) (ports.WorkspaceInfo, error) {
	if w.createErr != nil {
		return ports.WorkspaceInfo{}, w.createErr
	}
	w.lastCfg = cfg
	// Mirror the real adapter in in-place mode: resolve the project's repo root
	// (never a per-session path) and check out no branch, so manager tests can
	// assert the session's cwd and the empty branch.
	if cfg.Mode == domain.WorkspaceModeInPlace {
		path := w.inPlacePath
		if path == "" {
			path = "/repo/" + string(cfg.ProjectID)
		}
		return ports.WorkspaceInfo{Path: path, Branch: "", Mode: domain.WorkspaceModeInPlace, SessionID: cfg.SessionID, ProjectID: cfg.ProjectID}, nil
	}
	path := w.path
	if path == "" {
		path = "/ws/" + string(cfg.SessionID)
	}
	return ports.WorkspaceInfo{Path: path, Branch: cfg.Branch, Mode: domain.WorkspaceModeWorktree, SessionID: cfg.SessionID, ProjectID: cfg.ProjectID}, nil
}

func (w *fakeWorkspace) CreateWorkspaceProject(_ context.Context, cfg ports.WorkspaceProjectConfig) (ports.WorkspaceProjectInfo, error) {
	if w.projectErr != nil {
		return ports.WorkspaceProjectInfo{}, w.projectErr
	}
	w.lastProjectCfg = cfg
	if len(w.projectCreateInfo.Worktrees) > 0 {
		return w.projectCreateInfo, nil
	}
	rootPath := w.path
	if rootPath == "" {
		rootPath = "/ws/" + string(cfg.SessionID)
	}
	branch := cfg.Branch
	root := ports.WorkspaceInfo{Path: rootPath, Branch: branch, Mode: domain.WorkspaceModeWorktree, SessionID: cfg.SessionID, ProjectID: cfg.ProjectID}
	out := ports.WorkspaceProjectInfo{
		Root: root,
		Worktrees: []ports.WorkspaceRepoInfo{{
			RepoName:  domain.RootWorkspaceRepoName,
			RepoPath:  cfg.RootRepoPath,
			Path:      rootPath,
			Branch:    branch,
			BaseSHA:   "root-base",
			SessionID: cfg.SessionID,
			ProjectID: cfg.ProjectID,
		}},
	}
	for _, repo := range cfg.Repos {
		out.Worktrees = append(out.Worktrees, ports.WorkspaceRepoInfo{
			RepoName:     repo.Name,
			RepoPath:     repo.RepoPath,
			Path:         filepath.Join(rootPath, filepath.FromSlash(repo.RelativePath)),
			Branch:       branch,
			BaseSHA:      repo.Name + "-base",
			SessionID:    cfg.SessionID,
			ProjectID:    cfg.ProjectID,
			RelativePath: repo.RelativePath,
		})
	}
	return out, nil
}

type blockingWorkspace struct {
	*fakeWorkspace
	entered chan struct{}
	release chan struct{}
}

func (w *blockingWorkspace) Create(ctx context.Context, cfg ports.WorkspaceConfig) (ports.WorkspaceInfo, error) {
	select {
	case <-w.entered:
	default:
		close(w.entered)
	}
	select {
	case <-ctx.Done():
		return ports.WorkspaceInfo{}, ctx.Err()
	case <-w.release:
	}
	return w.fakeWorkspace.Create(ctx, cfg)
}

func (w *fakeWorkspace) Destroy(_ context.Context, info ports.WorkspaceInfo) error {
	// In-place teardown is a no-op in the real adapter (the shared repo root is
	// never removed); mirror that so a test asserting destroyed==0 for an in-place
	// session is meaningful.
	if info.Mode == domain.WorkspaceModeInPlace {
		return nil
	}
	if info.RepoPath != "" || fakeWorkspaceProjectPath(info) {
		entry := "Destroy:" + fakeWorkspaceRepoName(info)
		w.calls = append(w.calls, entry)
		if w.sharedLog != nil {
			*w.sharedLog = append(*w.sharedLog, entry)
		}
	}
	w.destroyed++
	return w.destroyErr
}
func (w *fakeWorkspace) DestroyWorkspaceProject(context.Context, ports.WorkspaceProjectInfo) error {
	w.projectDestroyed++
	return w.destroyErr
}
func (w *fakeWorkspace) Restore(ctx context.Context, cfg ports.WorkspaceConfig) (ports.WorkspaceInfo, error) {
	if w.restoreErr != nil {
		return ports.WorkspaceInfo{}, w.restoreErr
	}
	if cfg.RepoPath != "" {
		entry := "Restore:" + fakeWorkspaceRepoName(ports.WorkspaceInfo{
			Path:      cfg.Path,
			SessionID: cfg.SessionID,
			RepoPath:  cfg.RepoPath,
		})
		w.calls = append(w.calls, entry)
		return ports.WorkspaceInfo{Path: cfg.Path, Branch: cfg.Branch, Mode: cfg.Mode, SessionID: cfg.SessionID, ProjectID: cfg.ProjectID, RepoPath: cfg.RepoPath}, nil
	}
	return w.Create(ctx, cfg)
}
func (w *fakeWorkspace) ForceDestroy(_ context.Context, info ports.WorkspaceInfo) error {
	// The real adapter no-ops ForceDestroy for an in-place session (the shared
	// root is never removed); mirror that by not recording the call.
	if info.Mode == domain.WorkspaceModeInPlace {
		return nil
	}
	entry := "ForceDestroy:" + string(info.SessionID)
	if info.RepoPath != "" {
		entry = "ForceDestroy:" + fakeWorkspaceRepoName(info)
	}
	w.calls = append(w.calls, entry)
	if w.sharedLog != nil {
		*w.sharedLog = append(*w.sharedLog, entry)
	}
	return w.forceDestroyErr
}
func (w *fakeWorkspace) StashUncommitted(_ context.Context, info ports.WorkspaceInfo) (string, error) {
	// The real adapter no-ops StashUncommitted for an in-place session (nothing
	// session-scoped to save in the shared root); mirror that so an in-place
	// marker row always carries an empty preserve ref.
	if info.Mode == domain.WorkspaceModeInPlace {
		return "", nil
	}
	w.stashCalls++
	entry := "StashUncommitted:" + string(info.SessionID)
	if info.RepoPath != "" {
		entry = "StashUncommitted:" + fakeWorkspaceRepoName(info)
	}
	w.calls = append(w.calls, entry)
	if w.sharedLog != nil {
		*w.sharedLog = append(*w.sharedLog, entry)
	}
	if w.stashErr != nil || w.stashRef == "" || info.RepoPath == "" {
		return w.stashRef, w.stashErr
	}
	return w.stashRef + "/" + fakeWorkspaceRepoName(info), nil
}
func (w *fakeWorkspace) ApplyPreserved(_ context.Context, info ports.WorkspaceInfo, ref string) error {
	entry := "ApplyPreserved:" + string(info.SessionID)
	if info.RepoPath != "" {
		entry = "ApplyPreserved:" + fakeWorkspaceRepoName(info) + ":" + ref
	}
	w.calls = append(w.calls, entry)
	return w.applyErr
}

func fakeWorkspaceRepoName(info ports.WorkspaceInfo) string {
	if filepath.Base(info.Path) == string(info.SessionID) {
		return domain.RootWorkspaceRepoName
	}
	return filepath.Base(info.Path)
}

func fakeWorkspaceProjectPath(info ports.WorkspaceInfo) bool {
	if info.Path == "" || info.SessionID == "" {
		return false
	}
	if filepath.Base(info.Path) == string(info.SessionID) {
		return true
	}
	return filepath.Base(filepath.Dir(info.Path)) == string(info.SessionID)
}

type fakeMessenger struct {
	msgs []string
	err  error
}

func (m *fakeMessenger) Send(_ context.Context, _ domain.SessionID, msg string) error {
	m.msgs = append(m.msgs, msg)
	return m.err
}

func newManager() (*Manager, *fakeStore, *fakeRuntime, *fakeWorkspace) {
	st := newFakeStore()
	st.projects["mer"] = domain.ProjectRecord{ID: "mer", Config: testRoleAgents()}
	rt := &fakeRuntime{}
	ws := &fakeWorkspace{}
	// Stub lookPath so the pre-launch agent-binary check passes; the fakeAgent
	// returns argv ["launch"] which is not a real binary on PATH.
	lookPath := func(string) (string, error) { return "/bin/true", nil }
	m := New(Deps{Runtime: rt, Agents: fakeAgents{}, Workspace: ws, Store: st, Messenger: &fakeMessenger{}, Lifecycle: &fakeLCM{store: st}, LookPath: lookPath})
	return m, st, rt, ws
}
func testRoleAgents() domain.ProjectConfig {
	return domain.ProjectConfig{
		Worker:       domain.RoleOverride{Harness: domain.HarnessClaudeCode},
		Orchestrator: domain.RoleOverride{Harness: domain.HarnessClaudeCode},
	}
}
func seedTerminal(st *fakeStore, id domain.SessionID, meta domain.SessionMetadata) {
	st.sessions[id] = domain.SessionRecord{ID: id, ProjectID: "mer", Metadata: meta, IsTerminated: true, Activity: domain.Activity{State: domain.ActivityExited}}
}
func mkLive(id domain.SessionID) domain.SessionRecord {
	return domain.SessionRecord{ID: id, ProjectID: "mer", Metadata: domain.SessionMetadata{WorkspacePath: "/ws/" + string(id), RuntimeHandleID: "h1"}, Activity: domain.Activity{State: domain.ActivityActive}}
}

func mkSwitchable(id domain.SessionID) domain.SessionRecord {
	return domain.SessionRecord{
		ID: id, ProjectID: "mer", Kind: domain.KindWorker, Harness: domain.HarnessClaudeCode,
		Metadata: domain.SessionMetadata{Branch: "b/" + string(id), WorkspacePath: "/ws/" + string(id), RuntimeHandleID: "h1", AgentSessionID: "old-native", Prompt: "do it"},
		Activity: domain.Activity{State: domain.ActivityActive},
	}
}

func TestSwitchHarness_Success(t *testing.T) {
	st := newFakeStore()
	st.projects["mer"] = domain.ProjectRecord{ID: "mer", Config: testRoleAgents()}
	rt := &fakeRuntime{}
	agent := &recordingAgent{}
	lookPath := func(string) (string, error) { return "/bin/true", nil }
	m := New(Deps{Runtime: rt, Agents: singleAgent{agent: agent}, Workspace: &fakeWorkspace{}, Store: st, Messenger: &fakeMessenger{}, Lifecycle: &fakeLCM{store: st}, LookPath: lookPath})
	id := domain.SessionID("ao-1")
	st.sessions[id] = mkSwitchable(id)

	rec, err := m.SwitchHarness(ctx, id, domain.HarnessCodex, "glm-4")
	if err != nil {
		t.Fatalf("SwitchHarness: %v", err)
	}
	// Old agent stopped, new one created — exactly once each.
	if rt.destroyed != 1 || rt.created != 1 {
		t.Fatalf("runtime destroyed=%d created=%d, want 1/1", rt.destroyed, rt.created)
	}
	if len(rt.destroyedIDs) != 1 || rt.destroyedIDs[0] != "h1" {
		t.Fatalf("destroyed old handle = %v, want [h1]", rt.destroyedIDs)
	}
	if rec.Harness != domain.HarnessCodex {
		t.Fatalf("harness = %q, want codex", rec.Harness)
	}
	if rec.Metadata.AgentSessionID != "" {
		t.Fatalf("AgentSessionID = %q, want cleared", rec.Metadata.AgentSessionID)
	}
	if agent.lastConfig.Model != "glm-4" {
		t.Fatalf("switch launch model = %q, want glm-4", agent.lastConfig.Model)
	}
	if rec.Metadata.Model != "glm-4" {
		t.Fatalf("persisted switch model = %q, want glm-4", rec.Metadata.Model)
	}
	lcm := m.lcm.(*fakeLCM)
	if lcm.switched != 1 {
		t.Fatalf("MarkSwitched calls = %d, want 1", lcm.switched)
	}
	if lcm.IsSwitching(id) {
		t.Fatal("switch guard not cleared after a successful switch")
	}
}

func TestSwitchHarness_OrchestratorDeliversKickoffAfterStart(t *testing.T) {
	st := newFakeStore()
	st.projects["mer"] = domain.ProjectRecord{ID: "mer", Config: testRoleAgents()}
	rt := &fakeRuntime{blankReads: 2}
	agent := &afterStartTitleAgent{}
	lookPath := func(string) (string, error) { return "/bin/true", nil }
	m := New(Deps{Runtime: rt, Agents: singleAgent{agent: agent}, Workspace: &fakeWorkspace{}, Store: st, Messenger: &fakeMessenger{}, Lifecycle: &fakeLCM{store: st}, LookPath: lookPath})
	m.paneReady = paneReadyConfig{pollInterval: time.Millisecond, deadline: 50 * time.Millisecond}
	id := domain.SessionID("ao-1")
	st.sessions[id] = domain.SessionRecord{
		ID: id, ProjectID: "mer", Kind: domain.KindOrchestrator, Harness: domain.HarnessClaudeCode,
		Metadata: domain.SessionMetadata{Branch: "b/ao-1", WorkspacePath: "/ws/ao-1", RuntimeHandleID: "h1"},
		Activity: domain.Activity{State: domain.ActivityActive},
	}

	rec, err := m.SwitchHarness(ctx, id, domain.HarnessCodex, "")
	if err != nil {
		t.Fatalf("SwitchHarness: %v", err)
	}
	if len(rt.sent) != 1 || !strings.Contains(rt.sent[0], "Read your standing policy") {
		t.Fatalf("runtime sends = %#v, want orchestrator kickoff", rt.sent)
	}
	if rt.getOutputCallsAtSend[0] <= rt.blankReads {
		t.Fatalf("kickoff sent after %d pane reads, want it to wait past %d blank reads", rt.getOutputCallsAtSend[0], rt.blankReads)
	}
	if !strings.Contains(rec.Metadata.Prompt, "Read your standing policy") {
		t.Fatalf("metadata prompt = %q, want persisted kickoff", rec.Metadata.Prompt)
	}
}

func TestSwitchHarness_GuardCoversSessionSnapshot(t *testing.T) {
	st := newFakeStore()
	st.projects["mer"] = domain.ProjectRecord{ID: "mer", Config: testRoleAgents()}
	rt := &fakeRuntime{}
	id := domain.SessionID("ao-1")
	st.sessions[id] = mkSwitchable(id)
	lcm := &fakeLCM{
		store: st,
		onBeginSwitch: func() {
			rec := st.sessions[id]
			rec.Harness = domain.HarnessAider
			rec.Metadata.RuntimeHandleID = "fresh-handle"
			st.sessions[id] = rec
		},
	}
	m := New(Deps{
		Runtime:   rt,
		Agents:    fakeAgents{},
		Workspace: &fakeWorkspace{},
		Store:     st,
		Messenger: &fakeMessenger{},
		Lifecycle: lcm,
		LookPath:  func(string) (string, error) { return "/bin/true", nil },
	})

	if _, err := m.SwitchHarness(ctx, id, domain.HarnessCodex, ""); err != nil {
		t.Fatalf("SwitchHarness: %v", err)
	}
	if len(rt.destroyedIDs) != 1 || rt.destroyedIDs[0] != "fresh-handle" {
		t.Fatalf("destroyed handle = %v, want current guarded snapshot [fresh-handle]", rt.destroyedIDs)
	}
}

func TestSwitchHarness_UnknownHarnessLeavesAgentRunning(t *testing.T) {
	m, st, rt, _ := newManager()
	id := domain.SessionID("ao-1")
	st.sessions[id] = mkSwitchable(id)

	_, err := m.SwitchHarness(ctx, id, domain.AgentHarness("bogus"), "")
	if !errors.Is(err, ErrUnknownHarness) {
		t.Fatalf("err = %v, want ErrUnknownHarness", err)
	}
	// Validation fails before the running agent is touched.
	if rt.destroyed != 0 || rt.created != 0 {
		t.Fatalf("runtime touched on validation failure: destroyed=%d created=%d", rt.destroyed, rt.created)
	}
}

func TestSwitchHarness_TerminatedRelaunchesUnderNewAgent(t *testing.T) {
	m, st, rt, ws := newManager()
	id := domain.SessionID("ao-1")
	seedTerminal(st, id, domain.SessionMetadata{Branch: "b/ao-1", WorkspacePath: "/ws/ao-1", AgentSessionID: "old-native", Prompt: "do it"})

	rec, err := m.SwitchHarness(ctx, id, domain.HarnessCodex, "")
	if err != nil {
		t.Fatalf("SwitchHarness on terminated: %v", err)
	}
	// Relaunch-as: worktree restored (by branch), new runtime created, nothing to stop.
	if ws.lastCfg.Branch != "b/ao-1" {
		t.Fatalf("worktree restore branch = %q, want b/ao-1", ws.lastCfg.Branch)
	}
	if rt.created != 1 || rt.destroyed != 0 {
		t.Fatalf("runtime created=%d destroyed=%d, want 1/0 (nothing to tear down)", rt.created, rt.destroyed)
	}
	if rec.Harness != domain.HarnessCodex || rec.IsTerminated {
		t.Fatalf("record after relaunch = %+v, want codex + live", rec)
	}
	if rec.Metadata.AgentSessionID != "" {
		t.Fatalf("AgentSessionID = %q, want cleared", rec.Metadata.AgentSessionID)
	}
}

// A terminated session's runtime can linger (keep-alive shell outlives the
// agent), so its deterministic session name is still taken. The relaunch must
// tear it down before Create, or Create collides ("duplicate session").
func TestSwitchHarness_TerminatedClearsLingeringRuntime(t *testing.T) {
	m, st, rt, _ := newManager()
	id := domain.SessionID("ao-1")
	seedTerminal(st, id, domain.SessionMetadata{Branch: "b/ao-1", WorkspacePath: "/ws/ao-1", RuntimeHandleID: "ao-1", Prompt: "do it"})

	if _, err := m.SwitchHarness(ctx, id, domain.HarnessCodex, ""); err != nil {
		t.Fatalf("SwitchHarness: %v", err)
	}
	if rt.destroyed != 1 || len(rt.destroyedIDs) != 1 || rt.destroyedIDs[0] != "ao-1" {
		t.Fatalf("stale runtime not cleared before relaunch: destroyed=%d ids=%v", rt.destroyed, rt.destroyedIDs)
	}
	if rt.created != 1 {
		t.Fatalf("new runtime not created: created=%d", rt.created)
	}
}

func TestSwitchHarness_RejectsConcurrentSwitch(t *testing.T) {
	m, st, rt, _ := newManager()
	id := domain.SessionID("ao-1")
	st.sessions[id] = mkSwitchable(id)

	// Simulate a switch already in flight by claiming the guard first.
	lcm := m.lcm.(*fakeLCM)
	if !lcm.TryBeginSwitch(id) {
		t.Fatal("precondition: could not claim guard")
	}
	_, err := m.SwitchHarness(ctx, id, domain.HarnessCodex, "")
	if !errors.Is(err, ErrSwitchInProgress) {
		t.Fatalf("err = %v, want ErrSwitchInProgress", err)
	}
	if rt.created != 0 || rt.destroyed != 0 {
		t.Fatalf("runtime touched despite in-progress guard: created=%d destroyed=%d", rt.created, rt.destroyed)
	}
}

func TestSwitchHarness_TerminatedPromptlessWorkerRejected(t *testing.T) {
	m, st, rt, ws := newManager()
	id := domain.SessionID("ao-1")
	// Terminated worker with no saved prompt: nothing to launch a fresh agent from.
	seedTerminal(st, id, domain.SessionMetadata{Branch: "b/ao-1", WorkspacePath: "/ws/ao-1"})
	rec := st.sessions[id]
	rec.Kind = domain.KindWorker
	st.sessions[id] = rec

	_, err := m.SwitchHarness(ctx, id, domain.HarnessCodex, "")
	if !errors.Is(err, ErrNotResumable) {
		t.Fatalf("err = %v, want ErrNotResumable", err)
	}
	if rt.created != 0 || ws.lastCfg.Branch != "" {
		t.Fatalf("relaunched a promptless worker: created=%d restoreBranch=%q", rt.created, ws.lastCfg.Branch)
	}
}

// A harness this session already launched (e.g. Claude Code, which pins a
// deterministic native session id) must RESUME on switch, not fresh-launch —
// otherwise it collides with its own prior session ("session id already in use").
func TestSwitchHarness_ResumesPreviouslyUsedHarness(t *testing.T) {
	st := newFakeStore()
	st.projects["mer"] = domain.ProjectRecord{ID: "mer", Config: testRoleAgents()}
	rt := &fakeRuntime{}
	lookPath := func(string) (string, error) { return "/bin/true", nil }
	m := New(Deps{Runtime: rt, Agents: singleAgent{agent: alwaysResumeAgent{}}, Workspace: &fakeWorkspace{}, Store: st, Messenger: &fakeMessenger{}, Lifecycle: &fakeLCM{store: st}, LookPath: lookPath})

	id := domain.SessionID("ao-1")
	// Live on codex, but claude-code ran this session before.
	st.sessions[id] = domain.SessionRecord{
		ID: id, ProjectID: "mer", Kind: domain.KindWorker, Harness: domain.HarnessCodex,
		Metadata: domain.SessionMetadata{
			Branch: "b/ao-1", WorkspacePath: "/ws/ao-1", RuntimeHandleID: "h1", Prompt: "do it",
			LaunchedHarnesses: []domain.AgentHarness{domain.HarnessCodex, domain.HarnessClaudeCode},
		},
		Activity: domain.Activity{State: domain.ActivityActive},
	}

	if _, err := m.SwitchHarness(ctx, id, domain.HarnessClaudeCode, ""); err != nil {
		t.Fatalf("SwitchHarness: %v", err)
	}
	if len(rt.lastCfg.Argv) == 0 || rt.lastCfg.Argv[0] != "resume" {
		t.Fatalf("argv = %v, want a resume command (harness used before)", rt.lastCfg.Argv)
	}
}

func TestSwitchHarness_SameHarnessPreservesNativeSessionID(t *testing.T) {
	st := newFakeStore()
	st.projects["mer"] = domain.ProjectRecord{ID: "mer", Config: testRoleAgents()}
	rt := &fakeRuntime{}
	agent := &recordingAgent{}
	lookPath := func(string) (string, error) { return "/bin/true", nil }
	m := New(Deps{Runtime: rt, Agents: singleAgent{agent: agent}, Workspace: &fakeWorkspace{}, Store: st, Messenger: &fakeMessenger{}, Lifecycle: &fakeLCM{store: st}, LookPath: lookPath})

	id := domain.SessionID("ao-1")
	st.sessions[id] = domain.SessionRecord{
		ID: id, ProjectID: "mer", Kind: domain.KindWorker, Harness: domain.HarnessCodex,
		Metadata: domain.SessionMetadata{
			Branch: "b/ao-1", WorkspacePath: "/ws/ao-1", RuntimeHandleID: "h1", Prompt: "do it",
			AgentSessionID:    "codex-native-id",
			LaunchedHarnesses: []domain.AgentHarness{domain.HarnessCodex},
		},
		Activity: domain.Activity{State: domain.ActivityActive},
	}

	if _, err := m.SwitchHarness(ctx, id, domain.HarnessCodex, "gpt-next"); err != nil {
		t.Fatalf("SwitchHarness: %v", err)
	}
	if got := agent.lastRestore.Session.Metadata[ports.MetadataKeyAgentSessionID]; got != "codex-native-id" {
		t.Fatalf("resume agent session id = %q, want codex-native-id", got)
	}
	if len(rt.lastCfg.Argv) == 0 || rt.lastCfg.Argv[0] != "resume" {
		t.Fatalf("argv = %v, want same-harness resume", rt.lastCfg.Argv)
	}
	if got := st.sessions[id].Metadata.AgentSessionID; got != "codex-native-id" {
		t.Fatalf("persisted agent session id = %q, want codex-native-id", got)
	}
}

func TestSwitchHarness_SwitchAwayAndBackPreservesNativeSessionID(t *testing.T) {
	m, st, rt, _ := newManager()
	id := domain.SessionID("ao-1")
	st.sessions[id] = domain.SessionRecord{
		ID: id, ProjectID: "mer", Kind: domain.KindWorker, Harness: domain.HarnessCodex,
		Metadata: domain.SessionMetadata{
			Branch: "b/ao-1", WorkspacePath: "/ws/ao-1", RuntimeHandleID: "h1", Prompt: "do it",
			AgentSessionID:    "codex-native-id",
			LaunchedHarnesses: []domain.AgentHarness{domain.HarnessCodex},
		},
		Activity: domain.Activity{State: domain.ActivityActive},
	}

	if _, err := m.SwitchHarness(ctx, id, domain.HarnessClaudeCode, ""); err != nil {
		t.Fatalf("switch away: %v", err)
	}
	if got := st.sessions[id].Metadata.AgentSessionIDs[domain.HarnessCodex]; got != "codex-native-id" {
		t.Fatalf("preserved codex native id = %q, want codex-native-id", got)
	}
	if got := st.sessions[id].Metadata.AgentSessionID; got != "" {
		t.Fatalf("current agent session id after switch away = %q, want empty for target harness", got)
	}

	rt.lastCfg.Argv = nil
	if _, err := m.SwitchHarness(ctx, id, domain.HarnessCodex, ""); err != nil {
		t.Fatalf("switch back: %v", err)
	}
	if len(rt.lastCfg.Argv) != 2 || rt.lastCfg.Argv[0] != "resume" || rt.lastCfg.Argv[1] != "codex-native-id" {
		t.Fatalf("switch-back argv = %v, want resume codex-native-id", rt.lastCfg.Argv)
	}
}

// A harness this session has never launched must fresh-launch (create its
// session), not resume a non-existent one.
// Resuming a previously-used harness must not pass another harness's captured
// native session id. fakeAgent resumes only WITH a captured id, so with the id
// cleared it must fresh-launch rather than resume against a foreign id.
func TestSwitchHarness_ResumeDoesNotUseForeignSessionID(t *testing.T) {
	m, st, rt, _ := newManager()
	id := domain.SessionID("ao-1")
	st.sessions[id] = domain.SessionRecord{
		ID: id, ProjectID: "mer", Kind: domain.KindWorker, Harness: domain.HarnessCodex,
		Metadata: domain.SessionMetadata{
			Branch: "b/ao-1", WorkspacePath: "/ws/ao-1", RuntimeHandleID: "h1", Prompt: "do it",
			AgentSessionID:    "other-harness-native-id",
			LaunchedHarnesses: []domain.AgentHarness{domain.HarnessCodex, domain.HarnessClaudeCode},
		},
		Activity: domain.Activity{State: domain.ActivityActive},
	}

	if _, err := m.SwitchHarness(ctx, id, domain.HarnessClaudeCode, ""); err != nil {
		t.Fatalf("SwitchHarness: %v", err)
	}
	if len(rt.lastCfg.Argv) == 0 || rt.lastCfg.Argv[0] != "launch" {
		t.Fatalf("argv = %v, want fresh launch (adapter can't derive its id)", rt.lastCfg.Argv)
	}
	for _, a := range rt.lastCfg.Argv {
		if a == "other-harness-native-id" {
			t.Fatalf("leaked another harness's session id into the launch: %v", rt.lastCfg.Argv)
		}
	}
}

func TestSwitchHarness_FreshLaunchForNewHarness(t *testing.T) {
	st := newFakeStore()
	st.projects["mer"] = domain.ProjectRecord{ID: "mer", Config: testRoleAgents()}
	rt := &fakeRuntime{}
	lookPath := func(string) (string, error) { return "/bin/true", nil }
	m := New(Deps{Runtime: rt, Agents: singleAgent{agent: alwaysResumeAgent{}}, Workspace: &fakeWorkspace{}, Store: st, Messenger: &fakeMessenger{}, Lifecycle: &fakeLCM{store: st}, LookPath: lookPath})

	id := domain.SessionID("ao-1")
	st.sessions[id] = domain.SessionRecord{
		ID: id, ProjectID: "mer", Kind: domain.KindWorker, Harness: domain.HarnessCodex,
		Metadata: domain.SessionMetadata{
			Branch: "b/ao-1", WorkspacePath: "/ws/ao-1", RuntimeHandleID: "h1", Prompt: "do it",
			LaunchedHarnesses: []domain.AgentHarness{domain.HarnessCodex},
		},
		Activity: domain.Activity{State: domain.ActivityActive},
	}

	if _, err := m.SwitchHarness(ctx, id, domain.HarnessAider, ""); err != nil {
		t.Fatalf("SwitchHarness: %v", err)
	}
	if len(rt.lastCfg.Argv) == 0 || rt.lastCfg.Argv[0] != "launch" {
		t.Fatalf("argv = %v, want a fresh launch (harness never used)", rt.lastCfg.Argv)
	}
	// The switched-to harness is now recorded.
	if got := st.sessions[id].Metadata.LaunchedHarnesses; !containsHarness(got, domain.HarnessAider) {
		t.Fatalf("launched harnesses = %v, want to include aider", got)
	}
}

func TestSwitchHarness_CreateFailureTerminates(t *testing.T) {
	m, st, rt, _ := newManager()
	rt.createErr = errors.New("boom")
	id := domain.SessionID("ao-1")
	st.sessions[id] = mkSwitchable(id)

	if _, err := m.SwitchHarness(ctx, id, domain.HarnessCodex, ""); err == nil {
		t.Fatal("expected error when the new runtime fails to launch")
	}
	if rt.destroyed != 1 {
		t.Fatalf("destroyed=%d, want 1 (old agent stopped before the failed launch)", rt.destroyed)
	}
	lcm := m.lcm.(*fakeLCM)
	if lcm.terminated[id] != 1 {
		t.Fatalf("MarkTerminated=%d, want 1 (no live-session-with-dead-handle)", lcm.terminated[id])
	}
	if lcm.IsSwitching(id) {
		t.Fatal("switch guard not cleared after a failed switch")
	}
}

func TestSpawn_ResolvesProjectConfig(t *testing.T) {
	st := newFakeStore()
	st.projects["mer"] = domain.ProjectRecord{ID: "mer", Config: domain.ProjectConfig{
		DefaultBranch:   "develop",
		Env:             map[string]string{"FOO": "bar"},
		AutonomousMerge: true,
		AgentConfig:     domain.AgentConfig{Model: "base-model"},
		// A worker role override wins over the base agent config for workers.
		Worker: domain.RoleOverride{Harness: domain.HarnessCodex, AgentConfig: domain.AgentConfig{Model: "worker-model"}},
	}}
	agent := &recordingAgent{}
	rt := &fakeRuntime{}
	ws := &fakeWorkspace{}
	lookPath := func(string) (string, error) { return "/bin/true", nil }
	m := New(Deps{Runtime: rt, Agents: singleAgent{agent: agent}, Workspace: ws, Store: st, Messenger: &fakeMessenger{}, Lifecycle: &fakeLCM{store: st}, LookPath: lookPath})

	rec, err := m.Spawn(ctx, ports.SpawnConfig{ProjectID: "mer", Kind: domain.KindWorker})
	if err != nil {
		t.Fatal(err)
	}
	if agent.lastConfig.Model != "worker-model" {
		t.Fatalf("launch model = %q, want role override worker-model", agent.lastConfig.Model)
	}
	if rec.Harness != domain.HarnessCodex {
		t.Fatalf("harness = %q, want codex from role override", rec.Harness)
	}
	if ws.lastCfg.BaseBranch != "develop" {
		t.Fatalf("workspace base branch = %q, want develop", ws.lastCfg.BaseBranch)
	}
	if rt.lastCfg.Env["FOO"] != "bar" {
		t.Fatalf("runtime env FOO = %q, want bar", rt.lastCfg.Env["FOO"])
	}
	if rt.lastCfg.Env["POLYPOWERS_AUTOMERGE"] != "1" {
		t.Fatalf("runtime env POLYPOWERS_AUTOMERGE = %q, want 1", rt.lastCfg.Env["POLYPOWERS_AUTOMERGE"])
	}
	if rt.lastCfg.Env[EnvSessionID] == "" {
		t.Fatal("runtime env missing AO_SESSION_ID")
	}
	if rt.lastCfg.Env[EnvRuntimeToken] == "" {
		t.Fatal("runtime env missing AO_RUNTIME_TOKEN")
	}

	agent.lastConfig = ports.AgentConfig{}
	if _, err := m.Spawn(ctx, ports.SpawnConfig{ProjectID: "mer", Kind: domain.KindWorker, Model: "spawn-model"}); err != nil {
		t.Fatal(err)
	}
	if agent.lastConfig.Model != "spawn-model" {
		t.Fatalf("launch model = %q, want per-spawn override spawn-model", agent.lastConfig.Model)
	}
	if got := st.sessions["mer-2"].Metadata.Model; got != "spawn-model" {
		t.Fatalf("persisted session model = %q, want spawn-model", got)
	}

	// A project with no stored config yields a zero AgentConfig (adapter defaults)
	// when the spawn explicitly names its agent.
	st.projects["bare"] = domain.ProjectRecord{ID: "bare"}
	agent.lastConfig = ports.AgentConfig{Model: "stale"}
	rt.lastCfg = ports.RuntimeConfig{}
	if _, err := m.Spawn(ctx, ports.SpawnConfig{ProjectID: "bare", Kind: domain.KindWorker, Harness: domain.HarnessCodex}); err != nil {
		t.Fatal(err)
	}
	if !agent.lastConfig.IsZero() {
		t.Fatalf("launch config = %#v, want zero for project without config", agent.lastConfig)
	}
	if got, ok := rt.lastCfg.Env["POLYPOWERS_AUTOMERGE"]; ok {
		t.Fatalf("runtime env POLYPOWERS_AUTOMERGE = %q, want unset for project without autonomous merge", got)
	}
}

// fakeSpawnModelValidator records the harness/model it was asked about and
// returns a canned verdict, mirroring the three-way contract the manager acts on.
type fakeSpawnModelValidator struct {
	err        error
	gotHarness domain.AgentHarness
	gotModel   string
	callCount  int
}

func (f *fakeSpawnModelValidator) ValidateSpawnModel(_ context.Context, harness domain.AgentHarness, model string) error {
	f.callCount++
	f.gotHarness = harness
	f.gotModel = model
	return f.err
}

func spawnManagerWithValidator(v SpawnModelValidator) (*Manager, *fakeStore) {
	st := newFakeStore()
	st.projects["mer"] = domain.ProjectRecord{ID: "mer", Config: testRoleAgents()}
	lookPath := func(string) (string, error) { return "/bin/true", nil }
	m := New(Deps{Runtime: &fakeRuntime{}, Agents: fakeAgents{}, Workspace: &fakeWorkspace{}, Store: st, Messenger: &fakeMessenger{}, Lifecycle: &fakeLCM{store: st}, LookPath: lookPath, ModelValidator: v})
	return m, st
}

// A definitive rejection from the validator refuses the spawn BEFORE any durable
// session row is created.
func TestSpawn_RefusesDefinitivelyInvalidModel(t *testing.T) {
	v := &fakeSpawnModelValidator{err: errors.New("400 model not available")}
	m, st := spawnManagerWithValidator(v)

	_, err := m.Spawn(ctx, ports.SpawnConfig{ProjectID: "mer", Kind: domain.KindWorker, Model: "bogus-model"})
	if !errors.Is(err, ErrModelUnreachable) {
		t.Fatalf("Spawn err = %v, want ErrModelUnreachable", err)
	}
	if v.gotModel != "bogus-model" {
		t.Fatalf("validator saw model %q, want the resolved bogus-model", v.gotModel)
	}
	if len(st.sessions) != 0 {
		t.Fatalf("a refused spawn must not create a session row, got %d", len(st.sessions))
	}
}

// A probe-unavailable verdict fails open: the spawn proceeds unverified.
func TestSpawn_ProbeUnavailableModelProceeds(t *testing.T) {
	v := &fakeSpawnModelValidator{err: &ports.ProbeUnavailableError{Reason: "probe defect"}}
	m, _ := spawnManagerWithValidator(v)

	if _, err := m.Spawn(ctx, ports.SpawnConfig{ProjectID: "mer", Kind: domain.KindWorker, Model: "unprobed"}); err != nil {
		t.Fatalf("probe-unavailable must fail open (proceed), got %v", err)
	}
	if v.callCount != 1 {
		t.Fatalf("validator call count = %d, want 1", v.callCount)
	}
}

// A reachable (nil) verdict proceeds normally.
func TestSpawn_ReachableModelProceeds(t *testing.T) {
	v := &fakeSpawnModelValidator{}
	m, _ := spawnManagerWithValidator(v)

	if _, err := m.Spawn(ctx, ports.SpawnConfig{ProjectID: "mer", Kind: domain.KindWorker, Model: "good"}); err != nil {
		t.Fatalf("reachable model must proceed, got %v", err)
	}
	if v.gotHarness != domain.HarnessClaudeCode {
		t.Fatalf("validator saw harness %q, want the resolved claude-code", v.gotHarness)
	}
}

func TestSpawn_RejectsMissingRoleHarness(t *testing.T) {
	st := newFakeStore()
	st.projects["mer"] = domain.ProjectRecord{ID: "mer"}
	m := New(Deps{
		Runtime: &fakeRuntime{}, Agents: fakeAgents{}, Workspace: &fakeWorkspace{}, Store: st,
		Messenger: &fakeMessenger{}, Lifecycle: &fakeLCM{store: st},
		LookPath: func(string) (string, error) { return "/bin/true", nil },
	})

	if _, err := m.Spawn(ctx, ports.SpawnConfig{ProjectID: "mer", Kind: domain.KindWorker}); !errors.Is(err, ErrMissingHarness) {
		t.Fatalf("worker err = %v, want ErrMissingHarness", err)
	}
	if len(st.sessions) != 0 {
		t.Fatalf("missing worker harness must not create a session row, got %d", len(st.sessions))
	}
	if _, err := m.Spawn(ctx, ports.SpawnConfig{ProjectID: "mer", Kind: domain.KindOrchestrator}); !errors.Is(err, ErrMissingHarness) {
		t.Fatalf("orchestrator err = %v, want ErrMissingHarness", err)
	}
}

func TestSpawn_ExplicitHarnessWinsWithoutProjectRoleHarness(t *testing.T) {
	st := newFakeStore()
	st.projects["mer"] = domain.ProjectRecord{ID: "mer"}
	m := New(Deps{
		Runtime: &fakeRuntime{}, Agents: fakeAgents{}, Workspace: &fakeWorkspace{}, Store: st,
		Messenger: &fakeMessenger{}, Lifecycle: &fakeLCM{store: st},
		LookPath: func(string) (string, error) { return "/bin/true", nil },
	})
	if _, err := m.Spawn(ctx, ports.SpawnConfig{ProjectID: "mer", Kind: domain.KindWorker, Harness: domain.HarnessCodex}); err != nil {
		t.Fatal(err)
	}
	if got := st.sessions["mer-1"].Harness; got != domain.HarnessCodex {
		t.Fatalf("explicit harness = %q, want %q", got, domain.HarnessCodex)
	}
}

func TestSpawn_RejectsWorkerWhenProjectAtConcurrencyCap(t *testing.T) {
	st := newFakeStore()
	st.projects["mer"] = domain.ProjectRecord{ID: "mer", Config: domain.ProjectConfig{
		Worker:        domain.RoleOverride{Harness: domain.HarnessCodex},
		TrackerIntake: domain.TrackerIntakeConfig{MaxConcurrent: 1},
	}}
	st.sessions["mer-live"] = domain.SessionRecord{
		ID:        "mer-live",
		ProjectID: "mer",
		Kind:      domain.KindWorker,
		Harness:   domain.HarnessCodex,
	}
	m := New(Deps{
		Runtime: &fakeRuntime{}, Agents: singleAgent{agent: &recordingAgent{}}, Workspace: &fakeWorkspace{}, Store: st,
		Messenger: &fakeMessenger{}, Lifecycle: &fakeLCM{store: st},
		LookPath: func(string) (string, error) { return "/bin/true", nil },
	})

	if _, err := m.Spawn(ctx, ports.SpawnConfig{ProjectID: "mer", Kind: domain.KindWorker}); !errors.Is(err, ErrWorkerConcurrencyCap) {
		t.Fatalf("spawn err = %v, want ErrWorkerConcurrencyCap", err)
	}
	if len(st.sessions) != 1 {
		t.Fatalf("capped spawn must not create a session row, got %d rows", len(st.sessions))
	}
}

func TestSpawn_HistoricalIntakePoolBypassStillCountsAtConcurrencyCap(t *testing.T) {
	st := newFakeStore()
	st.projects["mer"] = domain.ProjectRecord{ID: "mer", Config: domain.ProjectConfig{
		Worker:        domain.RoleOverride{Harness: domain.HarnessCodex},
		TrackerIntake: domain.TrackerIntakeConfig{MaxConcurrent: 1},
	}}
	st.sessions["mer-live"] = domain.SessionRecord{
		ID:        "mer-live",
		ProjectID: "mer",
		Kind:      domain.KindWorker,
		Harness:   domain.HarnessCodex,
		Metadata:  domain.SessionMetadata{IntakePoolBypass: true},
	}
	m := New(Deps{
		Runtime: &fakeRuntime{}, Agents: singleAgent{agent: &recordingAgent{}}, Workspace: &fakeWorkspace{}, Store: st,
		Messenger: &fakeMessenger{}, Lifecycle: &fakeLCM{store: st},
		LookPath: func(string) (string, error) { return "/bin/true", nil },
	})

	if _, err := m.Spawn(ctx, ports.SpawnConfig{ProjectID: "mer", Kind: domain.KindWorker}); !errors.Is(err, ErrWorkerConcurrencyCap) {
		t.Fatalf("spawn err = %v, want historical bypass-marked worker to consume the cap", err)
	}
}

func TestSpawn_CountsInFlightSeedRowsAgainstConcurrencyCap(t *testing.T) {
	st := newFakeStore()
	st.projects["mer"] = domain.ProjectRecord{ID: "mer", Config: domain.ProjectConfig{
		Worker:        domain.RoleOverride{Harness: domain.HarnessCodex},
		TrackerIntake: domain.TrackerIntakeConfig{MaxConcurrent: 1},
	}}
	ws := &blockingWorkspace{
		fakeWorkspace: &fakeWorkspace{},
		entered:       make(chan struct{}),
		release:       make(chan struct{}),
	}
	m := New(Deps{
		Runtime: &fakeRuntime{}, Agents: singleAgent{agent: &recordingAgent{}}, Workspace: ws, Store: st,
		Messenger: &fakeMessenger{}, Lifecycle: &fakeLCM{store: st},
		LookPath: func(string) (string, error) { return "/bin/true", nil },
	})

	firstErr := make(chan error, 1)
	go func() {
		_, err := m.Spawn(ctx, ports.SpawnConfig{ProjectID: "mer", Kind: domain.KindWorker})
		firstErr <- err
	}()
	<-ws.entered

	if _, err := m.Spawn(ctx, ports.SpawnConfig{ProjectID: "mer", Kind: domain.KindWorker}); !errors.Is(err, ErrWorkerConcurrencyCap) {
		t.Fatalf("second spawn err = %v, want ErrWorkerConcurrencyCap", err)
	}

	close(ws.release)
	if err := <-firstErr; err != nil {
		t.Fatalf("first spawn failed: %v", err)
	}
	if len(st.sessions) != 1 {
		t.Fatalf("in-flight capped spawn must leave one session row, got %d", len(st.sessions))
	}
}

// TestSpawn_WorkerMixConvergesDeficitBased spawns ten workers through the real
// Spawn against a 60/30/10 mix and asserts the fleet lands on the exact target
// apportionment (6/3/1). Because selection reads the running counts each spawn
// persists, this exercises the full loop: pick → persist → count → pick.
func TestSpawn_WorkerMixConvergesDeficitBased(t *testing.T) {
	st := newFakeStore()
	st.projects["mer"] = domain.ProjectRecord{ID: "mer", Config: domain.ProjectConfig{
		WorkerMix: domain.WorkerMix{
			{Harness: domain.HarnessCodex, Weight: 60},
			{Harness: domain.HarnessCodexFugu, Weight: 30},
			{Harness: domain.HarnessClaudeCode, Model: "opus", Weight: 10},
		},
	}}
	agent := &recordingAgent{}
	m := New(Deps{
		Runtime: &fakeRuntime{}, Agents: singleAgent{agent: agent}, Workspace: &fakeWorkspace{}, Store: st,
		Messenger: &fakeMessenger{}, Lifecycle: &fakeLCM{store: st},
		LookPath: func(string) (string, error) { return "/bin/true", nil },
	})

	for i := 0; i < 10; i++ {
		if _, err := m.Spawn(ctx, ports.SpawnConfig{ProjectID: "mer", Kind: domain.KindWorker}); err != nil {
			t.Fatalf("spawn %d: %v", i, err)
		}
	}

	counts := map[domain.AgentHarness]int{}
	var claudeModel string
	for _, rec := range st.sessions {
		counts[rec.Harness]++
		if rec.Harness == domain.HarnessClaudeCode {
			claudeModel = rec.Metadata.Model
		}
	}
	want := map[domain.AgentHarness]int{domain.HarnessCodex: 6, domain.HarnessCodexFugu: 3, domain.HarnessClaudeCode: 1}
	for h, w := range want {
		if counts[h] != w {
			t.Fatalf("harness %s = %d, want %d (all=%v)", h, counts[h], w, counts)
		}
	}
	// The bucket's model pin must flow to the spawn so counting stays stable and
	// the launched agent gets the configured model.
	if claudeModel != "opus" {
		t.Fatalf("claude bucket model = %q, want opus", claudeModel)
	}
}

func TestSpawn_WorkerMixMarksFailedBucketDownWithoutSameAttemptSubstitution(t *testing.T) {
	st := newFakeStore()
	st.projects["mer"] = domain.ProjectRecord{ID: "mer", Config: domain.ProjectConfig{
		WorkerMix: domain.WorkerMix{
			{Harness: domain.HarnessCodex, Model: "gpt-5.5-codex", Weight: 60},
			{Harness: domain.HarnessClaudeCode, Model: "opus", Weight: 40},
		},
	}}
	agent := &modelFailAgent{failModel: "gpt-5.5-codex", err: errors.New("400 model not available")}
	m := New(Deps{
		Runtime: &fakeRuntime{}, Agents: singleAgent{agent: agent}, Workspace: &fakeWorkspace{}, Store: st,
		Messenger: &fakeMessenger{}, Lifecycle: &fakeLCM{store: st},
		LookPath: func(string) (string, error) { return "/bin/true", nil },
	})

	_, err := m.Spawn(ctx, ports.SpawnConfig{ProjectID: "mer", Kind: domain.KindWorker})
	if err == nil || !strings.Contains(err.Error(), "400 model not available") {
		t.Fatalf("first spawn err = %v, want exact bucket launch failure", err)
	}
	if len(st.sessions) != 0 {
		t.Fatalf("failed codex bucket must not substitute claude in the same attempt; sessions=%v", st.sessions)
	}
	downKey := domain.BucketKey{Harness: domain.HarnessCodex, Model: "gpt-5.5-codex"}
	if !m.workerMixBucketDown(downKey) {
		t.Fatal("failed codex model bucket was not marked down")
	}

	if _, err := m.Spawn(ctx, ports.SpawnConfig{ProjectID: "mer", Kind: domain.KindWorker}); err != nil {
		t.Fatalf("second spawn should use the healthy claude bucket's own turn: %v", err)
	}
	if got := st.sessions["mer-2"].Harness; got != domain.HarnessClaudeCode {
		t.Fatalf("second spawn harness = %q, want claude-code", got)
	}
	if got := st.sessions["mer-2"].Metadata.Model; got != "opus" {
		t.Fatalf("second spawn model = %q, want opus", got)
	}

	_, err = m.Spawn(ctx, ports.SpawnConfig{ProjectID: "mer", Kind: domain.KindWorker})
	if !errors.Is(err, ErrWorkerMixBucketDown) {
		t.Fatalf("third spawn err = %v, want ErrWorkerMixBucketDown for the down bucket's next slot", err)
	}
	if len(st.sessions) != 1 {
		t.Fatalf("down bucket slot must reduce capacity, not create another session; sessions=%v", st.sessions)
	}

	agent.failModel = ""
	if _, err := m.Spawn(ctx, ports.SpawnConfig{ProjectID: "mer", Kind: domain.KindWorker, Harness: domain.HarnessCodex, Model: "gpt-5.5-codex"}); err != nil {
		t.Fatalf("explicit successful codex bucket spawn should recover bucket: %v", err)
	}
	if m.workerMixBucketDown(downKey) {
		t.Fatal("successful exact bucket spawn did not mark bucket recovered")
	}
}

// TestSpawn_WorkerMixEmitsCandidateHealthTelemetry confirms the worker-mix
// surface now alerts through the shared candidate-health policy (GH #142): a
// failed exact bucket emits ao.candidate_health.candidate_down naming the
// surface and reason, and a later successful exact spawn emits
// candidate_recovered.
func TestSpawn_WorkerMixEmitsCandidateHealthTelemetry(t *testing.T) {
	st := newFakeStore()
	st.projects["mer"] = domain.ProjectRecord{ID: "mer", Config: domain.ProjectConfig{
		WorkerMix: domain.WorkerMix{{Harness: domain.HarnessCodex, Model: "gpt-5.5-codex", Weight: 100}},
	}}
	agent := &modelFailAgent{failModel: "gpt-5.5-codex", err: errors.New("400 model not available")}
	sink := &candidateHealthSink{}
	m := New(Deps{
		Runtime: &fakeRuntime{}, Agents: singleAgent{agent: agent}, Workspace: &fakeWorkspace{}, Store: st,
		Messenger: &fakeMessenger{}, Lifecycle: &fakeLCM{store: st},
		LookPath:  func(string) (string, error) { return "/bin/true", nil },
		Telemetry: sink,
	})

	if _, err := m.Spawn(ctx, ports.SpawnConfig{ProjectID: "mer", Kind: domain.KindWorker}); err == nil {
		t.Fatal("spawn should fail on the down bucket")
	}
	down := sink.named("ao.candidate_health.candidate_down")
	if len(down) != 1 {
		t.Fatalf("want 1 candidate_down event, got %d", len(down))
	}
	if got := down[0].Payload["surface"]; got != "worker_mix" {
		t.Fatalf("candidate_down surface = %v, want worker_mix", got)
	}
	if got := down[0].Payload["reason"]; got != "400 model not available" {
		t.Fatalf("candidate_down reason = %v, want the observed error", got)
	}

	agent.failModel = ""
	if _, err := m.Spawn(ctx, ports.SpawnConfig{ProjectID: "mer", Kind: domain.KindWorker, Harness: domain.HarnessCodex, Model: "gpt-5.5-codex"}); err != nil {
		t.Fatalf("successful exact spawn should recover the bucket: %v", err)
	}
	if got := len(sink.named("ao.candidate_health.candidate_recovered")); got != 1 {
		t.Fatalf("want 1 candidate_recovered event, got %d", got)
	}
}

func TestSpawn_WorkerMixExplicitModelMarksActualBucketDown(t *testing.T) {
	st := newFakeStore()
	st.projects["mer"] = domain.ProjectRecord{ID: "mer", Config: domain.ProjectConfig{
		WorkerMix: domain.WorkerMix{{Harness: domain.HarnessCodex, Model: "gpt-5.4-codex", Weight: 100}},
	}}
	agent := &modelFailAgent{failModel: "gpt-5.5-codex", err: errors.New("400 model not available")}
	m := New(Deps{
		Runtime: &fakeRuntime{}, Agents: singleAgent{agent: agent}, Workspace: &fakeWorkspace{}, Store: st,
		Messenger: &fakeMessenger{}, Lifecycle: &fakeLCM{store: st},
		LookPath: func(string) (string, error) { return "/bin/true", nil },
	})

	_, err := m.Spawn(ctx, ports.SpawnConfig{ProjectID: "mer", Kind: domain.KindWorker, Model: "gpt-5.5-codex"})
	if err == nil || !strings.Contains(err.Error(), "400 model not available") {
		t.Fatalf("spawn err = %v, want explicit model launch failure", err)
	}
	actualKey := domain.BucketKey{Harness: domain.HarnessCodex, Model: "gpt-5.5-codex"}
	configuredKey := domain.BucketKey{Harness: domain.HarnessCodex, Model: "gpt-5.4-codex"}
	if !m.workerMixBucketDown(actualKey) {
		t.Fatal("explicit launch bucket was not marked down")
	}
	if m.workerMixBucketDown(configuredKey) {
		t.Fatal("configured mix bucket was marked down instead of actual explicit model bucket")
	}

	_, err = m.Spawn(ctx, ports.SpawnConfig{ProjectID: "mer", Kind: domain.KindWorker, Model: "gpt-5.5-codex"})
	if !errors.Is(err, ErrWorkerMixBucketDown) {
		t.Fatalf("repeat explicit model spawn err = %v, want ErrWorkerMixBucketDown", err)
	}

	agent.failModel = ""
	if _, err := m.Spawn(ctx, ports.SpawnConfig{ProjectID: "mer", Kind: domain.KindWorker, Harness: domain.HarnessCodex, Model: "gpt-5.5-codex"}); err != nil {
		t.Fatalf("explicit successful exact bucket spawn should recover bucket: %v", err)
	}
	if m.workerMixBucketDown(actualKey) {
		t.Fatal("successful exact explicit bucket spawn did not mark bucket recovered")
	}
}

// TestSpawn_WorkerMixExplicitHarnessOverrides confirms an explicit --agent wins
// over a configured mix — this is how the haiku deploy pool stays outside the mix.
func TestSpawn_WorkerMixExplicitHarnessOverrides(t *testing.T) {
	st := newFakeStore()
	st.projects["mer"] = domain.ProjectRecord{ID: "mer", Config: domain.ProjectConfig{
		WorkerMix: domain.WorkerMix{{Harness: domain.HarnessCodex, Weight: 100}},
	}}
	m := New(Deps{
		Runtime: &fakeRuntime{}, Agents: singleAgent{agent: &recordingAgent{}}, Workspace: &fakeWorkspace{}, Store: st,
		Messenger: &fakeMessenger{}, Lifecycle: &fakeLCM{store: st},
		LookPath: func(string) (string, error) { return "/bin/true", nil },
	})
	if _, err := m.Spawn(ctx, ports.SpawnConfig{ProjectID: "mer", Kind: domain.KindWorker, Harness: domain.HarnessDroid}); err != nil {
		t.Fatal(err)
	}
	if got := st.sessions["mer-1"].Harness; got != domain.HarnessDroid {
		t.Fatalf("explicit harness = %q, want droid (mix must not override)", got)
	}
}

// TestSpawn_WorkerMixIgnoredForOrchestrator confirms the mix is worker-only: an
// orchestrator spawn still resolves via its role override, never the mix.
func TestSpawn_WorkerMixIgnoredForOrchestrator(t *testing.T) {
	st := newFakeStore()
	st.projects["mer"] = domain.ProjectRecord{ID: "mer", Config: domain.ProjectConfig{
		Orchestrator: domain.RoleOverride{Harness: domain.HarnessClaudeCode},
		WorkerMix:    domain.WorkerMix{{Harness: domain.HarnessCodex, Weight: 100}},
	}}
	m := New(Deps{
		Runtime: &fakeRuntime{}, Agents: singleAgent{agent: &recordingAgent{}}, Workspace: &fakeWorkspace{}, Store: st,
		Messenger: &fakeMessenger{}, Lifecycle: &fakeLCM{store: st},
		LookPath: func(string) (string, error) { return "/bin/true", nil },
	})
	if _, err := m.Spawn(ctx, ports.SpawnConfig{ProjectID: "mer", Kind: domain.KindOrchestrator}); err != nil {
		t.Fatal(err)
	}
	if got := st.sessions["mer-1"].Harness; got != domain.HarnessClaudeCode {
		t.Fatalf("orchestrator harness = %q, want claude-code role override (mix is worker-only)", got)
	}
}

func TestSpawn_OrchestratorBranchIgnoresDisplaySessionPrefix(t *testing.T) {
	st := newFakeStore()
	st.projects["learn-breakthrough"] = domain.ProjectRecord{ID: "learn-breakthrough", Config: domain.ProjectConfig{
		SessionPrefix: "lb",
		Orchestrator:  domain.RoleOverride{Harness: domain.HarnessClaudeCode},
	}}
	ws := &fakeWorkspace{}
	m := New(Deps{
		Runtime: &fakeRuntime{}, Agents: singleAgent{agent: &recordingAgent{}}, Workspace: ws, Store: st,
		Messenger: &fakeMessenger{}, Lifecycle: &fakeLCM{store: st},
		LookPath: func(string) (string, error) { return "/bin/true", nil },
	})
	if _, err := m.Spawn(ctx, ports.SpawnConfig{ProjectID: "learn-breakthrough", Kind: domain.KindOrchestrator}); err != nil {
		t.Fatal(err)
	}
	if ws.lastCfg.Branch != "ao/learn-breakt-orchestrator" {
		t.Fatalf("orchestrator branch = %q, want stable project-derived branch", ws.lastCfg.Branch)
	}
	if ws.lastCfg.SessionPrefix != "lb" {
		t.Fatalf("orchestrator workspace prefix = %q, want display prefix unchanged", ws.lastCfg.SessionPrefix)
	}
}

func TestSpawn_OrchestratorTitleUsesProjectPrefixOrc(t *testing.T) {
	st := newFakeStore()
	st.projects["agent-orchestrator"] = domain.ProjectRecord{
		ID:          "agent-orchestrator",
		DisplayName: "Agent Orchestrator",
		Config: domain.ProjectConfig{
			ProjectPrefix: "ao",
			Orchestrator:  domain.RoleOverride{Harness: domain.HarnessClaudeCode},
		},
	}
	agent := &launchTitleAgent{}
	rt := &fakeRuntime{}
	ws := &fakeWorkspace{}
	m := New(Deps{
		Runtime: rt, Agents: singleAgent{agent: agent}, Workspace: ws, Store: st,
		Messenger: &fakeMessenger{}, Lifecycle: &fakeLCM{store: st},
		LookPath: func(string) (string, error) { return "/bin/true", nil },
	})

	if _, err := m.Spawn(ctx, ports.SpawnConfig{ProjectID: "agent-orchestrator", Kind: domain.KindOrchestrator}); err != nil {
		t.Fatal(err)
	}

	wantName := "ao Orc"
	if got := st.sessions["agent-orchestrator-1"].DisplayName; got != wantName {
		t.Fatalf("stored displayName = %q, want %q", got, wantName)
	}
	if got := agent.lastLaunch.LaunchTitle; got != wantName {
		t.Fatalf("LaunchTitle = %q, want %q", got, wantName)
	}
	if got, want := rt.sent, []string{"/rename " + wantName}; !reflect.DeepEqual(got, want) {
		t.Fatalf("post-start sends = %#v, want %#v", got, want)
	}
	if ws.lastCfg.Branch != "ao/agent-orches-orchestrator" {
		t.Fatalf("orchestrator branch = %q, want stable project-derived branch", ws.lastCfg.Branch)
	}
}

func TestSpawn_OrchestratorTitleIgnoresExplicitDisplayName(t *testing.T) {
	st := newFakeStore()
	st.projects["agent-orchestrator"] = domain.ProjectRecord{
		ID: "agent-orchestrator",
		Config: domain.ProjectConfig{
			ProjectPrefix: "ao",
			Orchestrator:  domain.RoleOverride{Harness: domain.HarnessClaudeCode},
		},
	}
	agent := &launchTitleAgent{}
	rt := &fakeRuntime{}
	m := New(Deps{
		Runtime: rt, Agents: singleAgent{agent: agent}, Workspace: &fakeWorkspace{}, Store: st,
		Messenger: &fakeMessenger{}, Lifecycle: &fakeLCM{store: st},
		LookPath: func(string) (string, error) { return "/bin/true", nil },
	})

	if _, err := m.Spawn(ctx, ports.SpawnConfig{
		ProjectID:   "agent-orchestrator",
		Kind:        domain.KindOrchestrator,
		DisplayName: "custom coordinator name",
	}); err != nil {
		t.Fatal(err)
	}

	wantName := "ao Orc"
	if got := st.sessions["agent-orchestrator-1"].DisplayName; got != wantName {
		t.Fatalf("stored displayName = %q, want %q", got, wantName)
	}
	if got := agent.lastLaunch.LaunchTitle; got != wantName {
		t.Fatalf("LaunchTitle = %q, want %q", got, wantName)
	}
	if got, want := rt.sent, []string{"/rename " + wantName}; !reflect.DeepEqual(got, want) {
		t.Fatalf("post-start sends = %#v, want %#v", got, want)
	}
}

func TestSpawn_PrimeBranchIgnoresDisplaySessionPrefix(t *testing.T) {
	st := newFakeStore()
	st.projects["ao"] = domain.ProjectRecord{ID: "ao", DisplayName: "AO", Config: testRoleAgents().WithDefaults()}
	st.projects["ao"] = domain.ProjectRecord{ID: "ao", DisplayName: "AO", Config: domain.ProjectConfig{
		ProjectPrefix: "display",
		Prime:         domain.RoleOverride{Harness: domain.HarnessClaudeCode},
	}}
	ws := &fakeWorkspace{}
	lookPath := func(string) (string, error) { return "/bin/true", nil }
	m := New(Deps{Runtime: &fakeRuntime{}, Agents: singleAgent{agent: &recordingAgent{}}, Workspace: ws, Store: st, Messenger: &fakeMessenger{}, Lifecycle: &fakeLCM{store: st}, LookPath: lookPath})

	if _, err := m.Spawn(ctx, ports.SpawnConfig{ProjectID: "ao", Kind: domain.KindPrime}); err != nil {
		t.Fatal(err)
	}
	if ws.lastCfg.Branch != "ao/ao-prime" {
		t.Fatalf("prime branch = %q, want stable project-derived branch", ws.lastCfg.Branch)
	}
	if ws.lastCfg.SessionPrefix != "display" {
		t.Fatalf("prime workspace prefix = %q, want display prefix unchanged", ws.lastCfg.SessionPrefix)
	}
}

func TestSpawn_AssignsIDAndGoesIdle(t *testing.T) {
	m, st, rt, _ := newManager()
	s, err := m.Spawn(ctx, ports.SpawnConfig{ProjectID: "mer", Kind: domain.KindWorker, Prompt: "do it"})
	if err != nil {
		t.Fatal(err)
	}
	if s.ID != "mer-1" {
		t.Fatalf("got %q", s.ID)
	}
	if s.Activity.State != domain.ActivityIdle {
		t.Fatalf("fresh session records idle, got %q", s.Activity.State)
	}
	if rt.created != 1 {
		t.Fatal("runtime not created")
	}
	if st.sessions["mer-1"].Metadata.RuntimeHandleID != "h1" {
		t.Fatal("handle not folded")
	}
}

func TestSpawn_ForwardsDisplayNameAsLaunchTitleAndPromptInArgv(t *testing.T) {
	st := newFakeStore()
	st.projects["mer"] = domain.ProjectRecord{ID: "mer", Config: testRoleAgents()}
	agent := &launchTitleAgent{}
	rt := &fakeRuntime{}
	m := New(Deps{
		Runtime: rt, Agents: singleAgent{agent: agent}, Workspace: &fakeWorkspace{}, Store: st,
		Messenger: &fakeMessenger{}, Lifecycle: &fakeLCM{store: st},
		LookPath: func(string) (string, error) { return "/bin/true", nil },
	})

	if _, err := m.Spawn(ctx, ports.SpawnConfig{
		ProjectID:   "mer",
		Kind:        domain.KindWorker,
		DisplayName: "#53 title-sync",
		Prompt:      "implement\x1b issue 53",
	}); err != nil {
		t.Fatal(err)
	}

	if got := agent.lastLaunch.LaunchTitle; got != "#53 title-sync" {
		t.Fatalf("LaunchTitle = %q, want display name", got)
	}
	if got := agent.lastLaunch.Prompt; got != "implement\x1b issue 53" {
		t.Fatalf("launch prompt = %q, want preserved task prompt in config", got)
	}
	// The prompt goes in argv, so the title is the only post-start write.
	if got, want := rt.sent, []string{"/rename #53 title-sync"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("post-start sends = %#v, want %#v", got, want)
	}
	if got := st.sessions["mer-1"].Metadata.Prompt; got != "implement\x1b issue 53" {
		t.Fatalf("metadata prompt = %q, want original task prompt", got)
	}
}

func TestSpawn_NormalizesDisplayNameBeforeTitleDelivery(t *testing.T) {
	st := newFakeStore()
	st.projects["mer"] = domain.ProjectRecord{ID: "mer", Config: testRoleAgents()}
	agent := &launchTitleAgent{}
	rt := &fakeRuntime{}
	m := New(Deps{
		Runtime: rt, Agents: singleAgent{agent: agent}, Workspace: &fakeWorkspace{}, Store: st,
		Messenger: &fakeMessenger{}, Lifecycle: &fakeLCM{store: st},
		LookPath: func(string) (string, error) { return "/bin/true", nil },
	})

	if _, err := m.Spawn(ctx, ports.SpawnConfig{
		ProjectID:   "mer",
		Kind:        domain.KindWorker,
		DisplayName: "  #53\ntitle\t sync\x1b  ",
		Prompt:      "implement issue 53",
	}); err != nil {
		t.Fatal(err)
	}

	wantName := "#53 title sync"
	if got := st.sessions["mer-1"].DisplayName; got != wantName {
		t.Fatalf("stored displayName = %q, want %q", got, wantName)
	}
	if got := agent.lastLaunch.LaunchTitle; got != wantName {
		t.Fatalf("LaunchTitle = %q, want %q", got, wantName)
	}
	if got, want := rt.sent, []string{"/rename " + wantName}; !reflect.DeepEqual(got, want) {
		t.Fatalf("post-start sends = %#v, want %#v", got, want)
	}
}

func TestSpawn_ComputesWorkerNameFromIssueTitleAndReappliesInHarness(t *testing.T) {
	st := newFakeStore()
	st.projects["agent-orchestrator"] = domain.ProjectRecord{
		ID: "agent-orchestrator",
		Config: domain.ProjectConfig{
			SessionPrefix: "ao",
			Worker:        domain.RoleOverride{Harness: domain.HarnessCodex},
		},
	}
	agent := &launchTitleAgent{}
	rt := &fakeRuntime{}
	m := New(Deps{
		Runtime: rt, Agents: singleAgent{agent: agent}, Workspace: &fakeWorkspace{}, Store: st,
		Messenger: &fakeMessenger{}, Lifecycle: &fakeLCM{store: st},
		LookPath: func(string) (string, error) { return "/bin/true", nil },
	})

	if _, err := m.Spawn(ctx, ports.SpawnConfig{
		ProjectID:  "agent-orchestrator",
		IssueID:    "github:polymath-ventures/agent-orchestrator#146",
		IssueTitle: "Naming, done forever: one semantic name on every surface, every agent, every harness",
		Kind:       domain.KindWorker,
		Prompt:     "/address-issue 146",
	}); err != nil {
		t.Fatal(err)
	}

	wantName := "ao #146 naming-done"
	if got := st.sessions["agent-orchestrator-1"].DisplayName; got != wantName {
		t.Fatalf("stored displayName = %q, want %q", got, wantName)
	}
	if got := agent.lastLaunch.LaunchTitle; got != wantName {
		t.Fatalf("LaunchTitle = %q, want %q", got, wantName)
	}
	// The title is the only post-start write; the prompt rides argv.
	if got, want := rt.sent, []string{"/rename " + wantName}; !reflect.DeepEqual(got, want) {
		t.Fatalf("post-start sends = %#v, want %#v", got, want)
	}
	if got := agent.lastLaunch.Prompt; got != "/address-issue 146" {
		t.Fatalf("launch prompt = %q, want the prompt delivered in argv", got)
	}
}

func TestSpawn_DerivesOrchestratorLaunchTitleFromProjectPrefix(t *testing.T) {
	st := newFakeStore()
	st.projects["mer"] = domain.ProjectRecord{ID: "mer", DisplayName: "Mercury", Config: testRoleAgents()}
	agent := &launchTitleAgent{}
	m := New(Deps{
		Runtime: &fakeRuntime{}, Agents: singleAgent{agent: agent}, Workspace: &fakeWorkspace{}, Store: st,
		Messenger: &fakeMessenger{}, Lifecycle: &fakeLCM{store: st},
		LookPath: func(string) (string, error) { return "/bin/true", nil },
	})

	if _, err := m.Spawn(ctx, ports.SpawnConfig{ProjectID: "mer", Kind: domain.KindOrchestrator}); err != nil {
		t.Fatal(err)
	}
	if got := agent.lastLaunch.LaunchTitle; got != "mer Orc" {
		t.Fatalf("orchestrator LaunchTitle = %q, want project prefix role name", got)
	}
	if got := st.sessions["mer-1"].DisplayName; got != "mer Orc" {
		t.Fatalf("orchestrator displayName = %q, want project prefix role name", got)
	}
}

func TestSpawn_CapsOrchestratorNameButPreservesOrcSuffix(t *testing.T) {
	st := newFakeStore()
	st.projects["mer"] = domain.ProjectRecord{ID: "mer", Config: domain.ProjectConfig{
		ProjectPrefix: "mercury-mission-control-ops",
		Orchestrator:  domain.RoleOverride{Harness: domain.HarnessClaudeCode},
	}}
	agent := &launchTitleAgent{}
	m := New(Deps{
		Runtime: &fakeRuntime{}, Agents: singleAgent{agent: agent}, Workspace: &fakeWorkspace{}, Store: st,
		Messenger: &fakeMessenger{}, Lifecycle: &fakeLCM{store: st},
		LookPath: func(string) (string, error) { return "/bin/true", nil },
	})

	if _, err := m.Spawn(ctx, ports.SpawnConfig{ProjectID: "mer", Kind: domain.KindOrchestrator}); err != nil {
		t.Fatal(err)
	}
	wantName := "mercury-mission Orc"
	if got := agent.lastLaunch.LaunchTitle; got != wantName {
		t.Fatalf("orchestrator LaunchTitle = %q, want %q", got, wantName)
	}
	if got := st.sessions["mer-1"].DisplayName; got != wantName {
		t.Fatalf("orchestrator displayName = %q, want %q", got, wantName)
	}
	if got := len([]rune(wantName)); got > maxSessionDisplayNameRunes {
		t.Fatalf("test fixture length = %d, want within cap %d", got, maxSessionDisplayNameRunes)
	}
}

func TestSpawn_DerivesPrimeLaunchTitleFromProject(t *testing.T) {
	st := newFakeStore()
	st.projects["ao"] = domain.ProjectRecord{ID: "ao", DisplayName: "Agent Orchestrator", Config: domain.ProjectConfig{Prime: domain.RoleOverride{Harness: domain.HarnessClaudeCode}}}
	agent := &recordingAgent{}
	lookPath := func(string) (string, error) { return "/bin/true", nil }
	m := New(Deps{Runtime: &fakeRuntime{}, Agents: singleAgent{agent: agent}, Workspace: &fakeWorkspace{}, Store: st, Messenger: &fakeMessenger{}, Lifecycle: &fakeLCM{store: st}, LookPath: lookPath})

	if _, err := m.Spawn(ctx, ports.SpawnConfig{ProjectID: "ao", Kind: domain.KindPrime}); err != nil {
		t.Fatal(err)
	}
	if got := agent.lastLaunch.LaunchTitle; got != "AO Prime" {
		t.Fatalf("prime launch title = %q, want short project-prefix title", got)
	}
}

func TestSpawn_UsesExplicitPrimeLaunchTitle(t *testing.T) {
	st := newFakeStore()
	st.projects["ao"] = domain.ProjectRecord{ID: "ao", DisplayName: "Agent Orchestrator", Config: domain.ProjectConfig{Prime: domain.RoleOverride{Harness: domain.HarnessClaudeCode}}}
	agent := &recordingAgent{}
	lookPath := func(string) (string, error) { return "/bin/true", nil }
	m := New(Deps{Runtime: &fakeRuntime{}, Agents: singleAgent{agent: agent}, Workspace: &fakeWorkspace{}, Store: st, Messenger: &fakeMessenger{}, Lifecycle: &fakeLCM{store: st}, LookPath: lookPath})

	if _, err := m.Spawn(ctx, ports.SpawnConfig{ProjectID: "ao", Kind: domain.KindPrime, DisplayName: "AO Prime"}); err != nil {
		t.Fatal(err)
	}
	if got := agent.lastLaunch.LaunchTitle; got != "AO Prime" {
		t.Fatalf("prime launch title = %q, want AO Prime", got)
	}
}

func TestSpawn_InCommandHarnessDoesNotPostStartPrompt(t *testing.T) {
	st := newFakeStore()
	st.projects["mer"] = domain.ProjectRecord{ID: "mer", Config: testRoleAgents()}
	agent := &recordingAgent{}
	rt := &fakeRuntime{}
	m := New(Deps{
		Runtime: rt, Agents: singleAgent{agent: agent}, Workspace: &fakeWorkspace{}, Store: st,
		Messenger: &fakeMessenger{}, Lifecycle: &fakeLCM{store: st},
		LookPath: func(string) (string, error) { return "/bin/true", nil },
	})

	if _, err := m.Spawn(ctx, ports.SpawnConfig{
		ProjectID:   "mer",
		Kind:        domain.KindWorker,
		DisplayName: "#53 title-sync",
		Prompt:      "implement issue 53",
	}); err != nil {
		t.Fatal(err)
	}
	if len(rt.sent) != 0 {
		t.Fatalf("agent without title command received post-start sends: %#v", rt.sent)
	}
	if got := agent.lastLaunch.Prompt; got != "implement issue 53" {
		t.Fatalf("launch prompt = %q, want in-command prompt preserved", got)
	}
}

func TestRename_RejectsOverlongName(t *testing.T) {
	m, st, _, _ := newManager()
	st.sessions["mer-1"] = domain.SessionRecord{ID: "mer-1", ProjectID: "mer"}

	if err := m.Rename(ctx, "mer-1", strings.Repeat("x", 21)); err == nil {
		t.Fatal("Rename() overlong name succeeded, want error")
	}
}

func TestRename_LiveSessionUpdatesStoreAndHarnessTitle(t *testing.T) {
	st := newFakeStore()
	st.projects["mer"] = domain.ProjectRecord{ID: "mer", Config: testRoleAgents()}
	rt := &fakeRuntime{}
	messenger := &fakeMessenger{}
	m := New(Deps{
		Runtime: rt, Agents: singleAgent{agent: &launchTitleAgent{}}, Workspace: &fakeWorkspace{}, Store: st,
		Messenger: messenger, Lifecycle: &fakeLCM{store: st},
		LookPath: func(string) (string, error) { return "/bin/true", nil },
	})
	st.sessions["mer-1"] = domain.SessionRecord{
		ID: "mer-1", ProjectID: "mer", Harness: domain.HarnessClaudeCode,
		Activity: domain.Activity{State: domain.ActivityIdle},
		Metadata: domain.SessionMetadata{RuntimeHandleID: "h1"},
	}

	if err := m.Rename(ctx, "mer-1", "  New Name  "); err != nil {
		t.Fatal(err)
	}
	if got := st.sessions["mer-1"].DisplayName; got != "New Name" {
		t.Fatalf("displayName = %q, want trimmed name", got)
	}
	if len(rt.sent) != 0 {
		t.Fatalf("rename bypassed guarded messenger and wrote to runtime directly: %#v", rt.sent)
	}
	if got, want := messenger.msgs, []string{"/rename New Name"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("guarded sends = %#v, want %#v", got, want)
	}
	if st.renameSessionCalls != 1 {
		t.Fatalf("RenameSession calls = %d, want 1", st.renameSessionCalls)
	}
	if st.updateSessionCalls != 0 {
		t.Fatalf("UpdateSession calls = %d, want 0", st.updateSessionCalls)
	}
}

func TestRename_NormalizesDisplayNameBeforeStoreAndHarnessTitle(t *testing.T) {
	st := newFakeStore()
	st.projects["mer"] = domain.ProjectRecord{ID: "mer", Config: testRoleAgents()}
	messenger := &fakeMessenger{}
	m := New(Deps{
		Runtime: &fakeRuntime{}, Agents: singleAgent{agent: &launchTitleAgent{}}, Workspace: &fakeWorkspace{}, Store: st,
		Messenger: messenger, Lifecycle: &fakeLCM{store: st},
		LookPath: func(string) (string, error) { return "/bin/true", nil },
	})
	st.sessions["mer-1"] = domain.SessionRecord{
		ID: "mer-1", ProjectID: "mer", Harness: domain.HarnessClaudeCode,
		Activity: domain.Activity{State: domain.ActivityIdle},
		Metadata: domain.SessionMetadata{RuntimeHandleID: "h1"},
	}

	if err := m.Rename(ctx, "mer-1", "  New\nName\tNow\x1b  "); err != nil {
		t.Fatal(err)
	}

	wantName := "New Name Now"
	if got := st.sessions["mer-1"].DisplayName; got != wantName {
		t.Fatalf("displayName = %q, want %q", got, wantName)
	}
	if got, want := messenger.msgs, []string{"/rename " + wantName}; !reflect.DeepEqual(got, want) {
		t.Fatalf("guarded sends = %#v, want %#v", got, want)
	}
}

func TestSetIssue_ComputesNamePersistsIssueAndUpdatesHarnessTitle(t *testing.T) {
	st := newFakeStore()
	cfg := testRoleAgents()
	cfg.SessionPrefix = "ao"
	st.projects["agent-orchestrator"] = domain.ProjectRecord{ID: "agent-orchestrator", Config: cfg}
	messenger := &fakeMessenger{}
	m := New(Deps{
		Runtime: &fakeRuntime{}, Agents: singleAgent{agent: &launchTitleAgent{}}, Workspace: &fakeWorkspace{}, Store: st,
		Messenger: messenger, Lifecycle: &fakeLCM{store: st},
		LookPath: func(string) (string, error) { return "/bin/true", nil },
	})
	st.sessions["agent-orchestrator-116"] = domain.SessionRecord{
		ID: "agent-orchestrator-116", ProjectID: "agent-orchestrator", Kind: domain.KindWorker, Harness: domain.HarnessClaudeCode,
		IssueID: "github:polymath-ventures/agent-orchestrator#146", DisplayName: "ao #146 naming",
		Activity: domain.Activity{State: domain.ActivityIdle},
		Metadata: domain.SessionMetadata{RuntimeHandleID: "h1"},
	}

	rec, err := m.SetIssue(ctx, "agent-orchestrator-116", "github:polymath-ventures/agent-orchestrator#164", "Daemon-side rename when a session's work item changes")
	if err != nil {
		t.Fatal(err)
	}
	if rec.IssueID != "github:polymath-ventures/agent-orchestrator#164" {
		t.Fatalf("IssueID = %q, want rebind issue", rec.IssueID)
	}
	if got := st.sessions["agent-orchestrator-116"].DisplayName; got != "ao #164 daemon-side" {
		t.Fatalf("displayName = %q, want computed issue title", got)
	}
	if got, want := messenger.msgs, []string{"/rename ao #164 daemon-side"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("guarded sends = %#v, want %#v", got, want)
	}
	if st.setIssueCalls != 1 {
		t.Fatalf("SetSessionIssue calls = %d, want 1", st.setIssueCalls)
	}
	if st.renameSessionCalls != 0 {
		t.Fatalf("RenameSession calls = %d, want 0", st.renameSessionCalls)
	}
}

// TestSpawn_StampsUTCTimestamps locks the default clock to UTC so spawn-stamped
// CreatedAt/UpdatedAt match every other session write (rename, activity), which
// all use time.Now().UTC(). A local default produced mixed-timezone timestamps
// in `ao session get` (created in local time, updated in UTC).
func TestSpawn_StampsUTCTimestamps(t *testing.T) {
	m, st, _, _ := newManager()
	if _, err := m.Spawn(ctx, ports.SpawnConfig{ProjectID: "mer", Kind: domain.KindWorker}); err != nil {
		t.Fatal(err)
	}
	rec := st.sessions["mer-1"]
	if loc := rec.CreatedAt.Location(); loc != time.UTC {
		t.Fatalf("CreatedAt location = %v, want UTC", loc)
	}
	if loc := rec.UpdatedAt.Location(); loc != time.UTC {
		t.Fatalf("UpdatedAt location = %v, want UTC", loc)
	}
}

func TestSpawn_RollsBackOnRuntimeFailure(t *testing.T) {
	m, st, _, ws := newManager()
	m.runtime = &fakeRuntime{createErr: errors.New("boom")}
	if _, err := m.Spawn(ctx, ports.SpawnConfig{ProjectID: "mer"}); err == nil {
		t.Fatal("expected failure")
	}
	if ws.destroyed != 1 {
		t.Fatal("workspace should roll back")
	}
	if rec, present := st.sessions["mer-1"]; present {
		t.Fatalf("seed row must be deleted before a runtime handle is live, got %+v", rec)
	}
}

// TestSpawn_DeletesSeedRowOnWorkspaceFailure covers the failed-spawn cleanup:
// when workspace materialization fails (e.g. gitworktree refuses a branch
// checked out elsewhere), nothing observable was built, so the seed row is
// deleted outright rather than parked as a terminated orphan that clutters
// session lists.
func TestSpawn_DeletesSeedRowOnWorkspaceFailure(t *testing.T) {
	m, st, rt, ws := newManager()
	ws.createErr = ports.ErrWorkspaceBranchCheckedOutElsewhere
	_, err := m.Spawn(ctx, ports.SpawnConfig{ProjectID: "mer", Kind: domain.KindWorker})
	if !errors.Is(err, ports.ErrWorkspaceBranchCheckedOutElsewhere) {
		t.Fatalf("err = %v, want ports.ErrWorkspaceBranchCheckedOutElsewhere", err)
	}
	if rec, present := st.sessions["mer-1"]; present {
		t.Fatalf("seed row must be deleted, got %+v", rec)
	}
	if rt.created != 0 {
		t.Fatal("runtime.Create must not run when workspace materialization fails")
	}
}

// TestSpawn_ParksRowTerminatedWhenSeedDeleteFails asserts the fallback: if the
// seed-row delete itself fails, the failed spawn still parks the row as
// terminated so it never looks live.
func TestSpawn_ParksRowTerminatedWhenSeedDeleteFails(t *testing.T) {
	m, st, _, ws := newManager()
	ws.createErr = ports.ErrWorkspaceBranchNotFetched
	st.deleteErr = errors.New("db locked")
	if _, err := m.Spawn(ctx, ports.SpawnConfig{ProjectID: "mer", Kind: domain.KindWorker}); !errors.Is(err, ports.ErrWorkspaceBranchNotFetched) {
		t.Fatalf("err = %v, want ports.ErrWorkspaceBranchNotFetched", err)
	}
	if !st.sessions["mer-1"].IsTerminated {
		t.Fatal("row must fall back to terminated when the seed delete fails")
	}
}

func TestSpawn_WorkspaceProjectRecordsRootAndChildWorktrees(t *testing.T) {
	st := newFakeStore()
	projectPath := filepath.Join(string(filepath.Separator), "repo", "mer")
	managedPath := filepath.Join(string(filepath.Separator), "managed", "mer-1")
	st.projects["mer"] = domain.ProjectRecord{
		ID:     "mer",
		Path:   projectPath,
		Kind:   domain.ProjectKindWorkspace,
		Config: testRoleAgents(),
	}
	st.workspaceRepo["mer"] = []domain.WorkspaceRepoRecord{
		{Name: "api", RelativePath: "services/api"},
		{Name: "web", RelativePath: "apps/web"},
	}
	rt := &fakeRuntime{}
	ws := &fakeWorkspace{path: managedPath}
	m := New(Deps{
		Runtime: rt, Agents: fakeAgents{}, Workspace: ws, Store: st,
		Messenger: &fakeMessenger{}, Lifecycle: &fakeLCM{store: st},
		LookPath: func(string) (string, error) { return "/bin/true", nil },
	})

	rec, err := m.Spawn(ctx, ports.SpawnConfig{ProjectID: "mer", Kind: domain.KindWorker})
	if err != nil {
		t.Fatal(err)
	}
	if rec.Metadata.WorkspacePath != managedPath {
		t.Fatalf("workspace path = %q, want root worktree path", rec.Metadata.WorkspacePath)
	}
	if rec.Metadata.Branch != "ao/mer-1" {
		t.Fatalf("workspace branch = %q, want ao/mer-1", rec.Metadata.Branch)
	}
	if got := ws.lastProjectCfg.RootRepoPath; got != projectPath {
		t.Fatalf("root repo path = %q, want %q", got, projectPath)
	}
	if len(ws.lastProjectCfg.Repos) != 2 {
		t.Fatalf("child repo configs = %d, want 2", len(ws.lastProjectCfg.Repos))
	}
	if want := filepath.Join(projectPath, "services", "api"); ws.lastProjectCfg.Repos[0].RepoPath != want {
		t.Fatalf("api repo path = %q, want %q", ws.lastProjectCfg.Repos[0].RepoPath, want)
	}
	if want := filepath.Join(projectPath, "apps", "web"); ws.lastProjectCfg.Repos[1].RepoPath != want {
		t.Fatalf("web repo path = %q, want %q", ws.lastProjectCfg.Repos[1].RepoPath, want)
	}
	for _, repo := range ws.lastProjectCfg.Repos {
		if repo.BaseBranch != "" {
			t.Fatalf("child repo %s base branch = %q, want empty so adapter infers per-repo default", repo.Name, repo.BaseBranch)
		}
	}
	rows := st.worktrees["mer-1"]
	if len(rows) != 3 {
		t.Fatalf("session worktree rows = %d, want 3: %#v", len(rows), rows)
	}
	want := map[string]string{
		domain.RootWorkspaceRepoName: managedPath,
		"api":                        filepath.Join(managedPath, "services", "api"),
		"web":                        filepath.Join(managedPath, "apps", "web"),
	}
	for _, row := range rows {
		if row.Branch != rec.Metadata.Branch {
			t.Fatalf("row %s branch = %q, want %q", row.RepoName, row.Branch, rec.Metadata.Branch)
		}
		if want[row.RepoName] != row.WorktreePath {
			t.Fatalf("row %s path = %q, want %q", row.RepoName, row.WorktreePath, want[row.RepoName])
		}
		if row.BaseSHA == "" {
			t.Fatalf("row %s missing base sha", row.RepoName)
		}
	}
	if rt.created != 1 {
		t.Fatal("runtime should be created")
	}
	if ws.destroyed != 0 || ws.projectDestroyed != 0 {
		t.Fatal("successful spawn should not destroy workspaces")
	}
}

func TestSpawn_WorkspaceProjectRollsBackAllWorktreesOnRuntimeFailure(t *testing.T) {
	m, st, _, ws := newManager()
	st.projects["mer"] = domain.ProjectRecord{
		ID:     "mer",
		Path:   "/repo/mer",
		Kind:   domain.ProjectKindWorkspace,
		Config: testRoleAgents(),
	}
	st.workspaceRepo["mer"] = []domain.WorkspaceRepoRecord{{Name: "api", RelativePath: "api"}}
	m.runtime = &fakeRuntime{createErr: errors.New("boom")}
	if _, err := m.Spawn(ctx, ports.SpawnConfig{ProjectID: "mer", Kind: domain.KindWorker}); err == nil {
		t.Fatal("expected failure")
	}
	if ws.projectDestroyed != 1 {
		t.Fatalf("workspace project destroy calls = %d, want 1", ws.projectDestroyed)
	}
	if ws.destroyed != 0 {
		t.Fatalf("single-workspace destroy calls = %d, want 0", ws.destroyed)
	}
	if _, present := st.sessions["mer-1"]; present {
		t.Fatal("seed row should be deleted after runtime creation failure")
	}
}

func TestSpawn_WorkspaceProjectRollsBackWhenWorktreeRowsFail(t *testing.T) {
	m, st, rt, ws := newManager()
	st.projects["mer"] = domain.ProjectRecord{
		ID:     "mer",
		Path:   "/repo/mer",
		Kind:   domain.ProjectKindWorkspace,
		Config: testRoleAgents(),
	}
	st.workspaceRepo["mer"] = []domain.WorkspaceRepoRecord{{Name: "api", RelativePath: "api"}}
	st.upsertWTErr = errors.New("db locked")
	if _, err := m.Spawn(ctx, ports.SpawnConfig{ProjectID: "mer", Kind: domain.KindWorker}); err == nil || !strings.Contains(err.Error(), "record workspace worktree") {
		t.Fatalf("err = %v, want worktree row failure", err)
	}
	if ws.projectDestroyed != 1 {
		t.Fatalf("workspace project destroy calls = %d, want 1", ws.projectDestroyed)
	}
	if _, present := st.sessions["mer-1"]; present {
		t.Fatal("seed row should be deleted after workspace row failure")
	}
	if rt.created != 0 {
		t.Fatal("runtime.Create must not run when worktree row recording fails")
	}
}

func TestKill_TearsDownRuntimeAndWorkspace(t *testing.T) {
	m, st, rt, ws := newManager()
	st.sessions["mer-1"] = mkLive("mer-1")
	freed, err := m.Kill(ctx, "mer-1")
	if err != nil || !freed {
		t.Fatalf("freed=%v err=%v", freed, err)
	}
	if rt.destroyed != 1 || ws.destroyed != 1 {
		t.Fatal("kill should destroy runtime and workspace")
	}
}

// TestKill_TerminatesIncompleteHandle: a session whose runtime handle or
// workspace path is missing is still terminated — the destroy steps are
// skipped, but the session moves to terminal state so it can be cleaned up
// from the dashboard.
func TestKill_TerminatesIncompleteHandle(t *testing.T) {
	m, st, _, _ := newManager()
	st.sessions["mer-1"] = domain.SessionRecord{ID: "mer-1", ProjectID: "mer", Activity: domain.Activity{State: domain.ActivityActive}}
	freed, err := m.Kill(ctx, "mer-1")
	if err != nil {
		t.Fatalf("want nil error, got %v", err)
	}
	if freed {
		t.Fatal("freed = true, want false for session with no workspace")
	}
	if !st.sessions["mer-1"].IsTerminated {
		t.Fatal("session should be terminated even without a handle")
	}
	if got := st.sessions["mer-1"].TerminalFailureReason; got != "killed via session kill" {
		t.Fatalf("TerminalFailureReason = %q, want the explicit kill reason", got)
	}
}

// TestKill_AlreadyTerminatedRecordsNoReason: a cleanup-kill of a session that
// was ALREADY terminated (e.g. it exited cleanly hours ago and the operator is
// reclaiming its workspace) must not rewrite how it ended — only a kill of a
// live session records "killed via session kill".
func TestKill_AlreadyTerminatedRecordsNoReason(t *testing.T) {
	m, st, _, _ := newManager()
	rec := mkLive("mer-1")
	rec.IsTerminated = true
	rec.Activity = domain.Activity{State: domain.ActivityExited}
	st.sessions["mer-1"] = rec

	if _, err := m.Kill(ctx, "mer-1"); err != nil {
		t.Fatalf("kill: %v", err)
	}
	lcm := m.lcm.(*fakeLCM)
	if got := lcm.terminatedReason["mer-1"]; got != "" {
		t.Fatalf("kill of an already-terminated session passed reason %q, want empty (no history rewrite)", got)
	}
}

// TestKill_FailedTeardownCancelsIntent: a kill that errors before its final
// mark must void its declared termination intent, or a later unrelated crash
// would be misattributed to a kill that never completed.
func TestKill_FailedTeardownCancelsIntent(t *testing.T) {
	m, st, rt, _ := newManager()
	st.sessions["mer-1"] = mkLive("mer-1")
	rt.destroyErr = errors.New("tmux: server not responding")

	if _, err := m.Kill(ctx, "mer-1"); err == nil {
		t.Fatal("kill should surface the runtime destroy failure")
	}
	lcm := m.lcm.(*fakeLCM)
	if len(lcm.intents) != 0 {
		t.Fatalf("intents = %#v, want the abandoned kill's intent canceled", lcm.intents)
	}
	if lcm.canceledIntents != 1 {
		t.Fatalf("canceled intents = %d, want 1", lcm.canceledIntents)
	}
}

// TestKill_SuccessfulTeardownConsumesIntentWithoutCancel: the happy path's
// deferred cancel is a no-op because the final mark already consumed the token.
func TestKill_SuccessfulTeardownConsumesIntentWithoutCancel(t *testing.T) {
	m, st, _, _ := newManager()
	st.sessions["mer-1"] = mkLive("mer-1")

	if _, err := m.Kill(ctx, "mer-1"); err != nil {
		t.Fatalf("kill: %v", err)
	}
	lcm := m.lcm.(*fakeLCM)
	if len(lcm.intents) != 0 {
		t.Fatalf("intents = %#v, want consumed by the final mark", lcm.intents)
	}
	if lcm.canceledIntents != 0 {
		t.Fatalf("canceled intents = %d, want 0 (mark consumed the token)", lcm.canceledIntents)
	}
	if got := st.sessions["mer-1"].TerminalFailureReason; got != "killed via session kill" {
		t.Fatalf("TerminalFailureReason = %q, want the kill cause", got)
	}
}

// TestKill_DirtyWorkspacePreservesAndRemainsRetryable: a workspace teardown
// refused because of uncommitted work must NOT force-remove the worktree. Kill
// succeeds with freed=false and leaves the session non-terminal so a later retry
// can complete cleanup.
func TestKill_DirtyWorkspacePreservesAndRemainsRetryable(t *testing.T) {
	m, st, rt, ws := newManager()
	st.sessions["mer-1"] = mkLive("mer-1")
	ws.destroyErr = fmt.Errorf("gitworktree: refusing to remove: %w", ports.ErrWorkspaceDirty)
	freed, err := m.Kill(ctx, "mer-1")
	if err != nil {
		t.Fatalf("kill dirty workspace err = %v, want nil", err)
	}
	if freed {
		t.Fatal("freed = true, want false for preserved workspace")
	}
	if rt.destroyed != 1 {
		t.Fatal("runtime should be destroyed")
	}
	if st.sessions["mer-1"].IsTerminated {
		t.Fatal("session should remain active so cleanup can be retried")
	}
}

func TestKill_DeletesStaleRestoreMarker(t *testing.T) {
	m, st, _, _ := newManager()
	st.sessions["mer-1"] = mkLive("mer-1")
	st.worktrees["mer-1"] = []domain.SessionWorktreeRecord{
		{SessionID: "mer-1", RepoName: domain.RootWorkspaceRepoName, WorktreePath: "/tmp/wt"},
	}

	freed, err := m.Kill(ctx, "mer-1")
	if err != nil {
		t.Fatalf("Kill: %v", err)
	}
	if !freed {
		t.Fatal("Kill freed = false, want true")
	}
	if rows := st.worktrees["mer-1"]; len(rows) != 0 {
		t.Fatalf("stale restore marker = %+v, want deleted", rows)
	}
}

// TestKill_OtherWorkspaceErrorStillFails: only the typed dirty refusal is a
// success-with-preserved-workspace; any other teardown failure keeps erroring.
func TestKill_OtherWorkspaceErrorStillFails(t *testing.T) {
	m, st, _, ws := newManager()
	st.sessions["mer-1"] = mkLive("mer-1")
	ws.destroyErr = errors.New("disk on fire")
	if _, err := m.Kill(ctx, "mer-1"); err == nil || !strings.Contains(err.Error(), "disk on fire") {
		t.Fatalf("kill err = %v, want workspace error surfaced", err)
	}
}
func TestKill_WorkspaceProjectDestroysChildrenBeforeRoot(t *testing.T) {
	m, st, rt, ws := newManager()
	st.projects["mer"] = domain.ProjectRecord{ID: "mer", Path: "/repo/mer", Kind: domain.ProjectKindWorkspace, Config: testRoleAgents()}
	st.workspaceRepo["mer"] = []domain.WorkspaceRepoRecord{{Name: "api", RelativePath: "api"}}
	st.sessions["mer-1"] = domain.SessionRecord{
		ID:        "mer-1",
		ProjectID: "mer",
		Metadata:  domain.SessionMetadata{WorkspacePath: "/ws/mer-1", Branch: "ao/mer-1", RuntimeHandleID: "h1"},
		Activity:  domain.Activity{State: domain.ActivityActive},
	}
	st.worktrees["mer-1"] = []domain.SessionWorktreeRecord{
		{SessionID: "mer-1", RepoName: domain.RootWorkspaceRepoName, Branch: "ao/mer-1", WorktreePath: "/ws/mer-1"},
		{SessionID: "mer-1", RepoName: "api", Branch: "ao/mer-1", WorktreePath: "/ws/mer-1/api"},
	}

	freed, err := m.Kill(ctx, "mer-1")
	if err != nil || !freed {
		t.Fatalf("freed=%v err=%v", freed, err)
	}
	if rt.destroyed != 1 {
		t.Fatalf("runtime destroy calls = %d, want 1", rt.destroyed)
	}
	want := []string{"Destroy:api", "Destroy:__root__"}
	if got := ws.calls; strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("destroy order = %v, want %v", got, want)
	}
}

func TestKill_WorkspaceProjectFailsClosedOnUnregisteredChildRows(t *testing.T) {
	m, st, _, ws := newManager()
	st.projects["mer"] = domain.ProjectRecord{ID: "mer", Path: "/repo/mer", Kind: domain.ProjectKindWorkspace, Config: testRoleAgents()}
	st.workspaceRepo["mer"] = []domain.WorkspaceRepoRecord{{Name: "api", RelativePath: "api"}}
	st.sessions["mer-1"] = domain.SessionRecord{
		ID:        "mer-1",
		ProjectID: "mer",
		Metadata:  domain.SessionMetadata{WorkspacePath: "/ws/mer-1", Branch: "ao/mer-1", RuntimeHandleID: "h1"},
		Activity:  domain.Activity{State: domain.ActivityActive},
	}
	st.worktrees["mer-1"] = []domain.SessionWorktreeRecord{
		{SessionID: "mer-1", RepoName: domain.RootWorkspaceRepoName, Branch: "ao/mer-1", WorktreePath: "/ws/mer-1"},
		{SessionID: "mer-1", RepoName: "old-api", Branch: "ao/mer-1", WorktreePath: "/ws/mer-1/old-api"},
		{SessionID: "mer-1", RepoName: "api", Branch: "ao/mer-1", WorktreePath: "/ws/mer-1/api"},
	}

	freed, err := m.Kill(ctx, "mer-1")
	if err == nil || !strings.Contains(err.Error(), "old-api") {
		t.Fatalf("freed=%v err=%v, want unresolved historical row error", freed, err)
	}
	if freed {
		t.Fatal("workspace must not be reported freed when historical rows are unresolved")
	}
	if len(ws.calls) != 0 {
		t.Fatalf("destroy calls = %v, want none", ws.calls)
	}
	if st.sessions["mer-1"].IsTerminated {
		t.Fatal("session must remain active when workspace rows cannot be resolved")
	}
}

func TestKill_WorkspaceProjectDirtyRowRefusesRemoval(t *testing.T) {
	m, st, _, ws := newManager()
	ws.destroyErr = fmt.Errorf("dirty: %w", ports.ErrWorkspaceDirty)
	st.projects["mer"] = domain.ProjectRecord{ID: "mer", Path: "/repo/mer", Kind: domain.ProjectKindWorkspace, Config: testRoleAgents()}
	st.workspaceRepo["mer"] = []domain.WorkspaceRepoRecord{{Name: "api", RelativePath: "api"}}
	st.sessions["mer-1"] = domain.SessionRecord{
		ID:        "mer-1",
		ProjectID: "mer",
		Metadata:  domain.SessionMetadata{WorkspacePath: "/ws/mer-1", Branch: "ao/mer-1", RuntimeHandleID: "h1"},
		Activity:  domain.Activity{State: domain.ActivityActive},
	}
	st.worktrees["mer-1"] = []domain.SessionWorktreeRecord{
		{SessionID: "mer-1", RepoName: domain.RootWorkspaceRepoName, Branch: "ao/mer-1", WorktreePath: "/ws/mer-1"},
		{SessionID: "mer-1", RepoName: "api", Branch: "ao/mer-1", WorktreePath: "/ws/mer-1/api"},
	}

	freed, err := m.Kill(ctx, "mer-1")
	if err != nil || freed {
		t.Fatalf("freed=%v err=%v, want dirty row to preserve workspace", freed, err)
	}
	want := []string{"Destroy:api"}
	if got := ws.calls; strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("calls = %v, want %v", got, want)
	}
	if st.sessions["mer-1"].IsTerminated {
		t.Fatal("session should remain active so dirty workspace cleanup can be retried")
	}
}

func TestKill_RuntimeDestroyFailureLeavesSessionActive(t *testing.T) {
	m, st, rt, ws := newManager()
	rt.destroyErr = errors.New("tmux transient")
	st.sessions["mer-1"] = mkLive("mer-1")

	freed, err := m.Kill(ctx, "mer-1")
	if err == nil || !strings.Contains(err.Error(), "runtime") {
		t.Fatalf("freed=%v err=%v, want runtime error", freed, err)
	}
	if freed {
		t.Fatal("workspace must not be reported freed when runtime destroy fails")
	}
	if st.sessions["mer-1"].IsTerminated {
		t.Fatal("session must remain active when runtime destroy fails")
	}
	if ws.destroyed != 0 {
		t.Fatalf("workspace destroy calls = %d, want 0 after runtime failure", ws.destroyed)
	}
}

func TestRestore_ReopensTerminal(t *testing.T) {
	m, st, rt, _ := newManager()
	seedTerminal(st, "mer-1", domain.SessionMetadata{WorkspacePath: "/ws/mer-1", Branch: "b", AgentSessionID: "agent-x"})
	s, err := m.Restore(ctx, "mer-1")
	if err != nil {
		t.Fatal(err)
	}
	if s.Activity.State != domain.ActivityIdle {
		t.Fatalf("restored records idle, got %q", s.Activity.State)
	}
	if rt.created != 1 {
		t.Fatal("restore should relaunch")
	}
}

func TestRestore_UsesPersistedWorkspacePathAfterProjectPrefixChange(t *testing.T) {
	m, st, _, ws := newManager()
	st.projects["mer"] = domain.ProjectRecord{ID: "mer", Config: domain.ProjectConfig{
		ProjectPrefix: "new",
		Orchestrator:  domain.RoleOverride{Harness: domain.HarnessClaudeCode},
	}}
	oldPath := "/ws/mer/orchestrator/old-orchestrator"
	st.sessions["mer-orch"] = domain.SessionRecord{
		ID:           "mer-orch",
		ProjectID:    "mer",
		Kind:         domain.KindOrchestrator,
		Harness:      domain.HarnessClaudeCode,
		Metadata:     domain.SessionMetadata{WorkspacePath: oldPath, Branch: "ao/mer-orchestrator", AgentSessionID: "agent-x"},
		IsTerminated: true,
		Activity:     domain.Activity{State: domain.ActivityExited},
	}

	if _, err := m.Restore(ctx, "mer-orch"); err != nil {
		t.Fatal(err)
	}
	if ws.lastCfg.RestorePath != oldPath {
		t.Fatalf("restore path = %q, want persisted path %q", ws.lastCfg.RestorePath, oldPath)
	}
	if ws.lastCfg.SessionPrefix != "new" {
		t.Fatalf("session prefix = %q, want current display prefix new", ws.lastCfg.SessionPrefix)
	}
}

func TestRestore_AppliesProjectAgentConfig(t *testing.T) {
	st := newFakeStore()
	st.projects["mer"] = domain.ProjectRecord{ID: "mer", Config: domain.ProjectConfig{AgentConfig: domain.AgentConfig{Model: "restore-model"}}}
	seedTerminal(st, "mer-1", domain.SessionMetadata{WorkspacePath: "/ws/mer-1", Branch: "b", AgentSessionID: "agent-x"})
	agent := &recordingAgent{}
	lookPath := func(string) (string, error) { return "/bin/true", nil }
	m := New(Deps{Runtime: &fakeRuntime{}, Agents: singleAgent{agent: agent}, Workspace: &fakeWorkspace{}, Store: st, Messenger: &fakeMessenger{}, Lifecycle: &fakeLCM{store: st}, LookPath: lookPath})

	if _, err := m.Restore(ctx, "mer-1"); err != nil {
		t.Fatal(err)
	}
	if agent.lastConfig.Model != "restore-model" {
		t.Fatalf("restore config model = %q, want restore-model (config must carry across restore)", agent.lastConfig.Model)
	}
}

func TestRestore_AppliesPerSessionModelOverride(t *testing.T) {
	st := newFakeStore()
	st.projects["mer"] = domain.ProjectRecord{ID: "mer", Config: domain.ProjectConfig{
		AgentConfig: domain.AgentConfig{Model: "project-model"},
		Worker:      domain.RoleOverride{AgentConfig: domain.AgentConfig{Model: "worker-model"}},
	}}
	seedTerminal(st, "mer-1", domain.SessionMetadata{
		WorkspacePath:  "/ws/mer-1",
		Branch:         "b",
		AgentSessionID: "agent-x",
		Model:          "spawn-model",
	})
	agent := &recordingAgent{}
	m := New(Deps{Runtime: &fakeRuntime{}, Agents: singleAgent{agent: agent}, Workspace: &fakeWorkspace{}, Store: st, Messenger: &fakeMessenger{}, Lifecycle: &fakeLCM{store: st}, LookPath: func(string) (string, error) { return "/bin/true", nil }})

	if _, err := m.Restore(ctx, "mer-1"); err != nil {
		t.Fatal(err)
	}
	if agent.lastConfig.Model != "spawn-model" {
		t.Fatalf("restore config model = %q, want per-session spawn-model", agent.lastConfig.Model)
	}
	if st.sessions["mer-1"].Metadata.Model != "spawn-model" {
		t.Fatalf("restored metadata model = %q, want spawn-model", st.sessions["mer-1"].Metadata.Model)
	}
}

func TestRestore_RefusesLiveSession(t *testing.T) {
	m, st, _, _ := newManager()
	st.sessions["mer-1"] = mkLive("mer-1")
	if _, err := m.Restore(ctx, "mer-1"); !errors.Is(err, ErrNotRestorable) {
		t.Fatalf("want ErrNotRestorable, got %v", err)
	}
}
func TestCleanup_ReclaimsTerminalWorkspaces(t *testing.T) {
	m, st, _, ws := newManager()
	seedTerminal(st, "mer-1", domain.SessionMetadata{WorkspacePath: "/ws/mer-1"})
	st.sessions["mer-2"] = mkLive("mer-2")
	res, err := m.Cleanup(ctx, "mer")
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Cleaned) != 1 || res.Cleaned[0] != "mer-1" {
		t.Fatalf("got %v", res.Cleaned)
	}
	if len(res.Skipped) != 0 {
		t.Fatalf("skipped = %v, want none", res.Skipped)
	}
	if ws.destroyed != 1 {
		t.Fatal("live workspace must not be destroyed")
	}
}

// TestCleanup_SkipsWorkspaceStillReferencedByLiveSession: a terminated
// session's workspace must NOT be reclaimed while a live (non-terminated)
// session references the same path. Persistent/shared worktrees (the
// orchestrator's) are reused across respawn, so a terminated predecessor and
// a live successor can share one path — reclaiming it deletes the live
// session's cwd out from under it.
func TestCleanup_SkipsWorkspaceStillReferencedByLiveSession(t *testing.T) {
	m, st, rt, ws := newManager()
	// Terminated predecessor and live successor share one persistent worktree.
	// The predecessor keeps its OWN runtime handle (independent of the shared
	// workspace and of the successor's handle).
	seedTerminal(st, "mer-1", domain.SessionMetadata{WorkspacePath: "/ws/shared", RuntimeHandleID: "mer-1-runtime"})
	live := mkLive("mer-2")
	live.Metadata.WorkspacePath = "/ws/shared"
	st.sessions["mer-2"] = live

	res, err := m.Cleanup(ctx, "mer")
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Cleaned) != 0 {
		t.Fatalf("cleaned = %v, want none (path still in use by live session)", res.Cleaned)
	}
	if len(res.Skipped) != 1 || res.Skipped[0].SessionID != "mer-1" {
		t.Fatalf("skipped = %v, want mer-1", res.Skipped)
	}
	if res.Skipped[0].Reason != "workspace in use by a live session" {
		t.Fatalf("reason = %q", res.Skipped[0].Reason)
	}
	if ws.destroyed != 0 {
		t.Fatalf("destroyed = %d, want 0 — shared live workspace must not be torn down", ws.destroyed)
	}
	// The workspace is preserved, but the predecessor's own runtime must still be
	// reclaimed — keying the skip on the workspace path must not leak its runtime.
	if rt.destroyed != 1 || len(rt.destroyedIDs) != 1 || rt.destroyedIDs[0] != "mer-1-runtime" {
		t.Fatalf("runtime destroyed = %d ids=%v, want the skipped session's own handle torn down", rt.destroyed, rt.destroyedIDs)
	}
}

// TestCleanup_LiveWorkspaceGuardNormalizesPaths: the shared-path guard must
// compare canonicalized paths, so a trailing slash or "." segment on one
// record doesn't let a live session's worktree slip through as "not shared".
func TestCleanup_LiveWorkspaceGuardNormalizesPaths(t *testing.T) {
	m, st, _, ws := newManager()
	seedTerminal(st, "mer-1", domain.SessionMetadata{WorkspacePath: "/ws/shared/"})
	live := mkLive("mer-2")
	live.Metadata.WorkspacePath = "/ws/./shared"
	st.sessions["mer-2"] = live

	res, err := m.Cleanup(ctx, "mer")
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Cleaned) != 0 || len(res.Skipped) != 1 || res.Skipped[0].SessionID != "mer-1" {
		t.Fatalf("cleaned = %v, skipped = %v; want mer-1 skipped, none cleaned", res.Cleaned, res.Skipped)
	}
	if ws.destroyed != 0 {
		t.Fatalf("destroyed = %d, want 0", ws.destroyed)
	}
}

// TestCleanup_ReclaimsUnsharedWhileSkippingShared: a shared-path skip must not
// stop cleanup from reclaiming an adjacent terminated workspace that no live
// session references. The orchestrator's persistent worktree (shared across
// respawn) is the motivating case for the skip.
func TestCleanup_ReclaimsUnsharedWhileSkippingShared(t *testing.T) {
	m, st, _, ws := newManager()
	// Terminated orchestrator predecessor shares its persistent worktree with
	// the live orchestrator successor.
	orchTerm := domain.SessionRecord{ID: "mer-orch-1", ProjectID: "mer", Kind: domain.KindOrchestrator, Metadata: domain.SessionMetadata{WorkspacePath: "/ws/orchestrator"}, IsTerminated: true, Activity: domain.Activity{State: domain.ActivityExited}}
	st.sessions["mer-orch-1"] = orchTerm
	orchLive := domain.SessionRecord{ID: "mer-orch-2", ProjectID: "mer", Kind: domain.KindOrchestrator, Metadata: domain.SessionMetadata{WorkspacePath: "/ws/orchestrator"}, Activity: domain.Activity{State: domain.ActivityActive}}
	st.sessions["mer-orch-2"] = orchLive
	// An unrelated terminated worker whose workspace nobody else uses.
	seedTerminal(st, "mer-3", domain.SessionMetadata{WorkspacePath: "/ws/mer-3"})

	res, err := m.Cleanup(ctx, "mer")
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Cleaned) != 1 || res.Cleaned[0] != "mer-3" {
		t.Fatalf("cleaned = %v, want [mer-3]", res.Cleaned)
	}
	if len(res.Skipped) != 1 || res.Skipped[0].SessionID != "mer-orch-1" {
		t.Fatalf("skipped = %v, want mer-orch-1", res.Skipped)
	}
	if ws.destroyed != 1 {
		t.Fatalf("destroyed = %d, want 1 (only the unshared worker workspace)", ws.destroyed)
	}
}

// TestCleanup_ReportsSkippedWorkspaces: a refused teardown must be visible in
// the result with a reason — a silent skip leaves users staring at
// "Would clean N … 0 sessions cleaned" with no explanation.
func TestCleanup_ReportsSkippedWorkspaces(t *testing.T) {
	m, st, _, ws := newManager()
	seedTerminal(st, "mer-1", domain.SessionMetadata{WorkspacePath: "/ws/mer-1"})
	ws.destroyErr = fmt.Errorf("gitworktree: refusing to remove: %w", ports.ErrWorkspaceDirty)
	res, err := m.Cleanup(ctx, "mer")
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Cleaned) != 0 {
		t.Fatalf("cleaned = %v, want none", res.Cleaned)
	}
	if len(res.Skipped) != 1 || res.Skipped[0].SessionID != "mer-1" {
		t.Fatalf("skipped = %v, want mer-1", res.Skipped)
	}
	if res.Skipped[0].Reason != "workspace has uncommitted changes" {
		t.Fatalf("reason = %q", res.Skipped[0].Reason)
	}

	// A non-dirty teardown failure is reported too — but with a fixed public
	// reason: the raw cause carries internal filesystem paths and belongs in
	// the server log, not the API response.
	ws.destroyErr = errors.New("disk on fire")
	res, err = m.Cleanup(ctx, "mer")
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Skipped) != 1 || res.Skipped[0].Reason != "workspace teardown failed" {
		t.Fatalf("skipped = %v, want fixed teardown-failed reason", res.Skipped)
	}
	if strings.Contains(res.Skipped[0].Reason, "disk on fire") {
		t.Fatalf("raw internal error leaked into public reason: %q", res.Skipped[0].Reason)
	}
}

func TestCleanup_WorkspaceProjectDestroysChildrenBeforeRoot(t *testing.T) {
	m, st, _, ws := newManager()
	st.projects["mer"] = domain.ProjectRecord{ID: "mer", Path: "/repo/mer", Kind: domain.ProjectKindWorkspace, Config: testRoleAgents()}
	st.workspaceRepo["mer"] = []domain.WorkspaceRepoRecord{{Name: "api", RelativePath: "api"}}
	seedTerminal(st, "mer-1", domain.SessionMetadata{WorkspacePath: "/ws/mer-1", Branch: "ao/mer-1"})
	st.worktrees["mer-1"] = []domain.SessionWorktreeRecord{
		{SessionID: "mer-1", RepoName: domain.RootWorkspaceRepoName, Branch: "ao/mer-1", WorktreePath: "/ws/mer-1"},
		{SessionID: "mer-1", RepoName: "api", Branch: "ao/mer-1", WorktreePath: "/ws/mer-1/api"},
	}

	res, err := m.Cleanup(ctx, "mer")
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Cleaned) != 1 || res.Cleaned[0] != "mer-1" {
		t.Fatalf("cleaned = %v, want mer-1", res.Cleaned)
	}
	want := []string{"Destroy:api", "Destroy:__root__"}
	if got := ws.calls; strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("destroy order = %v, want %v", got, want)
	}
}

func TestCleanup_WorkspaceProjectMarksRetryRemoveAfterTeardownFailure(t *testing.T) {
	m, st, _, ws := newManager()
	ws.destroyErr = errors.New("locked")
	st.projects["mer"] = domain.ProjectRecord{ID: "mer", Path: "/repo/mer", Kind: domain.ProjectKindWorkspace, Config: testRoleAgents()}
	st.workspaceRepo["mer"] = []domain.WorkspaceRepoRecord{{Name: "api", RelativePath: "api"}}
	seedTerminal(st, "mer-1", domain.SessionMetadata{WorkspacePath: "/ws/mer-1", Branch: "ao/mer-1"})
	st.worktrees["mer-1"] = []domain.SessionWorktreeRecord{
		{SessionID: "mer-1", RepoName: domain.RootWorkspaceRepoName, Branch: "ao/mer-1", WorktreePath: "/ws/mer-1"},
		{SessionID: "mer-1", RepoName: "api", Branch: "ao/mer-1", WorktreePath: "/ws/mer-1/api"},
	}

	res, err := m.Cleanup(ctx, "mer")
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Cleaned) != 0 || len(res.Skipped) != 1 {
		t.Fatalf("cleanup result = %+v, want one skipped session", res)
	}
	states := map[string]string{}
	for _, row := range st.worktrees["mer-1"] {
		states[row.RepoName] = row.State
	}
	if states["api"] != "retry_remove" || states[domain.RootWorkspaceRepoName] != "retry_remove" {
		t.Fatalf("states = %v, want retry_remove rows", states)
	}
}

func TestCleanup_WorkspaceProjectDirtyRowsAreSkipped(t *testing.T) {
	m, st, _, ws := newManager()
	ws.destroyErr = fmt.Errorf("dirty: %w", ports.ErrWorkspaceDirty)
	st.projects["mer"] = domain.ProjectRecord{ID: "mer", Path: "/repo/mer", Kind: domain.ProjectKindWorkspace, Config: testRoleAgents()}
	st.workspaceRepo["mer"] = []domain.WorkspaceRepoRecord{{Name: "api", RelativePath: "api"}}
	seedTerminal(st, "mer-1", domain.SessionMetadata{WorkspacePath: "/ws/mer-1", Branch: "ao/mer-1"})
	st.worktrees["mer-1"] = []domain.SessionWorktreeRecord{
		{SessionID: "mer-1", RepoName: domain.RootWorkspaceRepoName, Branch: "ao/mer-1", WorktreePath: "/ws/mer-1"},
		{SessionID: "mer-1", RepoName: "api", Branch: "ao/mer-1", WorktreePath: "/ws/mer-1/api"},
	}

	res, err := m.Cleanup(ctx, "mer")
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Skipped) != 1 {
		t.Fatalf("cleanup result = %+v, want one skipped session", res)
	}
	refs := map[string]string{}
	states := map[string]string{}
	for _, row := range st.worktrees["mer-1"] {
		refs[row.RepoName] = row.PreservedRef
		states[row.RepoName] = row.State
	}
	if states["api"] != "" || refs["api"] != "" {
		t.Fatalf("api state/ref = %q/%q, want unchanged dirty row", states["api"], refs["api"])
	}
}

func TestSpawn_DefaultsBranchFromSessionID(t *testing.T) {
	m, st, _, _ := newManager()
	s, err := m.Spawn(ctx, ports.SpawnConfig{ProjectID: "mer", Kind: domain.KindWorker})
	if err != nil {
		t.Fatal(err)
	}
	// An empty SpawnConfig.Branch defaults to a unique per-session root branch
	// under a namespace that can also hold sibling PR branches.
	if got := st.sessions[s.ID].Metadata.Branch; got != "ao/mer-1/root" {
		t.Fatalf("default branch = %q, want ao/mer-1/root", got)
	}
}

func TestSpawn_ForwardsResolvedAgentConfigPermissions(t *testing.T) {
	st := newFakeStore()
	st.projects["mer"] = domain.ProjectRecord{ID: "mer", Config: domain.ProjectConfig{
		AgentConfig: domain.AgentConfig{Permissions: domain.PermissionModeAuto},
		Worker: domain.RoleOverride{
			Harness:     domain.HarnessClaudeCode,
			AgentConfig: domain.AgentConfig{Permissions: domain.PermissionModeBypassPermissions},
		},
	}}
	agent := &recordingAgent{}
	lookPath := func(string) (string, error) { return "/bin/true", nil }
	m := New(Deps{Runtime: &fakeRuntime{}, Agents: singleAgent{agent: agent}, Workspace: &fakeWorkspace{}, Store: st, Messenger: &fakeMessenger{}, Lifecycle: &fakeLCM{store: st}, LookPath: lookPath})

	_, err := m.Spawn(ctx, ports.SpawnConfig{ProjectID: "mer", Kind: domain.KindWorker})
	if err != nil {
		t.Fatal(err)
	}

	if agent.lastLaunch.Config.Permissions != domain.PermissionModeBypassPermissions {
		t.Fatalf("launch config permissions = %q, want bypass", agent.lastLaunch.Config.Permissions)
	}
	if agent.lastLaunch.Permissions != domain.PermissionModeBypassPermissions {
		t.Fatalf("launch permissions = %q, want bypass", agent.lastLaunch.Permissions)
	}
}

func TestRestore_ForwardsResolvedAgentConfigPermissions(t *testing.T) {
	st := newFakeStore()
	st.projects["mer"] = domain.ProjectRecord{ID: "mer", Config: domain.ProjectConfig{
		AgentConfig: domain.AgentConfig{Permissions: domain.PermissionModeBypassPermissions},
	}}
	st.sessions["mer-1"] = domain.SessionRecord{
		ID:           "mer-1",
		ProjectID:    "mer",
		Kind:         domain.KindWorker,
		IsTerminated: true,
		Metadata:     domain.SessionMetadata{Branch: "ao/mer-1", WorkspacePath: "/tmp/ws", AgentSessionID: "native-1"},
	}
	agent := &recordingAgent{}
	m := New(Deps{Runtime: &fakeRuntime{}, Agents: singleAgent{agent: agent}, Workspace: &fakeWorkspace{}, Store: st, Messenger: &fakeMessenger{}, Lifecycle: &fakeLCM{store: st}, LookPath: func(string) (string, error) { return "/bin/true", nil }})

	_, err := m.Restore(ctx, "mer-1")
	if err != nil {
		t.Fatal(err)
	}

	if agent.lastRestore.Config.Permissions != domain.PermissionModeBypassPermissions {
		t.Fatalf("restore config permissions = %q, want bypass", agent.lastRestore.Config.Permissions)
	}
	if agent.lastRestore.Permissions != domain.PermissionModeBypassPermissions {
		t.Fatalf("restore permissions = %q, want bypass", agent.lastRestore.Permissions)
	}
}

func TestSpawnWorker_AppendsActiveOrchestratorContact(t *testing.T) {
	st := newFakeStore()
	st.projects["mer"] = domain.ProjectRecord{ID: "mer", Config: testRoleAgents()}
	st.num = 1
	st.sessions["mer-1"] = domain.SessionRecord{ID: "mer-1", ProjectID: "mer", Kind: domain.KindOrchestrator}
	agent := &recordingAgent{}
	rt := &fakeRuntime{}
	ws := &fakeWorkspace{}
	lookPath := func(string) (string, error) { return "/bin/true", nil }
	m := New(Deps{Runtime: rt, Agents: singleAgent{agent: agent}, Workspace: ws, Store: st, Messenger: &fakeMessenger{}, Lifecycle: &fakeLCM{store: st}, LookPath: lookPath})

	s, err := m.Spawn(ctx, ports.SpawnConfig{ProjectID: "mer", Kind: domain.KindWorker, Prompt: "do it"})
	if err != nil {
		t.Fatal(err)
	}

	// The user prompt must be preserved and stored in metadata as-is.
	if got := st.sessions[s.ID].Metadata.Prompt; got != "do it" {
		t.Fatalf("metadata prompt = %q, want %q", got, "do it")
	}

	// Coordination instructions must be in the system prompt, not the user prompt.
	systemPrompt := agent.lastLaunch.SystemPrompt
	for _, want := range []string{
		"## Orc coordination",
		`ao send --session mer-1 --message "<your message>"`,
		"Only ping the Orc for true blockers, cross-session coordination",
	} {
		if !strings.Contains(systemPrompt, want) {
			t.Fatalf("system prompt missing %q:\n%s", want, systemPrompt)
		}
	}
	if strings.Contains(agent.lastLaunch.Prompt, "## Orc coordination") {
		t.Fatalf("Orc coordination must not be in the user prompt:\n%s", agent.lastLaunch.Prompt)
	}
}

func TestSpawnWorker_SkipsTerminatedOrchestratorContact(t *testing.T) {
	st := newFakeStore()
	st.projects["mer"] = domain.ProjectRecord{ID: "mer", Config: testRoleAgents()}
	st.num = 1
	st.sessions["mer-1"] = domain.SessionRecord{ID: "mer-1", ProjectID: "mer", Kind: domain.KindOrchestrator, IsTerminated: true}
	agent := &recordingAgent{}
	rt := &fakeRuntime{}
	ws := &fakeWorkspace{}
	lookPath := func(string) (string, error) { return "/bin/true", nil }
	m := New(Deps{Runtime: rt, Agents: singleAgent{agent: agent}, Workspace: ws, Store: st, Messenger: &fakeMessenger{}, Lifecycle: &fakeLCM{store: st}, LookPath: lookPath})

	_, err := m.Spawn(ctx, ports.SpawnConfig{ProjectID: "mer", Kind: domain.KindWorker, Prompt: "do it"})
	if err != nil {
		t.Fatal(err)
	}
	systemPrompt := agent.lastLaunch.SystemPrompt
	if strings.Contains(systemPrompt, "## Orc coordination") || strings.Contains(systemPrompt, "ao send --session mer-1") {
		t.Fatalf("terminated Orc should not be added to system prompt:\n%s", systemPrompt)
	}
}

func TestSpawnOrchestrator_UsesCoordinatorPrompt(t *testing.T) {
	st := newFakeStore()
	st.projects["mer"] = domain.ProjectRecord{ID: "mer", Config: testRoleAgents()}
	agent := &recordingAgent{}
	rt := &fakeRuntime{}
	ws := &fakeWorkspace{}
	lookPath := func(string) (string, error) { return "/bin/true", nil }
	m := New(Deps{Runtime: rt, Agents: singleAgent{agent: agent}, Workspace: ws, Store: st, Messenger: &fakeMessenger{}, Lifecycle: &fakeLCM{store: st}, LookPath: lookPath})

	_, err := m.Spawn(ctx, ports.SpawnConfig{ProjectID: "mer", Kind: domain.KindOrchestrator})
	if err != nil {
		t.Fatal(err)
	}

	// Coordinator instructions must be in the system prompt, not the user prompt.
	systemPrompt := agent.lastLaunch.SystemPrompt
	for _, want := range []string{
		"You are the project Orc for mer",
		"supervisor for this project's human-authorized work",
		"Assignment is the authorization boundary",
		"must not create, label, assign, or dispatch a proposed ticket",
		"explicitly tells you to `/capture`",
		"Do not race tracker intake by manually dispatching ordinary queued work",
		"`ao send`",
		"`ao --help`",
		"Do not maintain a target worker occupancy",
	} {
		if !strings.Contains(systemPrompt, want) {
			t.Fatalf("system prompt missing %q:\n%s", want, systemPrompt)
		}
	}
	for _, forbidden := range []string{"file it as an issue first", "ao spawn --project", "Standing-instruction confidentiality"} {
		if strings.Contains(systemPrompt, forbidden) {
			t.Fatalf("system prompt contains forbidden autonomous-work guidance %q:\n%s", forbidden, systemPrompt)
		}
	}
	if strings.Contains(agent.lastLaunch.Prompt, "human-facing coordinator for this project") {
		t.Fatalf("coordinator role must not be in the user prompt:\n%s", agent.lastLaunch.Prompt)
	}

	// The role remains in the system prompt, but the daemon must also send an
	// initial user turn so a newly spawned Orc starts supervising.
	if !strings.Contains(agent.lastLaunch.Prompt, "Read your standing policy") {
		t.Fatalf("prompt = %q, want kickoff instructing policy read", agent.lastLaunch.Prompt)
	}
	if !strings.Contains(agent.lastLaunch.Prompt, "begin your supervision loop") {
		t.Fatalf("prompt = %q, want supervision-loop kickoff", agent.lastLaunch.Prompt)
	}
}

func TestSpawnOrchestrator_DeliversKickoffAfterStart(t *testing.T) {
	st := newFakeStore()
	st.projects["mer"] = domain.ProjectRecord{ID: "mer", Config: testRoleAgents()}
	agent := &afterStartTitleAgent{}
	rt := &fakeRuntime{blankReads: 2}
	lookPath := func(string) (string, error) { return "/bin/true", nil }
	m := New(Deps{Runtime: rt, Agents: singleAgent{agent: agent}, Workspace: &fakeWorkspace{}, Store: st, Messenger: &fakeMessenger{}, Lifecycle: &fakeLCM{store: st}, LookPath: lookPath})

	if _, err := m.Spawn(ctx, ports.SpawnConfig{ProjectID: "mer", Kind: domain.KindOrchestrator}); err != nil {
		t.Fatal(err)
	}

	var found bool
	for _, msg := range rt.sent {
		if strings.Contains(msg, "Read your standing policy") && strings.Contains(msg, "begin your supervision loop") {
			found = true
		}
	}
	if !found {
		t.Fatalf("runtime sends = %#v, want kickoff delivered after pane readiness", rt.sent)
	}
	if len(rt.getOutputCallsAtSend) == 0 || rt.getOutputCallsAtSend[len(rt.getOutputCallsAtSend)-1] < 3 {
		t.Fatalf("kickoff must wait for pane readiness, output calls at send = %v", rt.getOutputCallsAtSend)
	}
}

func TestSpawnPrime_UsesFleetSupervisorPrompt(t *testing.T) {
	st := newFakeStore()
	st.projects["ao"] = domain.ProjectRecord{ID: "ao", Config: domain.ProjectConfig{Prime: domain.RoleOverride{Harness: domain.HarnessClaudeCode}}}
	agent := &recordingAgent{}
	rt := &fakeRuntime{}
	ws := &fakeWorkspace{}
	lookPath := func(string) (string, error) { return "/bin/true", nil }
	m := New(Deps{Runtime: rt, Agents: singleAgent{agent: agent}, Workspace: ws, Store: st, Messenger: &fakeMessenger{}, Lifecycle: &fakeLCM{store: st}, LookPath: lookPath})

	_, err := m.Spawn(ctx, ports.SpawnConfig{ProjectID: "ao", Kind: domain.KindPrime})
	if err != nil {
		t.Fatal(err)
	}

	systemPrompt := agent.lastLaunch.SystemPrompt
	for _, want := range []string{
		"You are the prime Orc for the AO fleet",
		"supervisor of supervisors",
		"recommend a capture with a proposed title, rationale, and scope",
		"must not create, label, assign, or dispatch tickets",
		"Do not implement, merge, or mutate project configuration",
		"`/api/v1/metrics`",
		"project Orcs",
	} {
		if !strings.Contains(systemPrompt, want) {
			t.Fatalf("prime system prompt missing %q:\n%s", want, systemPrompt)
		}
	}
	for _, forbidden := range []string{"file tickets", "file an ao issue", "Standing-instruction confidentiality"} {
		if strings.Contains(systemPrompt, forbidden) {
			t.Fatalf("prime system prompt contains forbidden guidance %q:\n%s", forbidden, systemPrompt)
		}
	}
	if strings.Contains(agent.lastLaunch.Prompt, "You are the prime Orc") {
		t.Fatalf("prime role must not be in the user prompt:\n%s", agent.lastLaunch.Prompt)
	}
	if !strings.Contains(agent.lastLaunch.Prompt, "Read your standing prime policy") {
		t.Fatalf("prompt = %q, want prime policy kickoff", agent.lastLaunch.Prompt)
	}
	if !strings.Contains(agent.lastLaunch.Prompt, "begin your fleet supervision loop") {
		t.Fatalf("prompt = %q, want fleet supervision kickoff", agent.lastLaunch.Prompt)
	}
}

func TestSystemPrompt_AppendsRoleInstructionsFile(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, ".claude"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, ".claude", "orchestrator-policy.md"), []byte("ORCHESTRATOR ONLY\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, ".claude", "worker-policy.md"), []byte("WORKER ONLY\r\n\r\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, ".claude", "prime-orchestrator-policy.md"), []byte("PRIME ONLY\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	st := newFakeStore()
	st.projects["mer"] = domain.ProjectRecord{
		ID:   "mer",
		Path: root,
		Config: domain.ProjectConfig{
			Worker:       domain.RoleOverride{InstructionsFile: ".claude/worker-policy.md"},
			Orchestrator: domain.RoleOverride{InstructionsFile: ".claude/orchestrator-policy.md"},
			Prime:        domain.RoleOverride{InstructionsFile: ".claude/prime-orchestrator-policy.md"},
		},
	}
	lookPath := func(string) (string, error) { return "/bin/true", nil }
	m := New(Deps{Runtime: &fakeRuntime{}, Agents: singleAgent{agent: &recordingAgent{}}, Workspace: &fakeWorkspace{}, Store: st, Messenger: &fakeMessenger{}, Lifecycle: &fakeLCM{store: st}, LookPath: lookPath})

	orchPrompt, err := m.buildSystemPrompt(ctx, domain.KindOrchestrator, "mer")
	if err != nil {
		t.Fatalf("orchestrator buildSystemPrompt: %v", err)
	}
	if !strings.Contains(orchPrompt, "ORCHESTRATOR ONLY") || strings.Contains(orchPrompt, "WORKER ONLY") {
		t.Fatalf("orchestrator prompt role file mismatch:\n%s", orchPrompt)
	}
	if strings.Contains(orchPrompt, "Standing-instruction confidentiality") {
		t.Fatalf("orchestrator prompt must be operator-reviewable:\n%s", orchPrompt)
	}

	workerPrompt, err := m.buildSystemPrompt(ctx, domain.KindWorker, "mer")
	if err != nil {
		t.Fatalf("worker buildSystemPrompt: %v", err)
	}
	if !strings.Contains(workerPrompt, "WORKER ONLY") || strings.Contains(workerPrompt, "ORCHESTRATOR ONLY") {
		t.Fatalf("worker prompt role file mismatch:\n%s", workerPrompt)
	}
	if strings.Contains(workerPrompt, "WORKER ONLY\n\n\n") {
		t.Fatalf("worker prompt should trim trailing file newlines:\n%s", workerPrompt)
	}
	if strings.Contains(workerPrompt, "WORKER ONLY\r") {
		t.Fatalf("worker prompt should trim trailing CRLF newlines:\n%s", workerPrompt)
	}

	primePrompt, err := m.buildSystemPrompt(ctx, domain.KindPrime, "mer")
	if err != nil {
		t.Fatalf("prime buildSystemPrompt: %v", err)
	}
	if !strings.Contains(primePrompt, "PRIME ONLY") || strings.Contains(primePrompt, "ORCHESTRATOR ONLY") || strings.Contains(primePrompt, "WORKER ONLY") {
		t.Fatalf("prime prompt role file mismatch:\n%s", primePrompt)
	}
	if strings.Contains(primePrompt, "Standing-instruction confidentiality") {
		t.Fatalf("prime prompt must be operator-reviewable:\n%s", primePrompt)
	}
}

func TestSystemPrompt_MissingConfiguredRoleInstructionsFileBlocksSpawn(t *testing.T) {
	st := newFakeStore()
	st.projects["mer"] = domain.ProjectRecord{
		ID:     "mer",
		Path:   t.TempDir(),
		Config: domain.ProjectConfig{Orchestrator: domain.RoleOverride{InstructionsFile: ".claude/missing.md"}},
	}
	agent := &recordingAgent{}
	lookPath := func(string) (string, error) { return "/bin/true", nil }
	m := New(Deps{Runtime: &fakeRuntime{}, Agents: singleAgent{agent: agent}, Workspace: &fakeWorkspace{}, Store: st, Messenger: &fakeMessenger{}, Lifecycle: &fakeLCM{store: st}, LookPath: lookPath})

	if _, err := m.Spawn(ctx, ports.SpawnConfig{ProjectID: "mer", Kind: domain.KindOrchestrator, Harness: domain.HarnessClaudeCode}); err == nil {
		t.Fatal("configured missing role file must block spawn")
	}
	if agent.lastLaunch.SystemPrompt != "" {
		t.Fatalf("agent launched despite missing configured role policy: %#v", agent.lastLaunch)
	}
}

func TestSystemPrompt_RejectsUnsafeConfiguredRoleInstructionsFiles(t *testing.T) {
	root := t.TempDir()
	large := filepath.Join(root, "too-large.md")
	if err := os.WriteFile(large, bytes.Repeat([]byte("x"), maxRoleInstructionsFileBytes+1), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "empty.md"), []byte(" \n\t"), 0o644); err != nil {
		t.Fatal(err)
	}

	cases := []struct {
		name string
		path string
	}{
		{name: "directory", path: "."},
		{name: "too_large", path: "too-large.md"},
		{name: "empty", path: "empty.md"},
		{name: "leading_whitespace", path: " too-large.md"},
		{name: "trailing_whitespace", path: "too-large.md "},
		{name: "parent_escape", path: "../too-large.md"},
		{name: "whitespace_hidden_escape", path: " ../too-large.md"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			st := newFakeStore()
			st.projects["mer"] = domain.ProjectRecord{
				ID:     "mer",
				Path:   root,
				Config: domain.ProjectConfig{Orchestrator: domain.RoleOverride{InstructionsFile: tc.path}},
			}
			lookPath := func(string) (string, error) { return "/bin/true", nil }
			m := New(Deps{Runtime: &fakeRuntime{}, Agents: singleAgent{agent: &recordingAgent{}}, Workspace: &fakeWorkspace{}, Store: st, Messenger: &fakeMessenger{}, Lifecycle: &fakeLCM{store: st}, LookPath: lookPath})

			if prompt, err := m.buildSystemPrompt(ctx, domain.KindOrchestrator, "mer"); err == nil {
				t.Fatalf("buildSystemPrompt accepted unsafe configured role file %q:\n%s", tc.path, prompt)
			}
		})
	}
}

func TestSpawnOrchestrator_WorkspaceProjectPromptListsRepos(t *testing.T) {
	st := newFakeStore()
	st.projects["mer"] = domain.ProjectRecord{ID: "mer", Kind: domain.ProjectKindWorkspace, Config: testRoleAgents()}
	st.workspaceRepo["mer"] = []domain.WorkspaceRepoRecord{
		{Name: "api", RelativePath: "services/api"},
		{Name: "web", RelativePath: "apps/web"},
	}
	agent := &recordingAgent{}
	rt := &fakeRuntime{}
	ws := &fakeWorkspace{}
	lookPath := func(string) (string, error) { return "/bin/true", nil }
	m := New(Deps{Runtime: rt, Agents: singleAgent{agent: agent}, Workspace: ws, Store: st, Messenger: &fakeMessenger{}, Lifecycle: &fakeLCM{store: st}, LookPath: lookPath})

	_, err := m.Spawn(ctx, ports.SpawnConfig{ProjectID: "mer", Kind: domain.KindOrchestrator})
	if err != nil {
		t.Fatal(err)
	}

	systemPrompt := agent.lastLaunch.SystemPrompt
	for _, want := range []string{
		"## Workspace project",
		"This project is a multi-repository workspace",
		"- __root__: .",
		"- api: services/api",
		"- web: apps/web",
		"When spawning workers, name the repository path",
		"track deliverables, pull requests, and checks by repository",
	} {
		if !strings.Contains(systemPrompt, want) {
			t.Fatalf("system prompt missing %q:\n%s", want, systemPrompt)
		}
	}
	if strings.Contains(agent.lastLaunch.Prompt, "multi-repository workspace") {
		t.Fatalf("workspace role context must not be in the user prompt:\n%s", agent.lastLaunch.Prompt)
	}
}

func TestSpawnWorker_WorkspaceProjectPromptListsRepos(t *testing.T) {
	st := newFakeStore()
	st.projects["mer"] = domain.ProjectRecord{ID: "mer", Kind: domain.ProjectKindWorkspace, Config: testRoleAgents()}
	st.workspaceRepo["mer"] = []domain.WorkspaceRepoRecord{{Name: "api", RelativePath: "api"}}
	agent := &recordingAgent{}
	rt := &fakeRuntime{}
	ws := &fakeWorkspace{}
	lookPath := func(string) (string, error) { return "/bin/true", nil }
	m := New(Deps{Runtime: rt, Agents: singleAgent{agent: agent}, Workspace: ws, Store: st, Messenger: &fakeMessenger{}, Lifecycle: &fakeLCM{store: st}, LookPath: lookPath})

	_, err := m.Spawn(ctx, ports.SpawnConfig{ProjectID: "mer", Kind: domain.KindWorker, Prompt: "fix api"})
	if err != nil {
		t.Fatal(err)
	}

	systemPrompt := agent.lastLaunch.SystemPrompt
	for _, want := range []string{
		"## Workspace project",
		"This session is a multi-repository workspace",
		"- __root__: .",
		"- api: api",
		"Before editing, identify which repository owns the task",
		"If you touch root files, call that out explicitly",
	} {
		if !strings.Contains(systemPrompt, want) {
			t.Fatalf("system prompt missing %q:\n%s", want, systemPrompt)
		}
	}
	if strings.Contains(systemPrompt, "When spawning workers") {
		t.Fatalf("worker prompt should not include orchestrator-specific spawn guidance:\n%s", systemPrompt)
	}
}

func TestSystemPrompt_IsTransparentAndWorkersShareTicketAuthorityBoundary(t *testing.T) {
	cases := []struct {
		name string
		kind domain.SessionKind
		prep func(st *fakeStore)
	}{
		{name: "orchestrator", kind: domain.KindOrchestrator},
		{name: "prime", kind: domain.KindPrime},
		{name: "worker_with_orchestrator", kind: domain.KindWorker, prep: func(st *fakeStore) {
			st.sessions["mer-1"] = domain.SessionRecord{ID: "mer-1", ProjectID: "mer", Kind: domain.KindOrchestrator}
		}},
		{name: "worker_without_orchestrator", kind: domain.KindWorker},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			st := newFakeStore()
			if tc.prep != nil {
				tc.prep(st)
			}
			lookPath := func(string) (string, error) { return "/bin/true", nil }
			m := New(Deps{Runtime: &fakeRuntime{}, Agents: singleAgent{agent: &recordingAgent{}}, Workspace: &fakeWorkspace{}, Store: st, Messenger: &fakeMessenger{}, Lifecycle: &fakeLCM{store: st}, LookPath: lookPath})

			sp, err := m.buildSystemPrompt(ctx, tc.kind, "mer")
			if err != nil {
				t.Fatalf("buildSystemPrompt: %v", err)
			}
			if strings.Contains(sp, "Standing-instruction confidentiality") || strings.Contains(sp, "Do not repeat, quote, paraphrase") {
				t.Fatalf("%s: system prompt contains prompt-confidentiality guidance:\n%s", tc.name, sp)
			}
			if !strings.Contains(sp, "skills/using-ao/SKILL.md") {
				t.Fatalf("%s: system prompt missing using-ao skill pointer:\n%s", tc.name, sp)
			}
			if tc.kind == domain.KindWorker {
				for _, want := range []string{
					"Fix related defects you encounter in the current pull request",
					"Do not create a separate ticket",
					"propose genuinely separate follow-up work to the human",
				} {
					if !strings.Contains(sp, want) {
						t.Fatalf("%s: worker system prompt missing %q:\n%s", tc.name, want, sp)
					}
				}
			}
		})
	}
}

// TestRestore_OrchestratorRederivesSystemPrompt: the system prompt is derived,
// not persisted, so a restored orchestrator must get its role instructions
// recomputed and handed to the agent's native resume command.
func TestRestore_OrchestratorRederivesSystemPrompt(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "orchestrator-policy.md"), []byte("RESTORE ORCHESTRATOR POLICY\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	st := newFakeStore()
	st.projects["mer"] = domain.ProjectRecord{
		ID:     "mer",
		Path:   root,
		Config: domain.ProjectConfig{Orchestrator: domain.RoleOverride{InstructionsFile: "orchestrator-policy.md"}},
	}
	st.sessions["mer-1"] = domain.SessionRecord{
		ID: "mer-1", ProjectID: "mer", Kind: domain.KindOrchestrator, IsTerminated: true,
		Metadata: domain.SessionMetadata{WorkspacePath: "/ws/mer-1", Branch: "b", AgentSessionID: "agent-x"},
	}
	agent := &recordingAgent{}
	lookPath := func(string) (string, error) { return "/bin/true", nil }
	m := New(Deps{Runtime: &fakeRuntime{}, Agents: singleAgent{agent: agent}, Workspace: &fakeWorkspace{}, Store: st, Messenger: &fakeMessenger{}, Lifecycle: &fakeLCM{store: st}, LookPath: lookPath})

	if _, err := m.Restore(ctx, "mer-1"); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(agent.lastRestore.SystemPrompt, "You are the project Orc for mer") {
		t.Fatalf("restore system prompt missing coordinator role:\n%s", agent.lastRestore.SystemPrompt)
	}
	if !strings.Contains(agent.lastRestore.SystemPrompt, "RESTORE ORCHESTRATOR POLICY") {
		t.Fatalf("restore system prompt missing role instructions file:\n%s", agent.lastRestore.SystemPrompt)
	}
}

// TestRestore_FallbackLaunchCarriesSystemPrompt: when the agent has no native
// session to resume, the fresh-launch fallback must carry the re-derived
// system prompt alongside the persisted task prompt.
func TestRestore_FallbackLaunchCarriesSystemPrompt(t *testing.T) {
	st := newFakeStore()
	st.sessions["mer-1"] = domain.SessionRecord{
		ID: "mer-1", ProjectID: "mer", Kind: domain.KindOrchestrator, IsTerminated: true,
		Metadata: domain.SessionMetadata{WorkspacePath: "/ws/mer-1", Branch: "b", Prompt: "kick off"},
	}
	agent := &recordingAgent{}
	lookPath := func(string) (string, error) { return "/bin/true", nil }
	m := New(Deps{Runtime: &fakeRuntime{}, Agents: singleAgent{agent: agent}, Workspace: &fakeWorkspace{}, Store: st, Messenger: &fakeMessenger{}, Lifecycle: &fakeLCM{store: st}, LookPath: lookPath})

	if _, err := m.Restore(ctx, "mer-1"); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(agent.lastLaunch.SystemPrompt, "You are the project Orc for mer") {
		t.Fatalf("fallback launch system prompt missing coordinator role:\n%s", agent.lastLaunch.SystemPrompt)
	}
	if agent.lastLaunch.Prompt != "kick off" {
		t.Fatalf("fallback launch prompt = %q, want persisted task prompt", agent.lastLaunch.Prompt)
	}
}

func TestRestore_FallbackLaunchDeliversPromptAfterStartWhenAgentRequestsIt(t *testing.T) {
	st := newFakeStore()
	st.projects["mer"] = domain.ProjectRecord{ID: "mer", Config: testRoleAgents()}
	st.sessions["mer-1"] = domain.SessionRecord{
		ID: "mer-1", ProjectID: "mer", Kind: domain.KindWorker, IsTerminated: true,
		Metadata: domain.SessionMetadata{WorkspacePath: "/ws/mer-1", Branch: "b", Prompt: "continue the task"},
	}
	rt := &fakeRuntime{}
	agent := &recordingAgent{}
	m := New(Deps{
		Runtime:   rt,
		Agents:    singleAgent{agent: afterStartAgent{recordingAgent: agent}},
		Workspace: &fakeWorkspace{},
		Store:     st,
		Messenger: &fakeMessenger{},
		Lifecycle: &fakeLCM{store: st},
		LookPath:  func(string) (string, error) { return "/bin/true", nil },
	})

	if _, err := m.Restore(ctx, "mer-1"); err != nil {
		t.Fatal(err)
	}
	if agent.lastLaunch.Prompt != "" {
		t.Fatalf("fallback launch prompt = %q, want empty for after-start delivery", agent.lastLaunch.Prompt)
	}
	if len(rt.sent) != 1 || rt.sent[0] != "continue the task" {
		t.Fatalf("delivered prompts = %#v, want saved prompt", rt.sent)
	}
	if rt.created != 1 {
		t.Fatalf("runtime.Create = %d, want 1", rt.created)
	}
}

// TestRestore_PromptlessOrchestratorResumesViaAdapter locks the orchestrator
// fix: a promptless session with no captured agentSessionId is still restorable
// when the adapter can resume it (Claude pins a deterministic --session-id).
// Before the fix the metadata-only guard rejected it with ErrNotResumable, so
// every boot abandoned the orchestrator and spawned a fresh one.
func TestRestore_PromptlessOrchestratorResumesViaAdapter(t *testing.T) {
	st := newFakeStore()
	st.sessions["mer-1"] = domain.SessionRecord{
		ID: "mer-1", ProjectID: "mer", Kind: domain.KindOrchestrator, IsTerminated: true,
		// No AgentSessionID, no Prompt: exactly how orchestrators are persisted.
		Metadata: domain.SessionMetadata{WorkspacePath: "/ws/mer-1", Branch: "ao/mer-orchestrator"},
		Activity: domain.Activity{State: domain.ActivityExited},
	}
	rt := &fakeRuntime{}
	lookPath := func(string) (string, error) { return "/bin/true", nil }
	m := New(Deps{Runtime: rt, Agents: singleAgent{agent: alwaysResumeAgent{}}, Workspace: &fakeWorkspace{}, Store: st, Messenger: &fakeMessenger{}, Lifecycle: &fakeLCM{store: st}, LookPath: lookPath})

	if _, err := m.Restore(ctx, "mer-1"); err != nil {
		t.Fatalf("promptless orchestrator must restore via adapter resume, got err = %v", err)
	}
	if rt.created != 1 {
		t.Fatalf("runtime.Create = %d, want 1 (resumed)", rt.created)
	}
	if st.sessions["mer-1"].IsTerminated {
		t.Error("orchestrator must be live after restore")
	}
	if len(rt.sent) != 1 || !strings.Contains(rt.sent[0], "Read your standing policy") {
		t.Fatalf("native restore sends = %#v, want post-start kickoff", rt.sent)
	}
}

func TestRestore_OrchestratorKickoffAfterMarkSpawned(t *testing.T) {
	st := newFakeStore()
	st.sessions["mer-1"] = domain.SessionRecord{
		ID: "mer-1", ProjectID: "mer", Kind: domain.KindOrchestrator, IsTerminated: true,
		Metadata: domain.SessionMetadata{WorkspacePath: "/ws/mer-1", Branch: "ao/mer-orchestrator"},
		Activity: domain.Activity{State: domain.ActivityExited},
	}
	rt := &fakeRuntime{}
	rt.onSend = func() {
		rec := st.sessions["mer-1"]
		if rec.IsTerminated {
			t.Fatal("kickoff sent before MarkSpawned made the session live")
		}
		if rec.Metadata.RuntimeHandleID == "" {
			t.Fatal("kickoff sent before MarkSpawned persisted runtime metadata")
		}
	}
	lookPath := func(string) (string, error) { return "/bin/true", nil }
	m := New(Deps{Runtime: rt, Agents: singleAgent{agent: alwaysResumeAgent{}}, Workspace: &fakeWorkspace{}, Store: st, Messenger: &fakeMessenger{}, Lifecycle: &fakeLCM{store: st}, LookPath: lookPath})

	if _, err := m.Restore(ctx, "mer-1"); err != nil {
		t.Fatal(err)
	}
}

// TestRestore_PromptlessUnresumableRelaunchesFresh covers the genuine-reboot
// case: a promptless session whose adapter cannot resume (no native session id,
// no captured AgentSessionID) must be relaunched fresh via GetLaunchCommand
// in the SAME id. The orchestrator is the canonical example: after a reboot
// where tmux is truly gone, RestoreAll must recover it in place rather than
// abandon it and mint a new one (which caused the id-increment bug).
func TestRestore_PromptlessUnresumableRelaunchesFresh(t *testing.T) {
	st := newFakeStore()
	st.sessions["mer-1"] = domain.SessionRecord{
		ID: "mer-1", ProjectID: "mer", Kind: domain.KindOrchestrator, IsTerminated: true,
		// No AgentSessionID, no Prompt: exactly how an orchestrator is persisted.
		Metadata: domain.SessionMetadata{WorkspacePath: "/ws/mer-1", Branch: "ao/mer-orchestrator"},
		Activity: domain.Activity{State: domain.ActivityExited},
	}
	rt := &fakeRuntime{}
	lookPath := func(string) (string, error) { return "/bin/true", nil }
	agent := &recordingAgent{}
	// recordingAgent returns ok=false without an agentSessionId and captures the
	// fresh-launch fallback config.
	m := New(Deps{Runtime: rt, Agents: singleAgent{agent: agent}, Workspace: &fakeWorkspace{}, Store: st, Messenger: &fakeMessenger{}, Lifecycle: &fakeLCM{store: st}, LookPath: lookPath})

	if _, err := m.Restore(ctx, "mer-1"); err != nil {
		t.Fatalf("promptless unresumable session must relaunch fresh, got err = %v", err)
	}
	if rt.created != 1 {
		t.Fatalf("runtime.Create = %d, want 1 (fresh launch)", rt.created)
	}
	if st.sessions["mer-1"].IsTerminated {
		t.Error("session must be live after fresh relaunch")
	}
	if !strings.Contains(agent.lastLaunch.Prompt, "Read your standing policy") {
		t.Fatalf("restore fallback prompt = %q, want orchestrator kickoff", agent.lastLaunch.Prompt)
	}
}

// TestRestore_PromptlessWorkerNotResumable is the RED test for the promptless-worker
// fix: a KindWorker session with no prompt and no captured AgentSessionID (so the
// adapter returns ok=false) must NOT be blank-relaunched. The session had no task
// to replay and no native id to resume from, so relaunching fresh would silently
// drop its work. Restore must return ErrNotResumable and leave the session terminated
// (runtime.Create must NOT be called).
func TestRestore_PromptlessWorkerNotResumable(t *testing.T) {
	st := newFakeStore()
	st.sessions["mer-1"] = domain.SessionRecord{
		ID: "mer-1", ProjectID: "mer", Kind: domain.KindWorker, IsTerminated: true,
		// No AgentSessionID, no Prompt: promptless worker with no resume handle.
		Metadata: domain.SessionMetadata{WorkspacePath: "/ws/mer-1", Branch: "ao/mer-1/root"},
		Activity: domain.Activity{State: domain.ActivityExited},
	}
	rt := &fakeRuntime{}
	lookPath := func(string) (string, error) { return "/bin/true", nil }
	// fakeAgents resolves to fakeAgent, whose GetRestoreCommand returns ok=false
	// when there is no AgentSessionID. With a KindWorker and empty Prompt, this
	// must produce ErrNotResumable instead of a blank relaunch.
	m := New(Deps{Runtime: rt, Agents: fakeAgents{}, Workspace: &fakeWorkspace{}, Store: st, Messenger: &fakeMessenger{}, Lifecycle: &fakeLCM{store: st}, LookPath: lookPath})

	_, err := m.Restore(ctx, "mer-1")
	if !errors.Is(err, ErrNotResumable) {
		t.Fatalf("promptless unresumable worker must return ErrNotResumable, got %v", err)
	}
	if rt.created != 0 {
		t.Fatalf("runtime.Create = %d, want 0 (must not relaunch a promptless worker)", rt.created)
	}
	if !st.sessions["mer-1"].IsTerminated {
		t.Error("session must remain terminated after ErrNotResumable")
	}
}

// TestRestore_WorkerPointsAtCurrentOrchestrator: a restored worker's
// coordination hint must reference the orchestrator active at restore time,
// not the one from its original spawn.
func TestRestore_WorkerPointsAtCurrentOrchestrator(t *testing.T) {
	st := newFakeStore()
	st.sessions["mer-9"] = domain.SessionRecord{ID: "mer-9", ProjectID: "mer", Kind: domain.KindOrchestrator}
	st.sessions["mer-1"] = domain.SessionRecord{
		ID: "mer-1", ProjectID: "mer", Kind: domain.KindWorker, IsTerminated: true,
		Metadata: domain.SessionMetadata{WorkspacePath: "/ws/mer-1", Branch: "b", AgentSessionID: "agent-x"},
	}
	agent := &recordingAgent{}
	lookPath := func(string) (string, error) { return "/bin/true", nil }
	m := New(Deps{Runtime: &fakeRuntime{}, Agents: singleAgent{agent: agent}, Workspace: &fakeWorkspace{}, Store: st, Messenger: &fakeMessenger{}, Lifecycle: &fakeLCM{store: st}, LookPath: lookPath})

	if _, err := m.Restore(ctx, "mer-1"); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(agent.lastRestore.SystemPrompt, `ao send --session mer-9`) {
		t.Fatalf("restore system prompt missing current orchestrator contact:\n%s", agent.lastRestore.SystemPrompt)
	}
}

// TestRestore_RefusesIncompleteHandle covers Bug 2: a terminated row whose
// spawn failed before the workspace landed (no WorkspacePath, no Branch) must
// fail Restore with ErrIncompleteHandle — the same typed sentinel Kill returns
// for the same shape — so the HTTP layer surfaces a typed 409 instead of an
// opaque 500.
func TestRestore_RefusesIncompleteHandle(t *testing.T) {
	m, st, _, _ := newManager()
	// Seed a terminated row with no workspace and no branch (the post-failure
	// shape of a Spawn that died before workspace.Create succeeded).
	st.sessions["mer-1"] = domain.SessionRecord{
		ID:           "mer-1",
		ProjectID:    "mer",
		IsTerminated: true,
		Metadata:     domain.SessionMetadata{Prompt: "do it"},
	}
	if _, err := m.Restore(ctx, "mer-1"); !errors.Is(err, ErrIncompleteHandle) {
		t.Fatalf("want ErrIncompleteHandle, got %v", err)
	}
}

// TestRollbackSpawn_DeletesSeedRow covers Bug 4: a session row in seed state
// (no workspace, no runtime, no agent session id, not terminated) is deleted
// outright by RollbackSpawn so the user never sees an orphan terminated row.
func TestRollbackSpawn_DeletesSeedRow(t *testing.T) {
	m, st, _, _ := newManager()
	// Seed row matches what CreateSession produces — no Metadata at all.
	st.sessions["mer-1"] = domain.SessionRecord{
		ID:        "mer-1",
		ProjectID: "mer",
		Activity:  domain.Activity{State: domain.ActivityIdle},
	}
	deleted, killed, err := m.RollbackSpawn(ctx, "mer-1")
	if err != nil {
		t.Fatalf("rollback err = %v", err)
	}
	if !deleted || killed {
		t.Fatalf("deleted=%v killed=%v, want deleted=true killed=false", deleted, killed)
	}
	if _, present := st.sessions["mer-1"]; present {
		t.Fatal("seed row must be removed from the store, not left as terminated")
	}
}

// TestRollbackSpawn_FallsBackToKillForLiveRow asserts the no-resurrection
// guarantee from Bug 4's RCA: once a row has observable spawn output (workspace
// + runtime handle), DeleteSession is a no-op and rollback falls back to Kill
// so the runtime + workspace are torn down rather than abandoned.
func TestRollbackSpawn_FallsBackToKillForLiveRow(t *testing.T) {
	m, st, rt, ws := newManager()
	st.sessions["mer-1"] = mkLive("mer-1")
	deleted, killed, err := m.RollbackSpawn(ctx, "mer-1")
	if err != nil {
		t.Fatalf("rollback err = %v", err)
	}
	if deleted || !killed {
		t.Fatalf("deleted=%v killed=%v, want deleted=false killed=true", deleted, killed)
	}
	if rt.destroyed != 1 || ws.destroyed != 1 {
		t.Fatalf("kill teardown not invoked: rt=%d ws=%d", rt.destroyed, ws.destroyed)
	}
	if !st.sessions["mer-1"].IsTerminated {
		t.Fatal("live row should be marked terminated after kill-fallback")
	}
}

// TestSpawn_RejectsMissingAgentBinary covers Bug 6: when the agent adapter
// returns an argv whose binary is not on PATH, Manager.Spawn must abort BEFORE
// runtime.Create rather than launching into an empty tmux pane that the
// reaper later mistakes for a live session.
func TestSpawn_RejectsMissingAgentBinary(t *testing.T) {
	st := newFakeStore()
	st.projects["mer"] = domain.ProjectRecord{ID: "mer", Config: testRoleAgents()}
	rt := &fakeRuntime{}
	ws := &fakeWorkspace{}
	notFound := func(name string) (string, error) {
		if name == "tmux" {
			return "/bin/tmux", nil
		}
		return "", fmt.Errorf("exec: %q: not found", name)
	}
	m := New(Deps{Runtime: rt, Agents: fakeAgents{}, Workspace: ws, Store: st, Messenger: &fakeMessenger{}, Lifecycle: &fakeLCM{store: st}, LookPath: notFound})

	_, err := m.Spawn(ctx, ports.SpawnConfig{ProjectID: "mer", Kind: domain.KindWorker})
	if !errors.Is(err, ports.ErrAgentBinaryNotFound) {
		t.Fatalf("err = %v, want ports.ErrAgentBinaryNotFound", err)
	}
	if rt.created != 0 {
		t.Fatal("runtime.Create must NOT run when the agent binary is missing")
	}
	if ws.destroyed != 1 {
		t.Fatal("workspace must be torn down when the pre-launch binary check fails")
	}
	if rec, present := st.sessions["mer-1"]; present {
		t.Fatalf("seed row must be deleted before a runtime handle is live, got %+v", rec)
	}
}

func TestSpawn_RejectsMissingTmuxBeforeSessionRow(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows uses ConPTY, not tmux")
	}
	st := newFakeStore()
	st.projects["mer"] = domain.ProjectRecord{ID: "mer", Config: testRoleAgents()}
	rt := &fakeRuntime{}
	ws := &fakeWorkspace{}
	lookPath := func(name string) (string, error) {
		if name == "tmux" {
			return "", fmt.Errorf("exec: %q: not found", name)
		}
		return "/bin/true", nil
	}
	m := New(Deps{Runtime: rt, Agents: fakeAgents{}, Workspace: ws, Store: st, Messenger: &fakeMessenger{}, Lifecycle: &fakeLCM{store: st}, LookPath: lookPath})

	_, err := m.Spawn(ctx, ports.SpawnConfig{ProjectID: "mer", Kind: domain.KindWorker})
	if !errors.Is(err, ports.ErrRuntimePrerequisite) || !strings.Contains(err.Error(), "tmux required") {
		t.Fatalf("err = %v, want missing tmux prerequisite", err)
	}
	if len(st.sessions) != 0 {
		t.Fatalf("no session row should be created before runtime prerequisites pass, got %d", len(st.sessions))
	}
	if ws.lastCfg.SessionID != "" || ws.destroyed != 0 {
		t.Fatal("workspace must not be created when tmux is missing")
	}
	if rt.created != 0 {
		t.Fatal("runtime must not be created when tmux is missing")
	}
}

func TestSpawn_RejectsUnknownHarness(t *testing.T) {
	st := newFakeStore()
	rt := &fakeRuntime{}
	ws := &fakeWorkspace{}
	m := New(Deps{Runtime: rt, Agents: missingAgents{}, Workspace: ws, Store: st, Messenger: &fakeMessenger{}, Lifecycle: &fakeLCM{store: st}, LookPath: func(string) (string, error) { return "/bin/true", nil }})

	_, err := m.Spawn(ctx, ports.SpawnConfig{ProjectID: "mer", Kind: domain.KindWorker, Harness: "bogus"})
	if !errors.Is(err, ErrUnknownHarness) {
		t.Fatalf("err = %v, want ErrUnknownHarness", err)
	}
	// The harness is rejected before any durable state is created — no seed row,
	// no worktree — so an unknown harness never leaves an orphan behind.
	if len(st.sessions) != 0 {
		t.Fatalf("no session row should be created, got %d", len(st.sessions))
	}
	if ws.lastCfg.SessionID != "" || ws.destroyed != 0 {
		t.Fatal("workspace must not be created for an unknown harness")
	}
	if rt.created != 0 {
		t.Fatal("runtime must not be created for an unknown harness")
	}
}

func TestSpawn_RejectsCrossProviderModelBeforeDurableState(t *testing.T) {
	st := newFakeStore()
	// Worker role resolves to codex; an explicit Claude model (opus) is the wrong
	// provider for it — the exact combination that hung codex workers.
	st.projects["mer"] = domain.ProjectRecord{ID: "mer", Config: domain.ProjectConfig{
		Worker: domain.RoleOverride{Harness: domain.HarnessCodex},
	}}
	rt := &fakeRuntime{}
	ws := &fakeWorkspace{}
	m := New(Deps{Runtime: rt, Agents: singleAgent{agent: &recordingAgent{}}, Workspace: ws, Store: st, Messenger: &fakeMessenger{}, Lifecycle: &fakeLCM{store: st}, LookPath: func(string) (string, error) { return "/bin/true", nil }})

	_, err := m.Spawn(ctx, ports.SpawnConfig{ProjectID: "mer", Kind: domain.KindWorker, Model: "opus"})
	if !errors.Is(err, ErrModelHarnessMismatch) {
		t.Fatalf("err = %v, want ErrModelHarnessMismatch", err)
	}
	// The mismatch is caught before any durable state — no seed row, no
	// worktree, no runtime — so a wrong-provider model never leaves an orphan.
	if len(st.sessions) != 0 {
		t.Fatalf("no session row should be created, got %d", len(st.sessions))
	}
	if ws.lastCfg.SessionID != "" || ws.destroyed != 0 {
		t.Fatal("workspace must not be created for a cross-provider model")
	}
	if rt.created != 0 {
		t.Fatal("runtime must not be created for a cross-provider model")
	}
}

// pathPinManager builds a manager whose Executable dep is stubbed, plus a
// buffer capturing its log output, for the hook PATH pin tests.
func pathPinManager(executable func() (string, error)) (*Manager, *fakeStore, *fakeRuntime, *bytes.Buffer) {
	st := newFakeStore()
	st.projects["mer"] = domain.ProjectRecord{ID: "mer", Config: testRoleAgents()}
	rt := &fakeRuntime{}
	logBuf := &bytes.Buffer{}
	lookPath := func(string) (string, error) { return "/bin/true", nil }
	m := New(Deps{
		Runtime: rt, Agents: fakeAgents{}, Workspace: &fakeWorkspace{}, Store: st,
		Messenger: &fakeMessenger{}, Lifecycle: &fakeLCM{store: st},
		LookPath: lookPath, Executable: executable,
		Logger: slog.New(slog.NewTextHandler(logBuf, nil)),
	})
	return m, st, rt, logBuf
}

// TestSpawnAndRestore_PinHookPATHToDaemonBinary covers the activity-tracking
// fix: the spawned session's PATH must put the daemon executable's directory
// first, so the bare `ao` in the workspace hook commands resolves to the
// daemon that installed them, not a foreign `ao` earlier on the user's PATH
// (e.g. the legacy TypeScript CLI, which has no `hooks` command and silently
// kills activity tracking).
func TestSpawnAndRestore_PinHookPATHToDaemonBinary(t *testing.T) {
	daemonExe := filepath.Join(t.TempDir(), "ao")
	want := filepath.Dir(daemonExe) + string(os.PathListSeparator) + "/usr/bin"
	executable := func() (string, error) { return daemonExe, nil }

	cases := []struct {
		name   string
		launch func(m *Manager, st *fakeStore) error
	}{
		{
			name: "spawn",
			launch: func(m *Manager, _ *fakeStore) error {
				_, err := m.Spawn(ctx, ports.SpawnConfig{ProjectID: "mer", Kind: domain.KindWorker})
				return err
			},
		},
		{
			name: "restore",
			launch: func(m *Manager, st *fakeStore) error {
				seedTerminal(st, "mer-1", domain.SessionMetadata{WorkspacePath: "/ws/mer-1", Branch: "b", AgentSessionID: "agent-x"})
				_, err := m.Restore(ctx, "mer-1")
				return err
			},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("PATH", "/usr/bin")
			m, st, rt, _ := pathPinManager(executable)
			if err := tc.launch(m, st); err != nil {
				t.Fatal(err)
			}
			if got := rt.lastCfg.Env["PATH"]; got != want {
				t.Fatalf("runtime env PATH = %q, want %q", got, want)
			}
		})
	}
}

// TestSpawn_HookPATHPinUnavailable asserts the degraded path is loud, not
// silent: when the daemon executable cannot anchor `ao` resolution, PATH is
// left to the runtime's inherited default and a warning is logged.
func TestSpawn_HookPATHPinUnavailable(t *testing.T) {
	cases := []struct {
		name       string
		executable func() (string, error)
	}{
		{"executable unresolvable", func() (string, error) { return "", errors.New("no exe") }},
		{"executable not named ao", func() (string, error) { return "/opt/aod/ao-daemon", nil }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			m, _, rt, logBuf := pathPinManager(tc.executable)
			if _, err := m.Spawn(ctx, ports.SpawnConfig{ProjectID: "mer", Kind: domain.KindWorker}); err != nil {
				t.Fatal(err)
			}
			if got, ok := rt.lastCfg.Env["PATH"]; ok {
				t.Fatalf("runtime env PATH = %q, want unset when the pin cannot be applied", got)
			}
			if !strings.Contains(logBuf.String(), "not pinned") {
				t.Fatalf("expected a 'not pinned' warning in the log, got %q", logBuf.String())
			}
		})
	}
}

// TestSpawn_ProjectPATHIsPinBase asserts a project's PATH override survives the
// pin as its base rather than being clobbered or clobbering: the daemon dir
// still comes first.
func TestSpawn_ProjectPATHIsPinBase(t *testing.T) {
	daemonExe := filepath.Join(t.TempDir(), "ao")
	m, st, rt, _ := pathPinManager(func() (string, error) { return daemonExe, nil })
	st.projects["mer"] = domain.ProjectRecord{ID: "mer", Config: domain.ProjectConfig{
		Env:    map[string]string{"PATH": "/proj/bin"},
		Worker: domain.RoleOverride{Harness: domain.HarnessClaudeCode},
	}}
	if _, err := m.Spawn(ctx, ports.SpawnConfig{ProjectID: "mer", Kind: domain.KindWorker}); err != nil {
		t.Fatal(err)
	}
	want := filepath.Dir(daemonExe) + string(os.PathListSeparator) + "/proj/bin"
	if got := rt.lastCfg.Env["PATH"]; got != want {
		t.Fatalf("runtime env PATH = %q, want %q", got, want)
	}
}

func TestSpawn_KeepsExplicitBranch(t *testing.T) {
	m, st, _, _ := newManager()
	s, err := m.Spawn(ctx, ports.SpawnConfig{ProjectID: "mer", Kind: domain.KindWorker, Branch: "feature/x"})
	if err != nil {
		t.Fatal(err)
	}
	if got := st.sessions[s.ID].Metadata.Branch; got != "feature/x" {
		t.Fatalf("explicit branch = %q, want feature/x", got)
	}
}

// ---- SaveAndTeardownAll / RestoreAll tests ----

// newLifecycleManager builds a manager wired with a recording workspace fake
// for the shutdown lifecycle tests.
func newLifecycleManager() (*Manager, *fakeStore, *fakeRuntime, *fakeWorkspace) {
	st := newFakeStore()
	st.projects["mer"] = domain.ProjectRecord{ID: "mer", Config: testRoleAgents()}
	rt := &fakeRuntime{}
	ws := &fakeWorkspace{}
	lookPath := func(string) (string, error) { return "/bin/true", nil }
	m := New(Deps{
		Runtime:   rt,
		Agents:    fakeAgents{},
		Workspace: ws,
		Store:     st,
		Messenger: &fakeMessenger{},
		Lifecycle: &fakeLCM{store: st},
		LookPath:  lookPath,
	})
	return m, st, rt, ws
}

// TestSaveAndTeardownAll_CaptureOrderAndMarker verifies (a): for a live session
// with a workspace, SaveAndTeardownAll must call StashUncommitted BEFORE
// UpsertSessionWorktree (writing preserved_ref) BEFORE ForceDestroy.
func TestSaveAndTeardownAll_CaptureOrderAndMarker(t *testing.T) {
	m, st, _, ws := newLifecycleManager()

	// Wire a shared ordered call log so we can assert cross-fake ordering:
	// both fakeStore and fakeWorkspace append to the same slice.
	var sharedLog []string
	st.sharedLog = &sharedLog
	ws.sharedLog = &sharedLog

	// A live session with a workspace path and runtime handle.
	ws.stashRef = "refs/ao/preserved/mer-1"
	st.sessions["mer-1"] = domain.SessionRecord{
		ID:        "mer-1",
		ProjectID: "mer",
		Kind:      domain.KindWorker,
		Metadata:  domain.SessionMetadata{WorkspacePath: "/ws/mer-1", Branch: "ao/mer-1/root", RuntimeHandleID: "h1"},
		Activity:  domain.Activity{State: domain.ActivityActive},
	}

	if err := m.SaveAndTeardownAll(ctx); err != nil {
		t.Fatalf("SaveAndTeardownAll err = %v", err)
	}

	// Stash must come before ForceDestroy in the call log.
	stashIdx, forceIdx := -1, -1
	for i, c := range ws.calls {
		if c == "StashUncommitted:mer-1" {
			stashIdx = i
		}
		if c == "ForceDestroy:mer-1" {
			forceIdx = i
		}
	}
	if stashIdx == -1 {
		t.Fatal("StashUncommitted was not called")
	}
	if forceIdx == -1 {
		t.Fatal("ForceDestroy was not called")
	}
	if stashIdx >= forceIdx {
		t.Fatalf("StashUncommitted (call %d) must come before ForceDestroy (call %d)", stashIdx, forceIdx)
	}

	// UpsertSessionWorktree (DB write) must be committed BEFORE ForceDestroy.
	// Use the shared ordered log to compare positions across the store and workspace.
	upsertIdx, sharedForceIdx := -1, -1
	for i, c := range sharedLog {
		if c == "UpsertSessionWorktree:mer-1" {
			upsertIdx = i
		}
		if c == "ForceDestroy:mer-1" {
			sharedForceIdx = i
		}
	}
	if upsertIdx == -1 {
		t.Fatal("UpsertSessionWorktree was not called")
	}
	if sharedForceIdx == -1 {
		t.Fatal("ForceDestroy was not recorded in shared log")
	}
	if upsertIdx >= sharedForceIdx {
		t.Fatalf("UpsertSessionWorktree (pos %d) must come before ForceDestroy (pos %d) in shared call log %v", upsertIdx, sharedForceIdx, sharedLog)
	}

	// DB write (UpsertSessionWorktree) must have recorded the correct row.
	rows := st.worktrees["mer-1"]
	if len(rows) == 0 {
		t.Fatal("UpsertSessionWorktree was not called: no worktree row for mer-1")
	}
	if rows[0].PreservedRef != "refs/ao/preserved/mer-1" {
		t.Fatalf("preserved_ref = %q, want refs/ao/preserved/mer-1", rows[0].PreservedRef)
	}

	// The session must be marked terminated.
	if !st.sessions["mer-1"].IsTerminated {
		t.Fatal("session must be terminated after SaveAndTeardownAll")
	}
}

func TestRetireForReplacementCapturesAndReleasesWorkspace(t *testing.T) {
	m, st, rt, ws := newLifecycleManager()
	var sharedLog []string
	st.sharedLog = &sharedLog
	ws.sharedLog = &sharedLog
	ws.stashRef = "refs/ao/preserved/mer-orch"
	st.sessions["mer-orch"] = domain.SessionRecord{
		ID:        "mer-orch",
		ProjectID: "mer",
		Kind:      domain.KindOrchestrator,
		Metadata:  domain.SessionMetadata{WorkspacePath: "/ws/mer-orch", Branch: "ao/mer-orchestrator", RuntimeHandleID: "orch-handle"},
		Activity:  domain.Activity{State: domain.ActivityActive},
	}
	st.worktrees["mer-orch"] = []domain.SessionWorktreeRecord{{
		SessionID:    "mer-orch",
		RepoName:     domain.RootWorkspaceRepoName,
		Branch:       "ao/mer-orchestrator",
		WorktreePath: "/ws/mer-orch",
		PreservedRef: "refs/ao/preserved/old",
	}}

	if err := m.RetireForReplacement(ctx, "mer-orch"); err != nil {
		t.Fatalf("RetireForReplacement err = %v", err)
	}

	if rows := st.worktrees["mer-orch"]; len(rows) != 0 {
		t.Fatalf("replacement retirement must not write restore markers, got %#v", rows)
	}
	if !st.sessions["mer-orch"].IsTerminated {
		t.Fatal("retired orchestrator must be marked terminated")
	}
	if rt.destroyed != 1 || rt.destroyedIDs[0] != "orch-handle" {
		t.Fatalf("runtime destroyed = %d ids=%v, want orch-handle", rt.destroyed, rt.destroyedIDs)
	}

	stashIdx, deleteIdx, forceIdx := -1, -1, -1
	for i, c := range sharedLog {
		switch c {
		case "StashUncommitted:mer-orch":
			stashIdx = i
		case "DeleteSessionWorktrees:mer-orch":
			deleteIdx = i
		case "ForceDestroy:mer-orch":
			forceIdx = i
		}
	}
	if stashIdx == -1 || deleteIdx == -1 || forceIdx == -1 {
		t.Fatalf("missing expected calls in shared log: %v", sharedLog)
	}
	if stashIdx >= deleteIdx || deleteIdx >= forceIdx {
		t.Fatalf("replacement retire must capture, clear restore marker, then force release; log=%v", sharedLog)
	}
}

func TestRetireForReplacementWorkspaceProjectCapturesAndReleasesEveryRepo(t *testing.T) {
	m, st, rt, ws := newLifecycleManager()
	var sharedLog []string
	st.sharedLog = &sharedLog
	ws.sharedLog = &sharedLog
	ws.stashRef = "refs/ao/preserved/mer-orch"
	st.projects["mer"] = domain.ProjectRecord{ID: "mer", Path: "/repos/mer", Kind: domain.ProjectKindWorkspace, Config: testRoleAgents()}
	st.workspaceRepo["mer"] = []domain.WorkspaceRepoRecord{{
		ProjectID:    "mer",
		Name:         "api",
		RelativePath: "api",
	}}
	st.sessions["mer-orch"] = domain.SessionRecord{
		ID:        "mer-orch",
		ProjectID: "mer",
		Kind:      domain.KindOrchestrator,
		Metadata:  domain.SessionMetadata{WorkspacePath: "/ws/mer-orch", Branch: "ao/mer-orchestrator", RuntimeHandleID: "orch-handle"},
		Activity:  domain.Activity{State: domain.ActivityActive},
	}
	st.worktrees["mer-orch"] = []domain.SessionWorktreeRecord{
		{
			SessionID:    "mer-orch",
			RepoName:     domain.RootWorkspaceRepoName,
			Branch:       "ao/mer-orchestrator",
			WorktreePath: "/ws/mer-orch",
			PreservedRef: "refs/ao/preserved/old-root",
			State:        "active",
		},
		{
			SessionID:    "mer-orch",
			RepoName:     "api",
			Branch:       "ao/mer-orchestrator",
			WorktreePath: "/ws/mer-orch/api",
			PreservedRef: "refs/ao/preserved/old-api",
			State:        "active",
		},
	}

	if err := m.RetireForReplacement(ctx, "mer-orch"); err != nil {
		t.Fatalf("RetireForReplacement err = %v", err)
	}

	if rows := st.worktrees["mer-orch"]; len(rows) != 0 {
		t.Fatalf("replacement retirement must not write restore markers, got %#v", rows)
	}
	if !st.sessions["mer-orch"].IsTerminated {
		t.Fatal("retired orchestrator must be marked terminated")
	}
	if rt.destroyed != 1 || rt.destroyedIDs[0] != "orch-handle" {
		t.Fatalf("runtime destroyed = %d ids=%v, want orch-handle", rt.destroyed, rt.destroyedIDs)
	}

	wantOrder := []string{
		"StashUncommitted:__root__",
		"StashUncommitted:api",
		"ForceDestroy:api",
		"ForceDestroy:__root__",
		"DeleteSessionWorktrees:mer-orch",
	}
	next := 0
	for _, call := range sharedLog {
		if next < len(wantOrder) && call == wantOrder[next] {
			next++
		}
	}
	if next != len(wantOrder) {
		t.Fatalf("workspace project retirement order missing %v in log %v", wantOrder, sharedLog)
	}
}

func TestRetireForReplacementWorkspaceProjectRuntimeDestroyFailureKeepsRepoInventory(t *testing.T) {
	m, st, rt, ws := newLifecycleManager()
	rt.destroyErr = errors.New("tmux transient")
	ws.stashRef = "refs/ao/preserved/mer-orch"
	st.projects["mer"] = domain.ProjectRecord{ID: "mer", Path: "/repos/mer", Kind: domain.ProjectKindWorkspace, Config: testRoleAgents()}
	st.workspaceRepo["mer"] = []domain.WorkspaceRepoRecord{{
		ProjectID:    "mer",
		Name:         "api",
		RelativePath: "api",
	}}
	st.sessions["mer-orch"] = domain.SessionRecord{
		ID:        "mer-orch",
		ProjectID: "mer",
		Kind:      domain.KindOrchestrator,
		Metadata:  domain.SessionMetadata{WorkspacePath: "/ws/mer-orch", Branch: "ao/mer-orchestrator", RuntimeHandleID: "orch-handle"},
		Activity:  domain.Activity{State: domain.ActivityActive},
	}
	st.worktrees["mer-orch"] = []domain.SessionWorktreeRecord{
		{SessionID: "mer-orch", RepoName: domain.RootWorkspaceRepoName, Branch: "ao/mer-orchestrator", WorktreePath: "/ws/mer-orch", State: "active"},
		{SessionID: "mer-orch", RepoName: "api", Branch: "ao/mer-orchestrator", WorktreePath: "/ws/mer-orch/api", State: "active"},
	}

	err := m.RetireForReplacement(ctx, "mer-orch")
	if err == nil || !strings.Contains(err.Error(), "runtime") {
		t.Fatalf("RetireForReplacement err = %v, want runtime failure", err)
	}
	if st.sessions["mer-orch"].IsTerminated {
		t.Fatal("session must remain active when runtime destroy fails")
	}
	if rows := st.worktrees["mer-orch"]; len(rows) != 2 {
		t.Fatalf("workspace repo inventory after runtime failure = %v, want root and child retained", rows)
	}
	for _, call := range ws.calls {
		if strings.HasPrefix(call, "ForceDestroy:") {
			t.Fatalf("ForceDestroy must not run after runtime destroy failure; calls=%v", ws.calls)
		}
	}
}

func TestRetireForReplacementWorkspaceProjectForceDestroyFailureKeepsRepoInventory(t *testing.T) {
	m, st, _, ws := newLifecycleManager()
	ws.forceDestroyErr = errors.New("worktree still registered")
	ws.stashRef = "refs/ao/preserved/mer-orch"
	st.projects["mer"] = domain.ProjectRecord{ID: "mer", Path: "/repos/mer", Kind: domain.ProjectKindWorkspace, Config: testRoleAgents()}
	st.workspaceRepo["mer"] = []domain.WorkspaceRepoRecord{{
		ProjectID:    "mer",
		Name:         "api",
		RelativePath: "api",
	}}
	st.sessions["mer-orch"] = domain.SessionRecord{
		ID:        "mer-orch",
		ProjectID: "mer",
		Kind:      domain.KindOrchestrator,
		Metadata:  domain.SessionMetadata{WorkspacePath: "/ws/mer-orch", Branch: "ao/mer-orchestrator", RuntimeHandleID: "orch-handle"},
		Activity:  domain.Activity{State: domain.ActivityActive},
	}
	st.worktrees["mer-orch"] = []domain.SessionWorktreeRecord{
		{SessionID: "mer-orch", RepoName: domain.RootWorkspaceRepoName, Branch: "ao/mer-orchestrator", WorktreePath: "/ws/mer-orch", State: "active"},
		{SessionID: "mer-orch", RepoName: "api", Branch: "ao/mer-orchestrator", WorktreePath: "/ws/mer-orch/api", State: "active"},
	}

	err := m.RetireForReplacement(ctx, "mer-orch")
	if err == nil || !strings.Contains(err.Error(), "force destroy") {
		t.Fatalf("RetireForReplacement err = %v, want force destroy failure", err)
	}
	if st.sessions["mer-orch"].IsTerminated {
		t.Fatal("session must remain active when force destroy fails")
	}
	if rows := st.worktrees["mer-orch"]; len(rows) != 2 {
		t.Fatalf("workspace repo inventory after force destroy failure = %v, want root and child retained", rows)
	}
}

func TestRetireForReplacementForceDestroyFailureLeavesSessionActive(t *testing.T) {
	m, st, rt, ws := newLifecycleManager()
	ws.forceDestroyErr = errors.New("worktree still registered")
	ws.stashRef = "refs/ao/preserved/mer-orch"
	st.sessions["mer-orch"] = domain.SessionRecord{
		ID:        "mer-orch",
		ProjectID: "mer",
		Kind:      domain.KindOrchestrator,
		Metadata:  domain.SessionMetadata{WorkspacePath: "/ws/mer-orch", Branch: "ao/mer-orchestrator", RuntimeHandleID: "orch-handle"},
		Activity:  domain.Activity{State: domain.ActivityActive},
	}
	st.worktrees["mer-orch"] = []domain.SessionWorktreeRecord{{
		SessionID:    "mer-orch",
		RepoName:     domain.RootWorkspaceRepoName,
		Branch:       "ao/mer-orchestrator",
		WorktreePath: "/ws/mer-orch",
		PreservedRef: "refs/ao/preserved/old",
	}}

	err := m.RetireForReplacement(ctx, "mer-orch")
	if err == nil || !strings.Contains(err.Error(), "force destroy") {
		t.Fatalf("RetireForReplacement err = %v, want force destroy failure", err)
	}
	if st.sessions["mer-orch"].IsTerminated {
		t.Fatal("session must remain active so retry can retire it again")
	}
	if rt.destroyed != 1 {
		t.Fatalf("runtime destroyed = %d, want 1 before workspace release", rt.destroyed)
	}
	if ws.stashCalls != 1 {
		t.Fatalf("stash calls = %d, want 1", ws.stashCalls)
	}
}

func TestRetireForReplacementRuntimeDestroyFailureBlocksWorkspaceRelease(t *testing.T) {
	m, st, rt, ws := newLifecycleManager()
	rt.destroyErr = errors.New("tmux transient")
	ws.stashRef = "refs/ao/preserved/mer-orch"
	st.sessions["mer-orch"] = domain.SessionRecord{
		ID:        "mer-orch",
		ProjectID: "mer",
		Kind:      domain.KindOrchestrator,
		Metadata:  domain.SessionMetadata{WorkspacePath: "/ws/mer-orch", Branch: "ao/mer-orchestrator", RuntimeHandleID: "orch-handle"},
		Activity:  domain.Activity{State: domain.ActivityActive},
	}
	st.worktrees["mer-orch"] = []domain.SessionWorktreeRecord{{
		SessionID:    "mer-orch",
		RepoName:     domain.RootWorkspaceRepoName,
		Branch:       "ao/mer-orchestrator",
		WorktreePath: "/ws/mer-orch",
		PreservedRef: "refs/ao/preserved/old",
	}}

	err := m.RetireForReplacement(ctx, "mer-orch")
	if err == nil || !strings.Contains(err.Error(), "runtime") {
		t.Fatalf("RetireForReplacement err = %v, want runtime failure", err)
	}
	if st.sessions["mer-orch"].IsTerminated {
		t.Fatal("session must remain active when runtime destroy fails")
	}
	if rt.destroyed != 1 || rt.destroyedIDs[0] != "orch-handle" {
		t.Fatalf("runtime destroyed = %d ids=%v, want one attempt for orch-handle", rt.destroyed, rt.destroyedIDs)
	}
	for _, call := range ws.calls {
		if call == "ForceDestroy:mer-orch" {
			t.Fatalf("ForceDestroy must not run after runtime destroy failure; calls=%v", ws.calls)
		}
	}
}

// TestSaveAndTeardownAll_CleanWorktreeWritesEmptyRef verifies that a clean
// worktree (StashUncommitted returns "") still writes a worktree row (with
// empty preserved_ref). The row's presence is the shutdown-saved marker.
func TestSaveAndTeardownAll_CleanWorktreeWritesEmptyRef(t *testing.T) {
	m, st, _, ws := newLifecycleManager()
	ws.stashRef = "" // clean worktree
	st.sessions["mer-1"] = domain.SessionRecord{
		ID:        "mer-1",
		ProjectID: "mer",
		Kind:      domain.KindWorker,
		Metadata:  domain.SessionMetadata{WorkspacePath: "/ws/mer-1", Branch: "ao/mer-1/root", RuntimeHandleID: "h1"},
		Activity:  domain.Activity{State: domain.ActivityActive},
	}

	if err := m.SaveAndTeardownAll(ctx); err != nil {
		t.Fatalf("SaveAndTeardownAll err = %v", err)
	}

	rows := st.worktrees["mer-1"]
	if len(rows) == 0 {
		t.Fatal("clean worktree must still write a session_worktrees row as the shutdown-saved marker")
	}
	if rows[0].PreservedRef != "" {
		t.Fatalf("preserved_ref = %q, want empty for clean worktree", rows[0].PreservedRef)
	}
}

// TestSaveAndTeardownAll_SkipsNoWorkspacePath: sessions without a workspace
// path are skipped (spawn failed before workspace.Create).
func TestSaveAndTeardownAll_SkipsNoWorkspacePath(t *testing.T) {
	m, st, _, ws := newLifecycleManager()
	st.sessions["mer-1"] = domain.SessionRecord{
		ID:        "mer-1",
		ProjectID: "mer",
		Kind:      domain.KindWorker,
		Metadata:  domain.SessionMetadata{}, // no workspace path
		Activity:  domain.Activity{State: domain.ActivityActive},
	}

	if err := m.SaveAndTeardownAll(ctx); err != nil {
		t.Fatalf("SaveAndTeardownAll err = %v", err)
	}

	if len(ws.calls) != 0 {
		t.Fatalf("no workspace calls expected for sessions with no workspace path, got %v", ws.calls)
	}
	if len(st.worktrees["mer-1"]) != 0 {
		t.Fatal("no worktree row should be written for sessions with no workspace path")
	}
}

// TestSaveAndTeardownAll_SkipsAlreadyTerminated: already-terminated sessions
// are skipped.
func TestSaveAndTeardownAll_SkipsAlreadyTerminated(t *testing.T) {
	m, st, _, ws := newLifecycleManager()
	st.sessions["mer-1"] = domain.SessionRecord{
		ID:           "mer-1",
		ProjectID:    "mer",
		Kind:         domain.KindWorker,
		IsTerminated: true,
		Metadata:     domain.SessionMetadata{WorkspacePath: "/ws/mer-1", Branch: "ao/mer-1/root"},
		Activity:     domain.Activity{State: domain.ActivityExited},
	}

	if err := m.SaveAndTeardownAll(ctx); err != nil {
		t.Fatalf("SaveAndTeardownAll err = %v", err)
	}
	if len(ws.calls) != 0 {
		t.Fatalf("already-terminated sessions must be skipped, got calls %v", ws.calls)
	}
}

// TestSaveAndTeardownAll_NoKindFilter: both worker and orchestrator sessions
// are saved (no kind filter).
func TestSaveAndTeardownAll_NoKindFilter(t *testing.T) {
	m, st, _, _ := newLifecycleManager()
	st.sessions["mer-1"] = domain.SessionRecord{
		ID: "mer-1", ProjectID: "mer", Kind: domain.KindWorker,
		Metadata: domain.SessionMetadata{WorkspacePath: "/ws/mer-1", Branch: "ao/mer-1/root", RuntimeHandleID: "h1"},
		Activity: domain.Activity{State: domain.ActivityActive},
	}
	st.sessions["mer-2"] = domain.SessionRecord{
		ID: "mer-2", ProjectID: "mer", Kind: domain.KindOrchestrator,
		Metadata: domain.SessionMetadata{WorkspacePath: "/ws/mer-2", Branch: "ao/mer-orchestrator", RuntimeHandleID: "h2"},
		Activity: domain.Activity{State: domain.ActivityActive},
	}

	if err := m.SaveAndTeardownAll(ctx); err != nil {
		t.Fatalf("SaveAndTeardownAll err = %v", err)
	}

	if len(st.worktrees["mer-1"]) == 0 {
		t.Error("worker session mer-1 must be saved")
	}
	if len(st.worktrees["mer-2"]) == 0 {
		t.Error("orchestrator session mer-2 must be saved")
	}
	if !st.sessions["mer-1"].IsTerminated {
		t.Error("worker session mer-1 must be terminated")
	}
	if !st.sessions["mer-2"].IsTerminated {
		t.Error("orchestrator session mer-2 must be terminated")
	}
}

func TestSaveAndTeardownAll_WorkspaceProjectPreservesEachRepoAndRemovesChildrenFirst(t *testing.T) {
	m, st, _, ws := newLifecycleManager()
	st.projects["mer"] = domain.ProjectRecord{ID: "mer", Path: "/repo/mer", Kind: domain.ProjectKindWorkspace, Config: testRoleAgents()}
	st.workspaceRepo["mer"] = []domain.WorkspaceRepoRecord{{Name: "api", RelativePath: "api"}}
	ws.stashRef = "refs/ao/preserved/mer-1"
	st.sessions["mer-1"] = domain.SessionRecord{
		ID:        "mer-1",
		ProjectID: "mer",
		Kind:      domain.KindWorker,
		Metadata:  domain.SessionMetadata{WorkspacePath: "/ws/mer-1", Branch: "ao/mer-1", RuntimeHandleID: "h1"},
		Activity:  domain.Activity{State: domain.ActivityActive},
	}
	st.worktrees["mer-1"] = []domain.SessionWorktreeRecord{
		{SessionID: "mer-1", RepoName: domain.RootWorkspaceRepoName, Branch: "ao/mer-1", WorktreePath: "/ws/mer-1", BaseSHA: "root-base"},
		{SessionID: "mer-1", RepoName: "api", Branch: "ao/mer-1", WorktreePath: "/ws/mer-1/api", BaseSHA: "api-base"},
	}

	if err := m.SaveAndTeardownAll(ctx); err != nil {
		t.Fatalf("SaveAndTeardownAll err = %v", err)
	}
	rows := st.worktrees["mer-1"]
	if len(rows) != 2 {
		t.Fatalf("worktree rows = %v, want 2", rows)
	}
	refs := map[string]string{}
	for _, row := range rows {
		refs[row.RepoName] = row.PreservedRef
	}
	if refs[domain.RootWorkspaceRepoName] != "refs/ao/preserved/mer-1/__root__" || refs["api"] != "refs/ao/preserved/mer-1/api" {
		t.Fatalf("preserved refs = %v", refs)
	}
	wantSuffix := []string{"ForceDestroy:api", "ForceDestroy:__root__"}
	gotSuffix := ws.calls[len(ws.calls)-2:]
	if strings.Join(gotSuffix, ",") != strings.Join(wantSuffix, ",") {
		t.Fatalf("force destroy suffix = %v, want %v; all calls %v", gotSuffix, wantSuffix, ws.calls)
	}
}

func TestSaveAndTeardownAll_WorkspaceProjectRegistryDriftPreservesWholeWorkspace(t *testing.T) {
	m, st, _, ws := newLifecycleManager()
	st.projects["mer"] = domain.ProjectRecord{
		ID:     "mer",
		Path:   "/repo/mer",
		Kind:   domain.ProjectKindWorkspace,
		Config: testRoleAgents(),
	}
	st.workspaceRepo["mer"] = []domain.WorkspaceRepoRecord{{Name: "api", RelativePath: "api"}}
	st.sessions["mer-1"] = domain.SessionRecord{
		ID:        "mer-1",
		ProjectID: "mer",
		Kind:      domain.KindWorker,
		Metadata:  domain.SessionMetadata{WorkspacePath: "/ws/mer-1", Branch: "ao/mer-1/root", RuntimeHandleID: "h1"},
		Activity:  domain.Activity{State: domain.ActivityActive},
	}
	st.worktrees["mer-1"] = []domain.SessionWorktreeRecord{
		{SessionID: "mer-1", RepoName: domain.RootWorkspaceRepoName, Branch: "ao/mer-1/root", WorktreePath: "/ws/mer-1", State: "active"},
		{SessionID: "mer-1", RepoName: "old-child", Branch: "ao/mer-1/root", WorktreePath: "/ws/mer-1/old-child", State: "active"},
	}

	if err := m.SaveAndTeardownAll(ctx); err != nil {
		t.Fatalf("SaveAndTeardownAll err = %v", err)
	}
	if ws.stashCalls != 0 {
		t.Fatalf("stash calls = %d, want 0 when registry drift makes rows unsafe", ws.stashCalls)
	}
	for _, call := range ws.calls {
		if strings.HasPrefix(call, "ForceDestroy:") {
			t.Fatalf("ForceDestroy must not run when a historical child row is unresolved; calls=%v", ws.calls)
		}
	}
	if st.sessions["mer-1"].IsTerminated {
		t.Fatal("session should remain live when teardown is skipped for registry drift")
	}
}

// TestRestoreAll_RestoresBothWorkerAndOrchestrator verifies (b): RestoreAll
// restores both a worker and an orchestrator session saved by SaveAndTeardownAll.
func TestRestoreAll_RestoresBothWorkerAndOrchestrator(t *testing.T) {
	m, st, rt, _ := newLifecycleManager()

	// Seed two terminated sessions that were saved by SaveAndTeardownAll
	// (presence of session_worktrees rows is the marker).
	st.sessions["mer-1"] = domain.SessionRecord{
		ID:           "mer-1",
		ProjectID:    "mer",
		Kind:         domain.KindWorker,
		Harness:      domain.HarnessClaudeCode,
		IsTerminated: true,
		Metadata:     domain.SessionMetadata{WorkspacePath: "/ws/mer-1", Branch: "ao/mer-1/root", AgentSessionID: "agent-w"},
		Activity:     domain.Activity{State: domain.ActivityExited},
	}
	st.sessions["mer-2"] = domain.SessionRecord{
		ID:           "mer-2",
		ProjectID:    "mer",
		Kind:         domain.KindOrchestrator,
		Harness:      domain.HarnessClaudeCode,
		IsTerminated: true,
		Metadata:     domain.SessionMetadata{WorkspacePath: "/ws/mer-2", Branch: "ao/mer-orchestrator", AgentSessionID: "agent-o"},
		Activity:     domain.Activity{State: domain.ActivityExited},
	}
	// Write the shutdown-saved marker rows.
	st.worktrees["mer-1"] = []domain.SessionWorktreeRecord{{SessionID: "mer-1", RepoName: "__root__", PreservedRef: "", State: "removed"}}
	st.worktrees["mer-2"] = []domain.SessionWorktreeRecord{{SessionID: "mer-2", RepoName: "__root__", PreservedRef: "", State: "removed"}}

	if err := m.RestoreAll(ctx); err != nil {
		t.Fatalf("RestoreAll err = %v", err)
	}

	if rt.created != 2 {
		t.Fatalf("RestoreAll must relaunch both sessions, runtime.Create called %d times", rt.created)
	}
	if st.sessions["mer-1"].IsTerminated {
		t.Error("worker session mer-1 must be live after RestoreAll")
	}
	if st.sessions["mer-2"].IsTerminated {
		t.Error("orchestrator session mer-2 must be live after RestoreAll")
	}
}

func TestRestoreAll_RestoresLegacyShutdownMarkerWithoutState(t *testing.T) {
	m, st, rt, _ := newLifecycleManager()
	st.sessions["mer-1"] = domain.SessionRecord{
		ID:           "mer-1",
		ProjectID:    "mer",
		Kind:         domain.KindWorker,
		Harness:      domain.HarnessClaudeCode,
		IsTerminated: true,
		Metadata:     domain.SessionMetadata{WorkspacePath: "/ws/mer-1", Branch: "ao/mer-1/root", AgentSessionID: "agent-w"},
		Activity:     domain.Activity{State: domain.ActivityExited},
	}
	st.worktrees["mer-1"] = []domain.SessionWorktreeRecord{
		{SessionID: "mer-1", RepoName: domain.RootWorkspaceRepoName, WorktreePath: "/ws/mer-1"},
	}

	if err := m.RestoreAll(ctx); err != nil {
		t.Fatalf("RestoreAll err = %v", err)
	}
	if rt.created != 1 {
		t.Fatalf("legacy shutdown marker must relaunch once, runtime.Create called %d times", rt.created)
	}
	if st.sessions["mer-1"].IsTerminated {
		t.Fatal("legacy shutdown marker session must be live after RestoreAll")
	}
	if rows := st.worktrees["mer-1"]; len(rows) != 0 {
		t.Fatalf("consumed restore marker = %+v, want deleted", rows)
	}
}

// TestRestoreAll_SkipsSessionsKilledBeforeShutdown verifies (c): a session
// the user killed BEFORE shutdown has no session_worktrees row and must NOT
// be resurrected.
func TestRestoreAll_SkipsSessionsKilledBeforeShutdown(t *testing.T) {
	m, st, rt, _ := newLifecycleManager()

	// This session was killed by the user before shutdown: IsTerminated=true,
	// but no session_worktrees row (SaveAndTeardownAll skipped it).
	st.sessions["mer-1"] = domain.SessionRecord{
		ID:           "mer-1",
		ProjectID:    "mer",
		Kind:         domain.KindWorker,
		Harness:      domain.HarnessClaudeCode,
		IsTerminated: true,
		Metadata:     domain.SessionMetadata{WorkspacePath: "/ws/mer-1", Branch: "ao/mer-1/root", Prompt: "do it"},
		Activity:     domain.Activity{State: domain.ActivityExited},
	}
	// Deliberately no entry in st.worktrees for mer-1.

	if err := m.RestoreAll(ctx); err != nil {
		t.Fatalf("RestoreAll err = %v", err)
	}

	if rt.created != 0 {
		t.Fatalf("user-killed session must not be restored, runtime.Create called %d times", rt.created)
	}
	if !st.sessions["mer-1"].IsTerminated {
		t.Error("user-killed session must remain terminated")
	}
}

// TestRestoreAll_DeletesMarkerAfterRelaunch covers issue #2319 (b): the
// shutdown-saved marker is one-shot. After RestoreAll relaunches a session, its
// session_worktrees marker is deleted, so a second RestoreAll (with no fresh
// marker) does NOT relaunch it again.
func TestRestoreAll_DeletesMarkerAfterRelaunch(t *testing.T) {
	m, st, rt, _ := newLifecycleManager()

	st.sessions["mer-1"] = domain.SessionRecord{
		ID:           "mer-1",
		ProjectID:    "mer",
		Kind:         domain.KindWorker,
		Harness:      domain.HarnessClaudeCode,
		IsTerminated: true,
		Metadata:     domain.SessionMetadata{WorkspacePath: "/ws/mer-1", Branch: "ao/mer-1/root", AgentSessionID: "agent-w"},
		Activity:     domain.Activity{State: domain.ActivityExited},
	}
	st.worktrees["mer-1"] = []domain.SessionWorktreeRecord{{SessionID: "mer-1", RepoName: "__root__", State: "removed"}}

	if err := m.RestoreAll(ctx); err != nil {
		t.Fatalf("RestoreAll err = %v", err)
	}
	if rt.created != 1 {
		t.Fatalf("first RestoreAll must relaunch once, runtime.Create called %d times", rt.created)
	}
	rows, err := st.ListSessionWorktrees(ctx, "mer-1")
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 0 {
		t.Fatalf("RestoreAll must delete the one-shot marker, got %d rows", len(rows))
	}
}

// TestRestoreAll_KilledSessionNotResurrectedOnSecondBoot covers issue #2319 (c),
// the killed-session-resurrection scenario. A terminated session WITH a marker
// is relaunched exactly once; on a second RestoreAll (no new marker) it stays
// terminated and is not relaunched again.
func TestRestoreAll_KilledSessionNotResurrectedOnSecondBoot(t *testing.T) {
	m, st, rt, _ := newLifecycleManager()

	st.sessions["mer-1"] = domain.SessionRecord{
		ID:           "mer-1",
		ProjectID:    "mer",
		Kind:         domain.KindWorker,
		Harness:      domain.HarnessClaudeCode,
		IsTerminated: true,
		Metadata:     domain.SessionMetadata{WorkspacePath: "/ws/mer-1", Branch: "ao/mer-1/root", AgentSessionID: "agent-w"},
		Activity:     domain.Activity{State: domain.ActivityExited},
	}
	st.worktrees["mer-1"] = []domain.SessionWorktreeRecord{{SessionID: "mer-1", RepoName: "__root__", State: "removed"}}

	// First boot: marker present, session relaunches once.
	if err := m.RestoreAll(ctx); err != nil {
		t.Fatalf("first RestoreAll err = %v", err)
	}
	if rt.created != 1 {
		t.Fatalf("first RestoreAll must relaunch once, runtime.Create called %d times", rt.created)
	}

	// Simulate the user killing the relaunched session before the next quit, so
	// it has no fresh marker, then a second boot.
	if _, err := m.Kill(ctx, "mer-1"); err != nil {
		t.Fatalf("kill err = %v", err)
	}
	if err := m.RestoreAll(ctx); err != nil {
		t.Fatalf("second RestoreAll err = %v", err)
	}
	if rt.created != 1 {
		t.Fatalf("killed session must NOT be resurrected on second boot, runtime.Create total = %d, want 1", rt.created)
	}
	if !st.sessions["mer-1"].IsTerminated {
		t.Error("killed session must remain terminated after second RestoreAll")
	}
}

func TestRestoreAll_SkipsActiveWorkspaceProjectRowsFromUserKilledSession(t *testing.T) {
	m, st, rt, _ := newLifecycleManager()
	st.projects["mer"] = domain.ProjectRecord{ID: "mer", Path: "/repo/mer", Kind: domain.ProjectKindWorkspace, Config: testRoleAgents()}
	st.workspaceRepo["mer"] = []domain.WorkspaceRepoRecord{{Name: "api", RelativePath: "api"}}
	st.sessions["mer-1"] = domain.SessionRecord{
		ID:           "mer-1",
		ProjectID:    "mer",
		Kind:         domain.KindWorker,
		Harness:      domain.HarnessClaudeCode,
		IsTerminated: true,
		Metadata:     domain.SessionMetadata{WorkspacePath: "/ws/mer-1", Branch: "ao/mer-1", Prompt: "do it"},
		Activity:     domain.Activity{State: domain.ActivityExited},
	}
	st.worktrees["mer-1"] = []domain.SessionWorktreeRecord{
		{SessionID: "mer-1", RepoName: domain.RootWorkspaceRepoName, Branch: "ao/mer-1", WorktreePath: "/ws/mer-1", State: "active"},
		{SessionID: "mer-1", RepoName: "api", Branch: "ao/mer-1", WorktreePath: "/ws/mer-1/api", State: "active"},
	}

	if err := m.RestoreAll(ctx); err != nil {
		t.Fatalf("RestoreAll err = %v", err)
	}
	if rt.created != 0 {
		t.Fatalf("active inventory rows must not resurrect user-killed sessions, runtime.Create called %d times", rt.created)
	}
}

// TestRestoreAll_AppliesPreservedRef: when the session_worktrees row has a
// non-empty preserved_ref, RestoreAll calls ApplyPreserved after workspace
// restore but before relaunching.
func TestRestoreAll_AppliesPreservedRef(t *testing.T) {
	m, st, rt, ws := newLifecycleManager()

	st.sessions["mer-1"] = domain.SessionRecord{
		ID:           "mer-1",
		ProjectID:    "mer",
		Kind:         domain.KindWorker,
		Harness:      domain.HarnessClaudeCode,
		IsTerminated: true,
		Metadata:     domain.SessionMetadata{WorkspacePath: "/ws/mer-1", Branch: "ao/mer-1/root", AgentSessionID: "agent-w"},
		Activity:     domain.Activity{State: domain.ActivityExited},
	}
	st.worktrees["mer-1"] = []domain.SessionWorktreeRecord{
		{SessionID: "mer-1", RepoName: "__root__", PreservedRef: "refs/ao/preserved/mer-1", State: "removed"},
	}

	if err := m.RestoreAll(ctx); err != nil {
		t.Fatalf("RestoreAll err = %v", err)
	}

	applied := false
	for _, c := range ws.calls {
		if c == "ApplyPreserved:mer-1" {
			applied = true
		}
	}
	if !applied {
		t.Fatal("ApplyPreserved was not called for session with preserved_ref")
	}
	if rt.created != 1 {
		t.Fatal("session must still be relaunched even after ApplyPreserved")
	}
}

// TestRestoreAll_ConflictLogsAndContinues: when ApplyPreserved returns
// ErrPreservedConflict, RestoreAll logs and continues (still relaunches).
func TestRestoreAll_ConflictLogsAndContinues(t *testing.T) {
	st := newFakeStore()
	st.projects["mer"] = domain.ProjectRecord{ID: "mer", Config: testRoleAgents()}
	rt := &fakeRuntime{}
	ws := &fakeWorkspace{applyErr: fmt.Errorf("conflict: %w", ports.ErrPreservedConflict)}
	var logBuf bytes.Buffer
	lookPath := func(string) (string, error) { return "/bin/true", nil }
	m := New(Deps{
		Runtime:   rt,
		Agents:    fakeAgents{},
		Workspace: ws,
		Store:     st,
		Messenger: &fakeMessenger{},
		Lifecycle: &fakeLCM{store: st},
		LookPath:  lookPath,
		Logger:    slog.New(slog.NewTextHandler(&logBuf, nil)),
	})

	st.sessions["mer-1"] = domain.SessionRecord{
		ID:           "mer-1",
		ProjectID:    "mer",
		Kind:         domain.KindWorker,
		Harness:      domain.HarnessClaudeCode,
		IsTerminated: true,
		Metadata:     domain.SessionMetadata{WorkspacePath: "/ws/mer-1", Branch: "ao/mer-1/root", AgentSessionID: "agent-w"},
		Activity:     domain.Activity{State: domain.ActivityExited},
	}
	st.worktrees["mer-1"] = []domain.SessionWorktreeRecord{
		{SessionID: "mer-1", RepoName: "__root__", PreservedRef: "refs/ao/preserved/mer-1", State: "removed"},
	}

	if err := m.RestoreAll(ctx); err != nil {
		t.Fatalf("RestoreAll err = %v; conflict must not abort", err)
	}
	if rt.created != 1 {
		t.Fatalf("session must still relaunch after conflict, runtime.Create called %d times", rt.created)
	}
}

func TestRestoreAll_WorkspaceProjectRestoresAndAppliesEachRepo(t *testing.T) {
	m, st, rt, ws := newLifecycleManager()
	st.projects["mer"] = domain.ProjectRecord{ID: "mer", Path: "/repo/mer", Kind: domain.ProjectKindWorkspace, Config: testRoleAgents()}
	st.workspaceRepo["mer"] = []domain.WorkspaceRepoRecord{{Name: "api", RelativePath: "api"}}
	st.sessions["mer-1"] = domain.SessionRecord{
		ID:           "mer-1",
		ProjectID:    "mer",
		Kind:         domain.KindWorker,
		Harness:      domain.HarnessClaudeCode,
		IsTerminated: true,
		Metadata:     domain.SessionMetadata{WorkspacePath: "/ws/mer-1", Branch: "ao/mer-1", AgentSessionID: "agent-w"},
		Activity:     domain.Activity{State: domain.ActivityExited},
	}
	st.worktrees["mer-1"] = []domain.SessionWorktreeRecord{
		{SessionID: "mer-1", RepoName: domain.RootWorkspaceRepoName, Branch: "ao/mer-1", WorktreePath: "/ws/mer-1", PreservedRef: "refs/ao/preserved/mer-1", State: "removed"},
		{SessionID: "mer-1", RepoName: "api", Branch: "ao/mer-1", WorktreePath: "/ws/mer-1/api", PreservedRef: "refs/ao/preserved/mer-1", State: "removed"},
	}

	if err := m.RestoreAll(ctx); err != nil {
		t.Fatalf("RestoreAll err = %v", err)
	}
	wantPrefix := []string{"Restore:__root__", "Restore:api"}
	if got := ws.calls[:2]; strings.Join(got, ",") != strings.Join(wantPrefix, ",") {
		t.Fatalf("restore prefix = %v, want %v; all calls %v", got, wantPrefix, ws.calls)
	}
	applied := strings.Join(ws.calls, ",")
	if !strings.Contains(applied, "ApplyPreserved:__root__:refs/ao/preserved/mer-1") ||
		!strings.Contains(applied, "ApplyPreserved:api:refs/ao/preserved/mer-1") {
		t.Fatalf("apply calls missing, got %v", ws.calls)
	}
	if rt.created != 1 {
		t.Fatalf("runtime.Create calls = %d, want 1", rt.created)
	}
	rows, err := st.ListSessionWorktrees(ctx, "mer-1")
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 2 {
		t.Fatalf("workspace project rows after RestoreAll = %v, want root and child inventory", rows)
	}
	states := map[string]string{}
	for _, row := range rows {
		states[row.RepoName] = row.State
		if row.PreservedRef != "" {
			t.Fatalf("row %s preserved_ref = %q, want consumed", row.RepoName, row.PreservedRef)
		}
	}
	if states[domain.RootWorkspaceRepoName] != "active" || states["api"] != "active" {
		t.Fatalf("workspace project row states = %v, want active inventory", states)
	}
}

func TestRestoreAll_WorkspaceProjectRootOnlyMarkerRestoresRegisteredChildren(t *testing.T) {
	m, st, rt, ws := newLifecycleManager()
	st.projects["mer"] = domain.ProjectRecord{ID: "mer", Path: "/repo/mer", Kind: domain.ProjectKindWorkspace, Config: testRoleAgents()}
	st.workspaceRepo["mer"] = []domain.WorkspaceRepoRecord{{Name: "api", RelativePath: "api"}}
	st.sessions["mer-1"] = domain.SessionRecord{
		ID:           "mer-1",
		ProjectID:    "mer",
		Kind:         domain.KindWorker,
		Harness:      domain.HarnessClaudeCode,
		IsTerminated: true,
		Metadata:     domain.SessionMetadata{WorkspacePath: "/ws/mer-1", Branch: "ao/mer-1", AgentSessionID: "agent-w"},
		Activity:     domain.Activity{State: domain.ActivityExited},
	}
	st.worktrees["mer-1"] = []domain.SessionWorktreeRecord{{
		SessionID:    "mer-1",
		RepoName:     domain.RootWorkspaceRepoName,
		Branch:       "ao/mer-1",
		WorktreePath: "/ws/mer-1",
		PreservedRef: "refs/ao/preserved/root",
		State:        "removed",
	}}

	if err := m.RestoreAll(ctx); err != nil {
		t.Fatalf("RestoreAll err = %v", err)
	}
	wantPrefix := []string{"Restore:__root__", "Restore:api"}
	if got := ws.calls[:2]; strings.Join(got, ",") != strings.Join(wantPrefix, ",") {
		t.Fatalf("restore prefix = %v, want %v; all calls %v", got, wantPrefix, ws.calls)
	}
	applied := strings.Join(ws.calls, ",")
	if !strings.Contains(applied, "ApplyPreserved:__root__:refs/ao/preserved/root") {
		t.Fatalf("root preserved ref was not applied; calls=%v", ws.calls)
	}
	if rt.created != 1 {
		t.Fatalf("runtime.Create calls = %d, want 1", rt.created)
	}
	rows, err := st.ListSessionWorktrees(ctx, "mer-1")
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 2 {
		t.Fatalf("workspace project rows after RestoreAll = %v, want root and registered child", rows)
	}
	states := map[string]string{}
	for _, row := range rows {
		states[row.RepoName] = row.State
		if row.PreservedRef != "" {
			t.Fatalf("row %s preserved_ref = %q, want consumed", row.RepoName, row.PreservedRef)
		}
	}
	if states[domain.RootWorkspaceRepoName] != "active" || states["api"] != "active" {
		t.Fatalf("workspace project row states = %v, want active root and child", states)
	}
}

func TestReconcileLive_DeadSessionStashedAndTerminated(t *testing.T) {
	st := newFakeStore()
	rt := &fakeRuntime{aliveByHandle: map[string]bool{}} // handle not alive
	ws := &fakeWorkspace{stashRef: "refs/ao/preserved/s1"}
	lcm := &fakeLCM{store: st}
	lookPath := func(string) (string, error) { return "/bin/true", nil }
	m := New(Deps{Runtime: rt, Agents: fakeAgents{}, Workspace: ws, Store: st, Messenger: &fakeMessenger{}, Lifecycle: lcm, LookPath: lookPath})

	rec := domain.SessionRecord{
		ID:           "s1",
		ProjectID:    "p1",
		IsTerminated: false,
		Metadata: domain.SessionMetadata{
			Branch: "ao/s1/root", WorkspacePath: "/wt/s1", RuntimeHandleID: "s1",
		},
	}

	if err := m.reconcileLive(context.Background(), rec); err != nil {
		t.Fatalf("reconcileLive: %v", err)
	}
	if ws.stashCalls != 1 {
		t.Fatalf("StashUncommitted calls = %d, want 1", ws.stashCalls)
	}
	if lcm.terminated["s1"] != 1 {
		t.Fatalf("MarkTerminated(s1) = %d, want 1", lcm.terminated["s1"])
	}
	if rt.destroyed != 0 {
		t.Fatalf("Destroy calls = %d, want 0 (dead session: no tmux to kill)", rt.destroyed)
	}
	// The crash-orphaned session must be saved for restore, exactly like a
	// graceful shutdown: a session_worktrees marker carrying the preserve ref,
	// and the worktree torn down so RestoreAll re-creates it clean.
	rows := st.worktrees["s1"]
	if len(rows) != 1 || rows[0].PreservedRef != "refs/ao/preserved/s1" {
		t.Fatalf("session_worktrees marker for s1 = %+v, want one row with the preserve ref", rows)
	}
	foundForceDestroy := false
	for _, c := range ws.calls {
		if c == "ForceDestroy:s1" {
			foundForceDestroy = true
		}
	}
	if !foundForceDestroy {
		t.Fatalf("reconcileLive must ForceDestroy the worktree after capturing work; calls = %v", ws.calls)
	}
}

func TestReconcileLive_IncompleteWorktreeSessionTerminated(t *testing.T) {
	for _, tc := range []struct {
		name string
		meta domain.SessionMetadata
	}{
		{"missing workspace", domain.SessionMetadata{Branch: "ao/s1/root", RuntimeHandleID: "s1"}},
		{"missing branch", domain.SessionMetadata{WorkspacePath: "/wt/s1", RuntimeHandleID: "s1"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			st := newFakeStore()
			rt := &fakeRuntime{aliveByHandle: map[string]bool{"s1": true}}
			ws := &fakeWorkspace{}
			lcm := &fakeLCM{store: st}
			lookPath := func(string) (string, error) { return "/bin/true", nil }
			m := New(Deps{Runtime: rt, Agents: fakeAgents{}, Workspace: ws, Store: st, Messenger: &fakeMessenger{}, Lifecycle: lcm, LookPath: lookPath})

			rec := domain.SessionRecord{ID: "s1", ProjectID: "p1", IsTerminated: false, Metadata: tc.meta}
			if err := m.reconcileLive(context.Background(), rec); err != nil {
				t.Fatalf("reconcileLive: %v", err)
			}
			if lcm.terminated["s1"] != 1 {
				t.Fatalf("MarkTerminated(s1) = %d, want 1 for incomplete worktree row", lcm.terminated["s1"])
			}
			if ws.stashCalls != 0 || rt.destroyed != 1 || len(st.worktrees["s1"]) != 0 {
				t.Fatalf("incomplete row should terminate with runtime destroy but without stash/restore marker: stash=%d destroy=%d rows=%+v", ws.stashCalls, rt.destroyed, st.worktrees["s1"])
			}
		})
	}
}

func TestReconcileLive_OrchestratorMissingWorktreeIsRestored(t *testing.T) {
	st := newFakeStore()
	st.projects["p1"] = domain.ProjectRecord{ID: "p1", Config: testRoleAgents()}
	rt := &fakeRuntime{aliveByHandle: map[string]bool{}} // handle not alive
	ws := &fakeWorkspace{stashErr: fmt.Errorf("dirty check: %w", os.ErrNotExist)}
	lcm := &fakeLCM{store: st}
	lookPath := func(string) (string, error) { return "/bin/true", nil }
	m := New(Deps{Runtime: rt, Agents: fakeAgents{}, Workspace: ws, Store: st, Messenger: &fakeMessenger{}, Lifecycle: lcm, LookPath: lookPath})

	rec := domain.SessionRecord{
		ID:           "p1-orch",
		ProjectID:    "p1",
		Kind:         domain.KindOrchestrator,
		Harness:      domain.HarnessClaudeCode,
		IsTerminated: false,
		Metadata: domain.SessionMetadata{
			Branch: "ao/p1-orchestrator", WorkspacePath: "/wt/p1-orch", RuntimeHandleID: "orch",
		},
	}
	st.sessions[rec.ID] = rec

	if err := m.reconcileLive(context.Background(), rec); err != nil {
		t.Fatalf("reconcileLive: %v", err)
	}
	if lcm.terminated[rec.ID] != 1 {
		t.Fatalf("missing orchestrator must be marked terminated once before restore; got %d", lcm.terminated[rec.ID])
	}
	if got := ws.lastCfg; got.ProjectID != "p1" || got.SessionID != rec.ID || got.Kind != domain.KindOrchestrator || got.Branch != "ao/p1-orchestrator" {
		t.Fatalf("Restore config = %+v, want orchestrator session config", got)
	}
	if rt.created != 1 {
		t.Fatalf("missing orchestrator worktree must relaunch runtime once, got %d", rt.created)
	}
	if st.sessions[rec.ID].IsTerminated {
		t.Fatal("missing orchestrator must be live after same-boot restore")
	}
	if rows := st.worktrees[rec.ID]; len(rows) != 0 {
		t.Fatalf("restore marker must be consumed after successful restore, got %+v", rows)
	}
}

func TestReconcileLive_AliveSessionAdoptedNoop(t *testing.T) {
	st := newFakeStore()
	rt := &fakeRuntime{aliveByHandle: map[string]bool{"s2": true}}
	ws := &fakeWorkspace{}
	lcm := &fakeLCM{store: st}
	lookPath := func(string) (string, error) { return "/bin/true", nil }
	m := New(Deps{Runtime: rt, Agents: fakeAgents{}, Workspace: ws, Store: st, Messenger: &fakeMessenger{}, Lifecycle: lcm, LookPath: lookPath})

	rec := domain.SessionRecord{
		ID: "s2", ProjectID: "p1", IsTerminated: false,
		Metadata: domain.SessionMetadata{Branch: "ao/s2/root", WorkspacePath: "/wt/s2", RuntimeHandleID: "s2"},
	}

	if err := m.reconcileLive(context.Background(), rec); err != nil {
		t.Fatalf("reconcileLive: %v", err)
	}
	if ws.stashCalls != 0 || lcm.terminated["s2"] != 0 || rt.destroyed != 0 {
		t.Fatalf("adopt should be a no-op: stash=%d term=%d destroy=%d", ws.stashCalls, lcm.terminated["s2"], rt.destroyed)
	}
}

func TestReconcileLive_PrimePaneAliveButAgentExitedTerminatesForReplacement(t *testing.T) {
	st := newFakeStore()
	rt := &fakeRuntime{
		aliveByHandle:        map[string]bool{"ao-prime": true},
		processAliveByHandle: map[string]bool{"ao-prime": false},
	}
	ws := &fakeWorkspace{stashRef: "refs/ao/preserved/ao-prime"}
	lcm := &fakeLCM{store: st}
	lookPath := func(string) (string, error) { return "/bin/true", nil }
	m := New(Deps{Runtime: rt, Agents: fakeAgents{}, Workspace: ws, Store: st, Messenger: &fakeMessenger{}, Lifecycle: lcm, LookPath: lookPath})

	rec := domain.SessionRecord{
		ID:           "ao-prime",
		ProjectID:    "ao",
		Kind:         domain.KindPrime,
		IsTerminated: false,
		Metadata: domain.SessionMetadata{
			Branch: "ao/prime/root", WorkspacePath: "/wt/prime", RuntimeHandleID: "ao-prime",
		},
	}

	if err := m.reconcileLive(context.Background(), rec); err != nil {
		t.Fatalf("reconcileLive: %v", err)
	}
	if lcm.terminated["ao-prime"] != 1 {
		t.Fatalf("MarkTerminated(ao-prime) = %d, want 1", lcm.terminated["ao-prime"])
	}
	if ws.stashCalls != 1 {
		t.Fatalf("StashUncommitted calls = %d, want 1", ws.stashCalls)
	}
	if rows := st.worktrees["ao-prime"]; len(rows) != 1 {
		t.Fatalf("session_worktrees marker for prime = %+v, want one restore marker", rows)
	}
	if len(rt.destroyedIDs) != 1 || rt.destroyedIDs[0] != "ao-prime" {
		t.Fatalf("destroyed runtime handles = %v, want [ao-prime]", rt.destroyedIDs)
	}
}

func TestReconcileLive_WorkerPaneAliveButAgentExitedTerminatesForRestore(t *testing.T) {
	st := newFakeStore()
	rt := &fakeRuntime{
		aliveByHandle:        map[string]bool{"worker": true},
		processAliveByHandle: map[string]bool{"worker": false},
	}
	ws := &fakeWorkspace{stashRef: "refs/ao/preserved/worker"}
	lcm := &fakeLCM{store: st}
	lookPath := func(string) (string, error) { return "/bin/true", nil }
	m := New(Deps{Runtime: rt, Agents: fakeAgents{}, Workspace: ws, Store: st, Messenger: &fakeMessenger{}, Lifecycle: lcm, LookPath: lookPath})

	rec := domain.SessionRecord{
		ID:           "worker",
		ProjectID:    "ao",
		Kind:         domain.KindWorker,
		IsTerminated: false,
		Metadata: domain.SessionMetadata{
			Branch: "ao/worker/root", WorkspacePath: "/wt/worker", RuntimeHandleID: "worker",
		},
	}

	if err := m.reconcileLive(context.Background(), rec); err != nil {
		t.Fatalf("reconcileLive: %v", err)
	}
	if lcm.terminated["worker"] != 1 {
		t.Fatalf("MarkTerminated(worker) = %d, want 1", lcm.terminated["worker"])
	}
	if ws.stashCalls != 1 {
		t.Fatalf("StashUncommitted calls = %d, want 1", ws.stashCalls)
	}
	if rows := st.worktrees["worker"]; len(rows) != 1 {
		t.Fatalf("session_worktrees marker for worker = %+v, want one restore marker", rows)
	}
	if len(rt.destroyedIDs) != 1 || rt.destroyedIDs[0] != "worker" {
		t.Fatalf("destroyed runtime handles = %v, want [worker]", rt.destroyedIDs)
	}
}

func TestReconcileLive_PaneAliveAgentExitedDestroysRuntimeWhenStashFails(t *testing.T) {
	st := newFakeStore()
	rt := &fakeRuntime{
		aliveByHandle:        map[string]bool{"worker": true},
		processAliveByHandle: map[string]bool{"worker": false},
	}
	ws := &fakeWorkspace{stashErr: errors.New("dirty check failed")}
	lcm := &fakeLCM{store: st}
	lookPath := func(string) (string, error) { return "/bin/true", nil }
	m := New(Deps{Runtime: rt, Agents: fakeAgents{}, Workspace: ws, Store: st, Messenger: &fakeMessenger{}, Lifecycle: lcm, LookPath: lookPath})

	rec := domain.SessionRecord{
		ID:           "worker",
		ProjectID:    "ao",
		Kind:         domain.KindWorker,
		IsTerminated: false,
		Metadata: domain.SessionMetadata{
			Branch: "ao/worker/root", WorkspacePath: "/wt/worker", RuntimeHandleID: "worker",
		},
	}

	if err := m.reconcileLive(context.Background(), rec); err != nil {
		t.Fatalf("reconcileLive: %v", err)
	}
	if lcm.terminated["worker"] != 1 {
		t.Fatalf("MarkTerminated(worker) = %d, want 1", lcm.terminated["worker"])
	}
	if rows := st.worktrees["worker"]; len(rows) != 0 {
		t.Fatalf("stash failure must not create restore markers, got %+v", rows)
	}
	if len(rt.destroyedIDs) != 1 || rt.destroyedIDs[0] != "worker" {
		t.Fatalf("destroyed runtime handles = %v, want [worker]", rt.destroyedIDs)
	}
}

// TestReconcileLive_ProbeErrorIsNotDeath locks the invariant that a failed
// IsAlive probe is NOT treated as proof that the session is dead. reconcileLive
// must propagate the error and must NOT stash, terminate, or destroy.
func TestReconcileLive_ProbeErrorIsNotDeath(t *testing.T) {
	st := newFakeStore()
	rt := &fakeRuntime{aliveErr: errors.New("probe boom")}
	ws := &fakeWorkspace{}
	lcm := &fakeLCM{store: st}
	lookPath := func(string) (string, error) { return "/bin/true", nil }
	m := New(Deps{Runtime: rt, Agents: fakeAgents{}, Workspace: ws, Store: st, Messenger: &fakeMessenger{}, Lifecycle: lcm, LookPath: lookPath})

	rec := domain.SessionRecord{
		ID:           "s3",
		ProjectID:    "p1",
		IsTerminated: false,
		Metadata: domain.SessionMetadata{
			Branch: "ao/s3/root", WorkspacePath: "/wt/s3", RuntimeHandleID: "s3",
		},
	}

	err := m.reconcileLive(context.Background(), rec)
	if err == nil {
		t.Fatal("reconcileLive: expected non-nil error on probe failure, got nil")
	}
	if ws.stashCalls != 0 {
		t.Fatalf("StashUncommitted calls = %d, want 0 (probe error is not death)", ws.stashCalls)
	}
	if lcm.terminated["s3"] != 0 {
		t.Fatalf("MarkTerminated(s3) = %d, want 0 (probe error is not death)", lcm.terminated["s3"])
	}
	if rt.destroyed != 0 {
		t.Fatalf("Destroy calls = %d, want 0 (probe error is not death)", rt.destroyed)
	}
}

// TestReconcile_AdoptAcrossDaemonRestart is the end-to-end durability proof for
// #2335: it drives the full boot-time Reconcile pass over the exact mix of
// session states a daemon restart/upgrade leaves behind and asserts agent
// sessions are decoupled from the daemon's lifetime:
//
//   - an alive orchestrator is ADOPTED in place: same id, still live, its runtime
//     never torn down, and NO new session minted (the id-increment regression
//     guard: adoption failure used to mint a fresh orchestrator id 14->15->16).
//   - an alive worker is adopted as a no-op.
//   - a worker whose runtime died with the daemon has its work captured (stashed
//     into a preserve ref, restore marker written) and is relaunched on this same
//     boot under its ORIGINAL id.
//   - a truly-dead session with no restore marker is NOT resurrected.
func TestReconcile_AdoptAcrossDaemonRestart(t *testing.T) {
	st := newFakeStore()
	st.projects["mer"] = domain.ProjectRecord{ID: "mer", Config: testRoleAgents()}
	rt := &fakeRuntime{aliveByHandle: map[string]bool{
		"orch":    true, // orchestrator runtime survived the daemon exit
		"w-alive": true, // worker runtime survived the daemon exit
		// "w-dead" is absent -> that worker's runtime died with the daemon.
	}}
	ws := &fakeWorkspace{stashRef: "refs/ao/preserved/mer-3"}
	lcm := &fakeLCM{store: st}
	lookPath := func(string) (string, error) { return "/bin/true", nil }
	m := New(Deps{Runtime: rt, Agents: fakeAgents{}, Workspace: ws, Store: st, Messenger: &fakeMessenger{}, Lifecycle: lcm, LookPath: lookPath})

	// Alive orchestrator: the promptless session whose adoption failure used to
	// mint a fresh orchestrator id. It must be adopted in place.
	st.sessions["mer-1"] = domain.SessionRecord{
		ID: "mer-1", ProjectID: "mer", Kind: domain.KindOrchestrator, Harness: domain.HarnessClaudeCode,
		Metadata: domain.SessionMetadata{Branch: "ao/mer-1/root", WorkspacePath: "/ws/mer-1", RuntimeHandleID: "orch"},
	}
	// Alive worker: adopted as a no-op.
	st.sessions["mer-2"] = domain.SessionRecord{
		ID: "mer-2", ProjectID: "mer", Kind: domain.KindWorker, Harness: domain.HarnessClaudeCode,
		Metadata: domain.SessionMetadata{Branch: "ao/mer-2/root", WorkspacePath: "/ws/mer-2", RuntimeHandleID: "w-alive", AgentSessionID: "agent-2"},
	}
	// Dead worker: its runtime died with the daemon; capture + relaunch under same id.
	st.sessions["mer-3"] = domain.SessionRecord{
		ID: "mer-3", ProjectID: "mer", Kind: domain.KindWorker, Harness: domain.HarnessClaudeCode,
		Metadata: domain.SessionMetadata{Branch: "ao/mer-3/root", WorkspacePath: "/ws/mer-3", RuntimeHandleID: "w-dead", AgentSessionID: "agent-3"},
	}
	// Truly-dead session the user killed before restart (terminated, no marker).
	st.sessions["mer-4"] = domain.SessionRecord{
		ID: "mer-4", ProjectID: "mer", Kind: domain.KindWorker, Harness: domain.HarnessClaudeCode,
		IsTerminated: true, Activity: domain.Activity{State: domain.ActivityExited},
		Metadata: domain.SessionMetadata{Branch: "ao/mer-4/root", WorkspacePath: "/ws/mer-4"},
	}

	if err := m.Reconcile(ctx); err != nil {
		t.Fatalf("Reconcile: %v", err)
	}

	// Alive orchestrator + worker adopted in place: same id, still live.
	if st.sessions["mer-1"].IsTerminated {
		t.Fatal("alive orchestrator must be adopted in place, not terminated")
	}
	if st.sessions["mer-2"].IsTerminated {
		t.Fatal("alive worker must be adopted in place, not terminated")
	}
	// No id increment: Reconcile must never mint a new session row.
	if st.num != 0 {
		t.Fatalf("Reconcile minted %d new session(s); adoption must reuse existing ids", st.num)
	}
	// Adopted runtimes were never torn down.
	if rt.destroyed != 0 {
		t.Fatalf("adopted sessions must not be destroyed; Destroy called %d times", rt.destroyed)
	}
	// Dead worker captured, then relaunched under its original id on this same boot.
	if lcm.terminated["mer-3"] != 1 {
		t.Fatalf("dead worker must be marked terminated once before relaunch; got %d", lcm.terminated["mer-3"])
	}
	if st.sessions["mer-3"].IsTerminated {
		t.Fatal("dead worker must be relaunched (not terminated) after Reconcile")
	}
	if rt.created != 1 {
		t.Fatalf("exactly one runtime relaunch expected (the dead worker); got %d", rt.created)
	}
	// One-shot restore marker consumed so it never outlives one restart (#2319).
	if rows := st.worktrees["mer-3"]; len(rows) != 0 {
		t.Fatalf("restore marker for mer-3 must be deleted after relaunch; got %+v", rows)
	}
	// Truly-dead, unmarked session is NOT resurrected.
	if !st.sessions["mer-4"].IsTerminated {
		t.Fatal("terminated session with no restore marker must stay terminated")
	}
}

func TestReconcileReap_TerminatedButAliveTmuxDestroyed(t *testing.T) {
	st := newFakeStore()
	rt := &fakeRuntime{aliveByHandle: map[string]bool{"t1": true}}
	ws := &fakeWorkspace{}
	lcm := &fakeLCM{store: st}
	lookPath := func(string) (string, error) { return "/bin/true", nil }
	m := New(Deps{Runtime: rt, Agents: fakeAgents{}, Workspace: ws, Store: st, Messenger: &fakeMessenger{}, Lifecycle: lcm, LookPath: lookPath})

	rec := domain.SessionRecord{
		ID: "t1", ProjectID: "p1", IsTerminated: true,
		Metadata: domain.SessionMetadata{RuntimeHandleID: "t1"},
	}

	if err := m.reconcileReap(context.Background(), rec); err != nil {
		t.Fatalf("reconcileReap: %v", err)
	}
	if len(rt.destroyedIDs) != 1 || rt.destroyedIDs[0] != "t1" {
		t.Fatalf("destroyedIDs = %v, want [t1]", rt.destroyedIDs)
	}
}

func TestReconcileReap_TerminatedAndDeadTmuxLeftAlone(t *testing.T) {
	st := newFakeStore()
	rt := &fakeRuntime{aliveByHandle: map[string]bool{}} // t2 not alive
	ws := &fakeWorkspace{}
	lcm := &fakeLCM{store: st}
	lookPath := func(string) (string, error) { return "/bin/true", nil }
	m := New(Deps{Runtime: rt, Agents: fakeAgents{}, Workspace: ws, Store: st, Messenger: &fakeMessenger{}, Lifecycle: lcm, LookPath: lookPath})

	rec := domain.SessionRecord{
		ID: "t2", ProjectID: "p1", IsTerminated: true,
		Metadata: domain.SessionMetadata{RuntimeHandleID: "t2"},
	}
	if err := m.reconcileReap(context.Background(), rec); err != nil {
		t.Fatalf("reconcileReap: %v", err)
	}
	if rt.destroyed != 0 {
		t.Fatalf("Destroy calls = %d, want 0", rt.destroyed)
	}
}

// --- Send activity-confirmation tests (issue #2342) ---

// signalingAgent is a fakeAgent that advertises BOTH a prompt-submit and a
// blocked activity signal, so Manager.Send runs confirmActive for its harness
// (see ports.ActivitySignaler).
type signalingAgent struct{ fakeAgent }

func (signalingAgent) EmitsSubmitActivity() bool  { return true }
func (signalingAgent) EmitsBlockedActivity() bool { return true }

// submitOnlyAgent advertises a prompt-submit signal but NOT a blocked one — a
// harness like goose/opencode/agy that submits yet installs no permission hook.
// confirmActive must refuse to replay into it (it could submit into a decision the
// harness cannot report).
type submitOnlyAgent struct{ fakeAgent }

func (submitOnlyAgent) EmitsSubmitActivity() bool  { return true }
func (submitOnlyAgent) EmitsBlockedActivity() bool { return false }

// newSendTestManager builds a Manager wired for Send confirmation tests with
// fast (millisecond) confirmation timings so no test waits real seconds. The
// returned messenger records every Send; the store is mutable so a test can
// flip Activity.State between polls.
func newSendTestManager(t *testing.T, agent ports.Agent, messenger ports.AgentMessenger, st *fakeStore) *Manager {
	t.Helper()
	rt := &fakeRuntime{}
	ws := &fakeWorkspace{}
	lcm := &fakeLCM{store: st}
	lookPath := func(string) (string, error) { return "/bin/true", nil }
	m := New(Deps{
		Runtime: rt, Agents: singleAgent{agent}, Workspace: ws, Store: st,
		Messenger: messenger, Lifecycle: lcm, LookPath: lookPath,
	})
	// Shrink the confirmation budget so the loop runs in milliseconds, not
	// seconds. m.sendConfirm is unexported; tests live in this package.
	m.sendConfirm = sendConfirmConfig{
		pollInterval:    time.Millisecond,
		attemptDeadline: 2 * time.Millisecond,
		maxAttempts:     3,
	}
	return m
}

func TestSend_SkipsConfirmForHooklessHarness(t *testing.T) {
	// A harness whose adapter does NOT implement ActivitySignaler (plain
	// fakeAgent) must skip confirmActive entirely: one Send, no replays, and the
	// call returns immediately without polling.
	st := newFakeStore()
	st.sessions["s1"] = domain.SessionRecord{ID: "s1", Harness: "claude-code"}
	msg := &fakeMessenger{}
	m := newSendTestManager(t, fakeAgent{}, msg, st)

	start := time.Now()
	if err := m.Send(context.Background(), "s1", "hello"); err != nil {
		t.Fatalf("Send: %v", err)
	}
	if len(msg.msgs) != 1 {
		t.Fatalf("Send calls = %d, want 1 (no replays for a hookless harness)", len(msg.msgs))
	}
	// Hookless path returns within milliseconds (no 2s+ confirmation wait).
	if dt := time.Since(start); dt > 250*time.Millisecond {
		t.Fatalf("Send took %s for a hookless harness; confirmActive should have been skipped", dt)
	}
}

func TestSend_ConfirmsByReplayingMessageUntilActive(t *testing.T) {
	// A signaling harness starts idle. If the first submit is not observed as
	// active, confirmActive must replay the intended message instead of sending
	// a bare Enter. A bare Enter can submit stale text left in the pane by
	// another actor.
	st := newFakeStore()
	st.sessions["s1"] = domain.SessionRecord{ID: "s1", Harness: "claude-code",
		Activity: domain.Activity{State: domain.ActivityIdle}}
	msg := &flipOnReplayMessenger{sessionID: "s1", store: st, replay: "do the thing"}
	m := newSendTestManager(t, signalingAgent{}, msg, st)

	if err := m.Send(context.Background(), "s1", "do the thing"); err != nil {
		t.Fatalf("Send: %v", err)
	}
	if len(msg.msgs) != 2 {
		t.Fatalf("Send calls = %d, want 2 (initial + one replay)", len(msg.msgs))
	}
	if msg.msgs[0] != "do the thing" {
		t.Fatalf("first msg = %q, want the prompt", msg.msgs[0])
	}
	if msg.msgs[1] != "do the thing" {
		t.Fatalf("retry msg = %q, want replay of the prompt", msg.msgs[1])
	}
	if got := st.sessions["s1"].Activity.State; got != domain.ActivityActive {
		t.Fatalf("Activity.State = %q, want active", got)
	}
}

func TestSend_ConfirmBudgetCapsRetries(t *testing.T) {
	// A signaling harness that never goes active must still terminate: at most
	// maxAttempts Sends (initial + maxAttempts-1 replays), and Send never errors.
	st := newFakeStore()
	st.sessions["s1"] = domain.SessionRecord{ID: "s1", Harness: "claude-code",
		Activity: domain.Activity{State: domain.ActivityIdle}}
	msg := &fakeMessenger{}
	m := newSendTestManager(t, signalingAgent{}, msg, st)

	if err := m.Send(context.Background(), "s1", "stuck prompt"); err != nil {
		t.Fatalf("Send: %v", err)
	}
	if len(msg.msgs) > m.sendConfirm.maxAttempts {
		t.Fatalf("Send calls = %d, want <= %d (budget cap)", len(msg.msgs), m.sendConfirm.maxAttempts)
	}
	if got := st.sessions["s1"].Activity.State; got == domain.ActivityActive {
		t.Fatalf("Activity.State = active, want unchanged (session never went active)")
	}
}

func TestSend_BlockedSessionRejectsDelivery(t *testing.T) {
	// A session paused on a permission decision (blocked) must not receive the
	// paste at all: the runtime appends Enter, which could answer the dialog.
	// Send surfaces ErrAwaitingDecision (the API's 409) and the messenger is
	// never called, so nothing — initial message or replay — reaches the pane.
	st := newFakeStore()
	st.sessions["s1"] = domain.SessionRecord{ID: "s1", Harness: "claude-code",
		Activity: domain.Activity{State: domain.ActivityBlocked}}
	msg := &fakeMessenger{}
	m := newSendTestManager(t, signalingAgent{}, msg, st)

	err := m.Send(context.Background(), "s1", "status update please")
	if !errors.Is(err, ErrAwaitingDecision) {
		t.Fatalf("Send error = %v, want ErrAwaitingDecision", err)
	}
	if len(msg.msgs) != 0 {
		t.Fatalf("Send calls = %d, want 0 (no paste into a pending decision)", len(msg.msgs))
	}
}

func TestDecision_ReturnsPendingQuestion(t *testing.T) {
	st := newFakeStore()
	st.sessions["s1"] = domain.SessionRecord{
		ID:       "s1",
		Harness:  "claude-code",
		Activity: domain.Activity{State: domain.ActivityBlocked},
		Metadata: domain.SessionMetadata{PendingDecision: &domain.PendingDecision{
			Kind:     domain.DecisionKindQuestion,
			Question: "Pick a direction",
			Options:  []string{"Use API", "Use terminal"},
		}},
	}
	m := newSendTestManager(t, signalingAgent{}, &fakeMessenger{}, st)

	decision, ok, err := m.Decision(context.Background(), "s1")
	if err != nil {
		t.Fatalf("Decision: %v", err)
	}
	if !ok {
		t.Fatal("Decision ok = false, want true")
	}
	if decision.Kind != domain.DecisionKindQuestion || decision.Question != "Pick a direction" {
		t.Fatalf("Decision = %#v, want pending question", decision)
	}
	if !reflect.DeepEqual(decision.Options, []string{"Use API", "Use terminal"}) {
		t.Fatalf("Options = %#v", decision.Options)
	}
}

func TestAnswerDecision_QuestionOptionBypassesSendGuard(t *testing.T) {
	st := newFakeStore()
	st.sessions["s1"] = domain.SessionRecord{
		ID:       "s1",
		Harness:  "claude-code",
		Activity: domain.Activity{State: domain.ActivityBlocked},
		Metadata: domain.SessionMetadata{
			RuntimeHandleID: "h1",
			PendingDecision: &domain.PendingDecision{
				Kind:     domain.DecisionKindQuestion,
				Question: "Pick a direction",
				Options:  []string{"Use API", "Use terminal"},
				Revision: "rev-a",
			},
		},
	}
	msg := &fakeMessenger{}
	m := newSendTestManager(t, signalingAgent{}, msg, st)

	if err := m.AnswerDecision(context.Background(), "s1", domain.DecisionAnswer{Option: 2, Revision: "rev-a"}); err != nil {
		t.Fatalf("AnswerDecision: %v", err)
	}
	if !reflect.DeepEqual(msg.msgs, []string{"2"}) {
		t.Fatalf("sent = %#v, want option number", msg.msgs)
	}
	if got := st.sessions["s1"].Metadata.PendingDecision; got != nil {
		t.Fatalf("PendingDecision = %#v, want cleared after answer", got)
	}
}

// TestAnswerDecision_RequiresRevision: an answer that names no revision was not
// prepared against a fetched decision and is refused outright.
func TestAnswerDecision_RequiresRevision(t *testing.T) {
	st := newFakeStore()
	st.sessions["s1"] = domain.SessionRecord{
		ID:       "s1",
		Harness:  "claude-code",
		Activity: domain.Activity{State: domain.ActivityBlocked},
		Metadata: domain.SessionMetadata{
			RuntimeHandleID: "h1",
			PendingDecision: &domain.PendingDecision{Kind: domain.DecisionKindQuestion, Question: "Q", Options: []string{"A"}, Revision: "rev-a"},
		},
	}
	msg := &fakeMessenger{}
	m := newSendTestManager(t, signalingAgent{}, msg, st)

	err := m.AnswerDecision(context.Background(), "s1", domain.DecisionAnswer{Option: 1})
	if !errors.Is(err, ErrDecisionRevisionRequired) {
		t.Fatalf("AnswerDecision error = %v, want ErrDecisionRevisionRequired", err)
	}
	if len(msg.msgs) != 0 {
		t.Fatalf("sent = %#v, want nothing without a revision", msg.msgs)
	}
	if st.sessions["s1"].Metadata.PendingDecision == nil {
		t.Fatal("decision must survive a refused answer")
	}
}

// TestAnswerDecision_StaleRevisionRejected: an answer prepared against a
// decision that has since been replaced is refused as stale — the new dialog
// must never receive an option index meant for the old one.
func TestAnswerDecision_StaleRevisionRejected(t *testing.T) {
	st := newFakeStore()
	st.sessions["s1"] = domain.SessionRecord{
		ID:       "s1",
		Harness:  "claude-code",
		Activity: domain.Activity{State: domain.ActivityBlocked},
		Metadata: domain.SessionMetadata{
			RuntimeHandleID: "h1",
			// Question B has replaced the A the caller fetched.
			PendingDecision: &domain.PendingDecision{Kind: domain.DecisionKindQuestion, Question: "B", Options: []string{"B1", "B2"}, Revision: "rev-b"},
		},
	}
	msg := &fakeMessenger{}
	m := newSendTestManager(t, signalingAgent{}, msg, st)

	err := m.AnswerDecision(context.Background(), "s1", domain.DecisionAnswer{Option: 1, Revision: "rev-a"})
	if !errors.Is(err, ErrDecisionStale) {
		t.Fatalf("AnswerDecision error = %v, want ErrDecisionStale", err)
	}
	if len(msg.msgs) != 0 {
		t.Fatalf("sent = %#v, want no cross-answer into dialog B", msg.msgs)
	}
	if got := st.sessions["s1"].Metadata.PendingDecision; got == nil || got.Revision != "rev-b" {
		t.Fatalf("dialog B = %#v, want untouched by the stale answer", got)
	}
}

// TestAnswerDecision_ConcurrentReplacementNeverCrossAnswers is the TOCTOU race:
// the decision is replaced AFTER AnswerDecision read it but BEFORE the claim.
// The CAS claim must fail, nothing may be sent, and the replacement dialog must
// survive (the clear only ever removes the answered decision).
func TestAnswerDecision_ConcurrentReplacementNeverCrossAnswers(t *testing.T) {
	st := newFakeStore()
	st.sessions["s1"] = domain.SessionRecord{
		ID:       "s1",
		Harness:  "claude-code",
		Activity: domain.Activity{State: domain.ActivityBlocked},
		Metadata: domain.SessionMetadata{
			RuntimeHandleID: "h1",
			PendingDecision: &domain.PendingDecision{Kind: domain.DecisionKindQuestion, Question: "A", Options: []string{"A1", "A2"}, Revision: "rev-a"},
		},
	}
	// Between the read and the CAS claim, question B replaces A.
	st.beforeClearDecision = func(f *fakeStore) {
		rec := f.sessions["s1"]
		rec.Metadata.PendingDecision = &domain.PendingDecision{Kind: domain.DecisionKindQuestion, Question: "B", Options: []string{"B1"}, Revision: "rev-b"}
		f.sessions["s1"] = rec
	}
	msg := &fakeMessenger{}
	m := newSendTestManager(t, signalingAgent{}, msg, st)

	err := m.AnswerDecision(context.Background(), "s1", domain.DecisionAnswer{Option: 2, Revision: "rev-a"})
	if !errors.Is(err, ErrDecisionStale) {
		t.Fatalf("AnswerDecision error = %v, want ErrDecisionStale from the failed claim", err)
	}
	if len(msg.msgs) != 0 {
		t.Fatalf("sent = %#v, want NOTHING — A's option must never reach dialog B", msg.msgs)
	}
	if got := st.sessions["s1"].Metadata.PendingDecision; got == nil || got.Revision != "rev-b" {
		t.Fatalf("dialog B = %#v, want it to survive the failed answer (clear only removes the answered decision)", got)
	}
}

// TestAnswerDecision_FailedSendRestoresDecision: a claimed answer whose pane
// delivery fails puts the decision back so the dialog stays operator-visible.
func TestAnswerDecision_FailedSendRestoresDecision(t *testing.T) {
	st := newFakeStore()
	decision := &domain.PendingDecision{Kind: domain.DecisionKindQuestion, Question: "Q", Options: []string{"A", "B"}, Revision: "rev-a"}
	st.sessions["s1"] = domain.SessionRecord{
		ID:       "s1",
		Harness:  "claude-code",
		Activity: domain.Activity{State: domain.ActivityBlocked},
		Metadata: domain.SessionMetadata{RuntimeHandleID: "h1", PendingDecision: decision},
	}
	msg := &fakeMessenger{err: errors.New("pane gone")}
	m := newSendTestManager(t, signalingAgent{}, msg, st)

	err := m.AnswerDecision(context.Background(), "s1", domain.DecisionAnswer{Option: 1, Revision: "rev-a"})
	if err == nil {
		t.Fatal("AnswerDecision should surface the send failure")
	}
	if got := st.sessions["s1"].Metadata.PendingDecision; got == nil || got.Revision != "rev-a" {
		t.Fatalf("decision = %#v, want restored after the failed send", got)
	}
}

func TestAnswerDecision_RefusesStaleDecisionWhenSessionNotBlocked(t *testing.T) {
	st := newFakeStore()
	st.sessions["s1"] = domain.SessionRecord{
		ID:       "s1",
		Harness:  "claude-code",
		Activity: domain.Activity{State: domain.ActivityActive},
		Metadata: domain.SessionMetadata{
			RuntimeHandleID: "h1",
			PendingDecision: &domain.PendingDecision{
				Kind:     domain.DecisionKindQuestion,
				Question: "Pick a direction",
				Options:  []string{"Use API", "Use terminal"},
			},
		},
	}
	msg := &fakeMessenger{}
	m := newSendTestManager(t, signalingAgent{}, msg, st)

	err := m.AnswerDecision(context.Background(), "s1", domain.DecisionAnswer{Option: 2})
	if !errors.Is(err, ErrNoPendingDecision) {
		t.Fatalf("AnswerDecision error = %v, want ErrNoPendingDecision", err)
	}
	if len(msg.msgs) != 0 {
		t.Fatalf("sent = %#v, want no stale decision answer", msg.msgs)
	}
}

func TestAnswerDecision_RefusesOptionForTextQuestion(t *testing.T) {
	st := newFakeStore()
	st.sessions["s1"] = domain.SessionRecord{
		ID:       "s1",
		Harness:  "claude-code",
		Activity: domain.Activity{State: domain.ActivityBlocked},
		Metadata: domain.SessionMetadata{
			RuntimeHandleID: "h1",
			PendingDecision: &domain.PendingDecision{Kind: domain.DecisionKindQuestion, Question: "What should I call this?", Revision: "rev-a"},
		},
	}
	msg := &fakeMessenger{}
	m := newSendTestManager(t, signalingAgent{}, msg, st)

	err := m.AnswerDecision(context.Background(), "s1", domain.DecisionAnswer{Option: 1, Revision: "rev-a"})
	if !errors.Is(err, ErrInvalidDecisionAnswer) {
		t.Fatalf("AnswerDecision error = %v, want ErrInvalidDecisionAnswer", err)
	}
	if len(msg.msgs) != 0 {
		t.Fatalf("sent = %#v, want no option answer for text question", msg.msgs)
	}
}

func TestAnswerDecision_RefusesPermissionDecision(t *testing.T) {
	st := newFakeStore()
	st.sessions["s1"] = domain.SessionRecord{
		ID:       "s1",
		Harness:  "claude-code",
		Activity: domain.Activity{State: domain.ActivityBlocked},
		Metadata: domain.SessionMetadata{
			RuntimeHandleID: "h1",
			PendingDecision: &domain.PendingDecision{Kind: domain.DecisionKindPermission, Question: "Allow Bash?"},
		},
	}
	msg := &fakeMessenger{}
	m := newSendTestManager(t, signalingAgent{}, msg, st)

	err := m.AnswerDecision(context.Background(), "s1", domain.DecisionAnswer{Option: 1})
	if !errors.Is(err, ErrDecisionNotAnswerable) {
		t.Fatalf("AnswerDecision error = %v, want ErrDecisionNotAnswerable", err)
	}
	if len(msg.msgs) != 0 {
		t.Fatalf("sent = %#v, want no permission answer", msg.msgs)
	}
}

func TestWakeIdle_AllowsWaitingInputAndConfirmsActive(t *testing.T) {
	st := newFakeStore()
	st.sessions["s1"] = domain.SessionRecord{ID: "s1", Harness: "claude-code",
		Kind:     domain.KindOrchestrator,
		Activity: domain.Activity{State: domain.ActivityWaitingInput}}
	msg := &flipOnReplayMessenger{sessionID: "s1", store: st, replay: "continue your supervision loop"}
	m := newSendTestManager(t, signalingAgent{}, msg, st)

	sent, err := m.WakeIdle(context.Background(), "s1", "continue your supervision loop")
	if err != nil {
		t.Fatalf("WakeIdle: %v", err)
	}
	if !sent {
		t.Fatal("WakeIdle sent = false, want true")
	}
	if len(msg.msgs) != 2 || msg.msgs[0] != "continue your supervision loop" || msg.msgs[1] != "continue your supervision loop" {
		t.Fatalf("WakeIdle sends = %#v, want wake message plus replay confirmation", msg.msgs)
	}
	if got := st.sessions["s1"].Activity.State; got != domain.ActivityActive {
		t.Fatalf("Activity.State = %q, want active", got)
	}
}

func TestWakeIdle_SuppressesBlockedAndActiveRaces(t *testing.T) {
	for name, state := range map[string]domain.ActivityState{
		"blocked": domain.ActivityBlocked,
		"active":  domain.ActivityActive,
	} {
		t.Run(name, func(t *testing.T) {
			st := newFakeStore()
			st.sessions["s1"] = domain.SessionRecord{ID: "s1", Harness: "claude-code",
				Kind:     domain.KindOrchestrator,
				Activity: domain.Activity{State: state}}
			msg := &fakeMessenger{}
			m := newSendTestManager(t, signalingAgent{}, msg, st)

			sent, err := m.WakeIdle(context.Background(), "s1", "continue your supervision loop")
			if err != nil {
				t.Fatalf("WakeIdle: %v", err)
			}
			if sent {
				t.Fatal("WakeIdle sent = true, want false")
			}
			if len(msg.msgs) != 0 {
				t.Fatalf("WakeIdle sends = %#v, want none", msg.msgs)
			}
		})
	}
}

func TestWakeIdle_SuppressesNonOrchestrator(t *testing.T) {
	st := newFakeStore()
	st.sessions["s1"] = domain.SessionRecord{ID: "s1", Harness: "claude-code",
		Kind:     domain.KindWorker,
		Activity: domain.Activity{State: domain.ActivityWaitingInput}}
	msg := &fakeMessenger{}
	m := newSendTestManager(t, signalingAgent{}, msg, st)

	sent, err := m.WakeIdle(context.Background(), "s1", "continue your supervision loop")
	if err != nil {
		t.Fatalf("WakeIdle: %v", err)
	}
	if sent {
		t.Fatal("WakeIdle sent = true, want false")
	}
	if len(msg.msgs) != 0 {
		t.Fatalf("WakeIdle sends = %#v, want none", msg.msgs)
	}
}

func TestSend_NoNudgeWhenBlockedAppearsMidWait(t *testing.T) {
	// The permission dialog can appear between polls (e.g. the delivered prompt
	// itself triggered a tool approval). The confirm loop must abort on the
	// first blocked observation instead of nudging after the deadline.
	st := newFakeStore()
	st.sessions["s1"] = domain.SessionRecord{ID: "s1", Harness: "claude-code",
		Activity: domain.Activity{State: domain.ActivityIdle}}
	msg := &blockOnSendMessenger{sessionID: "s1", store: st}
	m := newSendTestManager(t, signalingAgent{}, msg, st)

	if err := m.Send(context.Background(), "s1", "run the migration"); err != nil {
		t.Fatalf("Send: %v", err)
	}
	if len(msg.msgs) != 1 {
		t.Fatalf("Send calls = %d, want 1 (blocked observed mid-confirm, no replay)", len(msg.msgs))
	}
}

func TestSend_StillNudgesWhenWaitingInput(t *testing.T) {
	// waiting_input (an idle prompt awaiting the next instruction) is the
	// PRIMARY replay scenario: a long-idle worker whose submit was not observed.
	// The decision-safety guard must not disable it.
	st := newFakeStore()
	st.sessions["s1"] = domain.SessionRecord{ID: "s1", Harness: "claude-code",
		Activity: domain.Activity{State: domain.ActivityWaitingInput}}
	msg := &flipOnReplayMessenger{sessionID: "s1", store: st, replay: "do the thing"}
	m := newSendTestManager(t, signalingAgent{}, msg, st)

	if err := m.Send(context.Background(), "s1", "do the thing"); err != nil {
		t.Fatalf("Send: %v", err)
	}
	if len(msg.msgs) != 2 {
		t.Fatalf("Send calls = %d, want 2 (initial + one replay for waiting_input)", len(msg.msgs))
	}
	if msg.msgs[1] != "do the thing" {
		t.Fatalf("retry msg = %q, want replay of the prompt", msg.msgs[1])
	}
}

// blockOnSendMessenger records sends and flips the session to ActivityBlocked
// right after the initial message is delivered, simulating a prompt that
// immediately triggers a tool-permission dialog.
type blockOnSendMessenger struct {
	msgs      []string
	sessionID domain.SessionID
	store     *fakeStore
}

func (m *blockOnSendMessenger) Send(_ context.Context, _ domain.SessionID, msg string) error {
	m.msgs = append(m.msgs, msg)
	if rec, ok := m.store.sessions[m.sessionID]; ok {
		rec.Activity.State = domain.ActivityBlocked
		m.store.sessions[m.sessionID] = rec
	}
	return nil
}

func TestSend_NoNudgeWhenBlockedAppearsBeforeNudge(t *testing.T) {
	// The TOCTOU the per-poll check cannot cover: the session is not blocked on
	// waitForActive's final poll, but a permission dialog lands in the gap
	// before the replay. The just-in-time re-read in confirmActive must catch
	// it — exactly one Send, no replay.
	st := newFakeStore()
	st.sessions["s1"] = domain.SessionRecord{ID: "s1", Harness: "claude-code",
		Activity: domain.Activity{State: domain.ActivityIdle}}
	// blockAfterFirstReadStore flips the session to blocked on read #4. The
	// deterministic read sequence (attemptDeadline 0 makes waitForActive do
	// exactly one poll): #1 Deliver's pre-paste read, #2 Send's harness lookup,
	// #3 waitForActive's poll (idle → timeout), #4 the JIT pre-replay re-read —
	// which is the first to see blocked, landing the flip in the exact
	// post-final-poll / pre-replay window this test exists to cover.
	bst := &blockAfterFirstReadStore{fakeStore: st, id: "s1"}
	msg := &fakeMessenger{}
	m := New(Deps{
		Runtime: &fakeRuntime{}, Agents: singleAgent{signalingAgent{}}, Workspace: &fakeWorkspace{},
		Store: bst, Messenger: msg, Lifecycle: &fakeLCM{store: st},
		LookPath: func(string) (string, error) { return "/bin/true", nil },
	})
	m.sendConfirm = sendConfirmConfig{pollInterval: time.Millisecond, attemptDeadline: 0, maxAttempts: 3}

	if err := m.Send(context.Background(), "s1", "run the migration"); err != nil {
		t.Fatalf("Send: %v", err)
	}
	if len(msg.msgs) != 1 {
		t.Fatalf("Send calls = %d, want 1 (blocked appeared before replay, JIT re-read caught it)", len(msg.msgs))
	}
	if bst.reads < 4 {
		t.Fatalf("GetSession reads = %d, want >= 4 (the JIT pre-replay re-read must have run)", bst.reads)
	}
}

func TestSend_SkipsConfirmForSubmitOnlyHarness(t *testing.T) {
	// A harness that submits but cannot report blocked (goose/opencode/agy) is
	// NOT replay-safe: confirmActive must be skipped entirely, so a submit can
	// never reach a permission dialog the harness could not have signalled.
	st := newFakeStore()
	st.sessions["s1"] = domain.SessionRecord{ID: "s1", Harness: "goose",
		Activity: domain.Activity{State: domain.ActivityIdle}}
	msg := &fakeMessenger{}
	m := newSendTestManager(t, submitOnlyAgent{}, msg, st)

	if err := m.Send(context.Background(), "s1", "do the thing"); err != nil {
		t.Fatalf("Send: %v", err)
	}
	if len(msg.msgs) != 1 {
		t.Fatalf("Send calls = %d, want 1 (submit-only harness must not be replayed)", len(msg.msgs))
	}
}

func TestHarnessNudgeSafe(t *testing.T) {
	m := New(Deps{Agents: singleAgent{agent: fakeAgent{}}})
	if m.harnessNudgeSafe("claude-code") {
		t.Fatalf("hookless agent reported as replay-safe")
	}
	m2 := New(Deps{Agents: singleAgent{agent: signalingAgent{}}})
	if !m2.harnessNudgeSafe("claude-code") {
		t.Fatalf("submit+blocked agent not reported as replay-safe")
	}
	m3 := New(Deps{Agents: singleAgent{agent: submitOnlyAgent{}}})
	if m3.harnessNudgeSafe("claude-code") {
		t.Fatalf("submit-only agent (no blocked signal) reported as replay-safe")
	}
	m4 := New(Deps{Agents: missingAgents{}})
	if m4.harnessNudgeSafe("claude-code") {
		t.Fatalf("unresolved harness reported as replay-safe")
	}
}

// blockAfterFirstReadStore wraps fakeStore and flips the session to
// ActivityBlocked on the FOURTH GetSession call, so with attemptDeadline 0 the
// first read to observe blocked is confirmActive's just-in-time pre-replay
// re-read (reads #1-#3 are Deliver's pre-paste read, Send's harness lookup,
// and waitForActive's single poll — see TestSend_NoNudgeWhenBlockedAppearsBeforeNudge).
type blockAfterFirstReadStore struct {
	*fakeStore
	id    domain.SessionID
	reads int
}

func (s *blockAfterFirstReadStore) GetSession(ctx context.Context, id domain.SessionID) (domain.SessionRecord, bool, error) {
	s.reads++
	if s.reads >= 4 {
		if rec, ok := s.sessions[s.id]; ok {
			rec.Activity.State = domain.ActivityBlocked
			s.sessions[s.id] = rec
		}
	}
	return s.fakeStore.GetSession(ctx, id)
}

// flipOnReplayMessenger records sends like fakeMessenger and additionally flips
// a session to ActivityActive the first time it receives a replayed prompt,
// simulating the agent accepting the prompt after the retry.
type flipOnReplayMessenger struct {
	msgs      []string
	sessionID domain.SessionID
	store     *fakeStore
	replay    string
	flipped   bool
}

func (m *flipOnReplayMessenger) Send(_ context.Context, _ domain.SessionID, msg string) error {
	m.msgs = append(m.msgs, msg)
	if msg == m.replay && len(m.msgs) > 1 && !m.flipped {
		rec, ok := m.store.sessions[m.sessionID]
		if ok {
			rec.Activity.State = domain.ActivityActive
			m.store.sessions[m.sessionID] = rec
		}
		m.flipped = true
	}
	return nil
}

// The regression guard for #147. The title used to reach the harness twice —
// baked into argv as `-- /rename <title>` and sent again post-start — which
// also forced the prompt onto a post-start write. The two writes concatenated
// in the booting pane and the worker's task never ran.
//
// The argv half is asserted by the adapter tests (they must not spend the argv
// slot on a rename). Here we pin the manager half: exactly one post-start
// write, and it is the title. A prompt appearing here means the argv slot was
// taken by something else again.
func TestSpawn_DoesNotDoubleDeliverTitle(t *testing.T) {
	st := newFakeStore()
	st.projects["agent-orchestrator"] = domain.ProjectRecord{
		ID:     "agent-orchestrator",
		Config: domain.ProjectConfig{SessionPrefix: "ao", Worker: domain.RoleOverride{Harness: domain.HarnessCodex}},
	}
	agent := &launchTitleAgent{}
	rt := &fakeRuntime{}
	m := New(Deps{
		Runtime: rt, Agents: singleAgent{agent: agent}, Workspace: &fakeWorkspace{}, Store: st,
		Messenger: &fakeMessenger{}, Lifecycle: &fakeLCM{store: st},
		LookPath: func(string) (string, error) { return "/bin/true", nil },
	})

	if _, err := m.Spawn(ctx, ports.SpawnConfig{
		ProjectID: "agent-orchestrator", IssueID: "146", IssueTitle: "Naming",
		Kind: domain.KindWorker, Prompt: "/address-issue 146",
	}); err != nil {
		t.Fatal(err)
	}

	if got, want := rt.sent, []string{"/rename ao #146 naming"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("post-start sends = %#v, want exactly %#v", got, want)
	}
	// The adapter is handed both; its own tests assert it spends the argv slot
	// on the prompt rather than a second rename.
	if agent.lastLaunch.LaunchTitle == "" || agent.lastLaunch.Prompt != "/address-issue 146" {
		t.Fatalf("launch config = %+v, want title and argv prompt both passed to the adapter", agent.lastLaunch)
	}
}

// A worker with no issue must still get a deterministic name. An empty launch
// title is what let claude-code invent a random codename ("wombat-coffeehouse").
func TestSpawn_WorkerWithoutIssueUsesDeterministicName(t *testing.T) {
	st := newFakeStore()
	st.projects["agent-orchestrator"] = domain.ProjectRecord{
		ID:     "agent-orchestrator",
		Config: domain.ProjectConfig{SessionPrefix: "ao", Worker: domain.RoleOverride{Harness: domain.HarnessCodex}},
	}
	agent := &launchTitleAgent{}
	rt := &fakeRuntime{}
	m := New(Deps{
		Runtime: rt, Agents: singleAgent{agent: agent}, Workspace: &fakeWorkspace{}, Store: st,
		Messenger: &fakeMessenger{}, Lifecycle: &fakeLCM{store: st},
		LookPath: func(string) (string, error) { return "/bin/true", nil },
	})

	if _, err := m.Spawn(ctx, ports.SpawnConfig{
		ProjectID: "agent-orchestrator", Kind: domain.KindWorker, Prompt: "do a thing",
	}); err != nil {
		t.Fatal(err)
	}

	if got := st.sessions["agent-orchestrator-1"].DisplayName; got != "ao" {
		t.Fatalf("stored displayName = %q, want the project prefix so no codename is invented", got)
	}
	if got, want := rt.sent, []string{"/rename ao"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("post-start sends = %#v, want %#v", got, want)
	}
}

// tmux Create returns as soon as the pane exists, before the harness has drawn
// its input. Bytes sent into that gap are what concatenated the rename and the
// prompt in #146, so AO must wait for the pane to produce output first.
func TestSpawn_WaitsForPaneReadyBeforeTitleSend(t *testing.T) {
	st := newFakeStore()
	st.projects["mer"] = domain.ProjectRecord{ID: "mer", Config: testRoleAgents()}
	agent := &launchTitleAgent{}
	rt := &fakeRuntime{blankReads: 3}
	m := New(Deps{
		Runtime: rt, Agents: singleAgent{agent: agent}, Workspace: &fakeWorkspace{}, Store: st,
		Messenger: &fakeMessenger{}, Lifecycle: &fakeLCM{store: st},
		LookPath: func(string) (string, error) { return "/bin/true", nil },
	})
	m.paneReady = paneReadyConfig{pollInterval: time.Millisecond, deadline: 5 * time.Second}

	if _, err := m.Spawn(ctx, ports.SpawnConfig{
		ProjectID: "mer", Kind: domain.KindWorker, DisplayName: "titled", Prompt: "task",
	}); err != nil {
		t.Fatal(err)
	}

	if len(rt.getOutputCallsAtSend) != 1 {
		t.Fatalf("post-start sends = %#v, want exactly one", rt.sent)
	}
	if got := rt.getOutputCallsAtSend[0]; got <= rt.blankReads {
		t.Fatalf("title sent after %d pane reads, want it to wait past the %d blank reads", got, rt.blankReads)
	}
}

// A pane that never prints, or a runtime that cannot capture output, must not
// hold a spawn open: the write goes out anyway and the name is best-effort.
func TestSpawn_PaneReadyTimeoutStillCompletes(t *testing.T) {
	for _, tc := range []struct {
		name string
		rt   *fakeRuntime
	}{
		{"pane never prints", &fakeRuntime{blankReads: 1 << 30}},
		{"runtime cannot capture", &fakeRuntime{outputErr: errors.New("capture-pane: no such pane")}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			st := newFakeStore()
			st.projects["mer"] = domain.ProjectRecord{ID: "mer", Config: testRoleAgents()}
			agent := &launchTitleAgent{}
			m := New(Deps{
				Runtime: tc.rt, Agents: singleAgent{agent: agent}, Workspace: &fakeWorkspace{}, Store: st,
				Messenger: &fakeMessenger{}, Lifecycle: &fakeLCM{store: st},
				LookPath: func(string) (string, error) { return "/bin/true", nil },
			})
			m.paneReady = paneReadyConfig{pollInterval: time.Millisecond, deadline: 20 * time.Millisecond}

			if _, err := m.Spawn(ctx, ports.SpawnConfig{
				ProjectID: "mer", Kind: domain.KindWorker, DisplayName: "titled", Prompt: "task",
			}); err != nil {
				t.Fatalf("spawn must survive an unreadable pane: %v", err)
			}
			if got, want := tc.rt.sent, []string{"/rename titled"}; !reflect.DeepEqual(got, want) {
				t.Fatalf("post-start sends = %#v, want %#v after the readiness deadline lapses", got, want)
			}
		})
	}
}

// Harnesses that cannot carry the prompt in argv still deliver it after start,
// and that write waits for the pane too.
func TestSpawn_AfterStartHarnessDeliversTitleThenPromptOnceReady(t *testing.T) {
	st := newFakeStore()
	st.projects["mer"] = domain.ProjectRecord{ID: "mer", Config: testRoleAgents()}
	agent := &afterStartTitleAgent{}
	rt := &fakeRuntime{blankReads: 2}
	m := New(Deps{
		Runtime: rt, Agents: singleAgent{agent: agent}, Workspace: &fakeWorkspace{}, Store: st,
		Messenger: &fakeMessenger{}, Lifecycle: &fakeLCM{store: st},
		LookPath: func(string) (string, error) { return "/bin/true", nil },
	})
	m.paneReady = paneReadyConfig{pollInterval: time.Millisecond, deadline: 5 * time.Second}

	if _, err := m.Spawn(ctx, ports.SpawnConfig{
		ProjectID: "mer", Kind: domain.KindWorker, DisplayName: "titled", Prompt: "do\x1b task",
	}); err != nil {
		t.Fatal(err)
	}
	// Control chars are stripped from a pasted prompt but preserved in metadata.
	if got, want := rt.sent, []string{"/rename titled", "do task"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("post-start sends = %#v, want %#v", got, want)
	}
	if got := st.sessions["mer-1"].Metadata.Prompt; got != "do\x1b task" {
		t.Fatalf("metadata prompt = %q, want the original prompt", got)
	}
	if got := rt.getOutputCallsAtSend[0]; got <= rt.blankReads {
		t.Fatalf("first write happened after %d pane reads, want it to wait past %d", got, rt.blankReads)
	}
	if got := rt.getOutputCallsAtSend[1]; got != rt.getOutputCallsAtSend[0] {
		t.Fatalf("prompt performed a second readiness wait: title sent after %d reads, prompt after %d", rt.getOutputCallsAtSend[0], got)
	}
}

// The title is cosmetic and, with the prompt delivered in argv, the agent is
// already working by the time AO types it. Tearing the session down because a
// send-keys write hiccuped would destroy a healthy worker over a display label
// — the exact failure this issue's fix exists to avoid.
func TestSpawn_TitleWriteFailureDoesNotDestroyTheSession(t *testing.T) {
	st := newFakeStore()
	st.projects["mer"] = domain.ProjectRecord{ID: "mer", Config: testRoleAgents()}
	agent := &launchTitleAgent{}
	// The pane is alive; only the cosmetic write failed.
	rt := &fakeRuntime{sendErr: errors.New("tmux: send-keys failed"), aliveByHandle: map[string]bool{"h1": true}}
	m := New(Deps{
		Runtime: rt, Agents: singleAgent{agent: agent}, Workspace: &fakeWorkspace{}, Store: st,
		Messenger: &fakeMessenger{}, Lifecycle: &fakeLCM{store: st},
		LookPath: func(string) (string, error) { return "/bin/true", nil },
	})

	rec, err := m.Spawn(ctx, ports.SpawnConfig{
		ProjectID: "mer", Kind: domain.KindWorker, DisplayName: "titled", Prompt: "task",
	})
	if err != nil {
		t.Fatalf("spawn must survive a failed title write to a live pane, got %v", err)
	}
	if rec.ID == "" {
		t.Fatal("spawn returned no session record")
	}
	if rt.destroyed != 0 {
		t.Fatalf("runtime destroyed %d times; a cosmetic title write must not roll back the session", rt.destroyed)
	}
	// The name still lands in AO's own store even though the harness never got it.
	if got := st.sessions["mer-1"].DisplayName; got != "titled" {
		t.Fatalf("stored displayName = %q, want it recorded regardless of the harness write", got)
	}
}

// The prompt is not cosmetic. A harness that needs its prompt typed in and
// never receives it is a worker with no task, so that failure still rolls back.
func TestSpawn_PromptWriteFailureRollsBackTheSession(t *testing.T) {
	st := newFakeStore()
	st.projects["mer"] = domain.ProjectRecord{ID: "mer", Config: testRoleAgents()}
	agent := &afterStartTitleAgent{}
	rt := &fakeRuntime{sendErr: errors.New("tmux: send-keys failed")}
	m := New(Deps{
		Runtime: rt, Agents: singleAgent{agent: agent}, Workspace: &fakeWorkspace{}, Store: st,
		Messenger: &fakeMessenger{}, Lifecycle: &fakeLCM{store: st},
		LookPath: func(string) (string, error) { return "/bin/true", nil },
	})

	if _, err := m.Spawn(ctx, ports.SpawnConfig{
		ProjectID: "mer", Kind: domain.KindWorker, DisplayName: "titled", Prompt: "task",
	}); err == nil {
		t.Fatal("spawn must fail when the prompt cannot be delivered")
	}
	if rt.destroyed != 1 {
		t.Fatalf("runtime destroyed %d times, want 1 rollback", rt.destroyed)
	}
}

func TestOrchestratorPrompt_DoesNotTeachManualTrackerDispatch(t *testing.T) {
	prompt := orchestratorPrompt("agent-orchestrator")

	for _, forbidden := range []string{"ao spawn --project", "file it as an issue", "dispatch its id", "keep active intake near"} {
		if strings.Contains(prompt, forbidden) {
			t.Fatalf("orchestrator prompt contains manual-dispatch guidance %q:\n%s", forbidden, prompt)
		}
	}
	for _, want := range []string{"Assignment is the authorization boundary", "Do not race tracker intake", "explicitly tells you to `/capture`"} {
		if !strings.Contains(prompt, want) {
			t.Fatalf("orchestrator prompt missing %q:\n%s", want, prompt)
		}
	}
}

// The readiness wait must not depend on the injectable clock: the sleep between
// polls is real time, so a frozen clock would never reach a clock-derived
// deadline and spawn would hang until the context died.
func TestSpawn_PaneReadyDoesNotDependOnTheInjectedClock(t *testing.T) {
	st := newFakeStore()
	st.projects["mer"] = domain.ProjectRecord{ID: "mer", Config: testRoleAgents()}
	frozen := time.Date(2026, 7, 9, 0, 0, 0, 0, time.UTC)
	rt := &fakeRuntime{blankReads: 1 << 30} // pane never renders
	m := New(Deps{
		Runtime: rt, Agents: singleAgent{agent: &launchTitleAgent{}}, Workspace: &fakeWorkspace{}, Store: st,
		Messenger: &fakeMessenger{}, Lifecycle: &fakeLCM{store: st},
		LookPath: func(string) (string, error) { return "/bin/true", nil },
		Clock:    func() time.Time { return frozen },
	})
	m.paneReady = paneReadyConfig{pollInterval: time.Millisecond, deadline: 30 * time.Millisecond}

	done := make(chan error, 1)
	go func() {
		_, err := m.Spawn(ctx, ports.SpawnConfig{
			ProjectID: "mer", Kind: domain.KindWorker, DisplayName: "titled", Prompt: "task",
		})
		done <- err
	}()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("spawn: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("spawn hung: the pane-readiness wait never reached its deadline under a frozen clock")
	}
	if got, want := rt.sent, []string{"/rename titled"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("post-start sends = %#v, want %#v", got, want)
	}
}

// With the prompt delivered in argv, nothing else writes to the pane during a
// claude-code/codex spawn — the title write is the only probe that touches it.
// If the harness died between Create and that write, treating the failure as
// cosmetic would hand back a "live" idle session that never ran a thing. A
// title write that fails against a pane which is no longer alive must roll the
// spawn back, exactly as it did before the write was made non-fatal.
func TestSpawn_TitleWriteFailureOnDeadPaneRollsBack(t *testing.T) {
	st := newFakeStore()
	st.projects["mer"] = domain.ProjectRecord{ID: "mer", Config: testRoleAgents()}
	// aliveByHandle has no entry for "h1": the pane is gone.
	rt := &fakeRuntime{sendErr: errors.New("tmux: no such session")}
	m := New(Deps{
		Runtime: rt, Agents: singleAgent{agent: &launchTitleAgent{}}, Workspace: &fakeWorkspace{}, Store: st,
		Messenger: &fakeMessenger{}, Lifecycle: &fakeLCM{store: st},
		LookPath: func(string) (string, error) { return "/bin/true", nil },
	})

	if _, err := m.Spawn(ctx, ports.SpawnConfig{
		ProjectID: "mer", Kind: domain.KindWorker, DisplayName: "titled", Prompt: "task",
	}); err == nil {
		t.Fatal("spawn must fail when the title write reveals a dead pane")
	}
	if rt.destroyed != 1 {
		t.Fatalf("runtime destroyed %d times, want 1 rollback", rt.destroyed)
	}
	if _, ok := st.sessions["mer-1"]; ok {
		t.Fatal("seed row survived a rolled-back spawn")
	}
}

// A liveness probe that itself fails cannot prove the pane is healthy, so the
// spawn must not be reported as successful on the strength of it.
func TestSpawn_TitleWriteFailureWithUnknownLivenessRollsBack(t *testing.T) {
	st := newFakeStore()
	st.projects["mer"] = domain.ProjectRecord{ID: "mer", Config: testRoleAgents()}
	rt := &fakeRuntime{sendErr: errors.New("tmux: send-keys failed"), aliveErr: errors.New("tmux: server gone")}
	m := New(Deps{
		Runtime: rt, Agents: singleAgent{agent: &launchTitleAgent{}}, Workspace: &fakeWorkspace{}, Store: st,
		Messenger: &fakeMessenger{}, Lifecycle: &fakeLCM{store: st},
		LookPath: func(string) (string, error) { return "/bin/true", nil },
	})

	if _, err := m.Spawn(ctx, ports.SpawnConfig{
		ProjectID: "mer", Kind: domain.KindWorker, DisplayName: "titled", Prompt: "task",
	}); err == nil {
		t.Fatal("spawn must fail when pane liveness cannot be established")
	}
	if rt.destroyed != 1 {
		t.Fatalf("runtime destroyed %d times, want 1 rollback", rt.destroyed)
	}
}

// A tmux keep-alive shell preserves the session after the agent process exits.
// Spawn must probe the foreground command before MarkSpawned; otherwise the
// title write can succeed against bash and AO reports a live idle worker.
func TestSpawn_RollsBackWhenAgentProcessAlreadyExited(t *testing.T) {
	st := newFakeStore()
	st.projects["mer"] = domain.ProjectRecord{ID: "mer", Config: domain.ProjectConfig{
		WorkerMix: domain.WorkerMix{{Harness: domain.HarnessClaudeCode, Model: "opus", Weight: 100}},
	}}
	rt := &fakeRuntime{
		aliveByHandle:        map[string]bool{"h1": true},
		processAliveByHandle: map[string]bool{"h1": false},
	}
	lcm := &fakeLCM{store: st}
	m := New(Deps{
		Runtime: rt, Agents: singleAgent{agent: &launchTitleAgent{}}, Workspace: &fakeWorkspace{}, Store: st,
		Messenger: &fakeMessenger{}, Lifecycle: lcm,
		LookPath: func(string) (string, error) { return "/bin/true", nil },
	})

	if _, err := m.Spawn(ctx, ports.SpawnConfig{
		ProjectID: "mer", Kind: domain.KindWorker, DisplayName: "titled", Prompt: "task",
	}); err == nil {
		t.Fatal("spawn must fail when the agent process has already been replaced by the keep-alive shell")
	}
	if rt.destroyed != 1 {
		t.Fatalf("runtime destroyed %d times, want 1 rollback", rt.destroyed)
	}
	if lcm.completed != 0 {
		t.Fatalf("MarkSpawned called %d times, want 0", lcm.completed)
	}
	if _, ok := st.sessions["mer-1"]; ok {
		t.Fatal("seed row survived a rolled-back spawn")
	}
	if !m.workerMixBucketDown(domain.BucketKey{Harness: domain.HarnessClaudeCode, Model: "opus"}) {
		t.Fatal("worker mix bucket was not marked down for an immediate harness exit")
	}
}

// TestSpawn_ImmediateExitWritesNothingToThePaneBeforeRollback locks issue #237:
// the launch-process gate must run BEFORE any pane write. On the immediate-exit
// path the pane is already the keep-alive interactive shell, so a title (or, for
// after-start harnesses, the prompt) typed now would be executed as shell input
// on a spawn that is about to be destroyed. The guard must reject the spawn
// without ever calling SendMessage.
func TestSpawn_ImmediateExitWritesNothingToThePaneBeforeRollback(t *testing.T) {
	for _, tc := range []struct {
		name  string
		agent ports.Agent
	}{
		// argv-prompt harness (claude/codex): only the cosmetic title is typed.
		{"argv-prompt harness", &launchTitleAgent{}},
		// after-start harness: BOTH the title and the prompt are typed, so an
		// unguarded write would execute the prompt text as shell input.
		{"after-start harness", &afterStartTitleAgent{}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			st := newFakeStore()
			st.projects["mer"] = domain.ProjectRecord{ID: "mer", Config: domain.ProjectConfig{
				WorkerMix: domain.WorkerMix{{Harness: domain.HarnessClaudeCode, Model: "opus", Weight: 100}},
			}}
			rt := &fakeRuntime{
				aliveByHandle:        map[string]bool{"h1": true},
				processAliveByHandle: map[string]bool{"h1": false},
			}
			lcm := &fakeLCM{store: st}
			m := New(Deps{
				Runtime: rt, Agents: singleAgent{agent: tc.agent}, Workspace: &fakeWorkspace{}, Store: st,
				Messenger: &fakeMessenger{}, Lifecycle: lcm,
				LookPath: func(string) (string, error) { return "/bin/true", nil },
			})
			m.paneReady = paneReadyConfig{pollInterval: time.Millisecond, deadline: 30 * time.Millisecond}
			m.launchProbe = launchProbeConfig{retryDelay: time.Millisecond, attempts: 1}

			if _, err := m.Spawn(ctx, ports.SpawnConfig{
				ProjectID: "mer", Kind: domain.KindWorker, DisplayName: "titled", Prompt: "task",
			}); err == nil {
				t.Fatal("spawn must fail when the agent exited into the keep-alive shell")
			}
			// The core #237 guarantee: not one byte was typed into the pane
			// before the guard rolled the spawn back.
			if len(rt.sent) != 0 {
				t.Fatalf("pane writes before rollback = %#v, want none (nothing may be typed into the keep-alive shell)", rt.sent)
			}
			if rt.destroyed != 1 {
				t.Fatalf("runtime destroyed %d times, want 1 rollback", rt.destroyed)
			}
			if lcm.completed != 0 {
				t.Fatalf("MarkSpawned called %d times, want 0", lcm.completed)
			}
			if _, ok := st.sessions["mer-1"]; ok {
				t.Fatal("seed row survived a rolled-back spawn")
			}
		})
	}
}

// TestSpawn_HealthySlowStartDeliversTitleAndPromptAfterProbe proves the reorder
// did not regress the happy path: once the launch-process probe passes (here a
// transient false-then-true, exercising the grace window), a slow-starting
// after-start harness still delivers BOTH the title and the prompt into the
// pane, in order, and the spawn completes.
func TestSpawn_HealthySlowStartDeliversTitleAndPromptAfterProbe(t *testing.T) {
	st := newFakeStore()
	st.projects["mer"] = domain.ProjectRecord{ID: "mer", Config: testRoleAgents()}
	rt := &fakeRuntime{aliveByHandle: map[string]bool{"h1": true}, processAliveSeq: []bool{false, true}}
	lcm := &fakeLCM{store: st}
	m := New(Deps{
		Runtime: rt, Agents: singleAgent{agent: &afterStartTitleAgent{}}, Workspace: &fakeWorkspace{}, Store: st,
		Messenger: &fakeMessenger{}, Lifecycle: lcm,
		LookPath: func(string) (string, error) { return "/bin/true", nil },
	})
	m.paneReady = paneReadyConfig{pollInterval: time.Millisecond, deadline: 5 * time.Second}
	m.launchProbe = launchProbeConfig{retryDelay: time.Millisecond, attempts: 3}

	if _, err := m.Spawn(ctx, ports.SpawnConfig{
		ProjectID: "mer", Kind: domain.KindWorker, DisplayName: "titled", Prompt: "task",
	}); err != nil {
		t.Fatalf("healthy slow-start spawn must complete: %v", err)
	}
	if got, want := rt.sent, []string{"/rename titled", "task"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("post-start sends = %#v, want %#v (title then prompt, after the probe passes)", got, want)
	}
	if lcm.completed != 1 {
		t.Fatalf("MarkSpawned called %d times, want 1", lcm.completed)
	}
	if rt.destroyed != 0 {
		t.Fatalf("runtime destroyed %d times, want 0", rt.destroyed)
	}
}

// TestSpawn_LateExitAfterProbeRollsBack proves the second (post-write) gate
// preserves issue #219's end-of-spawn liveness guarantee across the issue #237
// reorder: an agent that passes the early probe (true) but then exits *during*
// the title/prompt delivery (false on the re-probe) must roll back rather than
// return a live-looking record. The pane writes succeed against the persistent
// keep-alive shell, so without the second gate MarkSpawned would run on a dead
// agent.
func TestSpawn_LateExitAfterProbeRollsBack(t *testing.T) {
	st := newFakeStore()
	st.projects["mer"] = domain.ProjectRecord{ID: "mer", Config: testRoleAgents()}
	// Early probe reads true (agent up → pane writes proceed); the post-write
	// re-probe reads false (agent has since exited). attempts=1 so each probe is
	// a single read of the sequence.
	rt := &fakeRuntime{aliveByHandle: map[string]bool{"h1": true}, processAliveSeq: []bool{true, false}}
	lcm := &fakeLCM{store: st}
	m := New(Deps{
		Runtime: rt, Agents: singleAgent{agent: &afterStartTitleAgent{}}, Workspace: &fakeWorkspace{}, Store: st,
		Messenger: &fakeMessenger{}, Lifecycle: lcm,
		LookPath: func(string) (string, error) { return "/bin/true", nil },
	})
	m.paneReady = paneReadyConfig{pollInterval: time.Millisecond, deadline: 30 * time.Millisecond}
	m.launchProbe = launchProbeConfig{retryDelay: time.Millisecond, attempts: 1}

	if _, err := m.Spawn(ctx, ports.SpawnConfig{
		ProjectID: "mer", Kind: domain.KindWorker, DisplayName: "titled", Prompt: "task",
	}); err == nil {
		t.Fatal("spawn must roll back when the agent exits after the early probe but before completion")
	}
	if lcm.completed != 0 {
		t.Fatalf("MarkSpawned called %d times, want 0 (late-exit spawn must not complete)", lcm.completed)
	}
	if rt.destroyed != 1 {
		t.Fatalf("runtime destroyed %d times, want 1 rollback", rt.destroyed)
	}
	// Both probes ran: the early one (true) and the post-write one (false).
	if len(rt.processAliveSeq) != 0 {
		t.Fatalf("processAliveSeq has %d entries left, want 0 (early + post-write probe both run)", len(rt.processAliveSeq))
	}
}

func TestSpawn_ProcessProbeErrorKeepsAliveSession(t *testing.T) {
	st := newFakeStore()
	st.projects["mer"] = domain.ProjectRecord{ID: "mer", Config: testRoleAgents()}
	rt := &fakeRuntime{
		aliveByHandle:   map[string]bool{"h1": true},
		processAliveErr: errors.New("tmux: transient display-message failure"),
	}
	lcm := &fakeLCM{store: st}
	m := New(Deps{
		Runtime: rt, Agents: singleAgent{agent: &launchTitleAgent{}}, Workspace: &fakeWorkspace{}, Store: st,
		Messenger: &fakeMessenger{}, Lifecycle: lcm,
		LookPath: func(string) (string, error) { return "/bin/true", nil },
	})

	rec, err := m.Spawn(ctx, ports.SpawnConfig{
		ProjectID: "mer", Kind: domain.KindWorker, DisplayName: "titled", Prompt: "task",
	})
	if err != nil {
		t.Fatalf("spawn must survive a transient process probe failure while the session is alive: %v", err)
	}
	if rec.ID == "" {
		t.Fatal("spawn returned no session record")
	}
	if rt.destroyed != 0 {
		t.Fatalf("runtime destroyed %d times, want 0", rt.destroyed)
	}
	if lcm.completed != 1 {
		t.Fatalf("MarkSpawned called %d times, want 1", lcm.completed)
	}
	if m.workerMixBucketDown(domain.BucketKey{Harness: domain.HarnessClaudeCode, Model: "opus"}) {
		t.Fatal("worker mix bucket was marked down after a transient probe failure")
	}
}

// TestSpawn_ProcessProbeErrorWithDeadSessionRollsBack: when the launch-process
// probe errors AND the session liveness probe also errors (both infra signals
// failing), the guard cannot confirm the session is alive, so it rolls back and
// surfaces the joined error rather than keeping a session it cannot vouch for.
func TestSpawn_ProcessProbeErrorWithDeadSessionRollsBack(t *testing.T) {
	st := newFakeStore()
	st.projects["mer"] = domain.ProjectRecord{ID: "mer", Config: testRoleAgents()}
	rt := &fakeRuntime{
		processAliveErr: errors.New("tmux: probe pane status failed"),
		aliveErr:        errors.New("tmux: liveness probe failed"),
	}
	lcm := &fakeLCM{store: st}
	m := New(Deps{
		Runtime: rt, Agents: singleAgent{agent: &launchTitleAgent{}}, Workspace: &fakeWorkspace{}, Store: st,
		Messenger: &fakeMessenger{}, Lifecycle: lcm,
		LookPath: func(string) (string, error) { return "/bin/true", nil },
	})
	m.paneReady = paneReadyConfig{pollInterval: time.Millisecond, deadline: 30 * time.Millisecond}
	m.launchProbe = launchProbeConfig{retryDelay: time.Millisecond, attempts: 1}

	_, err := m.Spawn(ctx, ports.SpawnConfig{
		ProjectID: "mer", Kind: domain.KindWorker, DisplayName: "titled", Prompt: "task",
	})
	if err == nil {
		t.Fatal("spawn must fail when both the process probe and the liveness probe error")
	}
	// Both underlying errors must be surfaced (errors.Join), not swallowed.
	if !strings.Contains(err.Error(), "probe pane status failed") || !strings.Contains(err.Error(), "liveness probe failed") {
		t.Fatalf("error must join both probe failures, got: %v", err)
	}
	if rt.destroyed != 1 {
		t.Fatalf("runtime destroyed %d times, want 1 rollback", rt.destroyed)
	}
}

func TestSpawn_RetriesFalseProcessProbeBeforeRollback(t *testing.T) {
	st := newFakeStore()
	st.projects["mer"] = domain.ProjectRecord{ID: "mer", Config: testRoleAgents()}
	rt := &fakeRuntime{aliveByHandle: map[string]bool{"h1": true}, processAliveSeq: []bool{false, true}}
	lcm := &fakeLCM{store: st}
	m := New(Deps{
		Runtime: rt, Agents: singleAgent{agent: &launchTitleAgent{}}, Workspace: &fakeWorkspace{}, Store: st,
		Messenger: &fakeMessenger{}, Lifecycle: lcm,
		LookPath: func(string) (string, error) { return "/bin/true", nil },
	})
	m.paneReady = paneReadyConfig{pollInterval: time.Millisecond, deadline: 30 * time.Millisecond}
	m.launchProbe = launchProbeConfig{retryDelay: time.Millisecond, attempts: 3}

	rec, err := m.Spawn(ctx, ports.SpawnConfig{
		ProjectID: "mer", Kind: domain.KindWorker, DisplayName: "titled", Prompt: "task",
	})
	if err != nil {
		t.Fatalf("spawn must retry a transient false launch-process probe: %v", err)
	}
	if rec.ID == "" {
		t.Fatal("spawn returned no session record")
	}
	if rt.destroyed != 0 {
		t.Fatalf("runtime destroyed %d times, want 0", rt.destroyed)
	}
	if lcm.completed != 1 {
		t.Fatalf("MarkSpawned called %d times, want 1", lcm.completed)
	}
}

// TestSpawn_LaunchProbeAttemptsAreConfigurable pins the grace/backoff to a
// single attempt (no retry) and proves the guard honours it: one false probe
// then rolls back without consuming the second (would-be-true) probe.
func TestSpawn_LaunchProbeAttemptsAreConfigurable(t *testing.T) {
	st := newFakeStore()
	st.projects["mer"] = domain.ProjectRecord{ID: "mer", Config: testRoleAgents()}
	rt := &fakeRuntime{aliveByHandle: map[string]bool{"h1": true}, processAliveSeq: []bool{false, true}}
	lcm := &fakeLCM{store: st}
	m := New(Deps{
		Runtime: rt, Agents: singleAgent{agent: &launchTitleAgent{}}, Workspace: &fakeWorkspace{}, Store: st,
		Messenger: &fakeMessenger{}, Lifecycle: lcm,
		LookPath: func(string) (string, error) { return "/bin/true", nil },
	})
	m.paneReady = paneReadyConfig{pollInterval: time.Millisecond, deadline: 30 * time.Millisecond}
	m.launchProbe = launchProbeConfig{retryDelay: time.Millisecond, attempts: 1}

	if _, err := m.Spawn(ctx, ports.SpawnConfig{
		ProjectID: "mer", Kind: domain.KindWorker, DisplayName: "titled", Prompt: "task",
	}); err == nil {
		t.Fatal("spawn must roll back when the single configured probe reports not-running")
	}
	if rt.destroyed != 1 {
		t.Fatalf("runtime destroyed %d times, want 1 rollback", rt.destroyed)
	}
	// The second, would-be-true probe must remain unconsumed: attempts=1 means
	// exactly one probe.
	if len(rt.processAliveSeq) != 1 {
		t.Fatalf("processAliveSeq has %d entries left, want 1 (only one probe should run)", len(rt.processAliveSeq))
	}
}
