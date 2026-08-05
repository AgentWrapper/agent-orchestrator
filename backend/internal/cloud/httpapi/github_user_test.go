package httpapi

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"

	cloudauth "github.com/aoagents/agent-orchestrator/backend/internal/cloud/auth"
	clouddomain "github.com/aoagents/agent-orchestrator/backend/internal/cloud/domain"
	cloudgithubapp "github.com/aoagents/agent-orchestrator/backend/internal/cloud/scm/githubapp"
	cloudsecrets "github.com/aoagents/agent-orchestrator/backend/internal/cloud/secrets"
)

func TestCreateGitHubUserAuthorizationPersistsHashedStateAndEncryptedPKCE(t *testing.T) {
	cipher, err := cloudsecrets.New([]byte("0123456789abcdef0123456789abcdef"))
	if err != nil {
		t.Fatal(err)
	}
	store := &githubUserTestStore{fakeGitHubStore: &fakeGitHubStore{}}
	client := &fakeGitHubUserClient{}
	server := &Server{
		githubStore:  store,
		secretCipher: cipher,
		githubApp: &githubAppRuntime{
			clientID:        "client-id",
			clientSecret:    "client-secret",
			userCallbackURL: "https://cloud.example/api/cloud/v1/github/user/callback",
			userClient:      client,
			now:             time.Now,
		},
	}
	request := httptest.NewRequest(http.MethodPost, "/github/user/authorize", nil)
	request = request.WithContext(cloudauth.ContextWithPrincipal(
		request.Context(),
		cloudauth.Principal{UserID: "user-1"},
	))
	recorder := httptest.NewRecorder()
	server.createGitHubUserAuthorization(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if store.attempt.UserID != "user-1" || len(store.attempt.StateHash) != 32 {
		t.Fatalf("attempt = %#v", store.attempt)
	}
	stateHash := sha256.Sum256([]byte(client.state))
	if string(store.attempt.StateHash) != string(stateHash[:]) {
		t.Fatal("persisted state hash does not match authorization state")
	}
	verifier, err := cipher.Decrypt(
		store.attempt.CodeVerifierEncrypted,
		store.attempt.CodeVerifierNonce,
		githubUserOAuthAssociatedData("user-1", stateHash[:]),
	)
	if err != nil {
		t.Fatalf("decrypt verifier: %v", err)
	}
	challenge := sha256.Sum256(verifier)
	if client.challenge != base64.RawURLEncoding.EncodeToString(challenge[:]) {
		t.Fatalf("PKCE challenge = %q", client.challenge)
	}
}

func TestGetGitHubUserListsPersonalAndOrganizationOwners(t *testing.T) {
	now := time.Date(2026, 8, 5, 14, 0, 0, 0, time.UTC)
	cipher, err := cloudsecrets.New([]byte("0123456789abcdef0123456789abcdef"))
	if err != nil {
		t.Fatal(err)
	}
	encrypted, nonce, err := cipher.Encrypt(
		[]byte("user-access-token"),
		githubUserTokenAssociatedData("user-1", 7, "access"),
	)
	if err != nil {
		t.Fatal(err)
	}
	expiresAt := now.Add(time.Hour)
	store := &githubUserTestStore{
		fakeGitHubStore: &fakeGitHubStore{},
		connection: clouddomain.GitHubUserConnection{
			UserID:               "user-1",
			GitHubUserID:         7,
			GitHubLogin:          "amoreX",
			AccessTokenEncrypted: encrypted,
			AccessTokenNonce:     nonce,
			AccessTokenExpiresAt: &expiresAt,
			Status:               "active",
			LastSyncedAt:         now,
		},
	}
	client := &fakeGitHubUserClient{
		installations: []cloudgithubapp.Installation{
			{
				ID:                  41,
				Account:             cloudgithubapp.Account{Login: "amoreX", Type: "User"},
				RepositorySelection: "all",
				Permissions:         map[string]string{"administration": "write"},
			},
			{
				ID:                  42,
				Account:             cloudgithubapp.Account{Login: "aoagents", Type: "Organization"},
				RepositorySelection: "selected",
				Permissions:         map[string]string{"administration": "write"},
			},
		},
	}
	server := &Server{
		githubStore:  store,
		secretCipher: cipher,
		githubApp: &githubAppRuntime{
			clientID:        "client-id",
			clientSecret:    "client-secret",
			userCallbackURL: "https://cloud.example/api/cloud/v1/github/user/callback",
			userClient:      client,
			now:             func() time.Time { return now },
		},
	}
	request := httptest.NewRequest(http.MethodGet, "/github/user", nil)
	request = request.WithContext(cloudauth.ContextWithPrincipal(
		request.Context(),
		cloudauth.Principal{UserID: "user-1"},
	))
	recorder := httptest.NewRecorder()
	server.getGitHubUser(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	var response githubUserConnectionResponse
	if err := json.NewDecoder(recorder.Body).Decode(&response); err != nil {
		t.Fatal(err)
	}
	if !response.Connected || response.Login != "amoreX" ||
		len(response.Installations) != 2 ||
		!response.Installations[0].CanCreateRepository ||
		response.Installations[1].CanCreateRepository {
		t.Fatalf("response = %#v", response)
	}
}

type githubUserTestStore struct {
	*fakeGitHubStore
	attempt    clouddomain.GitHubUserAuthAttempt
	connection clouddomain.GitHubUserConnection
}

func (s *githubUserTestStore) CreateGitHubUserAuthAttempt(
	_ context.Context,
	userID clouddomain.UserID,
	stateHash, verifierEncrypted, verifierNonce []byte,
	ttl time.Duration,
) (clouddomain.GitHubUserAuthAttempt, error) {
	s.attempt = clouddomain.GitHubUserAuthAttempt{
		ID:                    "attempt-1",
		UserID:                userID,
		StateHash:             append([]byte(nil), stateHash...),
		CodeVerifierEncrypted: append([]byte(nil), verifierEncrypted...),
		CodeVerifierNonce:     append([]byte(nil), verifierNonce...),
		ExpiresAt:             time.Now().Add(ttl),
	}
	return s.attempt, nil
}

func (s *githubUserTestStore) GitHubUserConnection(
	context.Context,
	clouddomain.UserID,
) (clouddomain.GitHubUserConnection, error) {
	return s.connection, nil
}

type fakeGitHubUserClient struct {
	state         string
	challenge     string
	installations []cloudgithubapp.Installation
}

func (c *fakeGitHubUserClient) UserAuthorizationURL(
	_, _, state, challenge string,
) (string, error) {
	c.state = state
	c.challenge = challenge
	return "https://github.example/authorize?state=" + url.QueryEscape(state), nil
}

func (*fakeGitHubUserClient) ExchangeUserCode(context.Context, string, string, string, string, string) (cloudgithubapp.UserAccessToken, error) {
	return cloudgithubapp.UserAccessToken{}, nil
}

func (*fakeGitHubUserClient) RefreshUserAccessToken(context.Context, string, string, string) (cloudgithubapp.UserAccessToken, error) {
	return cloudgithubapp.UserAccessToken{}, nil
}

func (*fakeGitHubUserClient) GetUser(context.Context, string) (cloudgithubapp.User, error) {
	return cloudgithubapp.User{}, nil
}

func (c *fakeGitHubUserClient) ListUserInstallations(context.Context, string) ([]cloudgithubapp.Installation, error) {
	return append([]cloudgithubapp.Installation(nil), c.installations...), nil
}

func (*fakeGitHubUserClient) RevokeUserAuthorization(context.Context, string, string, string) error {
	return nil
}

func (*fakeGitHubUserClient) CreateRepositoryAsUser(context.Context, string, string, string, string, bool) (cloudgithubapp.Repository, error) {
	return cloudgithubapp.Repository{}, nil
}

func (*fakeGitHubUserClient) DeleteRepositoryAsUser(context.Context, string, string, string) error {
	return nil
}

var _ GitHubUserClient = (*fakeGitHubUserClient)(nil)
var _ githubStore = (*githubUserTestStore)(nil)
