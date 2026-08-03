package httpapi

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	clouddomain "github.com/aoagents/agent-orchestrator/backend/internal/cloud/domain"
	cloudpostgres "github.com/aoagents/agent-orchestrator/backend/internal/cloud/postgres"
)

const (
	maxGitHubWebhookAttempts = 8
	maxGitHubWebhookBackoff  = 5 * time.Minute
)

// RunGitHubWebhookProcessor claims and processes the durable GitHub webhook
// inbox until the server context is canceled.
func (s *Server) RunGitHubWebhookProcessor(ctx context.Context) error {
	if s.githubApp == nil || s.githubApp.mode != "github-app" {
		return nil
	}
	if s.githubStore == nil || s.githubApp.client == nil {
		return errors.New("GitHub webhook processor is not configured")
	}
	timer := time.NewTimer(0)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-timer.C:
		}
		processed, err := s.processNextGitHubWebhook(ctx)
		if err != nil && ctx.Err() == nil {
			s.log.Error("GitHub webhook inbox operation failed")
		}
		delay := s.githubApp.processorInterval
		if processed {
			delay = 0
		}
		timer.Reset(delay)
	}
}

func (s *Server) processNextGitHubWebhook(ctx context.Context) (bool, error) {
	delivery, ok, err := s.githubStore.ClaimNextGitHubWebhookDelivery(ctx)
	if err != nil || !ok {
		return false, err
	}
	if err := s.processGitHubWebhookDelivery(ctx, delivery); err != nil {
		var retryAt *time.Time
		if delivery.AttemptCount < maxGitHubWebhookAttempts {
			value := s.githubApp.now().UTC().Add(githubWebhookBackoff(delivery.AttemptCount))
			retryAt = &value
		}
		markErr := s.githubStore.MarkGitHubWebhookDeliveryFailed(
			ctx,
			delivery.DeliveryID,
			"GitHub webhook processing failed",
			retryAt,
		)
		if markErr != nil {
			return true, fmt.Errorf("mark GitHub webhook failed: %w", markErr)
		}
		return true, nil
	}
	if err := s.githubStore.MarkGitHubWebhookDeliveryProcessed(ctx, delivery.DeliveryID); err != nil {
		return true, fmt.Errorf("mark GitHub webhook processed: %w", err)
	}
	return true, nil
}

func (s *Server) processGitHubWebhookDelivery(
	ctx context.Context,
	delivery clouddomain.GitHubWebhookDelivery,
) error {
	if delivery.Event == "ping" {
		return nil
	}
	if delivery.InstallationID == nil || *delivery.InstallationID <= 0 {
		return errors.New("GitHub webhook installation is missing")
	}
	binding, err := s.githubStore.FindGitHubInstallationByGitHubID(ctx, *delivery.InstallationID)
	if errors.Is(err, cloudpostgres.ErrGitHubInstallationNotFound) {
		// Installation webhooks can arrive before the browser confirms an
		// install. Confirmation performs the canonical initial sync.
		return nil
	}
	if err != nil {
		return err
	}
	action := strings.ToLower(strings.TrimSpace(delivery.Action))
	switch delivery.Event {
	case "installation":
		switch action {
		case "suspend", "suspended":
			if binding.Status == "disconnected" || binding.Status == "deleted" {
				return nil
			}
			return s.resyncGitHubBinding(ctx, binding)
		case "deleted":
			_, err = s.githubStore.UpdateGitHubInstallationStatus(
				ctx,
				binding.OrgID,
				binding.GitHubInstallationID,
				cloudpostgres.GitHubInstallationStatusUpdate{Status: "deleted"},
			)
			return err
		case "unsuspend", "unsuspended", "new_permissions_accepted", "created":
			if binding.Status == "disconnected" || binding.Status == "deleted" {
				return nil
			}
			return s.resyncGitHubBinding(ctx, binding)
		default:
			return nil
		}
	case "installation_repositories":
		if binding.Status != "active" {
			return nil
		}
		return s.resyncGitHubBinding(ctx, binding)
	default:
		if isGitHubRepositoryRefreshEvent(delivery.Event) {
			return s.refreshGitHubRepositoryTargets(ctx, binding, delivery.RepositoryID)
		}
		return nil
	}
}

func (s *Server) refreshGitHubRepositoryTargets(
	ctx context.Context,
	binding clouddomain.GitHubInstallation,
	repositoryID *int64,
) error {
	if binding.Status != "active" ||
		repositoryID == nil ||
		*repositoryID <= 0 ||
		s.githubApp.repositoryRefresh == nil {
		return nil
	}
	grant, err := s.githubStore.FindActiveGitHubRepositoryGrant(
		ctx,
		binding.OrgID,
		*repositoryID,
	)
	if errors.Is(err, cloudpostgres.ErrGitHubRepositoryGrantNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	if grant.GitHubInstallationID != binding.GitHubInstallationID {
		return nil
	}
	return s.githubApp.repositoryRefresh(ctx, binding.OrgID, *repositoryID)
}

func (s *Server) resyncGitHubBinding(
	ctx context.Context,
	binding clouddomain.GitHubInstallation,
) error {
	installation, err := s.githubApp.client.GetInstallation(ctx, binding.GitHubInstallationID)
	if err != nil {
		if handled, cleanupErr := s.markDeletedGitHubInstallationOnNotFound(ctx, binding, err); handled {
			return cleanupErr
		}
		return err
	}
	if !s.isConfiguredGitHubInstallation(installation) {
		return errors.New("GitHub installation does not belong to configured App")
	}
	_, err = s.bindAndSyncGitHubInstallation(
		ctx,
		binding.OrgID,
		binding.InstalledByUserID,
		installation,
	)
	if handled, cleanupErr := s.markDeletedGitHubInstallationOnNotFound(ctx, binding, err); handled {
		return cleanupErr
	}
	return err
}

func isGitHubRepositoryRefreshEvent(event string) bool {
	switch event {
	case "pull_request",
		"pull_request_review",
		"pull_request_review_thread",
		"check_run",
		"check_suite",
		"status":
		return true
	default:
		return false
	}
}

func githubWebhookBackoff(attempt int) time.Duration {
	if attempt < 1 {
		attempt = 1
	}
	exponent := attempt - 1
	if exponent > 10 {
		exponent = 10
	}
	delay := 5 * time.Second * time.Duration(1<<exponent)
	if delay > maxGitHubWebhookBackoff {
		return maxGitHubWebhookBackoff
	}
	return delay
}
