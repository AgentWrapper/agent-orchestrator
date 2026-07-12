package daemon

import (
	"context"
	"log/slog"
	"strings"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/activitydispatch"
	"github.com/aoagents/agent-orchestrator/backend/internal/config"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	projectsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/project"
)

const (
	orchestratorSupervisorInterval            = 30 * time.Second
	orchestratorUnhealthyReplacementThreshold = 5 * time.Minute
	orchestratorReplacementWindow             = time.Hour
	orchestratorMaxReplacementsPerWindow      = 3
	orchestratorReplacementInitialBackoff     = 30 * time.Second
	orchestratorReplacementMaxBackoff         = 15 * time.Minute
)

type orchestratorProjectLister interface {
	List(context.Context) ([]projectsvc.Summary, error)
}

type orchestratorEnsurer interface {
	SpawnOrchestrator(ctx context.Context, projectID domain.ProjectID, clean bool) (domain.Session, error)
	SpawnPrime(ctx context.Context, projectID domain.ProjectID, clean bool) (domain.Session, error)
	ActivePrime(ctx context.Context) (domain.Session, bool, error)
	WakeIdle(ctx context.Context, id domain.SessionID, message string) (bool, error)
	// ActiveOrchestrator returns a project's live orchestrator without spawning
	// one, so a paused project can be messaged without creating a fresh session.
	ActiveOrchestrator(ctx context.Context, projectID domain.ProjectID) (domain.Session, bool, error)
	// Send delivers a one-off message to a session (the pause notice).
	Send(ctx context.Context, id domain.SessionID, message string) error
}

type orchestratorWakeTracker struct {
	projects     map[domain.ProjectID]orchestratorWakeState
	replacements map[domain.ProjectID]orchestratorReplacementState
	// pausedNotified records, per project, the orchestrator instance already
	// told the fleet is paused, so the notice is sent once per (project,
	// orchestrator) — re-sent if the orchestrator is replaced mid-pause, and
	// cleared (after a resume notice) when the project resumes or disappears.
	pausedNotified      map[domain.ProjectID]domain.SessionID
	primePausedNotified map[domain.ProjectID]domain.SessionID
}

type orchestratorWakeState struct {
	lastWake       time.Time
	lastActivityAt time.Time
	unanswered     int
	warned         bool
}

type orchestratorReplacementState struct {
	attempts        []time.Time
	cappedNotified  bool
	nextAllowedAt   time.Time
	backoffExponent int
}

func newOrchestratorWakeTracker() *orchestratorWakeTracker {
	return &orchestratorWakeTracker{
		projects:            make(map[domain.ProjectID]orchestratorWakeState),
		replacements:        make(map[domain.ProjectID]orchestratorReplacementState),
		pausedNotified:      make(map[domain.ProjectID]domain.SessionID),
		primePausedNotified: make(map[domain.ProjectID]domain.SessionID),
	}
}

func startOrchestratorSupervisor(ctx context.Context, projects orchestratorProjectLister, sessions orchestratorEnsurer, notifier notificationSink, interval time.Duration, log *slog.Logger, resets *projectWakeResetQueue) <-chan struct{} {
	done := make(chan struct{})
	if log == nil {
		log = slog.Default()
	}
	if interval <= 0 {
		interval = orchestratorSupervisorInterval
	}
	wakes := newOrchestratorWakeTracker()
	var resetNotify <-chan struct{}
	if resets != nil {
		resetNotify = resets.notify
	}
	go func() {
		defer close(done)
		ensureOrchestrators(ctx, projects, sessions, notifier, wakes, time.Now().UTC(), log)
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-resetNotify:
				projectIDs := resets.drain()
				if len(projectIDs) > 0 {
					ensureSelectedOrchestrators(ctx, projects, sessions, notifier, wakes, time.Now().UTC(), log, projectIDs)
				}
			case <-ticker.C:
				ensureOrchestrators(ctx, projects, sessions, notifier, wakes, time.Now().UTC(), log)
			}
		}
	}()
	return done
}

