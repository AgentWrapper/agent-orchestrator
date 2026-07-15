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

// TestConfigJSONSchema_CoversEnums is a cheap drift guard: every Go enum
// constant this package defines for the config surface must appear
// somewhere in the schema text, so a new predicate kind / executor kind /
// trigger event added to the Go enums doesn't silently go undocumented in
// the schema the definitions editor consumes.
func TestConfigJSONSchema_CoversEnums(t *testing.T) {
	schema := string(ConfigJSONSchema())

	for _, k := range AllPredicateKinds {
		if !strings.Contains(schema, string(k)) {
			t.Errorf("schema missing predicate kind %q", k)
		}
	}
	for _, k := range AllExecutorKinds {
		if !strings.Contains(schema, string(k)) {
			t.Errorf("schema missing executor kind %q", k)
		}
	}
	for _, e := range AllStageTriggerEvents {
		if !strings.Contains(schema, string(e)) {
			t.Errorf("schema missing trigger event %q", e)
		}
	}
	for _, key := range []string{"name", "stages"} {
		if !strings.Contains(schema, `"`+key+`"`) {
			t.Errorf("schema missing required top-level key %q", key)
		}
	}
}
