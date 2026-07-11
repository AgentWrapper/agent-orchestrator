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
	orchestratorMaxUnansweredWakeSends        = 3
	orchestratorUnhealthyReplacementThreshold = 5 * time.Minute
	orchestratorReplacementWindow             = time.Hour
	orchestratorMaxReplacementsPerWindow      = 3
)

type orchestratorProjectLister interface {
	List(context.Context) ([]projectsvc.Summary, error)
}

type orchestratorEnsurer interface {
	SpawnOrchestrator(ctx context.Context, projectID domain.ProjectID, clean bool) (domain.Session, error)
	SpawnPrime(ctx context.Context, projectID domain.ProjectID, clean bool) (domain.Session, error)
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
	pausedNotified map[domain.ProjectID]domain.SessionID
}

type orchestratorWakeState struct {
	lastWake       time.Time
	lastActivityAt time.Time
	unanswered     int
	warned         bool
}

type orchestratorReplacementState struct {
	attempts       []time.Time
	cappedNotified bool
}

func newOrchestratorWakeTracker() *orchestratorWakeTracker {
	return &orchestratorWakeTracker{
		projects:       make(map[domain.ProjectID]orchestratorWakeState),
		replacements:   make(map[domain.ProjectID]orchestratorReplacementState),
		pausedNotified: make(map[domain.ProjectID]domain.SessionID),
	}
}

func startOrchestratorSupervisor(ctx context.Context, projects orchestratorProjectLister, sessions orchestratorEnsurer, notifier notificationSink, interval time.Duration, log *slog.Logger) <-chan struct{} {
	done := make(chan struct{})
	if log == nil {
		log = slog.Default()
	}
	if interval <= 0 {
		interval = orchestratorSupervisorInterval
	}
	wakes := newOrchestratorWakeTracker()
	go func() {
		defer close(done)
		ensureOrchestrators(ctx, projects, sessions, notifier, wakes, time.Now().UTC(), log)
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				ensureOrchestrators(ctx, projects, sessions, notifier, wakes, time.Now().UTC(), log)
			}
		}
	}()
	return done
}

func startPrimeSupervisor(ctx context.Context, cfg config.Config, projects orchestratorProjectLister, sessions orchestratorEnsurer, notifier notificationSink, interval time.Duration, log *slog.Logger) <-chan struct{} {
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
	go func() {
		defer close(done)
		ensurePrime(ctx, primeProjectID, projects, sessions, notifier, wakes, time.Now().UTC(), log)
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				ensurePrime(ctx, primeProjectID, projects, sessions, notifier, wakes, time.Now().UTC(), log)
			}
		}
	}()
	return done
}

