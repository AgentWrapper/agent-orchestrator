// Package trackerintake implements the opt-in issue-intake observer. It polls a
// project's configured tracker for eligible issues and starts one worker session
// per issue, leaving PR/lifecycle handling to the existing observers.
package trackerintake

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/url"
	"strings"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apierr"
	"github.com/aoagents/agent-orchestrator/backend/internal/observe"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

const (
	// DefaultTickInterval is intentionally slower than runtime liveness checks:
	// intake is a backlog sweep, not an interactive status surface.
	DefaultTickInterval = time.Minute
	// DefaultFailureBackoff suppresses repeated polls for a project after an
	// intake failure. The observer retries automatically after this window.
	DefaultFailureBackoff = 5 * time.Minute
)

// Store is the durable read surface the observer needs.
type Store interface {
	ListProjects(ctx context.Context) ([]domain.ProjectRecord, error)
	ListAllSessions(ctx context.Context) ([]domain.SessionRecord, error)
	// ListOpenPRs returns every tracked PR that is neither merged nor closed.
	// Intake pins an issue as seen when its open PR has a LIVE driver (a
	// non-terminated owning session) — the mechanical half of the duplicate-PR
	// guard (issue #181). A PR whose owner is terminated is deliberately NOT
	// pinned: that is the died-with-open-PR case (#230), routed to the terminal
	// death escalation instead. See seenIssueIDs.
	ListOpenPRs(ctx context.Context) ([]domain.PullRequest, error)
	ListPRsBySession(ctx context.Context, sessionID domain.SessionID) ([]domain.PullRequest, error)
	GetUnresolvedRecoveryIncidentByFingerprint(ctx context.Context, projectID domain.ProjectID, issueID domain.IssueID, fingerprint string) (domain.RecoveryIncident, bool, error)
	CreateRecoveryIncident(ctx context.Context, rec domain.RecoveryIncident) (domain.RecoveryIncident, error)
	UpdateRecoveryIncident(ctx context.Context, rec domain.RecoveryIncident) (domain.RecoveryIncident, bool, error)
	GetFleetPaused(ctx context.Context) (bool, error)
}

// Spawner is the session creation surface used by intake.
type Spawner interface {
	Spawn(ctx context.Context, cfg ports.SpawnConfig) (domain.Session, error)
}

// TrackerResolver picks the tracker adapter for a project's configured
// provider.
type TrackerResolver interface {
	Resolve(provider domain.TrackerProvider) (ports.Tracker, error)
}

// SingleTrackerResolver returns the same tracker for one specific provider and
// refuses every other provider. It exists so single-provider deployments don't
// need to construct a map.
type SingleTrackerResolver struct {
	Provider domain.TrackerProvider
	Adapter  ports.Tracker
}

// Resolve returns the wrapped adapter when the requested provider matches, or
// when the resolver was constructed without a provider pin.
func (s SingleTrackerResolver) Resolve(provider domain.TrackerProvider) (ports.Tracker, error) {
	if s.Adapter == nil {
		return nil, fmt.Errorf("tracker intake: no adapter for provider %q", provider)
	}
	if s.Provider == "" || provider == "" || provider == s.Provider {
		return s.Adapter, nil
	}
	return nil, fmt.Errorf("tracker intake: no adapter for provider %q", provider)
}

// Config holds optional observer knobs. Zero values use production defaults.
type Config struct {
	Tick           time.Duration
	FailureBackoff time.Duration
	Clock          func() time.Time
	Logger         *slog.Logger
	Notifications  notificationSink
}

type notificationSink interface {
	Notify(ctx context.Context, intent ports.NotificationIntent) error
}

// Observer polls configured projects and starts sessions for eligible issues.
type Observer struct {
	resolver       TrackerResolver
	store          Store
	spawner        Spawner
	tick           time.Duration
	failureBackoff time.Duration
	clock          func() time.Time
	logger         *slog.Logger
	notifications  notificationSink
	backoffUntil   map[string]time.Time
}

