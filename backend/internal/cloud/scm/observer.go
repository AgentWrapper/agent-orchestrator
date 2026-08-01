// Package scm observes provider facts for cloud-owned sessions and persists
// normalized PR/CI/review state independently of the local daemon.
package scm

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
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
		if message := scmNudgeMessage(*observation); message != "" {
			_, err := o.events.AppendUserMessage(
				ctx,
				target.AccountID,
				target.SessionID,
				fmt.Sprintf("scm-nudge:%x", sha256.Sum256([]byte(signature))),
				message,
			)
			if err != nil {
				o.log.Debug("cloud SCM nudge skipped", "session_id", target.SessionID, "err", err)
			}
		}
	}
}

func scmNudgeMessage(observation cloudlocalgh.PullRequestObservation) string {
	if observation.State == "merged" || observation.State == "closed" {
		return ""
	}
	items := make([]string, 0, 4)
	if observation.CIState == "failing" {
		items = append(items, "CI is failing. Inspect the failing checks, fix them, and push an update.")
	}
	if observation.ReviewState == "changes_requested" {
		items = append(items, "Review changes were requested. Address the review feedback and push fixes.")
	}
	if observation.Mergeability == "conflicting" || observation.Mergeability == "dirty" {
		items = append(items, "The pull request has merge conflicts. Rebase or merge the target branch and resolve conflicts.")
	}
	openThreads := 0
	for _, thread := range observation.ReviewThreads {
		if !thread.IsResolved && !thread.IsOutdated {
			openThreads++
		}
	}
	if openThreads > 0 {
		items = append(items, fmt.Sprintf("%d unresolved review thread(s) are actionable. Address each relevant thread and resolve it after fixing.", openThreads))
	}
	if len(items) == 0 {
		return ""
	}
	message := fmt.Sprintf(
		"AO observed actionable SCM feedback on PR #%d (%s):",
		observation.Number,
		observation.URL,
	)
	for _, item := range items {
		message += "\n- " + item
	}
	return message
}
