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
	"github.com/aoagents/agent-orchestrator/backend/internal/observe/trackerintake"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	reviewcore "github.com/aoagents/agent-orchestrator/backend/internal/review"
	sessionmanager "github.com/aoagents/agent-orchestrator/backend/internal/session_manager"
	"github.com/aoagents/agent-orchestrator/backend/internal/telemetrymeta"
)

var errOrchestratorReplacementVerification = errors.New("orchestrator replacement verification failed")
var errPrimeReplacementVerification = errors.New("prime replacement verification failed")

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
	ListReviewRunsBySession(ctx context.Context, id domain.SessionID) ([]domain.ReviewRun, error)
	GetRecoveryIncident(ctx context.Context, id string) (domain.RecoveryIncident, bool, error)
	UpdateRecoveryIncident(ctx context.Context, rec domain.RecoveryIncident) (domain.RecoveryIncident, bool, error)
	UpdateRecoveryIncidentIfUnchanged(ctx context.Context, rec, expected domain.RecoveryIncident) (domain.RecoveryIncident, bool, error)
	GetProject(ctx context.Context, id string) (domain.ProjectRecord, bool, error)
	GetFleetPaused(ctx context.Context) (bool, error)
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
	SwitchHarness(ctx context.Context, id domain.SessionID, harness domain.AgentHarness, model string) (domain.SessionRecord, error)
	SetIssue(ctx context.Context, id domain.SessionID, issueID domain.IssueID, issueTitle string) (domain.SessionRecord, error)
	Kill(ctx context.Context, id domain.SessionID) (bool, error)
	RetireForReplacement(ctx context.Context, id domain.SessionID) error
	Send(ctx context.Context, id domain.SessionID, message string) error
	Decision(ctx context.Context, id domain.SessionID) (domain.PendingDecision, bool, error)
	AnswerDecision(ctx context.Context, id domain.SessionID, answer domain.DecisionAnswer) error
	WakeIdle(ctx context.Context, id domain.SessionID, message string) (bool, error)
	Rename(ctx context.Context, id domain.SessionID, displayName string) error
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

// issueTitles resolves a tracker issue's title so the daemon can compute the
// semantic `<repoKey> #<issue> <slug>` session name. Tracker intake already
// carries the title it just read; this exists for the spawn paths that don't
// (the CLI and the HTTP API), so the name is computed identically no matter who
// asked for the session.
type issueTitles interface {
	Title(ctx context.Context, project domain.ProjectRecord, issue domain.IssueID) (string, error)
}

// issueTitleLookupTimeout bounds the tracker call on the spawn path. The title
// only decorates a display name, so a slow tracker must not hold up session
// creation.
const issueTitleLookupTimeout = 5 * time.Second

const recoveryVerificationSpawnTimeout = 2 * time.Minute
const recoveryVerificationCompensationTimeout = 5 * time.Second

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
	primeLock           sync.Mutex
	primeDisplayName    string
	// signalCapable reports whether a harness has a hook pipeline that can
	// deliver activity signals at all. Only capable harnesses are eligible for
	// the no_signal downgrade: a hook-less harness staying silent forever is
	// normal, not a broken pipeline. nil means "unknown": never downgrade.
	signalCapable func(domain.AgentHarness) bool
	// issueTitles resolves issue titles for the semantic session name. nil
	// means no lookup: names degrade to the head-only `<repoKey> #<issue>`.
	issueTitles issueTitles
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
	// IssueTitles resolves tracker issue titles for the computed session name.
	// Left nil, names fall back to `<repoKey> #<issue>` with no slug.
	IssueTitles issueTitles
	// PrimeDisplayName is the optional fleet-scoped name for fresh prime
	// spawns and clean replacements. Empty preserves the project-derived name.
	PrimeDisplayName string
}

// NewWithDeps wires a session service with optional PR-claim dependencies.
func NewWithDeps(d Deps) *Service {
	s := &Service{manager: d.Manager, store: d.Store, prClaimer: d.PRClaimer, scm: d.SCM, clock: d.Clock, signalCapable: d.SignalCapable, telemetry: d.Telemetry, issueTitles: d.IssueTitles, primeDisplayName: strings.TrimSpace(d.PrimeDisplayName)}
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
	return s.spawn(ctx, cfg, false)
}

