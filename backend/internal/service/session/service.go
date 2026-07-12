package session

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apierr"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	sessionmanager "github.com/aoagents/agent-orchestrator/backend/internal/session_manager"
	"github.com/aoagents/agent-orchestrator/backend/internal/telemetrymeta"
)

// Store is the read-only persistence surface needed to assemble controller-facing session read models.
type Store interface {
	GetSession(ctx context.Context, id domain.SessionID) (domain.SessionRecord, bool, error)
	ListSessions(ctx context.Context, project domain.ProjectID) ([]domain.SessionRecord, error)
	ListAllSessions(ctx context.Context) ([]domain.SessionRecord, error)
	RenameSession(ctx context.Context, id domain.SessionID, displayName string, updatedAt time.Time) (bool, error)
	SetSessionPreviewURL(ctx context.Context, id domain.SessionID, previewURL string, updatedAt time.Time) (bool, error)
	GetDisplayPRFactsForSession(ctx context.Context, id domain.SessionID) (domain.PRFacts, bool, error)
	ListPRFactsForSession(ctx context.Context, id domain.SessionID) ([]domain.PRFacts, error)
	ListPRsBySession(ctx context.Context, sessionID domain.SessionID) ([]domain.PullRequest, error)
	ListChecks(ctx context.Context, prURL string) ([]domain.PullRequestCheck, error)
	ListPRReviews(ctx context.Context, prURL string) ([]domain.PullRequestReview, error)
	ListPRReviewThreads(ctx context.Context, prURL string) ([]domain.PullRequestReviewThread, error)
	ListPRComments(ctx context.Context, prURL string) ([]domain.PullRequestComment, error)
	GetProject(ctx context.Context, id string) (domain.ProjectRecord, bool, error)
}

// ListFilter captures API-facing session list query filters.
type ListFilter struct {
	ProjectID        domain.ProjectID
	Active           *bool
	OrchestratorOnly bool
	Fresh            bool
}

// commander is the command-side surface Service delegates to: the
// *sessionmanager.Manager in production, a fake in tests.
type commander interface {
	Spawn(ctx context.Context, cfg ports.SpawnConfig) (domain.SessionRecord, error)
	Restore(ctx context.Context, id domain.SessionID) (domain.SessionRecord, error)
	Kill(ctx context.Context, id domain.SessionID) (bool, error)
	RetireForReplacement(ctx context.Context, id domain.SessionID) error
	Send(ctx context.Context, id domain.SessionID, message string) error
	Cleanup(ctx context.Context, project domain.ProjectID) (sessionmanager.CleanupResult, error)
	RollbackSpawn(ctx context.Context, id domain.SessionID) (deleted, killed bool, err error)
}

// RollbackOutcome reports what happened in a rollback: either the seed row was
// deleted, or the partially-spawned session was killed (runtime+workspace torn
// down, row marked terminated).
type RollbackOutcome struct {
	Deleted bool `json:"deleted"`
	Killed  bool `json:"killed"`
}

// CleanupOutcome reports what session cleanup reclaimed and what it preserved.
type CleanupOutcome struct {
	Cleaned []domain.SessionID `json:"cleaned"`
	Skipped []CleanupSkipped   `json:"skipped"`
}

// CleanupSkipped is one terminal session whose workspace was preserved by
// cleanup (never force-deleted), with the user-facing reason.
type CleanupSkipped struct {
	SessionID domain.SessionID `json:"sessionId"`
	Reason    string           `json:"reason"`
}

type scmProvider interface {
	ParseRepository(remote string) (ports.SCMRepo, bool)
	FetchPullRequests(ctx context.Context, refs []ports.SCMPRRef) ([]ports.SCMObservation, error)
	FetchReviewThreads(ctx context.Context, ref ports.SCMPRRef) (ports.SCMReviewObservation, error)
}

// Service is the controller-facing session service. It delegates command-side
// session operations to the internal sessionmanager.Manager and owns read-model
// assembly, including user-facing display status derivation.
type Service struct {
	manager             commander
	store               Store
	prClaimer           ports.PRClaimer
	scm                 scmProvider
	clock               func() time.Time
	telemetry           ports.EventSink
	orchestratorLocksMu sync.Mutex
	orchestratorLocks   map[domain.ProjectID]*sync.Mutex
	// signalCapable reports whether a harness has a hook pipeline that can
	// deliver activity signals at all. Only capable harnesses are eligible for
	// the no_signal downgrade: a hook-less harness staying silent forever is
	// normal, not a broken pipeline. nil means "unknown": never downgrade.
	signalCapable func(domain.AgentHarness) bool
}

