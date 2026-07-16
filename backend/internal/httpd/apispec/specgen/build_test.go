package specgen_test

import (
	"bytes"
	"testing"

	yaml "gopkg.in/yaml.v3"

	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apispec"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apispec/specgen"
)

// TestBuild_MatchesEmbedded is the drift guard: the committed (embedded)
// openapi.yaml must equal fresh Build() output. If this fails, run
// `go generate ./...` and commit the result.
func TestBuild_MatchesEmbedded(t *testing.T) {
	got, err := specgen.Build()
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	embedded := apispec.Default().YAML()
	if !bytes.Equal(got, embedded) {
		t.Fatalf("embedded openapi.yaml is stale — run `go generate ./...` and commit.\n"+
			"len(fresh)=%d len(embedded)=%d", len(got), len(embedded))
	}
}

func TestBuild_SCMTokenRequestsAreNonNullableWriteOnlyStrings(t *testing.T) {
	built, err := specgen.Build()
	if err != nil {
		t.Fatal(err)
	}
	var doc map[string]any
	if err := yaml.Unmarshal(built, &doc); err != nil {
		t.Fatal(err)
	}
	schemas := doc["components"].(map[string]any)["schemas"].(map[string]any)
	for _, name := range []string{"CreateSCMConnectionRequest", "UpdateSCMConnectionRequest"} {
		properties := schemas[name].(map[string]any)["properties"].(map[string]any)
		token := properties["token"].(map[string]any)
		if token["type"] != "string" || token["writeOnly"] != true {
			t.Fatalf("%s.token = %#v, want non-null write-only string", name, token)
		}
	}
}

func TestBuild_SCMConnectionTestDocumentsStructuredFailures(t *testing.T) {
	built, err := specgen.Build()
	if err != nil {
		t.Fatal(err)
	}
	var doc map[string]any
	if err := yaml.Unmarshal(built, &doc); err != nil {
		t.Fatal(err)
	}
	paths := doc["paths"].(map[string]any)
	operation := paths["/api/v1/scm/connections/{id}/test"].(map[string]any)["post"].(map[string]any)
	responses := operation["responses"].(map[string]any)
	for _, status := range []string{"401", "403", "404", "429", "500", "501", "503"} {
		if _, ok := responses[status]; !ok {
			t.Errorf("connection test response %s is undocumented", status)
		}
	}
}

// TestBuild_Deterministic guards against nondeterministic output (which would
// make the drift check flaky in CI).
func TestBuild_Deterministic(t *testing.T) {
	a, err := specgen.Build()
	if err != nil {
		t.Fatalf("Build #1: %v", err)
	}
	b, err := specgen.Build()
	if err != nil {
		t.Fatalf("Build #2: %v", err)
	}
	if !bytes.Equal(a, b) {
		t.Fatal("Build() is not deterministic across calls")
	}
}
