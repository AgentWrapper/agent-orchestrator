package worker

import (
	"testing"
	"time"
)

func TestTokenRoundTripAndExpiry(t *testing.T) {
	manager := NewTokenManager([]byte("01234567890123456789012345678901"))
	now := time.Date(2026, 7, 29, 18, 30, 0, 0, time.UTC)
	manager.now = func() time.Time { return now }
	token, err := manager.Issue(Claims{
		AccountID: "account-one",
		SessionID: "session-one",
		WorkerID:  "worker-one",
		Epoch:     1,
		Scopes:    []string{"worker:event"},
	}, time.Minute)
	if err != nil {
		t.Fatalf("Issue() error = %v", err)
	}
	claims, err := manager.Verify(token)
	if err != nil {
		t.Fatalf("Verify() error = %v", err)
	}
	if claims.SessionID != "session-one" || !HasScope(claims, "worker:event") {
		t.Fatalf("claims = %#v", claims)
	}
	manager.now = func() time.Time { return now.Add(2 * time.Minute) }
	if _, err := manager.Verify(token); err == nil {
		t.Fatal("Verify(expired) error = nil")
	}
}