// New constructs an Observer with safe defaults.
func New(resolver TrackerResolver, store Store, spawner Spawner, cfg Config) *Observer {
	o := &Observer{resolver: resolver, store: store, spawner: spawner, tick: cfg.Tick, failureBackoff: cfg.FailureBackoff, clock: cfg.Clock, logger: cfg.Logger, notifications: cfg.Notifications, backoffUntil: map[string]time.Time{}}
	if o.tick <= 0 {
		o.tick = DefaultTickInterval
	}
	if o.failureBackoff <= 0 {
		o.failureBackoff = DefaultFailureBackoff
	}
	if o.clock == nil {
		o.clock = time.Now
	}
	if o.logger == nil {
		o.logger = slog.Default()
	}
	return o
}

// Start launches the observer loop. The first poll runs immediately inside the
// goroutine, keeping daemon startup non-blocking.
func (o *Observer) Start(ctx context.Context) <-chan struct{} {
	return observe.StartPollLoop(ctx, o.tick, o.Poll, o.logger, "tracker intake")
}

// Poll runs one synchronous intake pass. Store discovery failures are returned
// because they prevent the pass from knowing the current world; provider and
// spawn failures are logged and skipped so one bad issue/project does not block
// the rest of the daemon.
func (o *Observer) Poll(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if o.resolver == nil || o.store == nil || o.spawner == nil {
		return nil
	}
	now := o.clock().UTC()
	// Fleet pause short-circuits the whole tick: dispatch nothing for any
	// project, including ones registered after the pause (they have no
	// per-project bit set — the distinct global flag gates them here).
	if fleetPaused, err := o.store.GetFleetPaused(ctx); err != nil {
		return err
	} else if fleetPaused {
		o.logger.Debug("tracker intake: fleet paused, skipping tick")
		return nil
	}
	projects, err := o.store.ListProjects(ctx)
	if err != nil {
		return err
	}
	enabledProjects := make([]domain.ProjectRecord, 0, len(projects))
	for _, project := range projects {
		// A paused project keeps its intake config intact but dispatches
		// nothing until resumed — pause is a gate, not config surgery.
		if project.Config.TrackerIntake.Enabled && !project.Paused {
			enabledProjects = append(enabledProjects, project)
		}
	}
	if len(enabledProjects) == 0 {
		return nil
	}
	sessions, err := o.store.ListAllSessions(ctx)
	if err != nil {
		return err
	}
	// A worker session may have ended while its PR stays open. Reading open PRs
	// lets intake treat "issue already has an open PR" as seen even when no live
	// session ties back to it, closing the duplicate-PR intake gap (issue #181).
	// A read failure must not silently re-dispatch a duplicate, so it fails the
	// pass (retried after backoff).
	openPRs, err := o.store.ListOpenPRs(ctx)
	if err != nil {
		return err
	}
	seen := seenIssueIDs(enabledProjects, sessions, openPRs)
	issueSessions := issueSessionsByProject(enabledProjects, sessions)
	for _, project := range enabledProjects {
		if err := ctx.Err(); err != nil {
			return err
		}
		if until, ok := o.backoffUntil[project.ID]; ok && now.Before(until) {
			o.logger.Debug("tracker intake: project in failure backoff", "project", project.ID, "until", until)
			continue
		}
		if failed := o.pollProject(ctx, project, seen, issueSessions[domain.ProjectID(project.ID)]); failed {
			o.backoffUntil[project.ID] = now.Add(o.failureBackoff)
		} else {
			delete(o.backoffUntil, project.ID)
		}
	}
	return nil
}

