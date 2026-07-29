package credentials

import (
	"bytes"
	"context"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/secrets"
	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/tenancy"
)

func TestCreateEncryptsBeforePersist(t *testing.T) {
	seals, err := secrets.NewLocalEnvelopeManager("test-secret-key", "test-key")
	if err != nil {
		t.Fatalf("secrets manager: %v", err)
	}
	store := &captureStore{}
	service := New(store, seals)
	ctx := tenancy.WithScope(context.Background(), tenancy.Scope{UserID: "user-1", OrgID: "org-1"})

	rec, err := service.Create(ctx, "openai", "primary", []byte("sk-test-secret"))
	if err != nil {
		t.Fatalf("create credential: %v", err)
	}
	if store.rec.Ciphertext == "" || store.rec.Nonce == "" {
		t.Fatalf("credential was not persisted")
	}
	if store.rec.Ciphertext == "sk-test-secret" {
		t.Fatalf("plaintext secret persisted in ciphertext field")
	}
	if bytes.Contains([]byte(store.rec.Ciphertext), []byte("sk-test-secret")) {
		t.Fatalf("ciphertext contains plaintext secret")
	}
	body, err := secrets.DecodeField(rec.Ciphertext)
	if err != nil {
		t.Fatalf("decode ciphertext: %v", err)
	}
	nonce, err := secrets.DecodeField(rec.Nonce)
	if err != nil {
		t.Fatalf("decode nonce: %v", err)
	}
	plaintext, err := seals.Decrypt(ctx, secrets.Ciphertext{
		Algorithm: rec.Algorithm,
		KeyID:     rec.KeyID,
		Nonce:     nonce,
		Body:      body,
	})
	if err != nil {
		t.Fatalf("decrypt ciphertext: %v", err)
	}
	if string(plaintext) != "sk-test-secret" {
		t.Fatalf("decrypted secret = %q, want original", plaintext)
	}
}

type captureStore struct {
	rec Record
}

func (s *captureStore) CreateAgentCredential(_ context.Context, rec Record) error {
	s.rec = rec
	return nil
}