func startPrimeSupervisor(ctx context.Context, cfg config.Config, projects orchestratorProjectLister, sessions orchestratorEnsurer, notifier notificationSink, interval time.Duration, log *slog.Logger, resets *primeWakeResetQueue) <-chan struct{} {
	done := make(chan struct{})
	if log == nil {
		log = slog.Default()
	}
	primeProjectID := domain.ProjectID(strings.TrimSpace(cfg.PrimeProjectID))
	if primeProjectID == "" {
		close(done)
		return done
	}
	if interval <= 0 {
		interval = orchestratorSupervisorInterval
	}
	wakes := newOrchestratorWakeTracker()
	var resetNotify <-chan struct{}
	if resets != nil {
		resetNotify = resets.notify
	}
	go func() {
		defer close(done)
		ensurePrime(ctx, primeProjectID, projects, sessions, notifier, wakes, time.Now().UTC(), log)
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-resetNotify:
				if resets.drain() {
					ensurePrimeReset(ctx, primeProjectID, projects, sessions, notifier, wakes, time.Now().UTC(), log)
				}
			case <-ticker.C:
				ensurePrime(ctx, primeProjectID, projects, sessions, notifier, wakes, time.Now().UTC(), log)
			}
		}
	}()
	return done
}

func ensureOrchestrators(ctx context.Context, projects orchestratorProjectLister, sessions orchestratorEnsurer, notifier notificationSink, wakes *orchestratorWakeTracker, now time.Time, log *slog.Logger) {
	ensureOrchestratorsFiltered(ctx, projects, sessions, notifier, wakes, now, log, nil, true, false)
}

func ensureSelectedOrchestrators(ctx context.Context, projects orchestratorProjectLister, sessions orchestratorEnsurer, notifier notificationSink, wakes *orchestratorWakeTracker, now time.Time, log *slog.Logger, selected map[domain.ProjectID]struct{}) {
	ensureOrchestratorsFiltered(ctx, projects, sessions, notifier, wakes, now, log, selected, false, true)
}

