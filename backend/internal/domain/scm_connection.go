package domain

import "time"

// SCMConnectionStatus is the last persisted provider-neutral validation state.
type SCMConnectionStatus string

// SCM connection validation status values are provider-neutral and persisted.
const (
	SCMConnectionStatusUnknown           SCMConnectionStatus = "unknown"
	SCMConnectionStatusConnected         SCMConnectionStatus = "connected"
	SCMConnectionStatusMissingCredential SCMConnectionStatus = "missing_credential"
	SCMConnectionStatusUnauthorized      SCMConnectionStatus = "unauthorized"
	SCMConnectionStatusForbidden         SCMConnectionStatus = "forbidden"
	SCMConnectionStatusUnreachable       SCMConnectionStatus = "unreachable"
	SCMConnectionStatusTLSError          SCMConnectionStatus = "tls_error"
	SCMConnectionStatusRateLimited       SCMConnectionStatus = "rate_limited"
)

// SCMConnection is persisted connection metadata. Credentials are represented
// only by an opaque vault reference and never by token bytes.
type SCMConnection struct {
	ID            string
	Provider      SCMProvider
	DisplayName   string
	WebBaseURL    string
	APIBaseURL    string
	CredentialRef string
	Status        SCMConnectionStatus
	Username      string
	CreatedAt     time.Time
	UpdatedAt     time.Time
}