// VerifyRecoveryIncident records the new fix/remediation being verified and
// respawns a normal worker to prove it past the original failure point.
func (s *Service) VerifyRecoveryIncident(ctx context.Context, incidentID, fixReference string) (domain.Session, error) {
	if s == nil || s.store == nil || s.manager == nil {
		return domain.Session{}, apierr.Internal("SESSION_SERVICE_UNAVAILABLE", "Session service is not fully configured")
	}
	fixReference = strings.TrimSpace(fixReference)
	if fixReference == "" {
		return domain.Session{}, apierr.Invalid("RECOVERY_FIX_REFERENCE_REQUIRED", "fixReference is required before verification respawn", nil)
	}
	incident, ok, err := s.store.GetRecoveryIncident(ctx, strings.TrimSpace(incidentID))
	if err != nil {
		return domain.Session{}, fmt.Errorf("get recovery incident: %w", err)
	}
	if !ok {
		return domain.Session{}, apierr.NotFound("RECOVERY_INCIDENT_NOT_FOUND", "Recovery incident not found")
	}
	if incident.Status == domain.RecoveryIncidentResolved {
		return domain.Session{}, apierr.Conflict("RECOVERY_INCIDENT_RESOLVED", "Recovery incident is already resolved", nil)
	}
	if incident.Status == domain.RecoveryIncidentVerifying && strings.TrimSpace(incident.FixReference) == fixReference {
		return domain.Session{}, apierr.Conflict("RECOVERY_FIX_ALREADY_VERIFYING", "This fix/remediation is already being verified for the incident", nil)
	}
	if strings.TrimSpace(incident.LastFailedFixReference) == fixReference {
		return domain.Session{}, apierr.Conflict("RECOVERY_FIX_PREVIOUSLY_FAILED", "This fix/remediation already failed verification for the incident; record a new fix before respawn", nil)
	}
	expected := incident
	claimed := incident
	claimed.Status = domain.RecoveryIncidentVerifying
	claimed.FixReference = fixReference
	claimed.VerificationSessionID = ""
	claimed.UpdatedAt = s.now()
	if _, ok, err := s.store.UpdateRecoveryIncidentIfUnchanged(ctx, claimed, expected); err != nil {
		return domain.Session{}, fmt.Errorf("claim recovery incident verification: %w", err)
	} else if !ok {
		return domain.Session{}, s.recoveryIncidentCASConflict(ctx, incident.ID, fixReference)
	}
	spawnCtx, cancelSpawn := context.WithTimeout(context.Background(), recoveryVerificationSpawnTimeout)
	rec, err := s.spawnRecoveryVerification(spawnCtx, incident)
	cancelSpawn()
	if err != nil {
		if revertErr := s.revertRecoveryVerificationClaim(incident.ID, expected, claimed); revertErr != nil {
			return domain.Session{}, errors.Join(
				fmt.Errorf("spawn recovery verification: %w", err),
				fmt.Errorf("revert verification claim: %w", revertErr),
			)
		}
		return domain.Session{}, err
	}
	verified := claimed
	verified.VerificationSessionID = rec.ID
	verified.UpdatedAt = s.now()
	compensateCtx, cancelCompensation := context.WithTimeout(context.Background(), recoveryVerificationCompensationTimeout)
	defer cancelCompensation()
	if _, ok, err := s.store.UpdateRecoveryIncidentIfUnchanged(compensateCtx, verified, claimed); err != nil {
		if _, _, rollbackErr := s.manager.RollbackSpawn(compensateCtx, rec.ID); rollbackErr != nil {
			return domain.Session{}, errors.Join(
				fmt.Errorf("update recovery incident: %w", err),
				fmt.Errorf("rollback verification worker %s: %w", rec.ID, rollbackErr),
			)
		}
		return domain.Session{}, fmt.Errorf("update recovery incident: %w", err)
	} else if !ok {
		if _, _, rollbackErr := s.manager.RollbackSpawn(compensateCtx, rec.ID); rollbackErr != nil {
			return domain.Session{}, fmt.Errorf("rollback stale verification worker %s: %w", rec.ID, rollbackErr)
		}
		return domain.Session{}, s.recoveryIncidentCASConflict(compensateCtx, incident.ID, fixReference)
	}
	return s.toSession(compensateCtx, rec)
}