// pollProject returns failed=true for conditions that should be retried after a
// backoff window rather than logged on every poll.
func (o *Observer) pollProject(ctx context.Context, project domain.ProjectRecord, seen map[domain.IssueID]bool, sessionsByIssue map[domain.IssueID][]domain.SessionRecord) (failed bool) {
	cfg := project.Config.TrackerIntake.WithDefaults()
	if !cfg.Enabled {
		return false
	}
	if err := cfg.Validate(); err != nil {
		o.logger.Warn("tracker intake: skipping project with invalid config", "project", project.ID, "err", err)
		return true
	}
	repo, ok := trackerRepo(project, cfg)
	if !ok {
		o.logger.Warn("tracker intake: skipping project without tracker scope", "project", project.ID, "provider", cfg.Provider, "origin", project.RepoOriginURL)
		return true
	}
	tracker, err := o.resolver.Resolve(cfg.Provider)
	if err != nil {
		o.logger.Warn("tracker intake: no adapter for provider", "project", project.ID, "provider", cfg.Provider, "err", err)
		return true
	}
	issues, err := tracker.List(ctx, repo, domain.ListFilter{
		State:    domain.ListOpen,
		Assignee: cfg.Assignee,
	})
	if err != nil {
		o.logger.Error("tracker intake: list issues failed", "project", project.ID, "repo", repo.Native, "err", err)
		return true
	}
	var spawnFailed bool
	workerPoolFull := false
	for _, issue := range issues {
		if ctx.Err() != nil {
			return true
		}
		if issue.State != domain.IssueOpen {
			continue
		}
		if !issueMatchesConfig(issue, cfg) {
			continue
		}
		issueID := CanonicalIssueID(issue.ID)
		if issueID == "" {
			continue
		}
		sessionsForIssue := sessionsByIssue[issueID]
		if seen[issueID] {
			// A live worker or live-driven open PR marks the issue handled — but a
			// live NON-worker session (an orchestrator bound to the issue) must not
			// silence a dead worker's terminal escalation, so fall through to the
			// dispatch decision when a terminated worker exists. That decision never
			// spawns while a terminated worker is present, so a seen issue can never
			// be double-dispatched from here.
			if _, ok := latestTerminatedWorker(sessionsForIssue); !ok {
				continue
			}
		}
		decision, err := o.dispatchDecision(ctx, issueID, sessionsForIssue)
		if err != nil {
			o.logger.Error("tracker intake: dispatch decision failed", "project", project.ID, "issue", issueID, "err", err)
			spawnFailed = true
			continue
		}
		if decision.intent != nil {
			o.emitNotification(ctx, *decision.intent)
		}
		if decision.done {
			seen[issueID] = true
			continue
		}
		if !decision.spawn {
			continue
		}
		if workerPoolFull {
			o.logger.Debug("tracker intake: normal worker pool already full, deferring issue", "project", project.ID, "issue", issueID)
			continue
		}
		spawnCfg := ports.SpawnConfig{
			ProjectID:  domain.ProjectID(project.ID),
			IssueID:    issueID,
			IssueTitle: issue.Title,
			Kind:       domain.KindWorker,
			Prompt:     BuildIssuePrompt(issue),
		}
		if harness, ok := domain.RoutingHarnessForIssueLabels(issue.Labels); ok {
			spawnCfg.Harness = harness
		}
		if _, err := o.spawner.Spawn(ctx, spawnCfg); err != nil {
			if isWorkerDeferral(err) {
				o.logger.Debug("tracker intake: spawn deferred by session allocator", "project", project.ID, "issue", issueID, "err", err)
				if isWorkerConcurrencyCap(err) {
					workerPoolFull = true
				}
				continue
			}
			o.logger.Error("tracker intake: spawn issue session failed", "project", project.ID, "issue", issueID, "err", err)
			spawnFailed = true
			continue
		}
		seen[issueID] = true
	}
	return spawnFailed
}

func isWorkerDeferral(err error) bool {
	return isWorkerConcurrencyCap(err) || isWorkerMixBucketDown(err)
}

func isWorkerConcurrencyCap(err error) bool {
	var apiError *apierr.Error
	return errors.As(err, &apiError) && apiError.Code == "WORKER_CONCURRENCY_CAP"
}

func isWorkerMixBucketDown(err error) bool {
	var apiError *apierr.Error
	return errors.As(err, &apiError) && apiError.Code == "WORKER_MIX_BUCKET_DOWN"
}

type dispatchDecision struct {
	spawn  bool
	done   bool
	intent *ports.NotificationIntent
}

