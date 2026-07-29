// Package scm observes provider facts for cloud-owned sessions and persists
// normalized PR/CI/review state independently of the local daemon.
package scm

import (
	"context"
	"encoding/json"
	"log/slog"
	"sync"
	"time"

	clouddomain "github.com/aoagents/agent-orchestrator/backend/internal/cloud/domain"
	cloudevents "github.com/aoagents/agent-orchestrator/backend/internal/cloud/events"
	cloudpostgres "github.com/aoagents/agent-orchestrator/backend/internal/cloud/postgres"
	cloudlocalgh "github.com/aoagents/agent-orchestrator/backend/internal/cloud/scm/localgh"
)

type store interface {
	ListSCMTargets(context.Context) ([]cloudpostgres.SCMTarget, error)
	WriteSCMObservation(context.Context, clouddomain.AccountID, clouddomain.SessionID, cloudlocalgh.PullRequestObservation) error
}

// Observer periodically persists normalized SCM state for active sessions.
type Observer struct {
	store    store
	github   *cloudlocalgh.Client
	events   *cloudevents.Service
	interval time.Duration
	log      *slog.Logger
	mu       sync.Mutex
	last     map[clouddomain.SessionID]string
}

// New creates an SCM observer.
func New(
	store store,
	github *cloudlocalgh.Client,
	events *cloudevents.Service,
	interval time.Duration,
	log *slog.Logger,
) *Observer {
	if interval <= 0 {
		interval = 30 * time.Second
	}
	if log == nil {
		log = slog.Default()
	}
	return &Observer{
		store:    store,
		github:   github,
		events:   events,
		interval: interval,
		log:      log,
		last:     make(map[clouddomain.SessionID]string),
	}
}

// Run observes SCM state until ctx is canceled.
func (o *Observer) Run(ctx context.Context) error {
	o.observe(ctx)
	ticker := time.NewTicker(o.interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
			o.observe(ctx)
		}
	}
}

func (o *Observer) observe(ctx context.Context) {
	targets, err := o.store.ListSCMTargets(ctx)
	if err != nil {
		o.log.Warn("cloud SCM target listing failed", "err", err)
		return
	}
	for _, target := range targets {
		observation, err := o.github.ObserveBranch(ctx, target.RepositoryURL, target.Branch)
		if err != nil {
			o.log.Warn("cloud SCM observation failed", "session_id", target.SessionID, "err", err)
			continue
		}
		if observation == nil {
			continue
		}
		encoded, _ := json.Marshal(observation)
		signature := string(encoded)
		o.mu.Lock()
		unchanged := o.last[target.SessionID] == signature
		if !unchanged {
			o.last[target.SessionID] = signature
		}
		o.mu.Unlock()
		if unchanged {
			continue
		}
		if err := o.store.WriteSCMObservation(ctx, target.AccountID, target.SessionID, *observation); err != nil {
			o.log.Warn("cloud SCM persistence failed", "session_id", target.SessionID, "err", err)
			continue
		}
		_, _ = o.events.Append(ctx, target.AccountID, target.SessionID, "scm.updated", encoded)
	}
}
