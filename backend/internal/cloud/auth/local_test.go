package auth

import (
	"context"
	"errors"
	"testing"
	"time"

	clouddomain "github.com/aoagents/agent-orchestrator/backend/internal/cloud/domain"
	cloudpostgres "github.com/aoagents/agent-orchestrator/backend/internal/cloud/postgres"
)

type fakeLocalStore struct {
	users    map[string]clouddomain.LocalUser
	sessions map[string]string
}

func newFakeLocalStore() *fakeLocalStore {
	return &fakeLocalStore{
		users:    make(map[string]clouddomain.LocalUser),
		sessions: make(map[string]string),
	}
}

func (s *fakeLocalStore) CreateLocalUser(
	_ context.Context,
	email, displayName, passwordHash string,
) (clouddomain.LocalUser, error) {
	if _, exists := s.users[email]; exists {
		return clouddomain.LocalUser{}, cloudpostgres.ErrLocalUserExists
	}
	user := clouddomain.LocalUser{
		ID:           "11111111-1111-4111-8111-111111111111",
		Email:        email,
		DisplayName:  displayName,
		PasswordHash: passwordHash,
	}
	s.users[email] = user
	return user, nil
}

func (s *fakeLocalStore) LocalUserByEmail(_ context.Context, email string) (clouddomain.LocalUser, error) {
	user, ok := s.users[email]
	if !ok {
		return clouddomain.LocalUser{}, cloudpostgres.ErrLocalUserNotFound
	}
	return user, nil
}

func (s *fakeLocalStore) CreateLocalSession(
	_ context.Context,
	userID string,
	hash []byte,
	expiresAt time.Time,
) error {
	if expiresAt.Before(time.Now()) {
		return errors.New("session is already expired")
	}
	s.sessions[string(hash)] = userID
	return nil
}

func (s *fakeLocalStore) LocalUserBySessionTokenHash(_ context.Context, hash []byte) (clouddomain.LocalUser, error) {
	userID, ok := s.sessions[string(hash)]
	if !ok {
		return clouddomain.LocalUser{}, cloudpostgres.ErrLocalSessionNotFound
	}
	for _, user := range s.users {
		if user.ID == userID {
			return user, nil
		}
	}
	return clouddomain.LocalUser{}, cloudpostgres.ErrLocalSessionNotFound
}

func (s *fakeLocalStore) DeleteLocalSession(_ context.Context, hash []byte) error {
	delete(s.sessions, string(hash))
	return nil
}

func TestLocalAuthenticatorSignUpLoginAndLogout(t *testing.T) {
	t.Parallel()
	authenticator := NewLocalAuthenticator(newFakeLocalStore())

	signedUp, err := authenticator.SignUp(context.Background(), " Person@Example.com ", "correct-horse", "Person")
	if err != nil {
		t.Fatalf("SignUp() error = %v", err)
	}
	if signedUp.Email != "person@example.com" || signedUp.AccessToken == "" {
		t.Fatalf("SignUp() principal = %#v", signedUp)
	}
	if _, err := authenticator.Verify(context.Background(), signedUp.AccessToken); err != nil {
		t.Fatalf("Verify() error = %v", err)
	}
	if err := authenticator.Logout(context.Background(), signedUp.AccessToken); err != nil {
		t.Fatalf("Logout() error = %v", err)
	}
	if _, err := authenticator.Verify(context.Background(), signedUp.AccessToken); !errors.Is(err, ErrUnauthenticated) {
		t.Fatalf("Verify() after Logout error = %v, want unauthenticated", err)
	}

	loggedIn, err := authenticator.Login(context.Background(), "person@example.com", "correct-horse")
	if err != nil {
		t.Fatalf("Login() error = %v", err)
	}
	if loggedIn.AccessToken == signedUp.AccessToken {
		t.Fatal("Login() reused an opaque session token")
	}
	if _, err := authenticator.Login(context.Background(), "person@example.com", "wrong-password"); !errors.Is(err, ErrUnauthenticated) {
		t.Fatalf("Login() with bad password error = %v, want unauthenticated", err)
	}
}

func TestLocalAuthenticatorRejectsInvalidSignup(t *testing.T) {
	t.Parallel()
	authenticator := NewLocalAuthenticator(newFakeLocalStore())
	if _, err := authenticator.SignUp(context.Background(), "invalid", "short", ""); err == nil {
		t.Fatal("SignUp() error = nil, want validation failure")
	}
}