// dispatchDecision decides what intake should do about an issue that already has
// session history. The dedup key is a *live driver*, not the mere existence of a
// PR (issue #230): only a non-terminated worker (or a landed/merged PR) makes an
// issue "handled". A worker that died with unfinished work — with or without an
// orphaned open PR — emits one terminal death notification and requires an
// explicit operator restart; intake never launches replacement workers (#313).
// Silence is never the terminal state.
func (o *Observer) dispatchDecision(ctx context.Context, issueID domain.IssueID, sessions []domain.SessionRecord) (dispatchDecision, error) {
	if len(sessions) == 0 {
		return dispatchDecision{spawn: true}, nil
	}
	// A live worker is actively driving the issue (its PR, if any, has a driver):
	// this is the legitimate duplicate-PR guard case (#181). Never notify — leave
	// the live worker alone.
	if hasLiveWorker(sessions) {
		return dispatchDecision{done: true}, nil
	}
	// No live worker. Inspect the (necessarily terminated) sessions' PRs against
	// the LATEST dead worker's chronology.
	latest, hasDeadWorker := latestTerminatedWorker(sessions)
	openPR, hasCurrentMerged, err := o.inspectHandledPRs(ctx, sessions, latest)
	if err != nil {
		return dispatchDecision{}, err
	}
	if hasCurrentMerged && openPR.URL == "" {
		// Work landed on a merged PR that belongs to (or postdates) the latest
		// dead worker; nothing left to do. Checked before the dead-worker gate so
		// a landed PR can never trigger a death escalation. A merged PR that
		// PREDATES the latest worker proves nothing about it — a reopened issue or
		// a later worker dying after an earlier PR merged must still escalate.
		return dispatchDecision{done: true}, nil
	}
	if !hasDeadWorker {
		return dispatchDecision{spawn: true}, nil
	}
	// A dead worker with unfinished work: create/advance the durable recovery
	// incident, escalate once per incident state (the notification store dedupes
	// re-emissions), and wait for diagnosis plus a new fix before verification
	// respawn. An orphaned open PR is a fact the operator needs, so the
	// notification names it.
	incident, err := o.ensureRecoveryIncident(ctx, issueID, latest, openPR)
	if err != nil {
		return dispatchDecision{}, err
	}
	intent := workerDiedIntent(latest, issueID, incident)
	intent.PRURL = openPR.URL
	return dispatchDecision{intent: &intent}, nil
}

func (o *Observer) ensureRecoveryIncident(ctx context.Context, issueID domain.IssueID, latest domain.SessionRecord, openPR domain.PullRequest) (domain.RecoveryIncident, error) {
	failurePoint := domain.RecoveryFailurePoint(latest, openPR.URL)
	fingerprint := domain.RecoveryFingerprint(latest.ProjectID, issueID, latest.TerminalFailureReason, failurePoint)
	existing, ok, err := o.store.GetUnresolvedRecoveryIncidentByFingerprint(ctx, latest.ProjectID, issueID, fingerprint)
	if err != nil {
		return domain.RecoveryIncident{}, err
	}
	now := o.clock().UTC()
	if now.IsZero() {
		now = time.Now().UTC()
	}
	if ok {
		if existing.LastSessionID == latest.ID {
			return existing, nil
		}
		existing.Attempt++
		existing.Status = domain.RecoveryIncidentOpen
		existing.Rung = domain.RecoveryRungForAttempt(existing.Attempt)
		existing.DeadSessionID = latest.ID
		existing.LastSessionID = latest.ID
		existing.TerminalFailureReason = strings.TrimSpace(latest.TerminalFailureReason)
		existing.FailurePoint = failurePoint
		existing.OpenPRURL = openPR.URL
		if failedFix := strings.TrimSpace(existing.FixReference); failedFix != "" {
			existing.LastFailedFixReference = failedFix
		}
		existing.FixReference = ""
		existing.VerificationSessionID = ""
		existing.UpdatedAt = now
		updated, found, err := o.store.UpdateRecoveryIncident(ctx, existing)
		if err != nil {
			return domain.RecoveryIncident{}, err
		}
		if !found {
			return domain.RecoveryIncident{}, fmt.Errorf("recovery incident disappeared during update: %s", existing.ID)
		}
		return updated, nil
	}
	createdAt := sessionSortTime(latest)
	if createdAt.IsZero() {
		createdAt = now
	}
	rec := domain.RecoveryIncident{
		ID:                    domain.RecoveryIncidentID(latest.ProjectID, issueID, fingerprint, latest.ID),
		ProjectID:             latest.ProjectID,
		IssueID:               issueID,
		Fingerprint:           fingerprint,
		Status:                domain.RecoveryIncidentOpen,
		Rung:                  domain.RecoveryRungWorker,
		Attempt:               1,
		DeadSessionID:         latest.ID,
		LastSessionID:         latest.ID,
		TerminalFailureReason: strings.TrimSpace(latest.TerminalFailureReason),
		FailurePoint:          failurePoint,
		OpenPRURL:             openPR.URL,
		CreatedAt:             createdAt,
		UpdatedAt:             now,
	}
	return o.store.CreateRecoveryIncident(ctx, rec)
}

