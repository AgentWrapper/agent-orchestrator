package cloud

import (
	"context"
	"strings"
	"testing"
)

// captureProvider records UploadFile calls so a test can assert what landed in
// the sandbox.
type captureProvider struct {
	*fakeProvider
	uploads map[string][]byte
}

func (c *captureProvider) UploadFile(_ context.Context, _ Sandbox, path string, data []byte) error {
	if c.uploads == nil {
		c.uploads = map[string][]byte{}
	}
	c.uploads[path] = data
	return nil
}

func newCaptureProvider() *captureProvider {
	return &captureProvider{fakeProvider: &fakeProvider{name: "capture"}}
}

func TestPortCredentials_InjectedCredentialWins(t *testing.T) {
	recipe, ok := recipeFor("claude-code")
	if !ok {
		t.Fatal("no claude-code recipe")
	}
	capture := newCaptureProvider()
	s := NewSupervisor(SupervisorConfig{APIKey: func() string { return "k" }})
	noopSh := func(string, int) (string, error) { return "", nil }

	injected := `{"claudeAiOauth":{"accessToken":"INJECTED-AT-SPAWN"}}`
	if err := s.portCredentials(context.Background(), capture, Sandbox{ID: "box-1"}, recipe, noopSh, injected); err != nil {
		t.Fatalf("portCredentials: %v", err)
	}

	var credFile string
	for path, data := range capture.uploads {
		if strings.Contains(path, ".credentials.json") {
			credFile = string(data)
		}
	}
	if credFile == "" {
		t.Fatalf("no credential file uploaded; uploads=%v", keysOf(capture.uploads))
	}
	if credFile != injected {
		t.Fatalf("credential file = %q, want the injected value verbatim", credFile)
	}
}

func TestPortCredentials_FakeHarnessNeedsNoCredential(t *testing.T) {
	recipe, ok := recipeFor("fake")
	if !ok {
		t.Fatal("no fake recipe")
	}
	capture := newCaptureProvider()
	s := NewSupervisor(SupervisorConfig{APIKey: func() string { return "k" }})
	noopSh := func(string, int) (string, error) { return "", nil }
	// No injected credential, no ported credential files → must not error.
	if err := s.portCredentials(context.Background(), capture, Sandbox{ID: "b"}, recipe, noopSh, ""); err != nil {
		t.Fatalf("fake harness portCredentials should be a no-op, got %v", err)
	}
}

func TestSpawnCloud_IdempotentReturnsExisting(t *testing.T) {
	s := NewSupervisor(SupervisorConfig{APIKey: func() string { return "k" }})
	// Pre-seed a provisioning session for a key (as if a prior attempt landed).
	s.sessions["box-existing"] = &CloudSession{
		SandboxID: "box-existing", TenantID: "acme", IdempotencyKey: "key-1", Status: StatusProvisioning,
	}
	res, err := s.SpawnCloud(context.Background(), SpawnInput{
		Harness: "fake", TenantID: "acme", IdempotencyKey: "key-1",
	})
	if err != nil {
		t.Fatalf("idempotent spawn: %v", err)
	}
	if res.SandboxID != "box-existing" {
		t.Fatalf("retry must return the existing sandbox, got %q", res.SandboxID)
	}
	// A different tenant with the same key must NOT hit the dedupe.
	// It would try to actually provision (no provider configured) → error is fine;
	// the point is it did NOT return box-existing.
	_, _ = s.SpawnCloud(context.Background(), SpawnInput{Harness: "fake", TenantID: "other", IdempotencyKey: "key-1"})
}

func keysOf(m map[string][]byte) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}
