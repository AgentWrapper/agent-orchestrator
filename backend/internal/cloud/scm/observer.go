// Package scm observes provider facts for cloud-owned sessions and persists
// normalized PR/CI/review state independently of the local daemon.
package scm

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
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
	appMode  bool
	interval time.Duration
	log      *slog.Logger
	mu       sync.Mutex
	last     map[clouddomain.SessionID]string
}

// ObserverOption customizes SCM observation behavior.
type ObserverOption func(*Observer)

// WithGitHubAppMode requires every observed target to retain an active,
// repository-specific GitHub App grant.
func WithGitHubAppMode() ObserverOption {
	return func(observer *Observer) {
		observer.appMode = true
	}
}

// New creates an SCM observer.
func New(
	store store,
	github *cloudlocalgh.Client,
	events *cloudevents.Service,
	interval time.Duration,
	log *slog.Logger,
	options ...ObserverOption,
) *Observer {
	if interval <= 0 {
		interval = 30 * time.Second
	}
	if log == nil {
		log = slog.Default()
	}
	observer := &Observer{
		store:    store,
		github:   github,
		events:   events,
		interval: interval,
		log:      log,
		last:     make(map[clouddomain.SessionID]string),
	}
	for _, option := range options {
		if option != nil {
			option(observer)
		}
	}
	return observer
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
		if err := o.observeTarget(ctx, target); err != nil {
			o.log.Warn("cloud SCM observation failed", "session_id", target.SessionID, "err", err)
		}
	}
}

// RefreshRepository immediately refreshes active SCM targets for one
// organization repository. GitHub App credential scope revalidates the active
// repository grant before every canonical provider read.
func (o *Observer) RefreshRepository(
	ctx context.Context,
	orgID clouddomain.OrgID,
	githubRepositoryID int64,
) error {
	if orgID == "" || githubRepositoryID <= 0 {
		return errors.New("organization and GitHub repository are required")
	}
	if !o.appMode {
		return errors.New("targeted GitHub repository refresh requires GitHub App mode")
	}
	targets, err := o.store.ListSCMTargets(ctx)
	if err != nil {
		return fmt.Errorf("list SCM targets for repository refresh: %w", err)
	}
	refreshErrors := make([]error, 0)
	for _, target := range targets {
		if target.OrgID != orgID ||
			target.GitHubRepositoryID == nil ||
			*target.GitHubRepositoryID != githubRepositoryID ||
			!target.GitHubGrantActive {
			continue
		}
		if err := o.observeTarget(ctx, target); err != nil {
			refreshErrors = append(
				refreshErrors,
				fmt.Errorf("refresh SCM target %s: %w", target.SessionID, err),
			)
		}
	}
	return errors.Join(refreshErrors...)
}

func (o *Observer) observeTarget(ctx context.Context, target cloudpostgres.SCMTarget) error {
	observationCtx := ctx
	if o.appMode {
		if target.GitHubRepositoryID == nil || !target.GitHubGrantActive {
			return nil
		}
		var err error
		observationCtx, err = cloudlocalgh.ContextWithCredentialScope(
			ctx,
			target.OrgID,
			*target.GitHubRepositoryID,
			cloudlocalgh.OperationObserve,
		)
		if err != nil {
			return fmt.Errorf("scope GitHub App observation: %w", err)
		}
	}
	observation, err := o.github.ObserveBranch(observationCtx, target.RepositoryURL, target.Branch)
	if err != nil {
		return err
	}
	if observation == nil {
		return nil
	}
	encoded, _ := json.Marshal(observation)
	signature := observationSignature(*observation)
	o.mu.Lock()
	unchanged := o.last[target.SessionID] == signature
	o.mu.Unlock()
	if unchanged {
		return nil
	}
	if err := o.store.WriteSCMObservation(ctx, target.AccountID, target.SessionID, *observation); err != nil {
		return fmt.Errorf("persist SCM observation: %w", err)
	}
	o.mu.Lock()
	o.last[target.SessionID] = signature
	o.mu.Unlock()
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
	return nil
}

func observationSignature(observation cloudlocalgh.PullRequestObservation) string {
	observation.ObservedAt = time.Time{}
	for index := range observation.Checks {
		observation.Checks[index].ObservedAt = time.Time{}
	}
	for index := range observation.ReviewThreads {
		observation.ReviewThreads[index].ObservedAt = time.Time{}
	}
	encoded, _ := json.Marshal(observation)
	return string(encoded)
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
