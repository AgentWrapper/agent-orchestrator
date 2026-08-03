package postgres

import (
	"bytes"
	"encoding/base64"
	"errors"
	"strings"
	"testing"

	clouddomain "github.com/aoagents/agent-orchestrator/backend/internal/cloud/domain"
)

func TestNewGitHubInstallStateUses256BitsAndStoresOnlyHash(t *testing.T) {
	source := bytes.Repeat([]byte{0x5a}, 32)
	state, hash, err := newGitHubInstallState(bytes.NewReader(source))
	if err != nil {
		t.Fatalf("newGitHubInstallState() error = %v", err)
	}
	raw, err := base64.RawURLEncoding.DecodeString(state)
	if err != nil {
		t.Fatalf("decode state: %v", err)
	}
	if !bytes.Equal(raw, source) {
		t.Fatalf("decoded state = %x, want %x", raw, source)
	}
	if len(raw) != 32 {
		t.Fatalf("state entropy = %d bytes, want 32", len(raw))
	}
	if len(hash) != 32 || bytes.Equal(hash, raw) {
		t.Fatalf("stored hash = %x, want a distinct 32-byte digest", hash)
	}
	if !bytes.Equal(hash, hashGitHubInstallState(state)) {
		t.Fatal("state hash is not deterministic")
	}
}

func TestNewGitHubInstallStatePropagatesEntropyFailure(t *testing.T) {
	_, _, err := newGitHubInstallState(&failingReader{})
	if err == nil {
		t.Fatal("newGitHubInstallState() error = nil")
	}
}

func TestNormalizeGitHubInstallationInput(t *testing.T) {
	input := GitHubInstallationInput{
		InstallationID:      42,
		AccountID:           84,
		AccountLogin:        " example ",
		AccountType:         " Organization ",
		RepositorySelection: "selected",
	}
	if err := normalizeGitHubInstallationInput(&input); err != nil {
		t.Fatalf("normalizeGitHubInstallationInput() error = %v", err)
	}
	if input.Status != "active" || input.AccountLogin != "example" ||
		input.AccountType != "Organization" ||
		string(input.Permissions) != "{}" ||
		input.Events == nil {
		t.Fatalf("normalized input = %#v", input)
	}

	input.RepositorySelection = "partial"
	if err := normalizeGitHubInstallationInput(&input); !errors.Is(err, ErrInvalidGitHubInstallation) {
		t.Fatalf("invalid selection error = %v, want ErrInvalidGitHubInstallation", err)
	}
}

func TestNormalizeGitHubPendingInstallationInput(t *testing.T) {
	input := GitHubPendingInstallationInput{
		InstallationID:      42,
		AccountID:           84,
		AccountLogin:        " example ",
		AccountType:         " Organization ",
		RepositorySelection: "selected",
		RepositoryCount:     3,
	}
	if err := normalizeGitHubPendingInstallationInput(&input); err != nil {
		t.Fatalf("normalizeGitHubPendingInstallationInput() error = %v", err)
	}
	if input.AccountLogin != "example" || input.AccountType != "Organization" {
		t.Fatalf("normalized pending input = %#v", input)
	}
	input.RepositoryCount = -1
	if err := normalizeGitHubPendingInstallationInput(&input); !errors.Is(err, ErrInvalidGitHubInstallation) {
		t.Fatalf("negative repository count error = %v, want ErrInvalidGitHubInstallation", err)
	}
}

func TestMatchesPendingGitHubConfirmation(t *testing.T) {
	installationID := int64(42)
	accountID := int64(84)
	accountLogin := "aoagents"
	accountType := "Organization"
	selection := "selected"
	repositoryCount := 1
	attempt := clouddomain.GitHubInstallAttempt{
		PendingGitHubInstallationID: &installationID,
		PendingGitHubAccountID:      &accountID,
		PendingAccountLogin:         &accountLogin,
		PendingAccountType:          &accountType,
		PendingRepositorySelection:  &selection,
		PendingRepositoryCount:      &repositoryCount,
	}
	confirmation := GitHubInstallationConfirmation{
		Installation: GitHubInstallationInput{
			InstallationID:      installationID,
			AccountID:           accountID,
			AccountLogin:        accountLogin,
			AccountType:         accountType,
			RepositorySelection: selection,
		},
		Repositories: []clouddomain.GitHubRepository{{ID: 101}},
	}
	if !matchesPendingGitHubConfirmation(attempt, confirmation) {
		t.Fatal("matching confirmation was rejected")
	}
	confirmation.Installation.InstallationID++
	if matchesPendingGitHubConfirmation(attempt, confirmation) {
		t.Fatal("different installation matched pending confirmation")
	}
	confirmation.Installation.InstallationID = installationID
	confirmation.Repositories = append(confirmation.Repositories, clouddomain.GitHubRepository{ID: 102})
	if matchesPendingGitHubConfirmation(attempt, confirmation) {
		t.Fatal("different repository count matched pending confirmation")
	}
}

