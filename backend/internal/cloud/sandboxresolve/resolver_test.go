package sandboxresolve

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	clouddomain "github.com/aoagents/agent-orchestrator/backend/internal/cloud/domain"
	cloudsandbox "github.com/aoagents/agent-orchestrator/backend/internal/cloud/sandbox"
	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/sandbox/daytona"
	cloudsecrets "github.com/aoagents/agent-orchestrator/backend/internal/cloud/secrets"
)

type fakeSecretStore struct {
	encrypted []byte
	nonce     []byte
	config    json.RawMessage
	label     string
}

func (f fakeSecretStore) ProviderConnectionSecret(
	context.Context,
	clouddomain.AccountID,
	string,
) ([]byte, []byte, json.RawMessage, string, error) {
	return f.encrypted, f.nonce, f.config, f.label, nil
}

func TestResolveUsesEncryptedUserConnection(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer user-key" {
			t.Fatalf("Authorization = %q", got)
		}
		_, _ = w.Write([]byte(`{"items":[]}`))
	}))
	defer server.Close()
	cipher, err := cloudsecrets.New([]byte("01234567890123456789012345678901"))
	if err != nil {
		t.Fatalf("secrets.New() error = %v", err)
	}
	encrypted, nonce, err := cipher.Encrypt([]byte("user-key"), "account-one:daytona:personal")
	if err != nil {
		t.Fatalf("Encrypt() error = %v", err)
	}
	resolver := New(
		fakeSecretStore{
			encrypted: encrypted,
			nonce:     nonce,
			config:    json.RawMessage(`{"apiUrl":"` + server.URL + `","target":"eu"}`),
			label:     "personal",
		},
		cipher,
		"https://default.invalid",
		"us",
		nil,
		nil,
		nil,
	)
	provider, err := resolver.Resolve(context.Background(), clouddomain.Sandbox{
		AccountID:            "account-one",
		Provider:             "daytona",
		ProviderConnectionID: "connection-one",
	})
	if err != nil {
		t.Fatalf("Resolve() error = %v", err)
	}
	client, ok := provider.(*daytona.Client)
	if !ok {
		t.Fatalf("provider type = %T", provider)
	}
	if err := client.Validate(context.Background()); err != nil {
		t.Fatalf("Validate() error = %v", err)
	}
}

var _ cloudsandbox.Provider = (*daytona.Client)(nil)
