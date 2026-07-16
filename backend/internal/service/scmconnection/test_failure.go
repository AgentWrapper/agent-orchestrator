package scmconnection

// TestFailureKind classifies a provider test failure without exposing provider details.
type TestFailureKind string

// Provider-neutral tester failure categories.
const (
	TestFailureAuth              TestFailureKind = "auth"
	TestFailureForbidden         TestFailureKind = "forbidden"
	TestFailureUnreachable       TestFailureKind = "unreachable"
	TestFailureTLS               TestFailureKind = "tls"
	TestFailureRateLimited       TestFailureKind = "rate_limited"
	TestFailureRepoNotFound      TestFailureKind = "repo_not_found"
	TestFailureWriteScopeMissing TestFailureKind = "write_scope_missing"
)

// TestFailure carries a provider-neutral category and a hidden diagnostic cause.
type TestFailure struct {
	Kind  TestFailureKind
	cause error
}

// NewTestFailure creates a redacted categorized provider test error.
func NewTestFailure(kind TestFailureKind, cause error) *TestFailure {
	return &TestFailure{Kind: kind, cause: cause}
}

func (e *TestFailure) Error() string { return "SCM connection test failed" }

func (e *TestFailure) Unwrap() error { return e.cause }
