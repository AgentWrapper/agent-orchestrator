// Package credentials stores user-provided inference-provider credentials with
// encryption applied before any database write.
package credentials

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/secrets"
	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/tenancy"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/envelope"
)

// Store persists encrypted credential records.
type Store interface {
	CreateAgentCredential(ctx context.Context, rec Record) error
}

// Service encrypts credentials before persistence.
type Service struct {
	store Store
	seals secrets.Manager
	now   func() time.Time
}

// Record is the encrypted database representation of an agent credential.
type Record struct {
	OrgID      string
	ID         string
	UserID     string
	Provider   string
	Label      string
	Ciphertext string
	Nonce      string
	KeyID      string
	Algorithm  string
	CreatedAt  time.Time
	UpdatedAt  time.Time
}

// New returns a credential service backed by the provided store and secret
// manager.
func New(store Store, seals secrets.Manager) *Service {
	return &Service{store: store, seals: seals, now: time.Now}
}

// Create encrypts plaintext secret material and stores only ciphertext.
func (s *Service) Create(ctx context.Context, provider, label string, plaintext []byte) (Record, error) {
	scope, ok := tenancy.ScopeFromContext(ctx)
	if !ok || scope.UserID == "" || scope.OrgID == "" {
		return Record{}, fmt.Errorf("cloud tenant scope missing from context")
	}
	ciphertext, err := s.seals.Encrypt(ctx, plaintext)
	if err != nil {
		return Record{}, err
	}
	now := s.now().UTC()
	rec := Record{
		OrgID:      scope.OrgID,
		ID:         uuid.NewString(),
		UserID:     scope.UserID,
		Provider:   strings.TrimSpace(provider),
		Label:      strings.TrimSpace(label),
		Ciphertext: secrets.EncodeField(ciphertext.Body),
		Nonce:      secrets.EncodeField(ciphertext.Nonce),
		KeyID:      ciphertext.KeyID,
		Algorithm:  ciphertext.Algorithm,
		CreatedAt:  now,
		UpdatedAt:  now,
	}
	if err := s.store.CreateAgentCredential(ctx, rec); err != nil {
		return Record{}, err
	}
	return rec, nil
}

// CreateHTTP stores an encrypted provider credential for the authenticated org.
func (s *Service) CreateHTTP(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Provider string `json:"provider"`
		Label    string `json:"label"`
		Secret   string `json:"secret"`
	}
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "INVALID_JSON", "Invalid JSON body", nil)
		return
	}
	if strings.TrimSpace(in.Provider) == "" || in.Secret == "" {
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "CREDENTIAL_REQUIRED", "provider and secret are required", nil)
		return
	}
	rec, err := s.Create(r.Context(), in.Provider, in.Label, []byte(in.Secret))
	if err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	envelope.WriteJSON(w, http.StatusCreated, map[string]any{
		"id":        rec.ID,
		"provider":  rec.Provider,
		"label":     rec.Label,
		"createdAt": rec.CreatedAt,
	})
}
