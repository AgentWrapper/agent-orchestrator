package localgh

import (
	"context"
	"errors"
	"testing"

	clouddomain "github.com/aoagents/agent-orchestrator/backend/internal/cloud/domain"
	cloudgithubapp "github.com/aoagents/agent-orchestrator/backend/internal/cloud/scm/githubapp"
)

type brokerGrantStore struct {
	grant     clouddomain.GitHubRepositoryGrant
	err       error
	orgID     clouddomain.OrgID
	repoID    int64
	findCalls int
}

func (s *brokerGrantStore) FindActiveGitHubRepositoryGrant(
	_ context.Context,
	orgID clouddomain.OrgID,
	repositoryID int64,
) (clouddomain.GitHubRepositoryGrant, error) {
	s.findCalls++
	s.orgID = orgID
	s.repoID = repositoryID
	return s.grant, s.err
}

type brokerMinter struct {
	installationID int64
	repositoryID   int64
	permissions    cloudgithubapp.Permissions
	err            error
}

func (m *brokerMinter) MintInstallationToken(
	_ context.Context,
	installationID, repositoryID int64,
	permissions cloudgithubapp.Permissions,
) (cloudgithubapp.InstallationToken, error) {
	m.installationID = installationID
	m.repositoryID = repositoryID
	m.permissions = permissions
	return cloudgithubapp.InstallationToken{}, m.err
}

func TestCredentialBrokerRequiresExplicitScope(t *testing.T) {
	store := &brokerGrantStore{}
	minter := &brokerMinter{}
	_, err := NewCredentialBroker(store, minter).Token(context.Background())
	if !errors.Is(err, ErrCredentialScopeRequired) {
		t.Fatalf("Token() error = %v, want ErrCredentialScopeRequired", err)
	}
	if store.findCalls != 0 {
		t.Fatal("broker queried a grant without an explicit scope")
	}
}

func TestCredentialBrokerRejectsCrossOrgOrRevokedGrant(t *testing.T) {
	grantErr := errors.New("active grant not found")
	store := &brokerGrantStore{err: grantErr}
	minter := &brokerMinter{}
	ctx, err := ContextWithCredentialScope(
		context.Background(),
		clouddomain.OrgID("org-one"),
		991,
		OperationPullRequestRead,
	)
	if err != nil {
		t.Fatalf("ContextWithCredentialScope() error = %v", err)
	}
	_, err = NewCredentialBroker(store, minter).Token(ctx)
	if !errors.Is(err, grantErr) {
		t.Fatalf("Token() error = %v, want active-grant error", err)
	}
	if store.orgID != "org-one" || store.repoID != 991 {
		t.Fatalf("grant lookup = (%q, %d)", store.orgID, store.repoID)
	}
	if minter.repositoryID != 0 {
		t.Fatal("broker minted a token after the scoped grant was rejected")
	}
}

func TestCredentialBrokerDownscopesEveryOperation(t *testing.T) {
	tests := []struct {
		operation CredentialOperation
		want      cloudgithubapp.Permissions
	}{
		{OperationObserve, cloudgithubapp.Permissions{
			"checks": "read", "pull_requests": "read", "statuses": "read",
		}},
		{OperationIssueRead, cloudgithubapp.Permissions{"issues": "read"}},
		{OperationPullRequestRead, cloudgithubapp.Permissions{"pull_requests": "read"}},
		{OperationMerge, cloudgithubapp.Permissions{"contents": "write"}},
		{OperationResolveReviewThread, cloudgithubapp.Permissions{"pull_requests": "write"}},
		{OperationGitUploadPack, cloudgithubapp.Permissions{"contents": "read"}},
		{OperationGitReceivePack, cloudgithubapp.Permissions{
			"contents": "write", "workflows": "write",
		}},
	}
	for _, test := range tests {
		t.Run(string(test.operation), func(t *testing.T) {
			mintErr := errors.New("stop after capture")
			store := &brokerGrantStore{grant: clouddomain.GitHubRepositoryGrant{
				GitHubInstallationID: 42,
			}}
			minter := &brokerMinter{err: mintErr}
			ctx, err := ContextWithCredentialScope(
				context.Background(),
				clouddomain.OrgID("org-one"),
				991,
				test.operation,
			)
			if err != nil {
				t.Fatalf("ContextWithCredentialScope() error = %v", err)
			}
			_, err = NewCredentialBroker(store, minter).Token(ctx)
			if !errors.Is(err, mintErr) {
				t.Fatalf("Token() error = %v, want capture error", err)
			}
			if minter.installationID != 42 || minter.repositoryID != 991 ||
				!equalPermissions(minter.permissions, test.want) {
				t.Fatalf(
					"mint scope = installation %d repository %d permissions %#v",
					minter.installationID,
					minter.repositoryID,
					minter.permissions,
				)
			}
		})
	}
}

func TestCredentialBrokerRejectsTamperedOperationPermissions(t *testing.T) {
	ctx := context.WithValue(context.Background(), credentialScopeContextKey{}, credentialScope{
		OrgID:        clouddomain.OrgID("org-one"),
		RepositoryID: 991,
		Operation:    OperationGitUploadPack,
		Permissions:  cloudgithubapp.Permissions{"contents": "write"},
	})
	store := &brokerGrantStore{}
	_, err := NewCredentialBroker(store, &brokerMinter{}).Token(ctx)
	if !errors.Is(err, ErrCredentialScopeInvalid) {
		t.Fatalf("Token() error = %v, want ErrCredentialScopeInvalid", err)
	}
	if store.findCalls != 0 {
		t.Fatal("broker queried a grant for a tampered permission scope")
	}
}
