package daemon

import (
	"context"
	"log/slog"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/activitydispatch"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	projectsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/project"
)

const (
	orchestratorSupervisorInterval     = 30 * time.Second
	orchestratorMaxUnansweredWakeSends = 3
)

type orchestratorProjectLister interface {
	List(context.Context) ([]projectsvc.Summary, error)
}

type orchestratorEnsurer interface {
	SpawnOrchestrator(ctx context.Context, projectID domain.ProjectID, clean bool) (domain.Session, error)
	WakeIdle(ctx context.Context, id domain.SessionID, message string) (bool, error)
}

type orchestratorWakeTracker struct {
	projects map[domain.ProjectID]orchestratorWakeState
}

type orchestratorWakeState struct {
	lastWake       time.Time
	lastActivityAt time.Time
	unanswered     int
	warned         bool
}

func newOrchestratorWakeTracker() *orchestratorWakeTracker {
	return &orchestratorWakeTracker{projects: make(map[domain.ProjectID]orchestratorWakeState)}
}

func startOrchestratorSupervisor(ctx context.Context, projects orchestratorProjectLister, sessions orchestratorEnsurer, interval time.Duration, log *slog.Logger) <-chan struct{} {
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
		ensureOrchestrators(ctx, projects, sessions, wakes, time.Now().UTC(), log)
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				ensureOrchestrators(ctx, projects, sessions, wakes, time.Now().UTC(), log)
			}
		}
	}()
	return done
}

func ensureOrchestrators(ctx context.Context, projects orchestratorProjectLister, sessions orchestratorEnsurer, wakes *orchestratorWakeTracker, now time.Time, log *slog.Logger) {
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
		orchestrator, err := sessions.SpawnOrchestrator(ctx, project.ID, false)
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			log.Warn("orchestrator-supervisor: ensure orchestrator failed", "project", project.ID, "err", err)
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
	if session.ID == "" || session.IsTerminated || session.Kind != domain.KindOrchestrator {
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

func orchestratorWakeMessage(projectID domain.ProjectID) string {
	return "Continue your supervision loop for project " + string(projectID) + ". Check worker sessions, waiting input, open issues, pull requests, merge/deploy gates, and post any needed digest or escalation."
}
