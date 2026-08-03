package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"net/http"
	"net/mail"
	"strings"
	"time"

	"golang.org/x/crypto/bcrypt"

	clouddomain "github.com/aoagents/agent-orchestrator/backend/internal/cloud/domain"
	cloudpostgres "github.com/aoagents/agent-orchestrator/backend/internal/cloud/postgres"
)

const localSessionTTL = 30 * 24 * time.Hour

// LocalStore persists the identities and opaque sessions used by local auth.
type LocalStore interface {
	CreateLocalUser(context.Context, string, string, string) (clouddomain.LocalUser, error)
	LocalUserByEmail(context.Context, string) (clouddomain.LocalUser, error)
	CreateLocalSession(context.Context, string, []byte, time.Time) error
	LocalUserBySessionTokenHash(context.Context, []byte) (clouddomain.LocalUser, error)
	DeleteLocalSession(context.Context, []byte) error
}

// LocalAuthenticator provides database-backed email/password authentication.
type LocalAuthenticator struct {
	store      LocalStore
	sessionTTL time.Duration
	now        func() time.Time
}

// NewLocalAuthenticator creates local email/password authentication.
func NewLocalAuthenticator(store LocalStore) *LocalAuthenticator {
	return &LocalAuthenticator{
		store:      store,
		sessionTTL: localSessionTTL,
		now:        time.Now,
	}
}

// SignUp creates a local user and returns a new opaque bearer token.
func (a *LocalAuthenticator) SignUp(
	ctx context.Context,
	email, password, displayName string,
) (Principal, error) {
	email, err := normalizeEmail(email)
	if err != nil {
		return Principal{}, err
	}
	if err := validatePassword(password); err != nil {
		return Principal{}, err
	}
	displayName = strings.TrimSpace(displayName)
	if displayName == "" {
		displayName = email
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return Principal{}, fmt.Errorf("hash local password: %w", err)
	}
	user, err := a.store.CreateLocalUser(ctx, email, displayName, string(hash))
	if err != nil {
		return Principal{}, err
	}
	return a.createSession(ctx, user)
}

// Login verifies a local password and returns a new opaque bearer token.
func (a *LocalAuthenticator) Login(ctx context.Context, email, password string) (Principal, error) {
	email, err := normalizeEmail(email)
	if err != nil {
		return Principal{}, ErrUnauthenticated
	}
	user, err := a.store.LocalUserByEmail(ctx, email)
	if err != nil {
		if errors.Is(err, cloudpostgres.ErrLocalUserNotFound) {
			return Principal{}, ErrUnauthenticated
		}
		return Principal{}, err
	}
	if bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(password)) != nil {
		return Principal{}, ErrUnauthenticated
	}
	return a.createSession(ctx, user)
}

// Verify validates an opaque local bearer session.
func (a *LocalAuthenticator) Verify(ctx context.Context, token string) (Principal, error) {
	if strings.TrimSpace(token) == "" {
		return Principal{}, ErrUnauthenticated
	}
	user, err := a.store.LocalUserBySessionTokenHash(ctx, tokenHash(token))
	if err != nil {
		if errors.Is(err, cloudpostgres.ErrLocalSessionNotFound) {
			return Principal{}, ErrUnauthenticated
		}
		return Principal{}, err
	}
	return principalForLocalUser(user, token), nil
}

// Logout invalidates the opaque bearer session token.
func (a *LocalAuthenticator) Logout(ctx context.Context, token string) error {
	if strings.TrimSpace(token) == "" {
		return ErrUnauthenticated
	}
	return a.store.DeleteLocalSession(ctx, tokenHash(token))
}

// Middleware requires a valid local bearer session and adds its principal.
func (a *LocalAuthenticator) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		token, ok := bearerToken(r.Header.Get("Authorization"))
		if !ok {
			writeUnauthorized(w)
			return
		}
		principal, err := a.Verify(r.Context(), token)
		if err != nil {
			writeUnauthorized(w)
			return
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), contextKey{}, principal)))
	})
}

func (a *LocalAuthenticator) createSession(ctx context.Context, user clouddomain.LocalUser) (Principal, error) {
	token, err := newOpaqueToken()
	if err != nil {
		return Principal{}, fmt.Errorf("generate local session token: %w", err)
	}
	if err := a.store.CreateLocalSession(ctx, user.ID, tokenHash(token), a.now().Add(a.sessionTTL)); err != nil {
		return Principal{}, err
	}
	return principalForLocalUser(user, token), nil
}

func principalForLocalUser(user clouddomain.LocalUser, token string) Principal {
	return Principal{
		UserID:         user.ID,
		AuthProvider:   "local",
		ExternalUserID: user.ID,
		Email:          user.Email,
		DisplayName:    user.DisplayName,
		AccessToken:    token,
	}
}

func normalizeEmail(value string) (string, error) {
	email := strings.ToLower(strings.TrimSpace(value))
	parsed, err := mail.ParseAddress(email)
	if err != nil || parsed.Address != email {
		return "", errors.New("a valid email address is required")
	}
	return email, nil
}

func validatePassword(password string) error {
	if len(password) < 8 || len(password) > 72 {
		return errors.New("password must be between 8 and 72 bytes")
	}
	return nil
}

func newOpaqueToken() (string, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(raw), nil
}

func tokenHash(token string) []byte {
	hash := sha256.Sum256([]byte(token))
	return hash[:]
}
