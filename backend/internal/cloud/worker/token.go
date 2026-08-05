// Package worker defines the authenticated protocol identity used by the
// lightweight process inside one cloud sandbox.
package worker

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	clouddomain "github.com/aoagents/agent-orchestrator/backend/internal/cloud/domain"
)

// Claims describes an authenticated cloud worker identity.
type Claims struct {
	AccountID clouddomain.AccountID `json:"accountId"`
	SessionID clouddomain.SessionID `json:"sessionId"`
	WorkerID  string                `json:"workerId"`
	Epoch     int64                 `json:"epoch"`
	ExpiresAt int64                 `json:"expiresAt"`
	Scopes    []string              `json:"scopes"`
}

// TokenManager issues and verifies signed worker tokens.
type TokenManager struct {
	key []byte
	now func() time.Time
}

// NewTokenManager creates a worker token manager with a copied signing key.
func NewTokenManager(key []byte) *TokenManager {
	copied := append([]byte(nil), key...)
	return &TokenManager{key: copied, now: time.Now}
}

// Issue signs claims with the requested lifetime.
func (m *TokenManager) Issue(claims Claims, ttl time.Duration) (string, error) {
	if claims.AccountID == "" || claims.SessionID == "" || claims.WorkerID == "" || claims.Epoch <= 0 {
		return "", errors.New("worker token claims are incomplete")
	}
	if ttl <= 0 {
		ttl = 15 * time.Minute
	}
	claims.ExpiresAt = m.now().Add(ttl).Unix()
	payload, err := json.Marshal(claims)
	if err != nil {
		return "", fmt.Errorf("encode worker claims: %w", err)
	}
	encoded := base64.RawURLEncoding.EncodeToString(payload)
	signature := m.sign(encoded)
	return "aow1." + encoded + "." + base64.RawURLEncoding.EncodeToString(signature), nil
}

// Verify validates a worker token and returns its claims.
func (m *TokenManager) Verify(token string) (Claims, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 || parts[0] != "aow1" {
		return Claims{}, ErrInvalidToken
	}
	signature, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil || !hmac.Equal(signature, m.sign(parts[1])) {
		return Claims{}, ErrInvalidToken
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return Claims{}, ErrInvalidToken
	}
	var claims Claims
	if err := json.Unmarshal(payload, &claims); err != nil {
		return Claims{}, ErrInvalidToken
	}
	if claims.ExpiresAt <= m.now().Unix() ||
		claims.AccountID == "" ||
		claims.SessionID == "" ||
		claims.WorkerID == "" ||
		claims.Epoch <= 0 {
		return Claims{}, ErrInvalidToken
	}
	return claims, nil
}

func (m *TokenManager) sign(encodedPayload string) []byte {
	mac := hmac.New(sha256.New, m.key)
	_, _ = mac.Write([]byte("aow1."))
	_, _ = mac.Write([]byte(encodedPayload))
	return mac.Sum(nil)
}

// HasScope reports whether claims grant the expected scope.
func HasScope(claims Claims, expected string) bool {
	for _, scope := range claims.Scopes {
		if scope == expected {
			return true
		}
	}
	return false
}

// NextWorkerID derives a worker identity for a session connection epoch.
func NextWorkerID(sessionID clouddomain.SessionID, epoch int64) string {
	return string(sessionID) + ":" + strconv.FormatInt(epoch, 10)
}

// ErrInvalidToken indicates that a worker token is invalid or expired.
var ErrInvalidToken = errors.New("invalid or expired worker token")
