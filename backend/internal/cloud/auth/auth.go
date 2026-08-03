// Package auth defines the AO Cloud authentication boundary.
package auth

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
)

// Principal identifies an authenticated AO Cloud user.
type Principal struct {
	UserID         string
	AuthProvider   string
	ExternalUserID string
	Email          string
	DisplayName    string
	AccessToken    string
}

// Authenticator authenticates API requests and stores their principal in context.
type Authenticator interface {
	Middleware(http.Handler) http.Handler
}

type contextKey struct{}

// PrincipalFromContext returns the authenticated principal stored in ctx.
func PrincipalFromContext(ctx context.Context) (Principal, bool) {
	principal, ok := ctx.Value(contextKey{}).(Principal)
	return principal, ok
}

// ContextWithPrincipal stores principal on ctx.
func ContextWithPrincipal(ctx context.Context, principal Principal) context.Context {
	return context.WithValue(ctx, contextKey{}, principal)
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
