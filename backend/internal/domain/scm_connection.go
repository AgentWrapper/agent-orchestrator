package domain

import "time"

// SCMConnection is persisted connection metadata. Credentials are represented
// only by an opaque vault reference and never by token bytes.
type SCMConnection struct {
	ID            string
	Provider      SCMProvider
	DisplayName   string
	WebBaseURL    string
	APIBaseURL    string
	CredentialRef string
	CreatedAt     time.Time
	UpdatedAt     time.Time
}