// inspectHandledPRs summarizes the PRs owned by an issue's worker sessions:
// openPR is the first still-open PR (zero if none) and hasCurrentMerged reports
// a merged PR that belongs to the LATEST terminated worker or postdates its
// chronology. A merged PR from an EARLIER worker generation proves nothing
// about the latest one — a reopened issue, or a later worker dying after an
// earlier worker's PR merged, must still escalate rather than be silenced by
// stale history. Callers reach this only after ruling out a live worker, so an
// open PR found here is orphaned by definition and is surfaced as a fact in
// the terminal death notification. Closed-unmerged PRs are reported as neither.
func (o *Observer) inspectHandledPRs(ctx context.Context, sessions []domain.SessionRecord, latest domain.SessionRecord) (openPR domain.PullRequest, hasCurrentMerged bool, err error) {
	if o.store == nil {
		return domain.PullRequest{}, false, nil
	}
	for _, sess := range sessions {
		if sess.Kind != domain.KindWorker {
			continue
		}
		prs, err := o.store.ListPRsBySession(ctx, sess.ID)
		if err != nil {
			return domain.PullRequest{}, false, err
		}
		for _, pr := range prs {
			switch {
			case pr.Merged:
				if mergedPRIsCurrent(pr, sess, latest) {
					hasCurrentMerged = true
				}
			case !pr.Closed && openPR.URL == "":
				openPR = pr
			}
		}
	}
	return openPR, hasCurrentMerged, nil
}

// mergedPRIsCurrent reports whether a merged PR counts as completing the
// CURRENT worker generation: it belongs to the latest terminated worker, or its
// last observed update does not predate that worker's chronology (e.g. an
// earlier worker's PR merged posthumously, after the latest worker died). The
// timestamp comparison needs BOTH sides to be usable: a latest worker with no
// recorded chronology must not let an earlier PR's nonzero timestamp silence
// its death escalation.
func mergedPRIsCurrent(pr domain.PullRequest, owner, latest domain.SessionRecord) bool {
	if latest.ID == "" {
		return true
	}
	if owner.ID == latest.ID {
		return true
	}
	latestTime := sessionSortTime(latest)
	return !pr.UpdatedAt.IsZero() && !latestTime.IsZero() && !pr.UpdatedAt.Before(latestTime)
}

// hasLiveWorker reports whether any non-terminated worker session is present for
// the issue — the "live driver" that makes an open PR a legitimate dedup case
// rather than an orphan (issue #230).
func hasLiveWorker(sessions []domain.SessionRecord) bool {
	for _, sess := range sessions {
		if sess.Kind == domain.KindWorker && !sess.IsTerminated {
			return true
		}
	}
	return false
}

func (o *Observer) emitNotification(ctx context.Context, intent ports.NotificationIntent) {
	if o.notifications == nil {
		return
	}
	if err := o.notifications.Notify(ctx, intent); err != nil {
		o.logger.Warn("tracker intake: notification failed", "session", intent.SessionID, "issue", intent.IssueID, "type", intent.Type, "err", err)
	}
}

func latestTerminatedWorker(sessions []domain.SessionRecord) (domain.SessionRecord, bool) {
	var latest domain.SessionRecord
	for _, sess := range sessions {
		if sess.Kind != domain.KindWorker || !sess.IsTerminated {
			continue
		}
		if latest.ID == "" || sessionSortTime(sess).After(sessionSortTime(latest)) {
			latest = sess
		}
	}
	return latest, latest.ID != ""
}

func sessionSortTime(sess domain.SessionRecord) time.Time {
	if !sess.UpdatedAt.IsZero() {
		return sess.UpdatedAt
	}
	return sess.CreatedAt
}