func (s *Service) spawnRecoveryVerification(ctx context.Context, incident domain.RecoveryIncident) (domain.SessionRecord, error) {
	cfg := ports.SpawnConfig{
		ProjectID: incident.ProjectID,
		IssueID:   incident.IssueID,
		Kind:      domain.KindWorker,
		Prompt:    recoveryVerificationPrompt(incident.IssueID),
	}
	project, err := s.requireProject(ctx, cfg.ProjectID)
	if err != nil {
		return domain.SessionRecord{}, err
	}
	if err := s.guardPaused(ctx, project, cfg); err != nil {
		return domain.SessionRecord{}, err
	}
	if issueID, ok := trackerintake.CanonicalIssueIDFromRef(project, cfg.IssueID); ok {
		cfg.IssueID = issueID
	}
	start := s.now()
	firstSession, err := s.isFirstSession(ctx)
	if err != nil {
		return domain.SessionRecord{}, fmt.Errorf("count sessions: %w", err)
	}
	cfg.IssueTitle = s.resolveIssueTitle(ctx, project, cfg)
	rec, err := s.manager.Spawn(ctx, cfg)
	if err != nil {
		s.emitSpawnFailed(cfg, err, s.now().Sub(start).Milliseconds())
		return domain.SessionRecord{}, toAPIError(err)
	}
	s.emitSpawned(rec, s.now().Sub(start).Milliseconds())
	if firstSession {
		s.emitFirstSessionSpawned(rec, project)
	}
	return rec, nil
}

func (s *Service) revertRecoveryVerificationClaim(incidentID string, expected, claimed domain.RecoveryIncident) error {
	revertCtx, cancel := context.WithTimeout(context.Background(), recoveryVerificationCompensationTimeout)
	defer cancel()
	if _, ok, err := s.store.UpdateRecoveryIncidentIfUnchanged(revertCtx, expected, claimed); err != nil {
		return err
	} else if !ok {
		return fmt.Errorf("recovery incident %s changed before claim revert", incidentID)
	}
	return nil
}

func (s *Service) recoveryIncidentCASConflict(ctx context.Context, incidentID, fixReference string) error {
	latest, ok, err := s.store.GetRecoveryIncident(ctx, incidentID)
	if err != nil {
		return fmt.Errorf("get recovery incident after stale update: %w", err)
	}
	if !ok {
		return apierr.NotFound("RECOVERY_INCIDENT_NOT_FOUND", "Recovery incident not found")
	}
	if latest.Status == domain.RecoveryIncidentResolved {
		return apierr.Conflict("RECOVERY_INCIDENT_RESOLVED", "Recovery incident is already resolved", nil)
	}
	if latest.Status == domain.RecoveryIncidentVerifying && strings.TrimSpace(latest.FixReference) == fixReference {
		return apierr.Conflict("RECOVERY_FIX_ALREADY_VERIFYING", "This fix/remediation is already being verified for the incident", nil)
	}
	if strings.TrimSpace(latest.LastFailedFixReference) == fixReference {
		return apierr.Conflict("RECOVERY_FIX_PREVIOUSLY_FAILED", "This fix/remediation already failed verification for the incident; record a new fix before respawn", nil)
	}
	return apierr.Conflict("RECOVERY_INCIDENT_STALE", "Recovery incident changed before verification could be recorded; reload and try again", nil)
}

func recoveryVerificationPrompt(issueID domain.IssueID) string {
	raw := strings.TrimSpace(string(issueID))
	if i := strings.LastIndexByte(raw, '#'); i >= 0 && i+1 < len(raw) {
		return "/address-issue " + raw[i+1:]
	}
	raw = strings.TrimPrefix(raw, "github:")
	if raw == "" {
		return "/address-issue"
	}
	return "/address-issue " + raw
}