func ensureOrchestratorsFiltered(ctx context.Context, projects orchestratorProjectLister, sessions orchestratorEnsurer, notifier notificationSink, wakes *orchestratorWakeTracker, now time.Time, log *slog.Logger, selected map[domain.ProjectID]struct{}, pruneMissing, resetDriven bool) {
	summaries, err := projects.List(ctx)
	if err != nil {
		if ctx.Err() != nil {
			return
		}
		log.Warn("orchestrator-supervisor: list projects failed", "err", err)
		return
	}
	seen := make(map[domain.ProjectID]struct{}, len(summaries))
	for _, project := range summaries {
		if ctx.Err() != nil {
			return
		}
		if project.ID == "" {
			continue
		}
		seen[project.ID] = struct{}{}
		if selected != nil {
			if _, ok := selected[project.ID]; !ok {
				continue
			}
		}
		// Respect the pause bit: for a paused (or still-draining) project, do
		// not spawn a fresh orchestrator or nudge an existing one for new work.
		// An existing orchestrator is kept running (to supervise the drain) but
		// told once to idle — spawn nothing new — so it stops looping on work
		// the spawn guard would reject anyway. Keyed by orchestrator id so a
		// replacement started mid-pause is (re)notified.
		if project.PauseState != "" && project.PauseState != projectsvc.PauseStateRunning {
			if orch, ok, err := sessions.ActiveOrchestrator(ctx, project.ID); err == nil && ok && wakes.pausedNotified[project.ID] != orch.ID {
				if err := sessions.Send(ctx, orch.ID, orchestratorPausedMessage(project.ID)); err == nil {
					wakes.pausedNotified[project.ID] = orch.ID
				} else if ctx.Err() == nil {
					log.Warn("orchestrator-supervisor: send pause notice failed", "project", project.ID, "session", orch.ID, "err", err)
				}
			}
			continue
		}
		// Just resumed: the orchestrator was told to idle until resume, so a
		// wake-interval-gated nudge is not enough (a signal-less harness would
		// never wake). Send an explicit resume notice on the transition, and
		// keep the pause marker until delivery actually succeeds (or there is no
		// notified orchestrator left) so a transient lookup/send failure retries
		// next tick rather than stranding the orchestrator asleep.
		if _, wasPaused := wakes.pausedNotified[project.ID]; wasPaused {
			orch, ok, err := sessions.ActiveOrchestrator(ctx, project.ID)
			switch {
			case err != nil:
				if ctx.Err() == nil {
					log.Warn("orchestrator-supervisor: resume lookup failed; will retry", "project", project.ID, "err", err)
				}
			case !ok:
				// No orchestrator remains to wake — nothing to retry.
				delete(wakes.pausedNotified, project.ID)
			default:
				if err := sessions.Send(ctx, orch.ID, orchestratorResumedMessage(project.ID)); err == nil {
					delete(wakes.pausedNotified, project.ID)
				} else if ctx.Err() == nil {
					log.Warn("orchestrator-supervisor: send resume notice failed; will retry", "project", project.ID, "session", orch.ID, "err", err)
				}
			}
		}
		orchestrator, err := sessions.SpawnOrchestrator(ctx, project.ID, false)
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			log.Warn("orchestrator-supervisor: ensure orchestrator failed", "project", project.ID, "err", err)
			continue
		}
		if resetDriven {
			wakes.resetWakeBackoff(project.ID)
		}
		if replace, reason := shouldReplaceUnhealthyOrchestrator(orchestrator, now); replace {
			allowed, cappedNow, count, nextAllowedAt := wakes.reserveReplacement(project.ID, now)
			if !allowed {
				if cappedNow {
					emitOrchestratorSupervisorNotification(ctx, notifier, domain.NotificationOrchestratorReplacementCapped, project.ID, orchestrator, now, log)
					log.Warn("orchestrator-supervisor: replacement fast window exhausted; backing off before retry", "project", project.ID, "session", orchestrator.ID, "reason", reason, "replacement_attempts", count, "next_allowed_at", nextAllowedAt)
				}
				continue
			}
			replacement, err := sessions.SpawnOrchestrator(ctx, project.ID, true)
			if err != nil {
				if ctx.Err() != nil {
					return
				}
				log.Warn("orchestrator-supervisor: replace unhealthy orchestrator failed", "project", project.ID, "session", orchestrator.ID, "reason", reason, "err", err)
				continue
			}
			delete(wakes.projects, project.ID)
			emitOrchestratorSupervisorNotification(ctx, notifier, domain.NotificationOrchestratorReplaced, project.ID, replacement, now, log)
			log.Warn("orchestrator-supervisor: replaced unhealthy orchestrator", "project", project.ID, "old_session", orchestrator.ID, "new_session", replacement.ID, "reason", reason)
			continue
		}
		policy, err := project.Config.WithDefaults().Orchestrator.WakeBackoffPolicy()
		if err != nil {
			log.Warn("orchestrator-supervisor: invalid wake backoff; using default", "project", project.ID, "err", err)
			policy = domain.WakeBackoffPolicy{Enabled: true, Base: domain.DefaultOrchestratorWakeInterval, Max: domain.DefaultWakeBackoffMaxInterval}
		}
		if shouldWakeOrchestrator(project.ID, orchestrator, policy, wakes, now) {
			sent, err := sessions.WakeIdle(ctx, orchestrator.ID, orchestratorWakeMessage(project.ID))
			if err != nil {
				if ctx.Err() != nil {
					return
				}
				wakes.recordWakeAttempt(project.ID, orchestrator, now)
				log.Warn("orchestrator-supervisor: wake orchestrator failed", "project", project.ID, "session", orchestrator.ID, "err", err)
				continue
			}
			if sent {
				state := wakes.recordWake(project.ID, orchestrator, now)
				if shouldWarnWakeBackoffMax(policy, state) {
					state.warned = true
					wakes.projects[project.ID] = state
					log.Warn("orchestrator-supervisor: wake backoff reached max; waiting for activity between capped wakes", "project", project.ID, "session", orchestrator.ID, "unanswered_wakes", state.unanswered, "max_interval", policy.Max)
				}
			}
		}
	}
	if pruneMissing {
		for projectID := range wakes.projects {
			if _, ok := seen[projectID]; !ok {
				delete(wakes.projects, projectID)
			}
		}
		for projectID := range wakes.replacements {
			if _, ok := seen[projectID]; !ok {
				delete(wakes.replacements, projectID)
			}
		}
		for projectID := range wakes.pausedNotified {
			if _, ok := seen[projectID]; !ok {
				delete(wakes.pausedNotified, projectID)
			}
		}
	}
}

