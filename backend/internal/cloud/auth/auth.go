// Package auth verifies Supabase access tokens at the cloud trust boundary.
// The configured project currently uses HS256, so verification is delegated to
// Supabase Auth's /user endpoint rather than copying the legacy signing secret
// into request middleware.
package auth

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// Principal identifies an authenticated AO Cloud user.
type Principal struct {
	UserID      string
	Email       string
	DisplayName string
	AccessToken string
}

type contextKey struct{}

// PrincipalFromContext returns the authenticated principal stored in ctx.
func PrincipalFromContext(ctx context.Context) (Principal, bool) {
	principal, ok := ctx.Value(contextKey{}).(Principal)
	return principal, ok
}

// Verifier validates Supabase access tokens.
type Verifier struct {
	baseURL string
	anonKey string
	client  *http.Client
}

// NewVerifier creates a Supabase access-token verifier.
func NewVerifier(baseURL, anonKey string, client *http.Client) *Verifier {
	if client == nil {
		client = &http.Client{Timeout: 10 * time.Second}
	}
	return &Verifier{
		baseURL: strings.TrimRight(baseURL, "/"),
		anonKey: anonKey,
		client:  client,
	}
}

// Verify validates an access token and returns its user principal.
func (v *Verifier) Verify(ctx context.Context, accessToken string) (Principal, error) {
	if strings.TrimSpace(accessToken) == "" {
		return Principal{}, ErrUnauthenticated
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, v.baseURL+"/auth/v1/user", http.NoBody)
	if err != nil {
		return Principal{}, fmt.Errorf("build Supabase user request: %w", err)
	}
	req.Header.Set("apikey", v.anonKey)
	req.Header.Set("Authorization", "Bearer "+accessToken)
	response, err := v.client.Do(req)
	if err != nil {
		return Principal{}, fmt.Errorf("verify Supabase access token: %w", err)
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode == http.StatusUnauthorized || response.StatusCode == http.StatusForbidden {
		_, _ = io.Copy(io.Discard, response.Body)
		return Principal{}, ErrUnauthenticated
	}
	if response.StatusCode != http.StatusOK {
		_, _ = io.Copy(io.Discard, response.Body)
		return Principal{}, fmt.Errorf("supabase Auth returned %s", response.Status)
	}
	var user struct {
		ID           string         `json:"id"`
		Email        string         `json:"email"`
		UserMetadata map[string]any `json:"user_metadata"`
	}
	decoder := json.NewDecoder(io.LimitReader(response.Body, 1<<20))
	if err := decoder.Decode(&user); err != nil {
		return Principal{}, fmt.Errorf("decode Supabase user: %w", err)
	}
	if user.ID == "" {
		return Principal{}, ErrUnauthenticated
	}
	displayName, _ := user.UserMetadata["full_name"].(string)
	if displayName == "" {
		displayName, _ = user.UserMetadata["name"].(string)
	}
	if displayName == "" {
		displayName = user.Email
	}
	return Principal{
		UserID:      user.ID,
		Email:       user.Email,
		DisplayName: displayName,
		AccessToken: accessToken,
	}, nil
}

// Middleware requires a valid bearer token and adds its principal to the request.
func (v *Verifier) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		token, ok := bearerToken(r.Header.Get("Authorization"))
		if !ok {
			writeUnauthorized(w)
			return
		}
		principal, err := v.Verify(r.Context(), token)
		if err != nil {
			writeUnauthorized(w)
			return
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), contextKey{}, principal)))
	})
}

func bearerToken(header string) (string, bool) {
	scheme, token, ok := strings.Cut(strings.TrimSpace(header), " ")
	return token, ok && strings.EqualFold(scheme, "Bearer") && strings.TrimSpace(token) != ""
}

func writeUnauthorized(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(http.StatusUnauthorized)
	_ = json.NewEncoder(w).Encode(map[string]string{
		"error":   "unauthorized",
		"code":    "AUTH_REQUIRED",
		"message": "A valid AO Cloud login is required.",
	})
}

// ErrUnauthenticated indicates that a valid user identity was not provided.
var ErrUnauthenticated = errors.New("unauthenticated")
