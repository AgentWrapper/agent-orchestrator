package domain

import (
	"encoding/json"
	"time"
)

// GitHubInstallAttempt is a short-lived, single-use GitHub App setup request.
// StateHash is persisted instead of the bearer state returned to the caller.
type GitHubInstallAttempt struct {
	ID                          string          `json:"id"`
	OrgID                       OrgID           `json:"orgId"`
	InitiatingUserID            UserID          `json:"initiatingUserId"`
	StateHash                   []byte          `json:"-"`
	Metadata                    json.RawMessage `json:"metadata"`
	PendingGitHubInstallationID *int64          `json:"-"`
	PendingGitHubAccountID      *int64          `json:"-"`
	PendingAccountLogin         *string         `json:"-"`
	PendingAccountType          *string         `json:"-"`
	PendingRepositorySelection  *string         `json:"-"`
	PendingRepositoryCount      *int            `json:"-"`
	PendingRecordedAt           *time.Time      `json:"-"`
	ExpiresAt                   time.Time       `json:"expiresAt"`
	ConsumedAt                  *time.Time      `json:"consumedAt,omitempty"`
	CreatedAt                   time.Time       `json:"createdAt"`
}

// GitHubPendingInstallation is the provider-verified installation summary an
// AO administrator must review before the installation can be bound.
type GitHubPendingInstallation struct {
	AccountLogin        string `json:"accountLogin"`
	AccountType         string `json:"accountType"`
	RepositorySelection string `json:"repositorySelection"`
	RepositoryCount     int    `json:"repositoryCount"`
}

// GitHubInstallation is a GitHub App installation exclusively bound to one AO
// organization.
type GitHubInstallation struct {
	ID                   string          `json:"id"`
	OrgID                OrgID           `json:"orgId"`
	GitHubInstallationID int64           `json:"githubInstallationId"`
	GitHubAccountID      int64           `json:"githubAccountId"`
	AccountLogin         string          `json:"accountLogin"`
	AccountType          string          `json:"accountType"`
	Status               string          `json:"status"`
	RepositorySelection  string          `json:"repositorySelection"`
	Permissions          json.RawMessage `json:"permissions"`
	Events               []string        `json:"events"`
	InstalledByUserID    UserID          `json:"installedByUserId"`
	SuspendedAt          *time.Time      `json:"suspendedAt,omitempty"`
	DisconnectedAt       *time.Time      `json:"disconnectedAt,omitempty"`
	DeletedAt            *time.Time      `json:"deletedAt,omitempty"`
	CreatedAt            time.Time       `json:"createdAt"`
	UpdatedAt            time.Time       `json:"updatedAt"`
}

// GitHubRepository is the latest metadata for an immutable numeric GitHub
// repository identity.
type GitHubRepository struct {
	ID              int64           `json:"id"`
	OwnerAccountID  int64           `json:"ownerAccountId"`
	Name            string          `json:"name"`
	FullName        string          `json:"fullName"`
	HTMLURL         string          `json:"htmlUrl"`
	CloneURL        string          `json:"cloneUrl"`
	SSHURL          string          `json:"sshUrl,omitempty"`
	DefaultBranch   string          `json:"defaultBranch"`
	Visibility      string          `json:"visibility,omitempty"`
	Private         bool            `json:"private"`
	Archived        bool            `json:"archived"`
	Disabled        bool            `json:"disabled"`
	Metadata        json.RawMessage `json:"metadata"`
	GitHubUpdatedAt *time.Time      `json:"githubUpdatedAt,omitempty"`
	FirstSeenAt     time.Time       `json:"firstSeenAt"`
	LastSyncedAt    time.Time       `json:"lastSyncedAt"`
}

// GitHubRepositoryGrant records one interval during which an AO organization
// could use a repository through an installation. Revoked rows are retained.
type GitHubRepositoryGrant struct {
	ID                   string          `json:"id"`
	OrgID                OrgID           `json:"orgId"`
	InstallationID       string          `json:"installationId"`
	GitHubInstallationID int64           `json:"githubInstallationId"`
	GitHubRepositoryID   int64           `json:"githubRepositoryId"`
	RepositorySelection  string          `json:"repositorySelection"`
	GrantedAt            time.Time       `json:"grantedAt"`
	LastSyncedAt         time.Time       `json:"lastSyncedAt"`
	RevokedAt            *time.Time      `json:"revokedAt,omitempty"`
	RevokeReason         string          `json:"revokeReason,omitempty"`
	Metadata             json.RawMessage `json:"metadata"`
}

// GitHubGrantedRepository combines current repository metadata with the active
// installation grant that authorizes an AO organization to use it.
type GitHubGrantedRepository struct {
	Repository GitHubRepository      `json:"repository"`
	Grant      GitHubRepositoryGrant `json:"grant"`
}

// GitHubWebhookDelivery is one durable GitHub webhook inbox item.
type GitHubWebhookDelivery struct {
	DeliveryID          string     `json:"deliveryId"`
	Event               string     `json:"event"`
	Action              string     `json:"action,omitempty"`
	InstallationID      *int64     `json:"installationId,omitempty"`
	RepositoryID        *int64     `json:"repositoryId,omitempty"`
	Payload             []byte     `json:"-"`
	PayloadHash         []byte     `json:"-"`
	Status              string     `json:"status"`
	AttemptCount        int        `json:"attemptCount"`
	ReceivedAt          time.Time  `json:"receivedAt"`
	ProcessingStartedAt *time.Time `json:"processingStartedAt,omitempty"`
	LastAttemptAt       *time.Time `json:"lastAttemptAt,omitempty"`
	ProcessedAt         *time.Time `json:"processedAt,omitempty"`
	NextAttemptAt       *time.Time `json:"nextAttemptAt,omitempty"`
	LastError           string     `json:"lastError,omitempty"`
	LastErrorAt         *time.Time `json:"lastErrorAt,omitempty"`
	UpdatedAt           time.Time  `json:"updatedAt"`
}