func ensurePrime(ctx context.Context, primeProjectID domain.ProjectID, projects orchestratorProjectLister, sessions orchestratorEnsurer, notifier notificationSink, wakes *orchestratorWakeTracker, now time.Time, log *slog.Logger) {
	ensurePrimeWithReset(ctx, primeProjectID, projects, sessions, notifier, wakes, now, log, false)
}

func ensurePrimeReset(ctx context.Context, primeProjectID domain.ProjectID, projects orchestratorProjectLister, sessions orchestratorEnsurer, notifier notificationSink, wakes *orchestratorWakeTracker, now time.Time, log *slog.Logger) {
	ensurePrimeWithReset(ctx, primeProjectID, projects, sessions, notifier, wakes, now, log, true)
}

func ensurePrimeWithReset(ctx context.Context, primeProjectID domain.ProjectID, projects orchestratorProjectLister, sessions orchestratorEnsurer, notifier notificationSink, wakes *orchestratorWakeTracker, now time.Time, log *slog.Logger, resetDriven bool) {
	if primeProjectID == "" {
		return
	}
	projectSummary, hasProjectConfig := primeProjectSummary(ctx, primeProjectID, projects, log)
	if !hasProjectConfig {
		delete(wakes.primePausedNotified, primeProjectID)
		log.Debug("prime-supervisor: prime host project config unavailable; skipping ensure", "project", primeProjectID)
		return
	}
	projectConfig := projectSummary.Config.WithDefaults()
	if projectConfig.Prime.Harness == "" {
		delete(wakes.primePausedNotified, primeProjectID)
		log.Debug("prime-supervisor: prime disabled; configure project prime.agent to enable", "project", primeProjectID)
		return
	}
	if projectSummary.PauseState != "" && projectSummary.PauseState != projectsvc.PauseStateRunning {
		prime, ok, err := sessions.ActivePrime(ctx)
		switch {
		case err != nil:
			if ctx.Err() == nil {
				log.Warn("prime-supervisor: paused prime lookup failed; will retry", "project", primeProjectID, "err", err)
			}
		case !ok:
			delete(wakes.primePausedNotified, primeProjectID)
		case wakes.primePausedNotified[primeProjectID] != prime.ID:
			if err := sessions.Send(ctx, prime.ID, primePausedMessage(primeProjectID)); err == nil {
				wakes.primePausedNotified[primeProjectID] = prime.ID
			} else if ctx.Err() == nil {
				log.Warn("prime-supervisor: send pause notice failed; will retry", "project", primeProjectID, "session", prime.ID, "err", err)
			}
		}
		log.Debug("prime-supervisor: prime host project paused; skipping prime spawn/wake", "project", primeProjectID, "pause_state", projectSummary.PauseState)
		return
	}
	if _, wasPaused := wakes.primePausedNotified[primeProjectID]; wasPaused {
		prime, ok, err := sessions.ActivePrime(ctx)
		switch {
		case err != nil:
			if ctx.Err() == nil {
				log.Warn("prime-supervisor: resume lookup failed; will retry", "project", primeProjectID, "err", err)
			}
		case !ok:
			delete(wakes.primePausedNotified, primeProjectID)
		default:
			if err := sessions.Send(ctx, prime.ID, primeResumedMessage(primeProjectID)); err == nil {
				delete(wakes.primePausedNotified, primeProjectID)
			} else if ctx.Err() == nil {
				log.Warn("prime-supervisor: send resume notice failed; will retry", "project", primeProjectID, "session", prime.ID, "err", err)
			}
		}
	}
	wakePolicy := primeWakeBackoffPolicy(primeProjectID, projectConfig, log)
	prime, err := sessions.SpawnPrime(ctx, primeProjectID, false)
	if err != nil {
		if ctx.Err() != nil {
			return
		}
		log.Warn("prime-supervisor: ensure prime failed", "project", primeProjectID, "err", err)
		return
	}
	if resetDriven {
		wakes.resetWakeBackoff(primeProjectID)
	}
	if replace, reason := shouldReplaceUnhealthyPrime(prime, now); replace {
		allowed, cappedNow, count, nextAllowedAt := wakes.reserveReplacement(primeProjectID, now)
		if !allowed {
			if cappedNow {
				emitOrchestratorSupervisorNotification(ctx, notifier, domain.NotificationOrchestratorReplacementCapped, primeProjectID, prime, now, log)
				log.Warn("prime-supervisor: replacement fast window exhausted; backing off before retry", "project", primeProjectID, "session", prime.ID, "reason", reason, "replacement_attempts", count, "next_allowed_at", nextAllowedAt)
			}
			return
		}
		replacement, err := sessions.SpawnPrime(ctx, primeProjectID, true)
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			log.Warn("prime-supervisor: replace unhealthy prime failed", "project", primeProjectID, "session", prime.ID, "reason", reason, "err", err)
			return
		}
		delete(wakes.projects, primeProjectID)
		emitOrchestratorSupervisorNotification(ctx, notifier, domain.NotificationOrchestratorReplaced, primeProjectID, replacement, now, log)
		log.Warn("prime-supervisor: replaced unhealthy prime", "project", primeProjectID, "old_session", prime.ID, "new_session", replacement.ID, "reason", reason)
		return
	}
	if shouldWakePrime(primeProjectID, prime, wakePolicy, wakes, now) {
		sent, err := sessions.WakeIdle(ctx, prime.ID, primeWakeMessage())
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			wakes.recordWakeAttempt(primeProjectID, prime, now)
			log.Warn("prime-supervisor: wake prime failed", "project", primeProjectID, "session", prime.ID, "err", err)
			return
		}
		if sent {
			state := wakes.recordWake(primeProjectID, prime, now)
			if shouldWarnWakeBackoffMax(wakePolicy, state) {
				state.warned = true
				wakes.projects[primeProjectID] = state
				log.Warn("prime-supervisor: wake backoff reached max; waiting for activity between capped wakes", "project", primeProjectID, "session", prime.ID, "unanswered_wakes", state.unanswered, "max_interval", wakePolicy.Max)
			}
		}
	}
}