// New wires a controller-facing session service over an internal session Manager.
func New(manager *sessionmanager.Manager, store Store) *Service {
	return NewWithDeps(Deps{Manager: manager, Store: store})
}

// Deps are optional collaborators for the session service. The default New
// path keeps existing tests and callers small; daemon wiring uses NewWithDeps
// to supply SCM observation for PR claiming.
type Deps struct {
	Manager   commander
	Store     Store
	PRClaimer ports.PRClaimer
	SCM       scmProvider
	Clock     func() time.Time
	Telemetry ports.EventSink
	// SignalCapable gates the no_signal status downgrade per harness; daemon
	// wiring passes activitydispatch.SupportsHarness. Left nil, no session is
	// ever downgraded to no_signal.
	SignalCapable func(domain.AgentHarness) bool
}

// NewWithDeps wires a session service with optional PR-claim dependencies.
func NewWithDeps(d Deps) *Service {
	s := &Service{manager: d.Manager, store: d.Store, prClaimer: d.PRClaimer, scm: d.SCM, clock: d.Clock, signalCapable: d.SignalCapable, telemetry: d.Telemetry}
	if s.prClaimer == nil {
		if w, ok := d.Store.(ports.PRClaimer); ok {
			s.prClaimer = w
		}
	}
	if s.clock == nil {
		s.clock = time.Now
	}
	return s
}

// Spawn creates a session and returns the API-facing read model.
func (s *Service) Spawn(ctx context.Context, cfg ports.SpawnConfig) (domain.Session, error) {
	project, err := s.requireProject(ctx, cfg.ProjectID)
	if err != nil {
		return domain.Session{}, err
	}
	start := s.now()
	firstSession, err := s.isFirstSession(ctx)
	if err != nil {
		return domain.Session{}, fmt.Errorf("count sessions: %w", err)
	}
	rec, err := s.manager.Spawn(ctx, cfg)
	if err != nil {
		s.emitSpawnFailed(cfg, err, s.now().Sub(start).Milliseconds())
		return domain.Session{}, toAPIError(err)
	}
	s.emitSpawned(rec, s.now().Sub(start).Milliseconds())
	if firstSession {
		s.emitFirstSessionSpawned(rec, project)
	}
	return s.toSession(ctx, rec)
}

// requireProject verifies the project is registered before any spawn write
// touches the session store, so an unknown projectId surfaces as a typed 404
// rather than an opaque 500 with an orphan terminated row left behind.
func (s *Service) requireProject(ctx context.Context, id domain.ProjectID) (domain.ProjectRecord, error) {
	if id == "" {
		return domain.ProjectRecord{}, apierr.Invalid("PROJECT_ID_REQUIRED", "projectId is required", nil)
	}
	if s.store == nil {
		return domain.ProjectRecord{ID: string(id)}, nil
	}
	rec, ok, err := s.store.GetProject(ctx, string(id))
	if err != nil {
		return domain.ProjectRecord{}, fmt.Errorf("get project %s: %w", id, err)
	}
	if !ok {
		return domain.ProjectRecord{}, apierr.NotFound("PROJECT_NOT_FOUND", "Unknown project. Register it with `ao project add`")
	}
	return rec, nil
}

func (s *Service) isFirstSession(ctx context.Context) (bool, error) {
	if s.store == nil {
		return false, nil
	}
	rows, err := s.store.ListAllSessions(ctx)
	if err != nil {
		return false, err
	}
	return len(rows) == 0, nil
}

func (s *Service) emitSpawned(rec domain.SessionRecord, durationMs int64) {
	if s.telemetry == nil {
		return
	}
	projectID := rec.ProjectID
	sessionID := rec.ID
	s.telemetry.Emit(context.Background(), ports.TelemetryEvent{
		Name:       "ao.session.spawned",
		Source:     "session_service",
		OccurredAt: s.now(),
		Level:      ports.TelemetryLevelInfo,
		ProjectID:  &projectID,
		SessionID:  &sessionID,
		Payload: map[string]any{
			"kind":        string(rec.Kind),
			"harness":     string(rec.Harness),
			"duration_ms": durationMs,
		},
	})
}