func (s *Service) spawn(ctx context.Context, cfg ports.SpawnConfig, allowPrime bool) (domain.Session, error) {
	if cfg.Kind == domain.KindPrime && !allowPrime {
		return domain.Session{}, apierr.Forbidden("PRIME_MANUAL_SPAWN_FORBIDDEN", "Prime sessions are started only by the env-gated supervisor", nil)
	}
	project, err := s.requireProject(ctx, cfg.ProjectID)
	if err != nil {
		return domain.Session{}, err
	}
	if err := s.guardPaused(ctx, project, cfg); err != nil {
		return domain.Session{}, err
	}
	if issueID, ok := trackerintake.CanonicalIssueIDFromRef(project, cfg.IssueID); ok {
		cfg.IssueID = issueID
	} else if cfg.Kind == domain.KindWorker && strings.TrimSpace(string(cfg.IssueID)) == "" {
		if issueID, ok := trackerintake.CanonicalIssueIDFromAddressIssuePrompt(project, cfg.Prompt); ok {
			cfg.IssueID = issueID
			cfg.DisplayName = ""
		}
	}
	start := s.now()
	firstSession, err := s.isFirstSession(ctx)
	if err != nil {
		return domain.Session{}, fmt.Errorf("count sessions: %w", err)
	}
	cfg.IssueTitle = s.resolveIssueTitle(ctx, project, cfg)
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

// resolveIssueTitle returns the tracker title to use for the session's computed
// name. Every spawn path funnels through Spawn — tracker intake, the CLI, and
// the HTTP API — but only intake already knows the title, so this fills the gap
// for the other two rather than making each caller fetch it.
//
// The title is cosmetic: it only supplies the slug in `<repoKey> #<issue>
// <slug>`. A tracker outage, a missing credential, or an issue id this daemon
// cannot map therefore degrades to the head-only name instead of failing the
// spawn.
func (s *Service) resolveIssueTitle(ctx context.Context, project domain.ProjectRecord, cfg ports.SpawnConfig) string {
	if existing := strings.TrimSpace(cfg.IssueTitle); existing != "" {
		return existing
	}
	if s.issueTitles == nil || strings.TrimSpace(string(cfg.IssueID)) == "" {
		return ""
	}
	if _, ok := trackerintake.IssueTrackerID(project, cfg.IssueID); !ok {
		return ""
	}
	lookupCtx, cancel := context.WithTimeout(ctx, issueTitleLookupTimeout)
	defer cancel()
	title, err := s.issueTitles.Title(lookupCtx, project, cfg.IssueID)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(title)
}

// guardPaused rejects a worker spawn when the project (or the whole fleet) is
// paused, unless the caller sets Force (`ao spawn --force`). Pause means "start
// no new work": it gates worker spawns only. Orchestrator lifecycle during a
// pause is governed by the orchestrator supervisor, not this guard, so an
// orchestrator spawn is never blocked here. Prime is the fleet's meta tier —
// the tier through which the operator pauses and resumes projects — so neither
// a host-project nor a fleet-wide pause may block it; its only off-switch is
// the operator's activation config (#312). A nil store (bare test service)
// can't be paused, so the guard is a no-op there.
func (s *Service) guardPaused(ctx context.Context, project domain.ProjectRecord, cfg ports.SpawnConfig) error {
	if cfg.Force || cfg.Kind == domain.KindOrchestrator || cfg.Kind == domain.KindPrime || s.store == nil {
		return nil
	}
	scope := ""
	switch {
	case project.Paused:
		scope = "project"
	default:
		fleetPaused, err := s.store.GetFleetPaused(ctx)
		if err != nil {
			return fmt.Errorf("get fleet paused: %w", err)
		}
		if fleetPaused {
			scope = "fleet"
		}
	}
	if scope == "" {
		return nil
	}
	return apierr.Conflict(
		"PROJECT_PAUSED",
		fmt.Sprintf("Fleet pause is active (%s scope): new sessions for project %s are blocked. Resume it, or pass --force to override.", scope, project.ID),
		map[string]any{"projectId": project.ID, "scope": scope},
	)
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
			_ = s.sendRetireNotice(ctx, orch.ID, orchestratorRetireNotice)
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
		s.emitOrchestratorReplacementVerificationFailed(project, sess, err)
	}
	return sess, nil
}

const orchestratorRetireNotice = "AO is replacing this project orchestrator. Stop coordinating new work now; a fresh orchestrator will take over on the canonical branch."

const primeRetireNotice = "AO is replacing the prime orchestrator. Stop supervising new fleet work now; a fresh prime will take over on the canonical branch."

func (s *Service) sendRetireNotice(ctx context.Context, id domain.SessionID, notice string) error {
	if err := s.manager.Send(ctx, id, notice); err != nil {
		return fmt.Errorf("send retire notice to %s: %w", id, err)
	}
	return nil
}