func primeProjectSummary(ctx context.Context, primeProjectID domain.ProjectID, projects orchestratorProjectLister, log *slog.Logger) (projectsvc.Summary, bool) {
	if projects == nil {
		return projectsvc.Summary{}, false
	}
	summaries, err := projects.List(ctx)
	if err != nil {
		if ctx.Err() == nil {
			log.Warn("prime-supervisor: list projects for prime config failed; skipping ensure", "project", primeProjectID, "err", err)
		}
		return projectsvc.Summary{}, false
	}
	for _, project := range summaries {
		if project.ID != primeProjectID {
			continue
		}
		return project, true
	}
	log.Debug("prime-supervisor: prime host project not found; skipping ensure", "project", primeProjectID)
	return projectsvc.Summary{}, false
}

func primeWakeBackoffPolicy(primeProjectID domain.ProjectID, projectConfig domain.ProjectConfig, log *slog.Logger) domain.WakeBackoffPolicy {
	policy, err := projectConfig.Prime.WakeBackoffPolicy()
	if err != nil {
		log.Warn("prime-supervisor: invalid wake backoff; using default", "project", primeProjectID, "err", err)
		return domain.WakeBackoffPolicy{Enabled: true, Base: domain.DefaultOrchestratorWakeInterval, Max: domain.DefaultWakeBackoffMaxInterval}
	}
	return policy
}

func (w *orchestratorWakeTracker) recordWakeAttempt(projectID domain.ProjectID, session domain.Session, now time.Time) orchestratorWakeState {
	state := w.projects[projectID]
	if state.lastActivityAt.IsZero() || session.Activity.LastActivityAt.After(state.lastActivityAt) {
		state.unanswered = 0
		state.warned = false
	}
	state.lastWake = now
	state.lastActivityAt = session.Activity.LastActivityAt
	w.projects[projectID] = state
	return state
}

func (w *orchestratorWakeTracker) recordWake(projectID domain.ProjectID, session domain.Session, now time.Time) orchestratorWakeState {
	state := w.recordWakeAttempt(projectID, session, now)
	state.unanswered++
	w.projects[projectID] = state
	return state
}

func (w *orchestratorWakeTracker) resetWakeBackoff(projectID domain.ProjectID) {
	state := w.projects[projectID]
	state.unanswered = 0
	state.warned = false
	w.projects[projectID] = state
}