func ensureOrchestrators(ctx context.Context, projects orchestratorProjectLister, sessions orchestratorEnsurer, notifier notificationSink, wakes *orchestratorWakeTracker, now time.Time, log *slog.Logger) {
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
		if replace, reason := shouldReplaceUnhealthyOrchestrator(orchestrator, now); replace {
			allowed, cappedNow, count := wakes.reserveReplacement(project.ID, now)
			if !allowed {
				if cappedNow {
					emitOrchestratorSupervisorNotification(ctx, notifier, domain.NotificationOrchestratorReplacementCapped, project.ID, orchestrator, now, log)
					log.Warn("orchestrator-supervisor: replacement limit reached; leaving unhealthy orchestrator for human intervention", "project", project.ID, "session", orchestrator.ID, "reason", reason, "replacement_attempts", count)
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
		interval, err := project.Config.WithDefaults().Orchestrator.WakeIntervalDuration()
		if err != nil {
			log.Warn("orchestrator-supervisor: invalid wake interval; using default", "project", project.ID, "err", err)
			interval = domain.DefaultOrchestratorWakeInterval
		}
		if shouldWakeOrchestrator(project.ID, orchestrator, interval, wakes, now) {
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
				if state.unanswered >= orchestratorMaxUnansweredWakeSends && !state.warned {
					state.warned = true
					wakes.projects[project.ID] = state
					log.Warn("orchestrator-supervisor: wake retry limit reached; waiting for activity before sending more wakes", "project", project.ID, "session", orchestrator.ID, "unanswered_wakes", state.unanswered)
				}
			}
		}
	}
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

func ensurePrime(ctx context.Context, primeProjectID domain.ProjectID, projects orchestratorProjectLister, sessions orchestratorEnsurer, notifier notificationSink, wakes *orchestratorWakeTracker, now time.Time, log *slog.Logger) {
	if primeProjectID == "" {
		return
	}
	wakeInterval := primeWakeInterval(ctx, primeProjectID, projects, log)
	prime, err := sessions.SpawnPrime(ctx, primeProjectID, false)
	if err != nil {
		if ctx.Err() != nil {
			return
		}
		log.Warn("prime-supervisor: ensure prime failed", "project", primeProjectID, "err", err)
		return
	}
	if replace, reason := shouldReplaceUnhealthyPrime(prime, now); replace {
		allowed, cappedNow, count := wakes.reserveReplacement(primeProjectID, now)
		if !allowed {
			if cappedNow {
				emitOrchestratorSupervisorNotification(ctx, notifier, domain.NotificationOrchestratorReplacementCapped, primeProjectID, prime, now, log)
				log.Warn("prime-supervisor: replacement limit reached; leaving unhealthy prime for human intervention", "project", primeProjectID, "session", prime.ID, "reason", reason, "replacement_attempts", count)
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
	if shouldWakePrime(primeProjectID, prime, wakeInterval, wakes, now) {
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
			if state.unanswered >= orchestratorMaxUnansweredWakeSends && !state.warned {
				state.warned = true
				wakes.projects[primeProjectID] = state
				log.Warn("prime-supervisor: wake retry limit reached; waiting for activity before sending more wakes", "project", primeProjectID, "session", prime.ID, "unanswered_wakes", state.unanswered)
			}
		}
	}
}

func primeWakeInterval(ctx context.Context, primeProjectID domain.ProjectID, projects orchestratorProjectLister, log *slog.Logger) time.Duration {
	if projects == nil {
		return domain.DefaultOrchestratorWakeInterval
	}
	summaries, err := projects.List(ctx)
	if err != nil {
		if ctx.Err() == nil {
			log.Warn("prime-supervisor: list projects for wake interval failed; using default", "project", primeProjectID, "err", err)
		}
		return domain.DefaultOrchestratorWakeInterval
	}
	for _, project := range summaries {
		if project.ID != primeProjectID {
			continue
		}
		interval, err := project.Config.WithDefaults().Prime.WakeIntervalDuration()
		if err != nil {
			log.Warn("prime-supervisor: invalid wake interval; using default", "project", primeProjectID, "err", err)
			return domain.DefaultOrchestratorWakeInterval
		}
		return interval
	}
	return domain.DefaultOrchestratorWakeInterval
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

func shouldWakeOrchestrator(projectID domain.ProjectID, session domain.Session, interval time.Duration, wakes *orchestratorWakeTracker, now time.Time) bool {
	return shouldWakeDaemonRole(projectID, session, domain.KindOrchestrator, interval, wakes, now)
}

func shouldWakePrime(projectID domain.ProjectID, session domain.Session, interval time.Duration, wakes *orchestratorWakeTracker, now time.Time) bool {
	return shouldWakeDaemonRole(projectID, session, domain.KindPrime, interval, wakes, now)
}

func shouldWakeDaemonRole(projectID domain.ProjectID, session domain.Session, kind domain.SessionKind, interval time.Duration, wakes *orchestratorWakeTracker, now time.Time) bool {
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
	if interval <= 0 {
		return false
	}
	if session.Activity.LastActivityAt.IsZero() || now.Sub(session.Activity.LastActivityAt) <= interval {
		return false
	}
	state := wakes.projects[projectID]
	if !state.lastActivityAt.IsZero() && session.Activity.LastActivityAt.After(state.lastActivityAt) {
		state.unanswered = 0
		state.warned = false
		wakes.projects[projectID] = state
	}
	if state.unanswered >= orchestratorMaxUnansweredWakeSends {
		return false
	}
	if !state.lastWake.IsZero() && now.Sub(state.lastWake) <= interval {
		return false
	}
	return true
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

func (w *orchestratorWakeTracker) reserveReplacement(projectID domain.ProjectID, now time.Time) (bool, bool, int) {
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
		w.replacements[projectID] = state
		return true, false, len(state.attempts)
	}
	cappedNow := !state.cappedNotified
	state.cappedNotified = true
	w.replacements[projectID] = state
	return false, cappedNow, len(state.attempts)
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