func (s *Service) emitFirstSessionSpawned(rec domain.SessionRecord, project domain.ProjectRecord) {
	if s.telemetry == nil {
		return
	}
	projectID := rec.ProjectID
	sessionID := rec.ID
	payload := map[string]any{
		"kind":    string(rec.Kind),
		"harness": string(rec.Harness),
	}
	if !project.RegisteredAt.IsZero() {
		payload["since_first_project_ms"] = s.now().Sub(project.RegisteredAt).Milliseconds()
	}
	s.telemetry.Emit(context.Background(), ports.TelemetryEvent{
		Name:       "ao.onboarding.first_session_spawned",
		Source:     "session_service",
		OccurredAt: s.now(),
		Level:      ports.TelemetryLevelInfo,
		ProjectID:  &projectID,
		SessionID:  &sessionID,
		Payload:    payload,
	})
}

func (s *Service) emitSpawnFailed(cfg ports.SpawnConfig, err error, durationMs int64) {
	if s.telemetry == nil {
		return
	}
	projectID := cfg.ProjectID
	apiErr := toAPIError(err)
	errorKind, errorCode := telemetrymeta.ErrorKindAndCode(apiErr)
	payload := map[string]any{
		"component":   "session_service",
		"operation":   "spawn_session",
		"kind":        string(cfg.Kind),
		"harness":     string(cfg.Harness),
		"duration_ms": durationMs,
		"error_kind":  errorKind,
		"fingerprint": telemetrymeta.Fingerprint("session_service", "spawn_session", string(cfg.Kind), string(cfg.Harness), errorKind, errorCode),
	}
	if errorCode != "" {
		payload["error_code"] = errorCode
	}
	s.telemetry.Emit(context.Background(), ports.TelemetryEvent{
		Name:       "ao.session.spawn_failed",
		Source:     "session_service",
		OccurredAt: s.now(),
		Level:      ports.TelemetryLevelError,
		ProjectID:  &projectID,
		Payload:    payload,
	})
}

// SpawnOrchestrator spawns an orchestrator session for a project. When clean is
// true it first tears down any active orchestrator(s) for that project so the new
// one is the only live coordinator. When clean is false it is idempotent: if an
// active orchestrator already exists it is returned as-is. A business rule that
// belongs here, not in the HTTP controller.
func (s *Service) SpawnOrchestrator(ctx context.Context, projectID domain.ProjectID, clean bool) (domain.Session, error) {
	unlock := s.lockOrchestratorProject(projectID)
	defer unlock()

	project, err := s.requireProject(ctx, projectID)
	if err != nil {
		return domain.Session{}, err
	}
	active := true
	if clean {
		existing, err := s.List(ctx, ListFilter{ProjectID: projectID, Active: &active, OrchestratorOnly: true})
		if err != nil {
			return domain.Session{}, err
		}
		for _, orch := range existing {
			_ = s.sendRetireNotice(ctx, orch.ID)
			if err := s.manager.RetireForReplacement(ctx, orch.ID); err != nil {
				return domain.Session{}, toAPIError(err)
			}
		}
	} else {
		// ponytail: check-then-spawn is not atomic; fine for the single-frontend ensure-on-load case. Upgrade path: a partial unique index on (project_id) where kind=orchestrator and not terminated.
		existing, err := s.List(ctx, ListFilter{ProjectID: projectID, Active: &active, OrchestratorOnly: true})
		if err != nil {
			return domain.Session{}, err
		}
		if len(existing) > 0 {
			return newestSession(existing), nil
		}
	}
	sess, err := s.Spawn(ctx, ports.SpawnConfig{ProjectID: projectID, Kind: domain.KindOrchestrator})
	if err != nil {
		return domain.Session{}, err
	}
	if err := verifyOrchestratorReplacement(project, sess); err != nil {
		return domain.Session{}, err
	}
	return sess, nil
}

const orchestratorRetireNotice = "AO is replacing this project orchestrator. Stop coordinating new work now; a fresh orchestrator will take over on the canonical branch."

