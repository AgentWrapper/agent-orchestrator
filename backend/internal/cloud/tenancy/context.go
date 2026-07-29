// Package tenancy carries cloud actor and organization scope through the
// existing daemon services without changing their public method signatures.
package tenancy

import (
	"context"
	"fmt"
)

type contextKey struct{}

// Scope is the authenticated cloud request scope.
type Scope struct {
	UserID string
	OrgID  string
}

// WithScope returns a child context scoped to one authenticated user/org pair.
func WithScope(ctx context.Context, scope Scope) context.Context {
	return context.WithValue(ctx, contextKey{}, scope)
}

// ScopeFromContext returns the cloud scope on ctx.
func ScopeFromContext(ctx context.Context) (Scope, bool) {
	scope, ok := ctx.Value(contextKey{}).(Scope)
	return scope, ok
}

// OrgIDFromContext returns the current org id or an error suitable for store
// methods that must never accidentally run unscoped in the control plane.
func OrgIDFromContext(ctx context.Context) (string, error) {
	scope, ok := ScopeFromContext(ctx)
	if !ok || scope.OrgID == "" {
		return "", fmt.Errorf("cloud tenant scope missing from context")
	}
	return scope.OrgID, nil
}