// SpawnPrime spawns the optional global prime orchestrator under its configured
// host project. Unlike project orchestrators, prime is a fleet-wide singleton:
// clean=false returns any active prime in the store, and clean=true retires all
// active primes before creating the replacement under projectID.
func (s *Service) SpawnPrime(ctx context.Context, projectID domain.ProjectID, clean bool) (domain.Session, error) {
	s.primeLock.Lock()
	defer s.primeLock.Unlock()

	project, err := s.requireProject(ctx, projectID)
	if err != nil {
		return domain.Session{}, err
	}
	existing, err := s.activePrimeSessions(ctx)
	if err != nil {
		return domain.Session{}, err
	}
	if clean {
		for _, prime := range existing {
			_ = s.sendRetireNotice(ctx, prime.ID, primeRetireNotice)
			if err := s.manager.RetireForReplacement(ctx, prime.ID); err != nil {
				return domain.Session{}, toAPIError(err)
			}
		}
	} else if len(existing) > 0 {
		return newestSession(existing), nil
	}
	sess, err := s.spawn(ctx, ports.SpawnConfig{ProjectID: projectID, Kind: domain.KindPrime, DisplayName: s.primeDisplayName}, true)
	if err != nil {
		return domain.Session{}, err
	}
	if err := verifyPrimeReplacement(project, sess); err != nil {
		s.emitOrchestratorReplacementVerificationFailed(project, sess, err)
	}
	return sess, nil
}

// ActivePrime returns the newest active fleet prime without spawning one.
func (s *Service) ActivePrime(ctx context.Context) (domain.Session, bool, error) {
	s.primeLock.Lock()
	defer s.primeLock.Unlock()

	existing, err := s.activePrimeSessions(ctx)
	if err != nil {
		return domain.Session{}, false, err
	}
	if len(existing) == 0 {
		return domain.Session{}, false, nil
	}
	return newestSession(existing), true, nil
}

