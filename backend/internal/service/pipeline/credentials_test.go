package pipelinesvc_test

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	pipelinesvc "github.com/aoagents/agent-orchestrator/backend/internal/service/pipeline"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite"
)

// newCredentialService stands up a real store with one project, which is all a
// credential needs to exist.
func newCredentialService(t *testing.T) (*pipelinesvc.Service, *sqlite.Store) {
	t.Helper()
	s, err := sqlite.Open(t.TempDir())
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { _ = s.Close() })
	now := time.Now().UTC().Truncate(time.Second)
	if err := s.UpsertProject(context.Background(), domain.ProjectRecord{ID: "proj", Path: t.TempDir(), RegisteredAt: now}); err != nil {
		t.Fatalf("seed project: %v", err)
	}
	return pipelinesvc.New(s), s
}

func TestSetCredential_RoundTripsNamesOnly(t *testing.T) {
	svc, store := newCredentialService(t)
	ctx := context.Background()

	if err := svc.SetCredential(ctx, "proj", "npm", map[string]string{"NPM_TOKEN": "s3cret"}); err != nil {
		t.Fatalf("SetCredential: %v", err)
	}
	if err := svc.SetCredential(ctx, "proj", "apple", map[string]string{"ASC_KEY": "k"}); err != nil {
		t.Fatalf("SetCredential: %v", err)
	}

	names, err := svc.ListCredentialNames(ctx, "proj")
	if err != nil {
		t.Fatalf("ListCredentialNames: %v", err)
	}
	if len(names) != 2 || names[0] != "apple" || names[1] != "npm" {
		t.Fatalf("names = %v, want [apple npm]", names)
	}

	// The value is reachable only through the daemon-internal read path the
	// engine injects from, never through the service's user-facing surface.
	env, ok, err := store.GetPipelineCredential(ctx, "proj", "npm")
	if err != nil || !ok {
		t.Fatalf("GetPipelineCredential: ok=%v err=%v", ok, err)
	}
	if env["NPM_TOKEN"] != "s3cret" {
		t.Fatalf("stored env = %v", env)
	}
}

func TestSetCredential_ReplacesWholeEnv(t *testing.T) {
	svc, store := newCredentialService(t)
	ctx := context.Background()

	if err := svc.SetCredential(ctx, "proj", "npm", map[string]string{"A": "1", "B": "2"}); err != nil {
		t.Fatalf("SetCredential: %v", err)
	}
	if err := svc.SetCredential(ctx, "proj", "npm", map[string]string{"A": "3"}); err != nil {
		t.Fatalf("SetCredential: %v", err)
	}

	env, _, err := store.GetPipelineCredential(ctx, "proj", "npm")
	if err != nil {
		t.Fatalf("GetPipelineCredential: %v", err)
	}
	if len(env) != 1 || env["A"] != "3" {
		t.Fatalf("env = %v, want a wholesale replacement", env)
	}
}

func TestSetCredential_Rejects(t *testing.T) {
	svc, _ := newCredentialService(t)
	ctx := context.Background()

	tests := []struct {
		name string
		cred string
		env  map[string]string
	}{
		{"blank name", "  ", map[string]string{"A": "1"}},
		{"no variables", "npm", nil},
		{"blank key", "npm", map[string]string{"  ": "1"}},
		{"key with =", "npm", map[string]string{"A=B": "1"}},
		{"key starting with a digit", "npm", map[string]string{"1A": "1"}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			err := svc.SetCredential(ctx, "proj", tc.cred, tc.env)
			if err == nil {
				t.Fatal("expected an error")
			}
			// A rejection message must not carry the value it rejected.
			if strings.Contains(err.Error(), "1") && tc.name != "key starting with a digit" {
				t.Fatalf("error %q leaks a credential value", err)
			}
		})
	}
}

func TestDeleteCredential(t *testing.T) {
	svc, _ := newCredentialService(t)
	ctx := context.Background()

	if err := svc.SetCredential(ctx, "proj", "npm", map[string]string{"A": "1"}); err != nil {
		t.Fatalf("SetCredential: %v", err)
	}
	if err := svc.DeleteCredential(ctx, "proj", "npm"); err != nil {
		t.Fatalf("DeleteCredential: %v", err)
	}
	names, err := svc.ListCredentialNames(ctx, "proj")
	if err != nil {
		t.Fatalf("ListCredentialNames: %v", err)
	}
	if len(names) != 0 {
		t.Fatalf("names = %v, want none", names)
	}
	if err := svc.DeleteCredential(ctx, "proj", "npm"); err == nil {
		t.Fatal("expected a not-found error deleting a credential twice")
	}
}