func (s *Service) sendRetireNotice(ctx context.Context, id domain.SessionID) error {
	if err := s.manager.Send(ctx, id, orchestratorRetireNotice); err != nil {
		return fmt.Errorf("send retire notice to %s: %w", id, err)
	}
	return nil
}

func verifyOrchestratorReplacement(project domain.ProjectRecord, sess domain.Session) error {
	if sess.IsTerminated {
		return fmt.Errorf("orchestrator replacement verification failed: new session %s is terminated", sess.ID)
	}
	if sess.Kind != domain.KindOrchestrator {
		return fmt.Errorf("orchestrator replacement verification failed: new session %s has kind %q", sess.ID, sess.Kind)
	}
	if expected := project.Config.Orchestrator.Harness; expected != "" && sess.Harness != expected {
		return fmt.Errorf("orchestrator replacement verification failed: new session %s uses harness %q, want %q", sess.ID, sess.Harness, expected)
	}
	expectedBranch := "ao/" + serviceSessionPrefix(project) + "-orchestrator"
	if sess.Metadata.Branch != "" && sess.Metadata.Branch != expectedBranch {
		return fmt.Errorf("orchestrator replacement verification failed: new session %s uses branch %q, want %q", sess.ID, sess.Metadata.Branch, expectedBranch)
	}
	return nil
}

func serviceSessionPrefix(project domain.ProjectRecord) string {
	if p := strings.TrimSpace(project.Config.SessionPrefix); p != "" {
		return p
	}
	id := project.ID
	if len(id) <= 12 {
		return id
	}
	return id[:12]
}

func newestSession(sessions []domain.Session) domain.Session {
	newest := sessions[0]
	for _, sess := range sessions[1:] {
		if sessionNewer(sess.SessionRecord, newest.SessionRecord) {
			newest = sess
		}
	}
	return newest
}

func sessionNewer(a, b domain.SessionRecord) bool {
	if !a.CreatedAt.Equal(b.CreatedAt) {
		return a.CreatedAt.After(b.CreatedAt)
	}
	if !a.UpdatedAt.Equal(b.UpdatedAt) {
		return a.UpdatedAt.After(b.UpdatedAt)
	}
	return string(a.ID) > string(b.ID)
}

func (s *Service) lockOrchestratorProject(projectID domain.ProjectID) func() {
	s.orchestratorLocksMu.Lock()
	if s.orchestratorLocks == nil {
		s.orchestratorLocks = make(map[domain.ProjectID]*sync.Mutex)
	}
	mu := s.orchestratorLocks[projectID]
	if mu == nil {
		mu = &sync.Mutex{}
		s.orchestratorLocks[projectID] = mu
	}
	s.orchestratorLocksMu.Unlock()

	mu.Lock()
	return mu.Unlock
}

// Restore relaunches a terminated session and returns the API-facing read model.
func (s *Service) Restore(ctx context.Context, id domain.SessionID) (domain.Session, error) {
	rec, err := s.manager.Restore(ctx, id)
	if err != nil {
		return domain.Session{}, toAPIError(err)
	}
	return s.toSession(ctx, rec)
}

// Kill delegates terminal intent and teardown to the internal manager.
func (s *Service) Kill(ctx context.Context, id domain.SessionID) (bool, error) {
	freed, err := s.manager.Kill(ctx, id)
	return freed, toAPIError(err)
}

// RollbackSpawn deletes a seed-state session row, or falls back to a Kill if
// the session has spawn output. Used by the CLI to undo a `spawn --claim-pr`
// when the claim step fails, avoiding the orphan terminated row that a plain
// Kill would leave behind.
func (s *Service) RollbackSpawn(ctx context.Context, id domain.SessionID) (RollbackOutcome, error) {
	deleted, killed, err := s.manager.RollbackSpawn(ctx, id)
	if err != nil {
		return RollbackOutcome{}, toAPIError(err)
	}
	return RollbackOutcome{Deleted: deleted, Killed: killed}, nil
}

// Send delegates agent messaging to the internal manager.
func (s *Service) Send(ctx context.Context, id domain.SessionID, message string) error {
	return toAPIError(s.manager.Send(ctx, id, message))
}

