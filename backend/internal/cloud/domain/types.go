// Package domain defines cloud-only durable facts. Shared AO session vocabulary
// remains in internal/contract; these records describe account and sandbox
// ownership that the local daemon deliberately does not have.
package domain

import (
	"encoding/json"
	"time"
)

type (
	// AccountID uniquely identifies a cloud account.
	AccountID string
	// UserID uniquely identifies an AO Cloud user.
	UserID string
	// OrgID uniquely identifies an AO Cloud organization/tenant.
	OrgID string
	// ProjectID uniquely identifies a cloud project.
	ProjectID string
	// SessionID uniquely identifies a cloud session.
	SessionID string
	// CommandID uniquely identifies an idempotent cloud command.
	CommandID string
)

// Account records ownership and display metadata for a cloud account.
type Account struct {
	ID          AccountID `json:"id"`
	OwnerUserID string    `json:"ownerUserId"`
	DisplayName string    `json:"displayName"`
	CreatedAt   time.Time `json:"createdAt"`
	UpdatedAt   time.Time `json:"updatedAt"`
}

// User is AO's durable identity row. Local auth and future Clerk auth both map
// into this table.
type User struct {
	ID             UserID    `json:"id"`
	AuthProvider   string    `json:"authProvider"`
	ExternalUserID string    `json:"externalUserId"`
	Email          string    `json:"email"`
	DisplayName    string    `json:"displayName"`
	AvatarURL      string    `json:"avatarUrl,omitempty"`
	CreatedAt      time.Time `json:"createdAt"`
	UpdatedAt      time.Time `json:"updatedAt"`
}

// Organization is the AO tenant. Personal, team, and enterprise ownership all
// use the same resource model.
type Organization struct {
	ID              OrgID     `json:"id"`
	AuthProvider    string    `json:"authProvider"`
	ExternalOrgID   string    `json:"externalOrgId,omitempty"`
	Slug            string    `json:"slug"`
	DisplayName     string    `json:"displayName"`
	Kind            string    `json:"kind"`
	Plan            string    `json:"plan"`
	Status          string    `json:"status"`
	CreatedByUserID UserID    `json:"createdByUserId,omitempty"`
	CreatedAt       time.Time `json:"createdAt"`
	UpdatedAt       time.Time `json:"updatedAt"`
}

// OrgMembership links a user to an organization with a role.
type OrgMembership struct {
	ID                   string    `json:"id"`
	OrgID                OrgID     `json:"orgId"`
	UserID               UserID    `json:"userId"`
	ExternalMembershipID string    `json:"externalMembershipId,omitempty"`
	Role                 string    `json:"role"`
	Status               string    `json:"status"`
	CreatedAt            time.Time `json:"createdAt"`
	UpdatedAt            time.Time `json:"updatedAt"`
}

// UserOrganization is one organization visible to a signed-in user, annotated
// with the user's role in that organization.
type UserOrganization struct {
	Organization Organization  `json:"organization"`
	Membership   OrgMembership `json:"membership"`
}

// OrgMember combines a user's profile with their organization membership.
type OrgMember struct {
	User       User          `json:"user"`
	Membership OrgMembership `json:"membership"`
}

// OrgInvitation records an invitation to join an organization.
type OrgInvitation struct {
	ID              string     `json:"id"`
	OrgID           OrgID      `json:"orgId"`
	Email           string     `json:"email"`
	InvitedUserID   UserID     `json:"invitedUserId,omitempty"`
	InvitedByUserID UserID     `json:"invitedByUserId"`
	InvitedByEmail  string     `json:"invitedByEmail,omitempty"`
	InvitedByName   string     `json:"invitedByName,omitempty"`
	Role            string     `json:"role"`
	Status          string     `json:"status"`
	ExpiresAt       time.Time  `json:"expiresAt"`
	AcceptedAt      *time.Time `json:"acceptedAt,omitempty"`
	DeclinedAt      *time.Time `json:"declinedAt,omitempty"`
	RevokedAt       *time.Time `json:"revokedAt,omitempty"`
	CreatedAt       time.Time  `json:"createdAt"`
	UpdatedAt       time.Time  `json:"updatedAt"`
}

// LocalUser is an email/password identity used when AO Cloud runs locally.
type LocalUser struct {
	ID           string
	Email        string
	DisplayName  string
	PasswordHash string
}

// Project describes a repository-backed cloud project.
type Project struct {
	ID                 ProjectID       `json:"id"`
	AccountID          AccountID       `json:"accountId"`
	OrgID              OrgID           `json:"orgId"`
	DisplayName        string          `json:"displayName"`
	RepositoryURL      string          `json:"repositoryUrl"`
	DefaultBranch      string          `json:"defaultBranch"`
	GitHubRepositoryID *int64          `json:"githubRepositoryId,omitempty"`
	Config             json.RawMessage `json:"config"`
	CreatedAt          time.Time       `json:"createdAt"`
	UpdatedAt          time.Time       `json:"updatedAt"`
}

