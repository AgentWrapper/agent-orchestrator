package auth

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/lestrrat-go/jwx/v3/jwk"
	"github.com/lestrrat-go/jwx/v3/jwt"
)

const externalJWKSCacheTTL = 5 * time.Minute

// ExternalJWTConfig configures an external OIDC/JWKS-style auth provider.
type ExternalJWTConfig struct {
	Provider string
	Issuer   string
	Audience string
	JWKSURL  string
	Client   *http.Client
}

// ExternalJWTAuthenticator validates signed external JWTs and returns AO principals.
type ExternalJWTAuthenticator struct {
	provider string
	issuer   string
	audience string
	jwksURL  string
	client   *http.Client

	mu           sync.Mutex
	cachedKeySet jwk.Set
	cachedUntil  time.Time
}

// NewExternalJWTAuthenticator creates an authenticator backed by a configured JWKS endpoint.
func NewExternalJWTAuthenticator(cfg ExternalJWTConfig) (*ExternalJWTAuthenticator, error) {
	provider := strings.TrimSpace(cfg.Provider)
	if provider == "" {
		provider = "external"
	}
	issuer := strings.TrimRight(strings.TrimSpace(cfg.Issuer), "/")
	audience := strings.TrimSpace(cfg.Audience)
	if audience == "" {
		audience = issuer
	}
	jwksURL := strings.TrimSpace(cfg.JWKSURL)
	if issuer == "" || audience == "" || jwksURL == "" {
		return nil, fmt.Errorf("external auth requires issuer, audience, and JWKS URL")
	}
	client := cfg.Client
	if client == nil {
		client = http.DefaultClient
	}
	return &ExternalJWTAuthenticator{
		provider: provider,
		issuer:   issuer,
		audience: audience,
		jwksURL:  jwksURL,
		client:   client,
	}, nil
}

// Verify validates a bearer JWT and extracts an external user principal.
func (a *ExternalJWTAuthenticator) Verify(ctx context.Context, token string) (Principal, error) {
	if strings.TrimSpace(token) == "" {
		return Principal{}, ErrUnauthenticated
	}
	parsed, err := a.parse(ctx, token)
	if err != nil {
		a.clearCachedKeySet()
		parsed, err = a.parse(ctx, token)
	}
	if err != nil {
		return Principal{}, ErrUnauthenticated
	}
	subject, ok := parsed.Subject()
	if !ok || strings.TrimSpace(subject) == "" {
		return Principal{}, ErrUnauthenticated
	}
	email := stringClaim(parsed, "email")
	displayName := firstNonEmpty(
		stringClaim(parsed, "name"),
		stringClaim(parsed, "displayName"),
		email,
		subject,
	)
	return Principal{
		AuthProvider:   a.provider,
		ExternalUserID: subject,
		Email:          strings.ToLower(strings.TrimSpace(email)),
		DisplayName:    strings.TrimSpace(displayName),
		AccessToken:    token,
	}, nil
}

// Middleware requires a valid external bearer JWT and adds its principal.
func (a *ExternalJWTAuthenticator) Middleware(next http.Handler) http.Handler {
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
		next.ServeHTTP(w, r.WithContext(ContextWithPrincipal(r.Context(), principal)))
	})
}

func (a *ExternalJWTAuthenticator) parse(ctx context.Context, token string) (jwt.Token, error) {
	keySet, err := a.keySet(ctx)
	if err != nil {
		return nil, err
	}
	return jwt.Parse(
		[]byte(token),
		jwt.WithKeySet(keySet),
		jwt.WithIssuer(a.issuer),
		jwt.WithAudience(a.audience),
	)
}

func (a *ExternalJWTAuthenticator) keySet(ctx context.Context) (jwk.Set, error) {
	now := time.Now()
	a.mu.Lock()
	if a.cachedKeySet != nil && now.Before(a.cachedUntil) {
		keySet := a.cachedKeySet
		a.mu.Unlock()
		return keySet, nil
	}
	a.mu.Unlock()

	keySet, err := jwk.Fetch(ctx, a.jwksURL, jwk.WithHTTPClient(a.client))
	if err != nil {
		return nil, fmt.Errorf("fetch external auth JWKS: %w", err)
	}

	a.mu.Lock()
	a.cachedKeySet = keySet
	a.cachedUntil = now.Add(externalJWKSCacheTTL)
	a.mu.Unlock()
	return keySet, nil
}

func (a *ExternalJWTAuthenticator) clearCachedKeySet() {
	a.mu.Lock()
	a.cachedKeySet = nil
	a.cachedUntil = time.Time{}
	a.mu.Unlock()
}

func stringClaim(token jwt.Token, name string) string {
	var value string
	if err := token.Get(name, &value); err != nil {
		return ""
	}
	return strings.TrimSpace(value)
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}