func shouldWakeOrchestrator(projectID domain.ProjectID, session domain.Session, policy domain.WakeBackoffPolicy, wakes *orchestratorWakeTracker, now time.Time) bool {
	return shouldWakeDaemonRole(projectID, session, domain.KindOrchestrator, policy, wakes, now)
}

func shouldWakePrime(projectID domain.ProjectID, session domain.Session, policy domain.WakeBackoffPolicy, wakes *orchestratorWakeTracker, now time.Time) bool {
	return shouldWakeDaemonRole(projectID, session, domain.KindPrime, policy, wakes, now)
}

func shouldWakeDaemonRole(projectID domain.ProjectID, session domain.Session, kind domain.SessionKind, policy domain.WakeBackoffPolicy, wakes *orchestratorWakeTracker, now time.Time) bool {
	if session.ID == "" || session.IsTerminated || session.Kind != kind {
		return false
	}
	if !activitydispatch.SupportsHarness(session.Harness) {
		return false
	}
	if session.Activity.State != domain.ActivityWaitingInput && session.Activity.State != domain.ActivityIdle {
		return false
	}
	if session.FirstSignalAt.IsZero() {
		return false
	}
	if policy.Base <= 0 {
		return false
	}
	state := wakes.projects[projectID]
	if !state.lastActivityAt.IsZero() && session.Activity.LastActivityAt.After(state.lastActivityAt) {
		state.unanswered = 0
		state.warned = false
		wakes.projects[projectID] = state
	}
	interval := wakeBackoffInterval(policy, state.unanswered)
	if session.Activity.LastActivityAt.IsZero() || now.Sub(session.Activity.LastActivityAt) < interval {
		return false
	}
	if !state.lastWake.IsZero() && now.Sub(state.lastWake) < interval {
		return false
	}
	return true
}

func wakeBackoffInterval(policy domain.WakeBackoffPolicy, unanswered int) time.Duration {
	if policy.Base <= 0 {
		return 0
	}
	if !policy.Enabled || unanswered <= 0 {
		return policy.Base
	}
	maxInterval := policy.Max
	if maxInterval <= 0 {
		maxInterval = policy.Base
	}
	interval := policy.Base
	for i := 0; i < unanswered; i++ {
		if interval >= maxInterval/2 {
			return maxInterval
		}
		interval *= 2
	}
	if interval > maxInterval {
		return maxInterval
	}
	return interval
}

func shouldWarnWakeBackoffMax(policy domain.WakeBackoffPolicy, state orchestratorWakeState) bool {
	return policy.Enabled && policy.Max > 0 && state.unanswered > 0 && !state.warned && wakeBackoffInterval(policy, state.unanswered) >= policy.Max
}

func shouldReplaceUnhealthyOrchestrator(session domain.Session, now time.Time) (bool, string) {
	return shouldReplaceUnhealthyDaemonRole(session, domain.KindOrchestrator, now)
}

func shouldReplaceUnhealthyPrime(session domain.Session, now time.Time) (bool, string) {
	return shouldReplaceUnhealthyDaemonRole(session, domain.KindPrime, now)
}

func shouldReplaceUnhealthyDaemonRole(session domain.Session, kind domain.SessionKind, now time.Time) (bool, string) {
	if session.ID == "" || session.IsTerminated || session.Kind != kind {
		return false, ""
	}
	if session.Activity.State == domain.ActivityBlocked {
		return false, ""
	}
	switch {
	case session.Status == domain.StatusNoSignal:
		if activityOlderThan(session, now, orchestratorUnhealthyReplacementThreshold) {
			return true, "no_signal"
		}
	case session.Activity.State == domain.ActivityExited:
		if activityOlderThan(session, now, orchestratorUnhealthyReplacementThreshold) {
			return true, "agent_exited"
		}
	}
	return false, ""
}

func activityOlderThan(session domain.Session, now time.Time, threshold time.Duration) bool {
	if threshold <= 0 {
		return false
	}
	at := session.Activity.LastActivityAt
	if at.IsZero() {
		at = session.UpdatedAt
	}
	if at.IsZero() {
		at = session.CreatedAt
	}
	if at.IsZero() {
		return false
	}
	return now.Sub(at) > threshold
}