// Rename updates the user-facing session display name.
func (s *Service) Rename(ctx context.Context, id domain.SessionID, displayName string) error {
	displayName = strings.TrimSpace(displayName)
	if displayName == "" {
		return apierr.Invalid("DISPLAY_NAME_REQUIRED", "Display name is required", nil)
	}
	renamed, err := s.store.RenameSession(ctx, id, displayName, time.Now().UTC())
	if err != nil {
		return fmt.Errorf("rename %s: %w", id, err)
	}
	if !renamed {
		return apierr.NotFound("SESSION_NOT_FOUND", "Unknown session")
	}
	return nil
}

// SetPreview persists the browser preview URL for a session and returns the
// refreshed read model. The URL is taken verbatim from the caller (the
// controller resolves it, either an explicit target or an autodetected entry).
// Persisting it via the store fans out a session_updated CDC event through the
// sessions_cdc_update trigger, mirroring how other session mutations surface on
// the live event stream.
func (s *Service) SetPreview(ctx context.Context, id domain.SessionID, previewURL string) (domain.Session, error) {
	updated, err := s.store.SetSessionPreviewURL(ctx, id, previewURL, time.Now().UTC())
	if err != nil {
		return domain.Session{}, fmt.Errorf("set preview url %s: %w", id, err)
	}
	if !updated {
		return domain.Session{}, apierr.NotFound("SESSION_NOT_FOUND", "Unknown session")
	}
	return s.Get(ctx, id)
}

// Cleanup delegates terminal workspace cleanup to the internal manager and
// reports both reclaimed and preserved (skipped) workspaces.
func (s *Service) Cleanup(ctx context.Context, project domain.ProjectID) (CleanupOutcome, error) {
	res, err := s.manager.Cleanup(ctx, project)
	if err != nil {
		return CleanupOutcome{}, err
	}
	out := CleanupOutcome{Cleaned: res.Cleaned, Skipped: make([]CleanupSkipped, 0, len(res.Skipped))}
	if out.Cleaned == nil {
		out.Cleaned = []domain.SessionID{}
	}
	for _, skip := range res.Skipped {
		out.Skipped = append(out.Skipped, CleanupSkipped{SessionID: skip.SessionID, Reason: skip.Reason})
	}
	return out, nil
}

// TeardownProject stops every live session in a project, then asks the session
// manager to reclaim terminal workspaces. Dirty worktrees are preserved by Kill
// and Cleanup; callers only see hard teardown failures.
func (s *Service) TeardownProject(ctx context.Context, project domain.ProjectID) error {
	recs, err := s.listRecords(ctx, project)
	if err != nil {
		return err
	}
	for _, rec := range recs {
		if rec.IsTerminated {
			continue
		}
		if _, err := s.Kill(ctx, rec.ID); err != nil {
			return err
		}
	}
	_, err = s.Cleanup(ctx, project)
	return err
}

// List returns sessions as enriched display models after applying API filters.
func (s *Service) List(ctx context.Context, filter ListFilter) ([]domain.Session, error) {
	recs, err := s.listRecords(ctx, filter.ProjectID)
	if err != nil {
		return nil, err
	}
	out := make([]domain.Session, 0, len(recs))
	for _, rec := range recs {
		if !matchesSessionFilter(rec, filter) {
			continue
		}
		sess, err := s.toSession(ctx, rec)
		if err != nil {
			return nil, err
		}
		out = append(out, sess)
	}
	return out, nil
}

func (s *Service) listRecords(ctx context.Context, project domain.ProjectID) ([]domain.SessionRecord, error) {
	if project == "" {
		recs, err := s.store.ListAllSessions(ctx)
		if err != nil {
			return nil, fmt.Errorf("list all sessions: %w", err)
		}
		return recs, nil
	}
	recs, err := s.store.ListSessions(ctx, project)
	if err != nil {
		return nil, fmt.Errorf("list %s: %w", project, err)
	}
	return recs, nil
}

func matchesSessionFilter(rec domain.SessionRecord, filter ListFilter) bool {
	if filter.Active != nil && rec.IsTerminated == *filter.Active {
		return false
	}
	if filter.OrchestratorOnly && rec.Kind != domain.KindOrchestrator {
		return false
	}
	if filter.Fresh && rec.IsTerminated {
		return false
	}
	return true
}

