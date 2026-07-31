package httpapi

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	cloudauth "github.com/aoagents/agent-orchestrator/backend/internal/cloud/auth"
	clouddomain "github.com/aoagents/agent-orchestrator/backend/internal/cloud/domain"
	cloudpostgres "github.com/aoagents/agent-orchestrator/backend/internal/cloud/postgres"
)

type localAuthStore struct {
	user     clouddomain.LocalUser
	sessions map[string]string
}

func (s *localAuthStore) CreateLocalUser(
	_ context.Context,
	email, displayName, passwordHash string,
) (clouddomain.LocalUser, error) {
	if s.user.ID != "" {
		return clouddomain.LocalUser{}, cloudpostgres.ErrLocalUserExists
	}
	s.user = clouddomain.LocalUser{
		ID:           "11111111-1111-4111-8111-111111111111",
		Email:        email,
		DisplayName:  displayName,
		PasswordHash: passwordHash,
	}
	return s.user, nil
}

func (s *localAuthStore) LocalUserByEmail(_ context.Context, email string) (clouddomain.LocalUser, error) {
	if s.user.ID == "" || s.user.Email != email {
		return clouddomain.LocalUser{}, cloudpostgres.ErrLocalUserNotFound
	}
	return s.user, nil
}

func (s *localAuthStore) CreateLocalSession(
	_ context.Context,
	userID string,
	tokenHash []byte,
	_ time.Time,
) error {
	if s.sessions == nil {
		s.sessions = make(map[string]string)
	}
	s.sessions[string(tokenHash)] = userID
	return nil
}

func (s *localAuthStore) LocalUserBySessionTokenHash(_ context.Context, tokenHash []byte) (clouddomain.LocalUser, error) {
	if s.sessions[string(tokenHash)] != s.user.ID {
		return clouddomain.LocalUser{}, cloudpostgres.ErrLocalSessionNotFound
	}
	return s.user, nil
}

func (s *localAuthStore) DeleteLocalSession(_ context.Context, tokenHash []byte) error {
	delete(s.sessions, string(tokenHash))
	return nil
}

func TestLocalAuthRoutesIssueAndRevokeBearerToken(t *testing.T) {
	t.Parallel()
	authenticator := cloudauth.NewLocalAuthenticator(&localAuthStore{})
	server := &Server{
		auth:      authenticator,
		localAuth: authenticator,
		log:       slog.Default(),
	}
	handler := server.routes()

	signup := httptest.NewRequest(
		http.MethodPost,
		"/api/cloud/v1/auth/signup",
		strings.NewReader(`{"email":"person@example.com","password":"correct-horse","displayName":"Person"}`),
	)
	signup.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, signup)
	if response.Code != http.StatusCreated {
		t.Fatalf("signup status = %d, want %d: %s", response.Code, http.StatusCreated, response.Body.String())
	}
	var body struct {
		AccessToken string `json:"accessToken"`
	}
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
		t.Fatalf("decode signup response: %v", err)
	}
	if body.AccessToken == "" {
		t.Fatal("signup response omitted accessToken")
	}

	logout := httptest.NewRequest(http.MethodPost, "/api/cloud/v1/auth/logout", nil)
	logout.Header.Set("Authorization", "Bearer "+body.AccessToken)
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, logout)
	if response.Code != http.StatusNoContent {
		t.Fatalf("logout status = %d, want %d", response.Code, http.StatusNoContent)
	}

	logout = httptest.NewRequest(http.MethodPost, "/api/cloud/v1/auth/logout", nil)
	logout.Header.Set("Authorization", "Bearer "+body.AccessToken)
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, logout)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("revoked token status = %d, want %d", response.Code, http.StatusUnauthorized)
	}
}