func TestNormalizeGitHubRepositoryKeepsNumericIdentity(t *testing.T) {
	repository := clouddomain.GitHubRepository{
		ID:             123,
		OwnerAccountID: 456,
		Name:           "agent-orchestrator",
		FullName:       "aoagents/agent-orchestrator",
		HTMLURL:        "https://github.com/aoagents/agent-orchestrator",
		CloneURL:       "https://github.com/aoagents/agent-orchestrator.git",
	}
	if err := normalizeGitHubRepository(&repository); err != nil {
		t.Fatalf("normalizeGitHubRepository() error = %v", err)
	}
	if repository.ID != 123 || repository.DefaultBranch != "main" ||
		string(repository.Metadata) != "{}" {
		t.Fatalf("normalized repository = %#v", repository)
	}
	repository.ID = 0
	if err := normalizeGitHubRepository(&repository); !errors.Is(err, ErrInvalidGitHubRepository) {
		t.Fatalf("zero repository ID error = %v, want ErrInvalidGitHubRepository", err)
	}
}

func TestSameGitHubWebhookDeliveryDetectsReplayConflicts(t *testing.T) {
	installationID := int64(11)
	repositoryID := int64(22)
	input := GitHubWebhookDeliveryInput{
		DeliveryID:     "delivery-1",
		Event:          "installation_repositories",
		Action:         "added",
		InstallationID: &installationID,
		RepositoryID:   &repositoryID,
		Payload:        []byte(`{"action":"added"}`),
	}
	hash := hashGitHubWebhookPayload(input.Payload)
	existing := clouddomain.GitHubWebhookDelivery{
		DeliveryID:     input.DeliveryID,
		Event:          input.Event,
		Action:         input.Action,
		InstallationID: &installationID,
		RepositoryID:   &repositoryID,
		PayloadHash:    hash,
	}
	if !sameGitHubWebhookDelivery(existing, input, hash) {
		t.Fatal("identical delivery was treated as a replay conflict")
	}
	changedPayload := input
	changedPayload.Payload = []byte(`{"action":"removed"}`)
	if sameGitHubWebhookDelivery(existing, changedPayload, hashGitHubWebhookPayload(changedPayload.Payload)) {
		t.Fatal("changed payload was deduplicated")
	}
	changedMetadata := input
	changedMetadata.Action = "removed"
	if sameGitHubWebhookDelivery(existing, changedMetadata, hash) {
		t.Fatal("changed delivery metadata was deduplicated")
	}
}

func TestGitHubMigrationContainsTenantAndReplayConstraints(t *testing.T) {
	body, err := migrations.ReadFile("migrations/00009_github_app.sql")
	if err != nil {
		t.Fatalf("read GitHub migration: %v", err)
	}
	sql := string(body)
	required := []string{
		"CHECK (octet_length(state_hash) = 32)",
		"pending_github_installation_id BIGINT",
		"pending_repository_count INTEGER CHECK (pending_repository_count >= 0)",
		"pending_recorded_at TIMESTAMPTZ",
		"UNIQUE (org_id, id)",
		"UNIQUE (org_id, github_repository_id, id)",
		"WHERE revoked_at IS NULL",
		"ADD COLUMN github_repository_id BIGINT",
		"ao_projects_org_github_grant_fk",
		"github_delivery_id TEXT PRIMARY KEY",
		"CHECK (octet_length(payload_hash) = 32)",
	}
	for _, fragment := range required {
		if !strings.Contains(sql, fragment) {
			t.Errorf("migration missing %q", fragment)
		}
	}
}

type failingReader struct{}

func (*failingReader) Read([]byte) (int, error) {
	return 0, errors.New("entropy unavailable")
}