// workerDiedIntent is the terminal death escalation for a worker that
// terminated with unfinished work. It carries the session's terminal failure
// reason so the operator sees where the worker died; resuming the issue
// requires an explicit operator restart.
func workerDiedIntent(sess domain.SessionRecord, issueID domain.IssueID, incident domain.RecoveryIncident) ports.NotificationIntent {
	return ports.NotificationIntent{
		Type:                  domain.NotificationWorkerDiedUnfinished,
		SessionID:             sess.ID,
		ProjectID:             sess.ProjectID,
		IssueID:               issueID,
		CreatedAt:             sessionSortTime(sess),
		SessionDisplayName:    sess.DisplayName,
		TerminalFailureReason: strings.TrimSpace(sess.TerminalFailureReason),
		RecoveryIncidentID:    incident.ID,
		RecoveryAttempt:       incident.Attempt,
		RecoveryRung:          incident.Rung,
	}
}

func issueMatchesConfig(issue domain.Issue, cfg domain.TrackerIntakeConfig) bool {
	assignee := strings.TrimSpace(cfg.Assignee)
	switch {
	case assignee == "":
		return false
	case assignee == "*":
		return len(issue.Assignees) > 0
	case strings.EqualFold(assignee, "none"):
		return false
	default:
		return containsFold(issue.Assignees, assignee)
	}
}

func containsFold(values []string, needle string) bool {
	for _, value := range values {
		if strings.EqualFold(strings.TrimSpace(value), needle) {
			return true
		}
	}
	return false
}

func seenIssueIDs(projects []domain.ProjectRecord, sessions []domain.SessionRecord, openPRs []domain.PullRequest) map[domain.IssueID]bool {
	seen := make(map[domain.IssueID]bool, len(sessions))
	projectByID := make(map[domain.ProjectID]domain.ProjectRecord, len(projects))
	for _, project := range projects {
		projectByID[domain.ProjectID(project.ID)] = project
	}
	markSeen := func(projectID domain.ProjectID, issue domain.IssueID) {
		if issue == "" {
			return
		}
		seen[issue] = true
		if project, ok := projectByID[projectID]; ok {
			if canonical, ok := CanonicalIssueIDFromRef(project, issue); ok {
				seen[canonical] = true
			}
		}
	}
	sessionByID := make(map[domain.SessionID]domain.SessionRecord, len(sessions))
	for _, sess := range sessions {
		sessionByID[sess.ID] = sess
		if sess.IsTerminated {
			continue
		}
		markSeen(sess.ProjectID, sess.IssueID)
	}
	// An issue with an open PR driven by a *live* worker must never be
	// re-dispatched (issue #181). This is a direct, PR-anchored guarantee rather
	// than relying only on the session-linkage pass above: even if the
	// session-side attribution changes (a future filter of the sessions slice, a
	// linkage the session row lost, or an intake pass that scopes sessions
	// differently), a live-driven open PR still pins its issue as seen.
	//
	// A PR owned by a *terminated* session is deliberately NOT pinned here: that
	// is the died-with-open-PR case (issue #230). Pinning it seen would silence the
	// orphaned PR — no live worker drives it, yet intake would treat it as handled.
	// Letting it fall through routes it to dispatchDecision, which escalates the
	// terminal worker death (naming the orphaned PR) for an explicit operator
	// restart. The dedup key is "open PR with a live driver", not merely "open PR
	// exists".
	for _, pr := range openPRs {
		sess, ok := sessionByID[pr.SessionID]
		if !ok || sess.IsTerminated {
			continue
		}
		markSeen(sess.ProjectID, sess.IssueID)
	}
	return seen
}

