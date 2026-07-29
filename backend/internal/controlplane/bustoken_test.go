package controlplane

import (
	"testing"
	"time"
)

func TestBusToken_MintVerifyRoundTrip(t *testing.T) {
	s := NewBusTokenSigner("super-secret-key", time.Hour)
	tok, err := s.MintForSandbox("acme", "box-1")
	if err != nil {
		t.Fatalf("mint: %v", err)
	}
	tenant, sandbox, err := s.Verify(tok)
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if tenant != "acme" || sandbox != "box-1" {
		t.Fatalf("claims = %q/%q", tenant, sandbox)
	}
}

func TestBusToken_NilWhenNoSecret(t *testing.T) {
	if NewBusTokenSigner("  ", time.Hour) != nil {
		t.Fatal("empty secret should yield a nil signer")
	}
}

func TestBusToken_RejectsForeignSecret(t *testing.T) {
	a := NewBusTokenSigner("key-A", time.Hour)
	b := NewBusTokenSigner("key-B", time.Hour)
	tok, _ := a.MintForSandbox("acme", "box-1")
	if _, _, err := b.Verify(tok); err == nil {
		t.Fatal("token from key-A must not verify under key-B")
	}
}

func TestBusToken_RejectsExpired(t *testing.T) {
	s := NewBusTokenSigner("k", time.Hour)
	tok, err := s.mint("acme", "box-1", time.Now().Add(-2*time.Hour)) // expired 1h ago
	if err != nil {
		t.Fatalf("mint: %v", err)
	}
	if _, _, err := s.Verify(tok); err == nil {
		t.Fatal("expired token must not verify")
	}
}

func TestBusToken_VerifyEmpty(t *testing.T) {
	s := NewBusTokenSigner("k", time.Hour)
	if _, _, err := s.Verify(""); err == nil {
		t.Fatal("empty token must error")
	}
}