// Get returns one session as an enriched display model, or an apierr.NotFound
// (SESSION_NOT_FOUND) if it is absent.
func (s *Service) Get(ctx context.Context, id domain.SessionID) (domain.Session, error) {
	rec, ok, err := s.store.GetSession(ctx, id)
	if err != nil {
		return domain.Session{}, fmt.Errorf("get %s: %w", id, err)
	}
	if !ok {
		return domain.Session{}, apierr.NotFound("SESSION_NOT_FOUND", "Unknown session")
	}
	return s.toSession(ctx, rec)
}

// toAPIError maps the session engine's sentinel errors to their REST API
// equivalents; an unrecognized error passes through and surfaces as a 500.
func toAPIError(err error) error {
	switch {
	case err == nil:
		return nil
	case errors.Is(err, sessionmanager.ErrNotFound):
		return apierr.NotFound("SESSION_NOT_FOUND", "Unknown session")
	case errors.Is(err, sessionmanager.ErrNotRestorable):
		return apierr.Conflict("SESSION_NOT_RESTORABLE", "Session is not restorable", nil)
	case errors.Is(err, sessionmanager.ErrTerminated):
		return apierr.Conflict("SESSION_TERMINATED", "Session is terminated", nil)
	case errors.Is(err, sessionmanager.ErrAwaitingDecision):
		return apierr.Conflict("SESSION_AWAITING_DECISION",
			"Session is paused on a permission decision; answer it in the session terminal first", nil)
	case errors.Is(err, sessionmanager.ErrIncompleteHandle):
		return apierr.Conflict("SESSION_INCOMPLETE_HANDLE", "Session is missing runtime or workspace handles", nil)
	case errors.Is(err, sessionmanager.ErrNotResumable):
		return apierr.Conflict("SESSION_NOT_RESUMABLE",
			"This session has no saved agent session or prompt to resume from", nil)
	case errors.Is(err, sessionmanager.ErrProjectNotResolvable):
		return apierr.Invalid("PROJECT_NOT_RESOLVABLE", "Project is not registered or has no repo. Register it with `ao project add`", nil)
	case errors.Is(err, sessionmanager.ErrUnknownHarness):
		return apierr.Invalid("UNKNOWN_HARNESS", err.Error(), nil)
	case errors.Is(err, sessionmanager.ErrMissingHarness):
		return apierr.Invalid("AGENT_REQUIRED", err.Error(), nil)
	case errors.Is(err, ports.ErrWorkspaceBranchCheckedOutElsewhere):
		return apierr.Conflict("BRANCH_CHECKED_OUT_ELSEWHERE", err.Error(), nil)
	case errors.Is(err, ports.ErrWorkspaceBranchNotFetched):
		return apierr.Invalid("BRANCH_NOT_FETCHED", err.Error(), nil)
	case errors.Is(err, ports.ErrWorkspaceBranchInvalid):
		return apierr.Invalid("INVALID_BRANCH", err.Error(), nil)
	case errors.Is(err, ports.ErrAgentBinaryNotFound):
		return apierr.Invalid("AGENT_BINARY_NOT_FOUND", err.Error(), nil)
	case errors.Is(err, ports.ErrRuntimePrerequisite):
		return apierr.Invalid("RUNTIME_PREREQUISITE_MISSING", err.Error(), nil)
	default:
		return err
	}
}

func (s *Service) toSession(ctx context.Context, rec domain.SessionRecord) (domain.Session, error) {
	prs, err := s.store.ListPRFactsForSession(ctx, rec.ID)
	if err != nil {
		return domain.Session{}, fmt.Errorf("pr facts %s: %w", rec.ID, err)
	}
	return domain.Session{SessionRecord: rec, Status: deriveStatus(rec, prs, s.now(), s.harnessSignals(rec.Harness)), TerminalHandleID: rec.Metadata.RuntimeHandleID, PRs: prs}, nil
}

// now tolerates a zero-value Service (tests construct the struct literally
// without going through New, which is where clock gets its default).
func (s *Service) now() time.Time {
	if s.clock == nil {
		return time.Now().UTC()
	}
	return s.clock().UTC()
}

// harnessSignals tolerates a zero-value Service the same way now does. Without
// an injected capability predicate the service cannot tell a broken pipeline
// from a hook-less harness, so it never claims no_signal.
func (s *Service) harnessSignals(h domain.AgentHarness) bool {
	if s.signalCapable == nil {
		return false
	}
	return s.signalCapable(h)
}
