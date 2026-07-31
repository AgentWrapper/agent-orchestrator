package pipeline

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestConfigJSONSchema_ParsesAsJSON(t *testing.T) {
	var doc map[string]any
	if err := json.Unmarshal(ConfigJSONSchema(), &doc); err != nil {
		t.Fatalf("embedded schema.json is not valid JSON: %v", err)
	}
	if doc["$schema"] != "https://json-schema.org/draft/2020-12/schema" {
		t.Fatalf("expected draft 2020-12 $schema, got %v", doc["$schema"])
	}
}

func TestConfigJSONSchema_ReturnsCopy(t *testing.T) {
	a := ConfigJSONSchema()
	b := ConfigJSONSchema()
	if len(a) == 0 {
		t.Fatal("expected non-empty schema")
	}
	a[0] = 'X'
	if string(a[:1]) == string(b[:1]) {
		t.Fatal("expected mutating one copy to not affect another")
	}
}

// TestConfigJSONSchema_CoversEnums is a cheap drift guard: schema.json is a
// hand-maintained mirror of definition.go, so every Go enum constant on the
// config surface must appear somewhere in the schema text. A new outcome,
// workspace kind or trigger event added to the Go enums then fails here until
// the schema the definitions editor consumes documents it too.
func TestConfigJSONSchema_CoversEnums(t *testing.T) {
	schema := string(ConfigJSONSchema())

	contains := func(what, value string) {
		t.Helper()
		if !strings.Contains(schema, `"`+value+`"`) {
			t.Errorf("schema missing %s %q", what, value)
		}
	}

	for _, o := range AllOutcomes {
		contains("outcome", string(o))
	}
	for _, w := range AllWorkspaceKinds {
		contains("workspace kind", string(w))
	}
	for _, e := range AllPREvents {
		contains("pr event", string(e))
	}
	for _, e := range AllSessionEvents {
		contains("session event", string(e))
	}
	for _, s := range AllConcurrencyScopes {
		contains("concurrency scope", string(s))
	}
	for _, k := range AllExecutorKinds {
		contains("executor kind", string(k))
	}
	for _, key := range []string{"name", "on", "concurrency", "defaults", "stages"} {
		contains("top-level key", key)
	}
}
