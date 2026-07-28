// Package controlplane is the hosted, multi-tenant service that fronts cloud
// sandbox provisioning. It authenticates a device (Clerk JWT), scopes every
// action to the caller's tenant, holds the single Daytona key, owns the
// cloud-session registry (SQL), and relays REST to sandboxes. Sandboxes still run
// on Daytona (our DaytonaClient) — the control plane is our software on our Azure,
// not the sandbox substrate.
package controlplane

import (
	"context"
	"fmt"
	"net/http"
	"strings"

	"github.com/MicahParks/keyfunc/v3"
	"github.com/golang-jwt/jwt/v5"
)

// tenantContextKey carries the authenticated tenant id through the request.
type tenantContextKey struct{}

// busScopeKey carries a bus token's sandbox scope. Empty for a full user token
// (which has authority over all of its tenant's sessions); set to the token's
// sandbox id for a per-sandbox bus token, which may only act for that sandbox.
type busScopeKey struct{}

// TenantFromContext returns the authenticated tenant id set by the auth
// middleware, or "" if none.
func TenantFromContext(ctx context.Context) string {
	if v, ok := ctx.Value(tenantContextKey{}).(string); ok {
		return v
	}
	return ""
}

// BusScopeFromContext returns the sandbox a bus token is scoped to, and whether
// the caller is a scoped bus token at all. (scoped=false ⇒ a full user token,
// unrestricted within its tenant.)
func BusScopeFromContext(ctx context.Context) (sandbox string, scoped bool) {
	v, ok := ctx.Value(busScopeKey{}).(string)
	return v, ok
}

// Authenticator resolves the tenant id for a request, or an error to reject it.
type Authenticator interface {
	Authenticate(r *http.Request) (tenantID string, err error)
}

// DevAuthenticator is the no-Clerk fallback for local dev/tests: it trusts an
// `X-AO-Tenant` header (default "dev-tenant"). NEVER use in production — it lets
// any caller claim any tenant. The service logs a loud warning when this is the
// active authenticator.
type DevAuthenticator struct{}

// Authenticate resolves the tenant from the `X-AO-Tenant` header, defaulting to "dev-tenant".
func (DevAuthenticator) Authenticate(r *http.Request) (string, error) {
	if t := strings.TrimSpace(r.Header.Get("X-AO-Tenant")); t != "" {
		return t, nil
	}
	return "dev-tenant", nil
}

// ClerkAuthenticator verifies a Clerk-issued RS256 JWT against Clerk's JWKS and
// derives the tenant id from the token. Tenant = the Clerk org id (`org_id`) when
// present (org/team), else the user id (`sub`) — so a solo user is their own
// tenant and an org is one shared tenant.
type ClerkAuthenticator struct {
	keys keyfunc.Keyfunc
	// issuer is the expected `iss` (Clerk Frontend API URL), verified when set.
	issuer string
}

// NewClerkAuthenticator builds a verifier from Clerk's JWKS URL (e.g.
// https://<your-app>.clerk.accounts.dev/.well-known/jwks.json). It fetches +
// caches the signing keys and refreshes them automatically.
func NewClerkAuthenticator(ctx context.Context, jwksURL, issuer string) (*ClerkAuthenticator, error) {
	if strings.TrimSpace(jwksURL) == "" {
		return nil, fmt.Errorf("controlplane: CLERK_JWKS_URL required for Clerk auth")
	}
	kf, err := keyfunc.NewDefaultCtx(ctx, []string{jwksURL})
	if err != nil {
		return nil, fmt.Errorf("controlplane: load Clerk JWKS: %w", err)
	}
	return &ClerkAuthenticator{keys: kf, issuer: strings.TrimSpace(issuer)}, nil
}

// Authenticate verifies the request's Clerk JWT and returns its tenant id.
func (c *ClerkAuthenticator) Authenticate(r *http.Request) (string, error) {
	raw := bearerToken(r)
	if raw == "" {
		return "", fmt.Errorf("missing bearer token")
	}
	opts := []jwt.ParserOption{jwt.WithValidMethods([]string{"RS256"}), jwt.WithExpirationRequired()}
	if c.issuer != "" {
		opts = append(opts, jwt.WithIssuer(c.issuer))
	}
	tok, err := jwt.Parse(raw, c.keys.Keyfunc, opts...)
	if err != nil || !tok.Valid {
		return "", fmt.Errorf("invalid token: %w", err)
	}
	claims, ok := tok.Claims.(jwt.MapClaims)
	if !ok {
		return "", fmt.Errorf("unexpected claims")
	}
	// Clerk leeway: reject tokens whose `nbf` is in the future beyond a small skew
	// is already handled by the parser; here we just pick the tenant.
	if org, _ := claims["org_id"].(string); strings.TrimSpace(org) != "" {
		return org, nil
	}
	if sub, _ := claims["sub"].(string); strings.TrimSpace(sub) != "" {
		return sub, nil
	}
	return "", fmt.Errorf("token has no org_id or sub")
}

func bearerToken(r *http.Request) string {
	h := r.Header.Get("Authorization")
	const p = "Bearer "
	if strings.HasPrefix(h, p) {
		return strings.TrimSpace(h[len(p):])
	}
	return ""
}

// authMiddleware authenticates each request and injects the tenant id, or 401s.
func authMiddleware(a Authenticator) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			tenant, err := a.Authenticate(r)
			if err != nil || tenant == "" {
				writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "unauthorized"})
				return
			}
			ctx := context.WithValue(r.Context(), tenantContextKey{}, tenant)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// busAuthMiddleware guards the federated-bus endpoints. It accepts either a full
// user token (a laptop daemon, via the normal authenticator) or a per-sandbox
// bus token (an in-sandbox daemon, via the signer). Both resolve to a tenant id
// injected into the context. Because it is mounted ONLY on the bus routes, a
// leaked sandbox token can never reach spawn/terminate/list.
func busAuthMiddleware(a Authenticator, signer *BusTokenSigner) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// Prefer a full user token (unrestricted within its tenant → no scope).
			if tenant, err := a.Authenticate(r); err == nil && tenant != "" {
				ctx := context.WithValue(r.Context(), tenantContextKey{}, tenant)
				next.ServeHTTP(w, r.WithContext(ctx))
				return
			}
			// Fall back to a per-sandbox bus token: carry its sandbox scope so
			// downstream handlers restrict it to acting for that sandbox only.
			if signer != nil {
				if tenant, sandbox, err := signer.Verify(bearerToken(r)); err == nil && tenant != "" {
					ctx := context.WithValue(r.Context(), tenantContextKey{}, tenant)
					ctx = context.WithValue(ctx, busScopeKey{}, sandbox)
					next.ServeHTTP(w, r.WithContext(ctx))
					return
				}
			}
			writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "unauthorized"})
		})
	}
}