func issueSessionsByProject(projects []domain.ProjectRecord, sessions []domain.SessionRecord) map[domain.ProjectID]map[domain.IssueID][]domain.SessionRecord {
	out := make(map[domain.ProjectID]map[domain.IssueID][]domain.SessionRecord)
	projectByID := make(map[domain.ProjectID]domain.ProjectRecord, len(projects))
	for _, project := range projects {
		projectByID[domain.ProjectID(project.ID)] = project
	}
	for _, sess := range sessions {
		if sess.IssueID == "" {
			continue
		}
		byIssue := out[sess.ProjectID]
		if byIssue == nil {
			byIssue = make(map[domain.IssueID][]domain.SessionRecord)
			out[sess.ProjectID] = byIssue
		}
		byIssue[sess.IssueID] = append(byIssue[sess.IssueID], sess)
		if project, ok := projectByID[sess.ProjectID]; ok {
			if canonical, ok := CanonicalIssueIDFromRef(project, sess.IssueID); ok {
				if canonical == sess.IssueID {
					continue
				}
				byIssue[canonical] = append(byIssue[canonical], sess)
			}
		}
	}
	return out
}

// CanonicalIssueID stores tracker issue ids in sessions.issue_id with the
// provider included, so future providers cannot collide on native ids.
func CanonicalIssueID(id domain.TrackerID) domain.IssueID {
	provider := id.Provider
	if provider == "" {
		provider = domain.TrackerProviderGitHub
	}
	native := strings.TrimSpace(id.Native)
	if native == "" {
		return ""
	}
	return domain.IssueID(string(provider) + ":" + native)
}

// BuildIssuePrompt returns the worker's initial task: exactly the single-entry
// router invocation `/address-issue <id>`, nothing more. The router is
// self-sufficient — it resolves the repo, reads the issue itself, claims,
// implements, reviews, and writes durable progress back to the ticket — so the
// worker needs only the issue reference, never a dump of title/url/labels/body.
// Keeping the prompt minimal is the permanent fix from GH #118: durable context
// lives in the ticket (it survives session loss and lets a resumed worker pick
// up from there), not in the spawn prompt.
func BuildIssuePrompt(issue domain.Issue) string {
	return "/address-issue " + intakeIssueRef(issue.ID)
}

// intakeIssueRef reduces a canonical tracker id to the reference the
// `/address-issue` skill consumes. GitHub's native form is "owner/repo#123" and
// the skill wants the issue number (it resolves the repo itself from the
// worker's environment), so everything after the last '#' is the reference. A
// native id without a '#' is passed through trimmed, so bare native ids still
// yield a resolvable argument instead of an empty one.
func intakeIssueRef(id domain.TrackerID) string {
	native := strings.TrimSpace(id.Native)
	if i := strings.LastIndexByte(native, '#'); i >= 0 {
		return native[i+1:]
	}
	return native
}

func trackerRepo(project domain.ProjectRecord, cfg domain.TrackerIntakeConfig) (domain.TrackerRepo, bool) {
	provider := cfg.Provider
	if provider == "" {
		provider = domain.TrackerProviderGitHub
	}
	if provider != domain.TrackerProviderGitHub {
		return domain.TrackerRepo{}, false
	}
	native := strings.TrimSpace(cfg.Repo)
	if native == "" {
		native = parseGitHubRepoNative(project.RepoOriginURL)
	}
	if native == "" {
		return domain.TrackerRepo{}, false
	}
	return domain.TrackerRepo{Provider: provider, Native: native}, true
}

func parseGitHubRepoNative(remote string) string {
	remote = strings.TrimSpace(remote)
	if remote == "" {
		return ""
	}
	if strings.HasPrefix(remote, "git@") {
		if _, rest, ok := strings.Cut(remote, ":"); ok {
			return cleanRepoPath(rest)
		}
	}
	if u, err := url.Parse(remote); err == nil && u.Host != "" {
		host := strings.TrimPrefix(strings.ToLower(u.Host), "www.")
		if host == "github.com" || strings.HasSuffix(host, ".github.com") || strings.HasSuffix(host, ".ghe.io") {
			return cleanRepoPath(u.Path)
		}
		return ""
	}
	return cleanRepoPath(remote)
}

func cleanRepoPath(path string) string {
	path = strings.Trim(strings.TrimSpace(path), "/")
	path = strings.TrimSuffix(path, ".git")
	parts := strings.Split(path, "/")
	if len(parts) < 2 {
		return ""
	}
	owner := strings.TrimSpace(parts[len(parts)-2])
	repo := strings.TrimSpace(parts[len(parts)-1])
	if owner == "" || repo == "" {
		return ""
	}
	return owner + "/" + repo
}
