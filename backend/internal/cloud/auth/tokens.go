// Package auth implements AO Cloud's v1 identity primitives: Google-backed
// login produces short-lived access JWTs plus server-stored refresh tokens.
package auth

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/tenancy"
)

const (
	defaultAccessTTL  = 15 * time.Minute
	defaultRefreshTTL = 30 * 24 * time.Hour
	defaultAudience   = "ao-cloud"
)

var errInvalidToken = errors.New("invalid token")

// Issuer signs and verifies AO Cloud access tokens.
type Issuer struct {
	secret     []byte
	issuer     string
	audience   string
	accessTTL  time.Duration
	refreshTTL time.Duration
	now        func() time.Time
}

// IssuerConfig configures token issuance.
type IssuerConfig struct {
	Secret     string
	Issuer     string
	Audience   string
	AccessTTL  time.Duration
	RefreshTTL time.Duration
	Now        func() time.Time
}

// NewIssuer returns a JWT issuer. Secret must be a high-entropy deployment
// secret; local dev can set AO_CLOUD_JWT_SECRET.
func NewIssuer(cfg IssuerConfig) (*Issuer, error) {
	if strings.TrimSpace(cfg.Secret) == "" {
		return nil, fmt.Errorf("jwt secret is required")
	}
	i := &Issuer{
		secret:     []byte(cfg.Secret),
		issuer:     cfg.Issuer,
		audience:   cfg.Audience,
		accessTTL:  cfg.AccessTTL,
		refreshTTL: cfg.RefreshTTL,
		now:        cfg.Now,
	}
	if i.issuer == "" {
		i.issuer = "ao-cloud"
	}
	if i.audience == "" {
		i.audience = defaultAudience
	}
	if i.accessTTL <= 0 {
		i.accessTTL = defaultAccessTTL
	}
	if i.refreshTTL <= 0 {
		i.refreshTTL = defaultRefreshTTL
	}
	if i.now == nil {
		i.now = time.Now
	}
	return i, nil
}

// TokenPair is returned after initial auth or refresh.
type TokenPair struct {
	AccessToken  string
	RefreshToken string
	ExpiresAt    time.Time
}

// Issue signs an access token and mints an opaque refresh token.
func (i *Issuer) Issue(subject string, orgIDs []string) (TokenPair, error) {
	now := i.now().UTC()
	expires := now.Add(i.accessTTL)
	access, err := i.sign(jwtClaims{
		Issuer:   i.issuer,
		Audience: i.audience,
		Subject:  subject,
		OrgIDs:   orgIDs,
		Issued:   now.Unix(),
		Expires:  expires.Unix(),
	})
	if err != nil {
		return TokenPair{}, err
	}
	refresh, err := randomToken(32)
	if err != nil {
		return TokenPair{}, err
	}
	return TokenPair{AccessToken: access, RefreshToken: refresh, ExpiresAt: expires}, nil
}

// VerifyAccessToken implements tenancy.TokenVerifier.
func (i *Issuer) VerifyAccessToken(token string) (tenancy.Claims, error) {
	claims, err := i.verify(token)
	if err != nil {
		return tenancy.Claims{}, err
	}
	if claims.Expires <= i.now().UTC().Unix() {
		return tenancy.Claims{}, errInvalidToken
	}
	if claims.Audience != i.audience {
		return tenancy.Claims{}, errInvalidToken
	}
	if claims.Subject == "" || len(claims.OrgIDs) == 0 {
		return tenancy.Claims{}, errInvalidToken
	}
	return tenancy.Claims{Subject: claims.Subject, OrgIDs: claims.OrgIDs}, nil
}

// RefreshTokenTTL is how long newly issued refresh tokens remain valid.
func (i *Issuer) RefreshTokenTTL() time.Duration { return i.refreshTTL }

type jwtClaims struct {
	Issuer   string   `json:"iss"`
	Audience string   `json:"aud"`
	Subject  string   `json:"sub"`
	OrgIDs   []string `json:"orgs"`
	Issued   int64    `json:"iat"`
	Expires  int64    `json:"exp"`
}

func (i *Issuer) sign(claims jwtClaims) (string, error) {
	header, err := json.Marshal(map[string]string{"alg": "HS256", "typ": "JWT"})
	if err != nil {
		return "", err
	}
	payload, err := json.Marshal(claims)
	if err != nil {
		return "", err
	}
	unsigned := b64(header) + "." + b64(payload)
	sig := i.signature(unsigned)
	return unsigned + "." + b64(sig), nil
}

func (i *Issuer) verify(token string) (jwtClaims, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return jwtClaims{}, errInvalidToken
	}
	unsigned := parts[0] + "." + parts[1]
	sig, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		return jwtClaims{}, errInvalidToken
	}
	if !hmac.Equal(sig, i.signature(unsigned)) {
		return jwtClaims{}, errInvalidToken
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return jwtClaims{}, errInvalidToken
	}
	var claims jwtClaims
	if err := json.Unmarshal(payload, &claims); err != nil {
		return jwtClaims{}, errInvalidToken
	}
	if claims.Issuer != i.issuer {
		return jwtClaims{}, errInvalidToken
	}
	return claims, nil
}

func (i *Issuer) signature(unsigned string) []byte {
	mac := hmac.New(sha256.New, i.secret)
	_, _ = mac.Write([]byte(unsigned))
	return mac.Sum(nil)
}

func b64(in []byte) string {
	return base64.RawURLEncoding.EncodeToString(in)
}

func randomToken(n int) (string, error) {
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

// HashRefreshToken returns the server-side token digest stored in api_tokens.
func HashRefreshToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

// Store is the auth persistence surface used by handlers.
type Store interface {
	UpsertGoogleUser(ctx context.Context, profile GoogleProfile) (User, []Org, error)
	StoreRefreshToken(ctx context.Context, token APIToken) error
	ConsumeRefreshToken(ctx context.Context, tokenHash string, now time.Time) (User, []Org, bool, error)
	CreateDeviceCode(ctx context.Context, code DeviceCode) error
	ApproveDeviceCode(ctx context.Context, userID, userCode string, now time.Time) (bool, error)
	PollDeviceCode(ctx context.Context, deviceCodeHash string, now time.Time) (DeviceCode, User, []Org, bool, error)
}

// User is the cloud identity persisted after Google login.
type User struct {
	ID    string
	Email string
}

// Org is an organization the authenticated user can access.
type Org struct {
	ID   string
	Name string
}

// APIToken is a stored opaque token digest, including refresh tokens.
type APIToken struct {
	ID        string
	UserID    string
	TokenHash string
	Kind      string
	ExpiresAt time.Time
	CreatedAt time.Time
}

// DeviceCode is the server-side state for CLI/desktop device authorization.
type DeviceCode struct {
	ID             string
	DeviceCodeHash string
	UserCode       string
	ClientName     string
	ExpiresAt      time.Time
	ApprovedUserID string
	ApprovedAt     time.Time
	ConsumedAt     time.Time
	CreatedAt      time.Time
}
