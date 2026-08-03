package postgres

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"

	clouddomain "github.com/aoagents/agent-orchestrator/backend/internal/cloud/domain"
)

func TestGitHubStoreIntegrationIsolationRevocationAndAtomicConfirmation(t *testing.T) {
	databaseURL := os.Getenv("AO_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("AO_DATABASE_URL is not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	if err := Migrate(ctx, databaseURL); err != nil {
		t.Fatalf("Migrate() error = %v", err)
	}
	store, err := Open(ctx, databaseURL)
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	defer store.Close()

	userA := uuid.NewString()
	userB := uuid.NewString()
	accountA, err := store.EnsureAccount(ctx, userA, "GitHub integration A")
	if err != nil {
		t.Fatalf("EnsureAccount(A) error = %v", err)
	}
	accountB, err := store.EnsureAccount(ctx, userB, "GitHub integration B")
	if err != nil {
		t.Fatalf("EnsureAccount(B) error = %v", err)
	}
	orgA := clouddomain.OrgID(accountA.ID)
	orgB := clouddomain.OrgID(accountB.ID)
	repositoryID := integrationGitHubID()
	rollbackRepositoryID := integrationGitHubID()
	concurrentRepositoryID := integrationGitHubID()
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cleanupCancel()
		_, _ = store.pool.Exec(cleanupCtx, `DELETE FROM ao_organizations WHERE id = ANY($1::uuid[])`, []string{string(orgA), string(orgB)})
		_, _ = store.pool.Exec(cleanupCtx, `DELETE FROM ao_accounts WHERE id = ANY($1::uuid[])`, []string{string(accountA.ID), string(accountB.ID)})
		_, _ = store.pool.Exec(cleanupCtx, `DELETE FROM ao_users WHERE id = ANY($1::uuid[])`, []string{userA, userB})
		_, _ = store.pool.Exec(cleanupCtx, `DELETE FROM ao_github_repositories WHERE github_repository_id = ANY($1::bigint[])`, []int64{repositoryID, rollbackRepositoryID, concurrentRepositoryID})
	})

	installationID := integrationGitHubID()
	installation := integrationGitHubInstallationInput(installationID)
	repository := integrationGitHubRepository(repositoryID)
	stateA := createPendingIntegrationAttempt(t, ctx, store, orgA, clouddomain.UserID(userA), installation, 1, nil)
	if _, err := store.ConfirmGitHubInstallation(ctx, orgA, clouddomain.UserID(userA), stateA, GitHubInstallationConfirmation{
		Installation: installation,
		Repositories: []clouddomain.GitHubRepository{repository},
	}); err != nil {
		t.Fatalf("ConfirmGitHubInstallation(A) error = %v", err)
	}
	if _, err := store.ConfirmGitHubInstallation(ctx, orgA, clouddomain.UserID(userA), stateA, GitHubInstallationConfirmation{
		Installation: installation,
		Repositories: []clouddomain.GitHubRepository{repository},
	}); !errors.Is(err, ErrInvalidGitHubInstallAttempt) {
		t.Fatalf("confirmation replay error = %v, want ErrInvalidGitHubInstallAttempt", err)
	}
	if _, err := store.FindActiveGitHubRepositoryGrant(ctx, orgA, repositoryID); err != nil {
		t.Fatalf("FindActiveGitHubRepositoryGrant(A) error = %v", err)
	}
	if _, err := store.FindActiveGitHubRepositoryGrant(ctx, orgB, repositoryID); !errors.Is(err, ErrGitHubRepositoryGrantNotFound) {
		t.Fatalf("cross-org active grant error = %v, want ErrGitHubRepositoryGrantNotFound", err)
	}

	stateB := createPendingIntegrationAttempt(t, ctx, store, orgB, clouddomain.UserID(userB), installation, 1, nil)
	if _, err := store.ConfirmGitHubInstallation(ctx, orgB, clouddomain.UserID(userB), stateB, GitHubInstallationConfirmation{
		Installation: installation,
		Repositories: []clouddomain.GitHubRepository{repository},
	}); !errors.Is(err, ErrGitHubInstallationConflict) {
		t.Fatalf("cross-org installation confirmation error = %v, want ErrGitHubInstallationConflict", err)
	}
	if _, err := store.GetPendingGitHubInstallation(ctx, orgB, clouddomain.UserID(userB), stateB); err != nil {
		t.Fatalf("cross-org conflict consumed pending attempt: %v", err)
	}

	if err := store.RevokeGitHubRepositoryGrant(ctx, orgA, repositoryID, "integration_test"); err != nil {
		t.Fatalf("RevokeGitHubRepositoryGrant() error = %v", err)
	}
	if _, err := store.FindActiveGitHubRepositoryGrant(ctx, orgA, repositoryID); !errors.Is(err, ErrGitHubRepositoryGrantNotFound) {
		t.Fatalf("revoked grant lookup error = %v, want ErrGitHubRepositoryGrantNotFound", err)
	}

	rollbackInstallationID := integrationGitHubID()
	rollbackInstallation := integrationGitHubInstallationInput(rollbackInstallationID)
	rollbackRepository := integrationGitHubRepository(rollbackRepositoryID)
	rollbackState := createPendingIntegrationAttempt(
		t,
		ctx,
		store,
		orgA,
		clouddomain.UserID(userA),
		rollbackInstallation,
		1,
		json.RawMessage(`{"forceAtomicFailure":true}`),
	)
	triggerName := "ao_test_github_confirm_" + uuid.New().String()[:8]
	functionName := triggerName + "_fn"
	quotedTrigger := `"` + triggerName + `"`
	quotedFunction := `"` + functionName + `"`
	if _, err := store.pool.Exec(ctx, fmt.Sprintf(`
		CREATE FUNCTION %s() RETURNS trigger LANGUAGE plpgsql AS $$
		BEGIN
			IF NEW.consumed_at IS NOT NULL
				AND NEW.metadata->>'forceAtomicFailure' = 'true' THEN
				RAISE EXCEPTION 'forced atomic confirmation failure';
			END IF;
			RETURN NEW;
		END
		$$
	`, quotedFunction)); err != nil {
		t.Fatalf("create atomic failure function: %v", err)
	}
	dropTrigger := func() {
		_, _ = store.pool.Exec(context.Background(), fmt.Sprintf(`DROP TRIGGER IF EXISTS %s ON ao_github_install_attempts`, quotedTrigger))
		_, _ = store.pool.Exec(context.Background(), fmt.Sprintf(`DROP FUNCTION IF EXISTS %s()`, quotedFunction))
	}
	t.Cleanup(dropTrigger)
	if _, err := store.pool.Exec(ctx, fmt.Sprintf(`
		CREATE TRIGGER %s
			BEFORE UPDATE OF consumed_at ON ao_github_install_attempts
			FOR EACH ROW EXECUTE FUNCTION %s()
	`, quotedTrigger, quotedFunction)); err != nil {
		t.Fatalf("create atomic failure trigger: %v", err)
	}

	if _, err := store.ConfirmGitHubInstallation(ctx, orgA, clouddomain.UserID(userA), rollbackState, GitHubInstallationConfirmation{
		Installation: rollbackInstallation,
		Repositories: []clouddomain.GitHubRepository{rollbackRepository},
	}); err == nil {
		t.Fatal("forced atomic confirmation error = nil")
	}
	if _, err := store.FindGitHubInstallationByGitHubID(ctx, rollbackInstallationID); !errors.Is(err, ErrGitHubInstallationNotFound) {
		t.Fatalf("rolled-back installation lookup error = %v, want ErrGitHubInstallationNotFound", err)
	}
	if _, err := store.FindActiveGitHubRepositoryGrant(ctx, orgA, rollbackRepositoryID); !errors.Is(err, ErrGitHubRepositoryGrantNotFound) {
		t.Fatalf("rolled-back grant lookup error = %v, want ErrGitHubRepositoryGrantNotFound", err)
	}
	if _, err := store.GetPendingGitHubInstallation(ctx, orgA, clouddomain.UserID(userA), rollbackState); err != nil {
		t.Fatalf("failed atomic confirmation consumed attempt: %v", err)
	}

	dropTrigger()
	if _, err := store.ConfirmGitHubInstallation(ctx, orgA, clouddomain.UserID(userA), rollbackState, GitHubInstallationConfirmation{
		Installation: rollbackInstallation,
		Repositories: []clouddomain.GitHubRepository{rollbackRepository},
	}); err != nil {
		t.Fatalf("ConfirmGitHubInstallation(after rollback) error = %v", err)
	}
	if _, err := store.FindActiveGitHubRepositoryGrant(ctx, orgA, rollbackRepositoryID); err != nil {
		t.Fatalf("successful atomic grant lookup error = %v", err)
	}

	concurrentInstallation := integrationGitHubInstallationInput(integrationGitHubID())
	concurrentRepository := integrationGitHubRepository(concurrentRepositoryID)
	concurrentState := createPendingIntegrationAttempt(
		t,
		ctx,
		store,
		orgA,
		clouddomain.UserID(userA),
		concurrentInstallation,
		1,
		nil,
	)
	start := make(chan struct{})
	results := make(chan error, 2)
	for range 2 {
		go func() {
			<-start
			_, confirmErr := store.ConfirmGitHubInstallation(
				ctx,
				orgA,
				clouddomain.UserID(userA),
				concurrentState,
				GitHubInstallationConfirmation{
					Installation: concurrentInstallation,
					Repositories: []clouddomain.GitHubRepository{concurrentRepository},
				},
			)
			results <- confirmErr
		}()
	}
	close(start)
	successes := 0
	replays := 0
	for range 2 {
		confirmErr := <-results
		switch {
		case confirmErr == nil:
			successes++
		case errors.Is(confirmErr, ErrInvalidGitHubInstallAttempt):
			replays++
		default:
			t.Fatalf("concurrent confirmation error = %v", confirmErr)
		}
	}
	if successes != 1 || replays != 1 {
		t.Fatalf("concurrent confirmations = %d success, %d replay", successes, replays)
	}
}