func (s *Service) activePrimeSessions(ctx context.Context) ([]domain.Session, error) {
	if s.store == nil {
		return nil, nil
	}
	records, err := s.store.ListAllSessions(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]domain.Session, 0, 1)
	for _, rec := range records {
		if rec.Kind != domain.KindPrime || rec.IsTerminated {
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

func (s *Service) emitOrchestratorReplacementVerificationFailed(project domain.ProjectRecord, sess domain.Session, err error) {
	if s.telemetry == nil {
		return
	}
	projectID := domain.ProjectID(project.ID)
	sessionID := sess.ID
	apiErr := toAPIError(err)
	errorKind, errorCode := telemetrymeta.ErrorKindAndCode(apiErr)
	payload := map[string]any{
		"component":           "session_service",
		"operation":           "replace_orchestrator",
		"kind":                string(sess.Kind),
		"harness":             string(sess.Harness),
		"branch":              sess.Metadata.Branch,
		"verification_detail": err.Error(),
		"remediation":         "Inspect the spawned orchestrator session; stop and replace it manually if it is not on the expected branch or harness.",
		"error_kind":          errorKind,
		"fingerprint":         telemetrymeta.Fingerprint("session_service", "replace_orchestrator", string(sess.Kind), string(sess.Harness), errorKind, errorCode),
	}
	if errorCode != "" {
		payload["error_code"] = errorCode
	}
	s.telemetry.Emit(context.Background(), ports.TelemetryEvent{
		Name:       "ao.orchestrator.replacement_verification_failed",
		Source:     "session_service",
		OccurredAt: s.now(),
		Level:      ports.TelemetryLevelWarn,
		ProjectID:  &projectID,
		SessionID:  &sessionID,
		Payload:    payload,
	})
}

func verifyOrchestratorReplacement(project domain.ProjectRecord, sess domain.Session) error {
	if sess.IsTerminated {
		return fmt.Errorf("%w: new session %s is terminated", errOrchestratorReplacementVerification, sess.ID)
	}
	if sess.Kind != domain.KindOrchestrator {
		return fmt.Errorf("%w: new session %s has kind %q", errOrchestratorReplacementVerification, sess.ID, sess.Kind)
	}
	if expected := project.Config.Orchestrator.Harness; expected != "" && sess.Harness != expected {
		return fmt.Errorf("%w: new session %s uses harness %q, want %q", errOrchestratorReplacementVerification, sess.ID, sess.Harness, expected)
	}
	expectedBranch := "ao/" + domain.DefaultProjectPrefix(project.ID) + "-orchestrator"
	if sess.Metadata.Branch != "" && sess.Metadata.Branch != expectedBranch {
		return fmt.Errorf("%w: new session %s uses branch %q, want %q", errOrchestratorReplacementVerification, sess.ID, sess.Metadata.Branch, expectedBranch)
	}
	return nil
}

func verifyPrimeReplacement(project domain.ProjectRecord, sess domain.Session) error {
	if sess.IsTerminated {
		return fmt.Errorf("%w: new session %s is terminated", errPrimeReplacementVerification, sess.ID)
	}
	if sess.Kind != domain.KindPrime {
		return fmt.Errorf("%w: new session %s has kind %q", errPrimeReplacementVerification, sess.ID, sess.Kind)
	}
	if expected := project.Config.Prime.Harness; expected != "" && sess.Harness != expected {
		return fmt.Errorf("%w: new session %s uses harness %q, want %q", errPrimeReplacementVerification, sess.ID, sess.Harness, expected)
	}
	expectedBranch := "ao/" + domain.DefaultProjectPrefix(project.ID) + "-prime"
	if sess.Metadata.Branch != "" && sess.Metadata.Branch != expectedBranch {
		return fmt.Errorf("%w: new session %s uses branch %q, want %q", errPrimeReplacementVerification, sess.ID, sess.Metadata.Branch, expectedBranch)
	}
	return nil
}

// ActiveOrchestrator returns the newest live orchestrator for a project, if one
// exists, without spawning. The orchestrator supervisor uses it to message a
// paused project's orchestrator without creating a fresh one.
func (s *Service) ActiveOrchestrator(ctx context.Context, project domain.ProjectID) (domain.Session, bool, error) {
	active := true
	list, err := s.List(ctx, ListFilter{ProjectID: project, Active: &active, OrchestratorOnly: true})
	if err != nil {
		return domain.Session{}, false, err
	}
	if len(list) == 0 {
		return domain.Session{}, false, nil
	}
	return newestSession(list), true, nil
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

// SwitchHarness swaps a live session's agent in place and returns the updated
// read model. model, when non-empty, overrides the agent model for the new launch.
//
// A merged session is locked: it must never switch. "merged" is a DERIVED
// read-model status (from PR facts), so the internal manager — which sees only
// durable session/workspace facts — cannot enforce it. Reject it here so direct
// API/CLI callers are held to the same rule as the inspector UI.
func (s *Service) SwitchHarness(ctx context.Context, id domain.SessionID, harness domain.AgentHarness, model string) (domain.Session, error) {
	if s.store != nil {
		cur, ok, err := s.store.GetSession(ctx, id)
		if err != nil {
			return domain.Session{}, fmt.Errorf("switch %s: %w", id, err)
		}
		if ok {
			sess, err := s.toSession(ctx, cur)
			if err != nil {
				return domain.Session{}, err
			}
			if sess.Status == domain.StatusMerged {
				return domain.Session{}, apierr.Conflict("SESSION_MERGED", "A merged session cannot switch agents", nil)
			}
		}
	}
	rec, err := s.manager.SwitchHarness(ctx, id, harness, model)
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

// Decision returns a queryable pending harness dialog for a session.
func (s *Service) Decision(ctx context.Context, id domain.SessionID) (domain.PendingDecision, bool, error) {
	decision, ok, err := s.manager.Decision(ctx, id)
	return decision, ok, toAPIError(err)
}

// AnswerDecision delegates answer delivery to the session manager's narrow
// question-only answer path.
func (s *Service) AnswerDecision(ctx context.Context, id domain.SessionID, answer domain.DecisionAnswer) error {
	return toAPIError(s.manager.AnswerDecision(ctx, id, answer))
}

// WakeIdle delegates daemon-owned idle wake delivery to the internal manager.
func (s *Service) WakeIdle(ctx context.Context, id domain.SessionID, message string) (bool, error) {
	sent, err := s.manager.WakeIdle(ctx, id, message)
	return sent, toAPIError(err)
}

// Rename updates the user-facing session display name.
func (s *Service) Rename(ctx context.Context, id domain.SessionID, displayName string) error {
	displayName = strings.TrimSpace(displayName)
	if displayName == "" {
		return apierr.Invalid("DISPLAY_NAME_REQUIRED", "Display name is required", nil)
	}
	if len([]rune(displayName)) > 20 {
		return apierr.Invalid("DISPLAY_NAME_TOO_LONG", "displayName must be 20 characters or fewer", nil)
	}
	if s.manager != nil {
		return toAPIError(s.manager.Rename(ctx, id, displayName))
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

// SetIssue changes the worker session's bound tracker issue and lets the
// manager recompute and deliver the daemon-owned display name.
func (s *Service) SetIssue(ctx context.Context, id domain.SessionID, issueID domain.IssueID) (domain.Session, error) {
	if strings.TrimSpace(string(issueID)) == "" {
		return domain.Session{}, apierr.Invalid("ISSUE_ID_REQUIRED", "issueId is required", nil)
	}
	rec, ok, err := s.store.GetSession(ctx, id)
	if err != nil {
		return domain.Session{}, fmt.Errorf("get %s: %w", id, err)
	}
	if !ok {
		return domain.Session{}, apierr.NotFound("SESSION_NOT_FOUND", "Unknown session")
	}
	if rec.Kind != domain.KindWorker {
		return domain.Session{}, apierr.Invalid("SESSION_NOT_WORKER", "Only worker sessions can be rebound to an issue", nil)
	}
	project, err := s.requireProject(ctx, rec.ProjectID)
	if err != nil {
		return domain.Session{}, err
	}
	if canonical, ok := trackerintake.CanonicalIssueIDFromRef(project, issueID); ok {
		issueID = canonical
	}
	issueTitle := s.resolveIssueTitle(ctx, project, ports.SpawnConfig{IssueID: issueID})
	updated, err := s.manager.SetIssue(ctx, id, issueID, issueTitle)
	if err != nil {
		return domain.Session{}, toAPIError(err)
	}
	return s.toSession(ctx, updated)
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

// HardDrain immediately terminates a paused project's live worker sessions (the
// `--hard` pause path), returning the count terminated. Orchestrators are left
// running unless includeOrchestrators is set (the `--hard --all` fleet path).
// Termination goes through Kill, so no zombie tmux is left behind.
func (s *Service) HardDrain(ctx context.Context, project domain.ProjectID, includeOrchestrators bool) (int, error) {
	recs, err := s.listRecords(ctx, project)
	if err != nil {
		return 0, err
	}
	killed := 0
	// Best-effort: `--hard` is the emergency stop for a runaway/rogue fleet, so a
	// single failed Kill must not strand every later session. Terminate all
	// eligible sessions, collect failures, and return the count plus a joined
	// error (nil when every kill succeeded).
	var errs []error
	for _, rec := range recs {
		if rec.IsTerminated {
			continue
		}
		if rec.Kind == domain.KindOrchestrator && !includeOrchestrators {
			continue
		}
		ok, err := s.Kill(ctx, rec.ID)
		if err != nil {
			errs = append(errs, fmt.Errorf("kill %s: %w", rec.ID, err))
			continue
		}
		if ok {
			killed++
		}
	}
	return killed, errors.Join(errs...)
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
			"Session is paused on a pending decision; query GET /api/v1/sessions/{id}/decision, answer question dialogs with `ao session decide`, or answer permission dialogs in the session terminal", nil)
	case errors.Is(err, sessionmanager.ErrNoPendingDecision):
		return apierr.NotFound("SESSION_DECISION_NOT_FOUND", "No pending decision is known for this session")
	case errors.Is(err, sessionmanager.ErrDecisionNotAnswerable):
		return apierr.Conflict("SESSION_DECISION_NOT_ANSWERABLE", "Pending permission decisions cannot be answered programmatically", nil)
	case errors.Is(err, sessionmanager.ErrInvalidDecisionAnswer):
		return apierr.Invalid("INVALID_DECISION_ANSWER", "Provide a valid one-based option or non-empty text answer", nil)
	case errors.Is(err, sessionmanager.ErrDecisionRevisionRequired):
		return apierr.Invalid("DECISION_REVISION_REQUIRED",
			"Answers must name the decision revision they were prepared against; fetch GET /api/v1/sessions/{id}/decision and pass its revision", nil)
	case errors.Is(err, sessionmanager.ErrDecisionStale):
		return apierr.Conflict("SESSION_DECISION_STALE",
			"The pending decision changed since it was fetched; fetch it again and re-answer the current dialog", nil)
	case errors.Is(err, sessionmanager.ErrIncompleteHandle):
		return apierr.Conflict("SESSION_INCOMPLETE_HANDLE", "Session is missing runtime or workspace handles", nil)
	case errors.Is(err, sessionmanager.ErrNotResumable):
		return apierr.Conflict("SESSION_NOT_RESUMABLE",
			"This session has no saved agent session or prompt to resume from", nil)
	case errors.Is(err, sessionmanager.ErrSwitchInProgress):
		return apierr.Conflict("SWITCH_IN_PROGRESS", "An agent switch is already in progress for this session", nil)
	case errors.Is(err, errOrchestratorReplacementVerification):
		return apierr.Conflict("ORCHESTRATOR_REPLACEMENT_VERIFICATION_FAILED",
			"Orchestrator replacement spawned but did not match verification expectations. Inspect the spawned session and replace it manually if needed. Verification detail: "+err.Error(),
			map[string]any{"verificationDetail": err.Error()})
	case errors.Is(err, errPrimeReplacementVerification):
		return apierr.Conflict("PRIME_REPLACEMENT_VERIFICATION_FAILED",
			"Prime replacement spawned but did not match verification expectations. Inspect the spawned session and replace it manually if needed. Verification detail: "+err.Error(),
			map[string]any{"verificationDetail": err.Error()})
	case errors.Is(err, sessionmanager.ErrProjectNotResolvable):
		return apierr.Invalid("PROJECT_NOT_RESOLVABLE", "Project is not registered or has no repo. Register it with `ao project add`", nil)
	case errors.Is(err, sessionmanager.ErrUnknownHarness):
		return apierr.Invalid("UNKNOWN_HARNESS", err.Error(), nil)
	case errors.Is(err, sessionmanager.ErrMissingHarness):
		return apierr.Invalid("AGENT_REQUIRED", err.Error(), nil)
	case errors.Is(err, sessionmanager.ErrInvalidKind):
		return apierr.Invalid("INVALID_KIND", err.Error(), nil)
	case errors.Is(err, sessionmanager.ErrWorkerConcurrencyCap):
		return apierr.Conflict("WORKER_CONCURRENCY_CAP", err.Error(), nil)
	case errors.Is(err, sessionmanager.ErrWorkerMixBucketDown):
		return apierr.Conflict("WORKER_MIX_BUCKET_DOWN", err.Error(), nil)
	case errors.Is(err, sessionmanager.ErrModelHarnessMismatch):
		return apierr.Invalid("MODEL_HARNESS_MISMATCH", err.Error(), nil)
	case errors.Is(err, sessionmanager.ErrModelUnreachable):
		return apierr.Invalid("MODEL_UNREACHABLE", err.Error(), nil)
	case errors.Is(err, sessionmanager.ErrBranchNotAllowedInPlace):
		return apierr.Invalid("BRANCH_NOT_ALLOWED_IN_PLACE", err.Error(), nil)
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
	status := deriveStatus(rec, prs, s.now(), s.harnessSignals(rec.Harness))
	if status == domain.StatusMergeable || status == domain.StatusApproved {
		clean, err := s.currentHeadsHaveCleanFinalReview(ctx, rec.ID)
		if err != nil {
			return domain.Session{}, err
		}
		if !clean {
			status = domain.StatusReviewPending
		}
	}
	return domain.Session{SessionRecord: rec, Status: status, TerminalHandleID: rec.Metadata.RuntimeHandleID, PRs: prs}, nil
}

func (s *Service) currentHeadsHaveCleanFinalReview(ctx context.Context, id domain.SessionID) (bool, error) {
	prs, err := s.store.ListPRsBySession(ctx, id)
	if err != nil {
		return false, err
	}
	open := make([]domain.PullRequest, 0, len(prs))
	for _, pr := range prs {
		if pr.URL != "" && pr.HeadSHA != "" && !pr.Draft && !pr.Merged && !pr.Closed {
			open = append(open, pr)
		}
	}
	if len(open) == 0 {
		return true, nil
	}
	runs, err := s.store.ListReviewRunsBySession(ctx, id)
	if err != nil {
		return false, err
	}
	for _, state := range reviewcore.Plan(open, runs) {
		if state.FinalReviewStatus != reviewcore.ReviewStateUpToDate {
			return false, nil
		}
	}
	return true, nil
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
