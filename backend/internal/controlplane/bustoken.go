package controlplane

import (
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// BusTokenSigner mints and verifies short-lived, sandbox-scoped bus tokens.
//
// A cloud sandbox gets one of these so its in-sandbox daemon can reach the bus
// endpoints (register/route/event) for its OWN tenant — without ever holding the
// user's Clerk credential or any master key. It is HS256 over a secret sourced
// from Key Vault (AO_BUS_SIGNING_KEY); the control plane both signs and verifies,
// so it stays stateless across restarts. The token carries scope:"bus", so the
// user-only endpoints (spawn/terminate/list) still reject it — a leaked sandbox
// token can't provision or tear down anything.
type BusTokenSigner struct {
	secret []byte
	ttl    time.Duration
}

// NewBusTokenSigner returns a signer, or nil when no secret is configured — in
// which case bus tokens can't be minted or verified and sandboxes simply get no
// outbound channel. A safe, explicit default rather than a silent weak key.
func NewBusTokenSigner(secret string, ttl time.Duration) *BusTokenSigner {
	secret = strings.TrimSpace(secret)
	if secret == "" {
		return nil
	}
	if ttl <= 0 {
		ttl = 12 * time.Hour
	}
	return &BusTokenSigner{secret: []byte(secret), ttl: ttl}
}

type busClaims struct {
	Tenant  string `json:"tenant"`
	Sandbox string `json:"sandbox"`
	Scope   string `json:"scope"`
	jwt.RegisteredClaims
}

// mint issues a token scoped to {tenant, sandbox}. now is a parameter for
// deterministic tests; MintForSandbox passes time.Now().
func (s *BusTokenSigner) mint(tenant, sandbox string, now time.Time) (string, error) {
	if s == nil {
		return "", errors.New("bus token signing not configured")
	}
	if tenant == "" {
		return "", errors.New("bus token needs a tenant")
	}
	claims := busClaims{
		Tenant:  tenant,
		Sandbox: sandbox,
		Scope:   "bus",
		RegisteredClaims: jwt.RegisteredClaims{
			IssuedAt:  jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(now.Add(s.ttl)),
		},
	}
	return jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString(s.secret)
}

// MintForSandbox issues a bus token for a sandbox's in-sandbox daemon.
func (s *BusTokenSigner) MintForSandbox(tenant, sandbox string) (string, error) {
	return s.mint(tenant, sandbox, time.Now())
}

// Verify checks a bus token and returns its tenant + sandbox scope. Errors on a
// bad signature, expiry, wrong algorithm, or a non-bus scope.
func (s *BusTokenSigner) Verify(token string) (tenant, sandbox string, err error) {
	if s == nil {
		return "", "", errors.New("bus token signing not configured")
	}
	if strings.TrimSpace(token) == "" {
		return "", "", errors.New("empty token")
	}
	var claims busClaims
	parsed, err := jwt.ParseWithClaims(token, &claims, func(t *jwt.Token) (any, error) {
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, fmt.Errorf("unexpected signing method %v", t.Header["alg"])
		}
		return s.secret, nil
	})
	if err != nil {
		return "", "", err
	}
	if !parsed.Valid || claims.Scope != "bus" || claims.Tenant == "" {
		return "", "", errors.New("invalid bus token")
	}
	return claims.Tenant, claims.Sandbox, nil
}