func createPendingIntegrationAttempt(
	t *testing.T,
	ctx context.Context,
	store *Store,
	orgID clouddomain.OrgID,
	userID clouddomain.UserID,
	installation GitHubInstallationInput,
	repositoryCount int,
	metadata json.RawMessage,
) string {
	t.Helper()
	state, _, err := store.CreateGitHubInstallAttempt(ctx, orgID, userID, metadata, time.Minute)
	if err != nil {
		t.Fatalf("CreateGitHubInstallAttempt() error = %v", err)
	}
	if _, err := store.RecordPendingGitHubInstallation(ctx, orgID, userID, state, GitHubPendingInstallationInput{
		InstallationID:      installation.InstallationID,
		AccountID:           installation.AccountID,
		AccountLogin:        installation.AccountLogin,
		AccountType:         installation.AccountType,
		RepositorySelection: installation.RepositorySelection,
		RepositoryCount:     repositoryCount,
	}); err != nil {
		t.Fatalf("RecordPendingGitHubInstallation() error = %v", err)
	}
	return state
}

func integrationGitHubInstallationInput(installationID int64) GitHubInstallationInput {
	return GitHubInstallationInput{
		InstallationID:      installationID,
		AccountID:           integrationGitHubID(),
		AccountLogin:        "ao-integration-" + uuid.New().String()[:8],
		AccountType:         "Organization",
		Status:              "active",
		RepositorySelection: "selected",
		Permissions:         json.RawMessage(`{"metadata":"read"}`),
		Events:              []string{"installation_repositories"},
	}
}

func integrationGitHubRepository(repositoryID int64) clouddomain.GitHubRepository {
	name := "repository-" + uuid.New().String()[:8]
	return clouddomain.GitHubRepository{
		ID:             repositoryID,
		OwnerAccountID: integrationGitHubID(),
		Name:           name,
		FullName:       "ao-integration/" + name,
		HTMLURL:        "https://github.com/ao-integration/" + name,
		CloneURL:       "https://github.com/ao-integration/" + name + ".git",
		DefaultBranch:  "main",
		Metadata:       json.RawMessage(`{}`),
	}
}

func integrationGitHubID() int64 {
	id := uuid.New()
	value := int64(binary.BigEndian.Uint64(id[:8]) & math.MaxInt64)
	if value == 0 {
		return 1
	}
	return value
}