func (w *orchestratorWakeTracker) reserveReplacement(projectID domain.ProjectID, now time.Time) (bool, bool, int, time.Time) {
	if w.replacements == nil {
		w.replacements = make(map[domain.ProjectID]orchestratorReplacementState)
	}
	state := w.replacements[projectID]
	cutoff := now.Add(-orchestratorReplacementWindow)
	kept := state.attempts[:0]
	for _, attempt := range state.attempts {
		if attempt.After(cutoff) {
			kept = append(kept, attempt)
		}
	}
	state.attempts = kept
	if len(state.attempts) < orchestratorMaxReplacementsPerWindow {
		// Count attempts before spawning so repeated replacement failures cap
		// themselves instead of crash-looping the supervisor.
		state.attempts = append(state.attempts, now)
		state.cappedNotified = false
		state.nextAllowedAt = time.Time{}
		state.backoffExponent = 0
		w.replacements[projectID] = state
		return true, false, len(state.attempts), time.Time{}
	}
	if !state.cappedNotified {
		state.cappedNotified = true
		state.nextAllowedAt = now.Add(orchestratorReplacementBackoff(0))
		state.backoffExponent = 0
		w.replacements[projectID] = state
		return false, true, len(state.attempts), state.nextAllowedAt
	}
	if now.Before(state.nextAllowedAt) {
		w.replacements[projectID] = state
		return false, false, len(state.attempts), state.nextAllowedAt
	}
	state.attempts = append(state.attempts, now)
	state.backoffExponent++
	state.nextAllowedAt = now.Add(orchestratorReplacementBackoff(state.backoffExponent))
	w.replacements[projectID] = state
	return true, false, len(state.attempts), state.nextAllowedAt
}

func orchestratorReplacementBackoff(exponent int) time.Duration {
	if exponent < 0 {
		exponent = 0
	}
	delay := orchestratorReplacementInitialBackoff
	for i := 0; i < exponent; i++ {
		delay *= 2
		if delay >= orchestratorReplacementMaxBackoff {
			return orchestratorReplacementMaxBackoff
		}
	}
	return delay
}

func emitOrchestratorSupervisorNotification(ctx context.Context, notifier notificationSink, typ domain.NotificationType, projectID domain.ProjectID, session domain.Session, now time.Time, log *slog.Logger) {
	if notifier == nil || session.ID == "" {
		return
	}
	if err := notifier.Notify(ctx, ports.NotificationIntent{
		Type:               typ,
		SessionID:          session.ID,
		ProjectID:          projectID,
		CreatedAt:          now,
		SessionDisplayName: session.DisplayName,
		SessionKind:        session.Kind,
	}); err != nil {
		if ctx.Err() != nil {
			return
		}
		log.Warn("orchestrator-supervisor: notification failed", "project", projectID, "session", session.ID, "type", typ, "err", err)
	}
}

func orchestratorWakeMessage(projectID domain.ProjectID) string {
	return "Continue your supervision loop for project " + string(projectID) + ". Check worker sessions, waiting input, open issues, pull requests, merge/deploy gates, and post any needed digest or escalation."
}

func primeWakeMessage() string {
	return "Continue your fleet supervision loop. Check all projects, project orchestrators, worker sessions, waiting input, open issues, pull requests, merge/deploy gates, metrics, resource alerts, zombies, cost and usage, and post any needed ticket, recommendation, digest, or escalation."
}

func orchestratorPausedMessage(projectID domain.ProjectID) string {
	return "Fleet is PAUSED for project " + string(projectID) + ". Spawn nothing new — new worker spawns are blocked. Let in-flight workers finish and supervise the drain; idle until the fleet is resumed."
}

func orchestratorResumedMessage(projectID domain.ProjectID) string {
	return "Fleet is RESUMED for project " + string(projectID) + ". Continue your normal supervision loop: dispatch and check worker sessions, issues, PRs, and merge/deploy gates as usual."
}

func primePausedMessage(projectID domain.ProjectID) string {
	return "Prime host project " + string(projectID) + " is PAUSED. Spawn nothing new and idle your fleet supervision loop until the host project is resumed."
}

func primeResumedMessage(projectID domain.ProjectID) string {
	return "Prime host project " + string(projectID) + " is RESUMED. Continue your normal fleet supervision loop across all projects."
}