// Issue is the repository-scoped task snapshot attached to a Cloud session.
type Issue struct {
	ID         string    `json:"id"`
	AccountID  AccountID `json:"accountId"`
	OrgID      OrgID     `json:"orgId"`
	ProjectID  ProjectID `json:"projectId"`
	Provider   string    `json:"provider"`
	Repository string    `json:"repository"`
	Number     int       `json:"number"`
	URL        string    `json:"url"`
	Title      string    `json:"title"`
	Body       string    `json:"body"`
	State      string    `json:"state"`
	ObservedAt time.Time `json:"observedAt"`
}

// PRClaim records AO's durable ownership of a repository pull request.
type PRClaim struct {
	ID         string    `json:"id"`
	AccountID  AccountID `json:"accountId"`
	OrgID      OrgID     `json:"orgId"`
	SessionID  SessionID `json:"sessionId"`
	Provider   string    `json:"provider"`
	Repository string    `json:"repository"`
	Number     int       `json:"number"`
	URL        string    `json:"url"`
	ClaimedAt  time.Time `json:"claimedAt"`
}

// Session records the durable state of a cloud agent session.
type Session struct {
	ID               SessionID `json:"id"`
	AccountID        AccountID `json:"accountId"`
	OrgID            OrgID     `json:"orgId"`
	ProjectID        ProjectID `json:"projectId"`
	Kind             string    `json:"kind"`
	Harness          string    `json:"harness"`
	DisplayName      string    `json:"displayName"`
	Branch           string    `json:"branch"`
	Prompt           string    `json:"-"`
	ActivityState    string    `json:"activityState"`
	IsTerminated     bool      `json:"isTerminated"`
	AgentSessionID   string    `json:"agentSessionId,omitempty"`
	Capabilities     []string  `json:"capabilities,omitempty"`
	RuntimeConnected bool      `json:"runtimeConnected"`
	ActiveTurn       *Turn     `json:"activeTurn,omitempty"`
	Status           string    `json:"status"`
	CreatedAt        time.Time `json:"createdAt"`
	UpdatedAt        time.Time `json:"updatedAt"`
}

// Turn is one durable user-message-to-agent-response lifecycle.
type Turn struct {
	ID                  string     `json:"id"`
	AccountID           AccountID  `json:"accountId"`
	OrgID               OrgID      `json:"orgId"`
	SessionID           SessionID  `json:"sessionId"`
	UserMessageSequence int64      `json:"userMessageSequence"`
	State               string     `json:"state"`
	WorkerEpoch         int64      `json:"-"`
	AttemptCount        int        `json:"attemptCount"`
	ErrorMessage        string     `json:"errorMessage,omitempty"`
	StartedAt           *time.Time `json:"startedAt,omitempty"`
	CompletedAt         *time.Time `json:"completedAt,omitempty"`
	CreatedAt           time.Time  `json:"createdAt"`
	UpdatedAt           time.Time  `json:"updatedAt"`
}

// ResourceProfile specifies sandbox compute and storage capacity.
type ResourceProfile struct {
	CPU    int `json:"cpu"`
	Memory int `json:"memory"`
	Disk   int `json:"disk"`
}

// DefaultResourceProfile returns the standard sandbox resource request.
func DefaultResourceProfile() ResourceProfile {
	return ResourceProfile{CPU: 4, Memory: 8, Disk: 10}
}

// Sandbox records desired and observed state for a session environment.
type Sandbox struct {
	SessionID             SessionID       `json:"sessionId"`
	AccountID             AccountID       `json:"accountId"`
	OrgID                 OrgID           `json:"orgId"`
	Provider              string          `json:"provider"`
	ProviderEnvironmentID string          `json:"providerEnvironmentId,omitempty"`
	ProviderConnectionID  string          `json:"providerConnectionId,omitempty"`
	DesiredState          string          `json:"desiredState"`
	ObservedState         string          `json:"observedState"`
	ResourceProfile       ResourceProfile `json:"resourceProfile"`
	WorkerLastSeenAt      *time.Time      `json:"workerLastSeenAt,omitempty"`
	LastError             string          `json:"lastError,omitempty"`
	ReconcileAfter        time.Time       `json:"reconcileAfter"`
	CreatedAt             time.Time       `json:"createdAt"`
	UpdatedAt             time.Time       `json:"updatedAt"`
}

// Event is an ordered durable session event.
type Event struct {
	SessionID SessionID       `json:"sessionId"`
	Sequence  int64           `json:"sequence"`
	Type      string          `json:"type"`
	Payload   json.RawMessage `json:"payload"`
	CreatedAt time.Time       `json:"createdAt"`
}

// CommandReceipt records the result of an idempotent cloud command.
type CommandReceipt struct {
	ID             CommandID      `json:"id"`
	AccountID      AccountID      `json:"accountId"`
	OrgID          OrgID          `json:"orgId"`
	SessionID      SessionID      `json:"sessionId,omitempty"`
	IdempotencyKey string         `json:"idempotencyKey"`
	Kind           string         `json:"kind"`
	Status         string         `json:"status"`
	Result         map[string]any `json:"result,omitempty"`
	ErrorCode      string         `json:"errorCode,omitempty"`
	ErrorMessage   string         `json:"errorMessage,omitempty"`
	CreatedAt      time.Time      `json:"createdAt"`
	UpdatedAt      time.Time      `json:"updatedAt"`
}
