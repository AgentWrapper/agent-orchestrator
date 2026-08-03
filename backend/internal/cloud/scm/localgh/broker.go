package localgh

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	clouddomain "github.com/aoagents/agent-orchestrator/backend/internal/cloud/domain"
	cloudgithubapp "github.com/aoagents/agent-orchestrator/backend/internal/cloud/scm/githubapp"
)

// CredentialOperation identifies one narrowly scoped control-plane GitHub
// operation. Installation credentials may only be minted for these operations.
type CredentialOperation string

const (
	OperationObserve             CredentialOperation = "observe"
	OperationIssueRead           CredentialOperation = "issue-read"
	OperationPullRequestRead     CredentialOperation = "pull-request-read"
	OperationMerge               CredentialOperation = "merge"
	OperationResolveReviewThread CredentialOperation = "resolve-review-thread"
	OperationGitUploadPack       CredentialOperation = "git-upload-pack"
	OperationGitReceivePack      CredentialOperation = "git-receive-pack"
)

var (
	// ErrCredentialScopeRequired means an App credential was requested without
	// an explicit organization, repository, operation, and permission scope.
	ErrCredentialScopeRequired = errors.New("explicit GitHub credential scope is required")
	// ErrCredentialScopeInvalid means the requested operation is unknown or its
	// permissions are broader or narrower than the operation permits.
	ErrCredentialScopeInvalid = errors.New("invalid GitHub credential scope")
)

type credentialScope struct {
	OrgID        clouddomain.OrgID
	RepositoryID int64
	Operation    CredentialOperation
	Permissions  cloudgithubapp.Permissions
}

type credentialScopeContextKey struct{}

// ContextWithCredentialScope creates the explicit organization/repository and
// operation-permission boundary required by the GitHub App token source.
func ContextWithCredentialScope(
	ctx context.Context,
	orgID clouddomain.OrgID,
	repositoryID int64,
	operation CredentialOperation,
) (context.Context, error) {
	permissions, err := permissionsForOperation(operation)
	if err != nil {
		return nil, err
	}
	if orgID == "" || repositoryID <= 0 {
		return nil, ErrCredentialScopeInvalid
	}
	return context.WithValue(ctx, credentialScopeContextKey{}, credentialScope{
		OrgID:        orgID,
		RepositoryID: repositoryID,
		Operation:    operation,
		Permissions:  permissions,
	}), nil
}

func permissionsForOperation(operation CredentialOperation) (cloudgithubapp.Permissions, error) {
	switch operation {
	case OperationObserve:
		return cloudgithubapp.Permissions{
			"checks":        "read",
			"pull_requests": "read",
			"statuses":      "read",
		}, nil
	case OperationIssueRead:
		return cloudgithubapp.Permissions{"issues": "read"}, nil
	case OperationPullRequestRead:
		return cloudgithubapp.Permissions{"pull_requests": "read"}, nil
	case OperationMerge:
		return cloudgithubapp.Permissions{"contents": "write"}, nil
	case OperationResolveReviewThread:
		return cloudgithubapp.Permissions{"pull_requests": "write"}, nil
	case OperationGitUploadPack:
		return cloudgithubapp.Permissions{"contents": "read"}, nil
	case OperationGitReceivePack:
		return cloudgithubapp.Permissions{
			"contents":  "write",
			"workflows": "write",
		}, nil
	default:
		return nil, fmt.Errorf("%w: unknown operation %q", ErrCredentialScopeInvalid, operation)
	}
}

type githubGrantStore interface {
	FindActiveGitHubRepositoryGrant(
		context.Context,
		clouddomain.OrgID,
		int64,
	) (clouddomain.GitHubRepositoryGrant, error)
}

type installationTokenMinter interface {
	MintInstallationToken(
		context.Context,
		int64,
		int64,
		cloudgithubapp.Permissions,
	) (cloudgithubapp.InstallationToken, error)
}

// CredentialBroker mints short-lived, repository-restricted GitHub App
// credentials and retains them only in process memory until near expiry.
type CredentialBroker struct {
	store  githubGrantStore
	client installationTokenMinter
	mu     sync.Mutex
	tokens map[credentialCacheKey]cachedCredential
}

type credentialCacheKey struct {
	orgID          clouddomain.OrgID
	repositoryID   int64
	installationID int64
	operation      CredentialOperation
}

type cachedCredential struct {
	value     string
	expiresAt time.Time
}

// NewCredentialBroker creates an installation credential token source.
func NewCredentialBroker(store githubGrantStore, client installationTokenMinter) *CredentialBroker {
	return &CredentialBroker{
		store:  store,
		client: client,
		tokens: make(map[credentialCacheKey]cachedCredential),
	}
}

// Token obtains an ephemeral installation credential for the exact scope in
// ctx. The returned value is intended only for the immediate GitHub request.
func (b *CredentialBroker) Token(ctx context.Context) (string, error) {
	scope, ok := ctx.Value(credentialScopeContextKey{}).(credentialScope)
	if !ok {
		return "", ErrCredentialScopeRequired
	}
	expected, err := permissionsForOperation(scope.Operation)
	if err != nil || scope.OrgID == "" || scope.RepositoryID <= 0 ||
		!equalPermissions(scope.Permissions, expected) {
		return "", ErrCredentialScopeInvalid
	}
	if b == nil || b.store == nil || b.client == nil {
		return "", errors.New("GitHub credential broker is not configured")
	}
	grant, err := b.store.FindActiveGitHubRepositoryGrant(ctx, scope.OrgID, scope.RepositoryID)
	if err != nil {
		return "", fmt.Errorf("authorize GitHub repository grant: %w", err)
	}
	cacheKey := credentialCacheKey{
		orgID:          scope.OrgID,
		repositoryID:   scope.RepositoryID,
		installationID: grant.GitHubInstallationID,
		operation:      scope.Operation,
	}
	b.mu.Lock()
	cached, ok := b.tokens[cacheKey]
	if ok && cached.value != "" && time.Until(cached.expiresAt) > time.Minute {
		b.mu.Unlock()
		return cached.value, nil
	}
	delete(b.tokens, cacheKey)
	b.mu.Unlock()

	token, err := b.client.MintInstallationToken(
		ctx,
		grant.GitHubInstallationID,
		scope.RepositoryID,
		expected,
	)
	if err != nil {
		return "", err
	}
	value := token.Token()
	if value == "" {
		return "", errors.New("GitHub installation token is empty")
	}
	b.mu.Lock()
	b.tokens[cacheKey] = cachedCredential{value: value, expiresAt: token.ExpiresAt}
	b.mu.Unlock()
	return value, nil
}

func equalPermissions(left, right cloudgithubapp.Permissions) bool {
	if len(left) != len(right) {
		return false
	}
	for name, level := range left {
		if right[name] != level {
			return false
		}
	}
	return true
}
