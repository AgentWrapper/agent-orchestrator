package pipeline

import _ "embed"

// configSchemaJSON is the JSON Schema (draft 2020-12) mirror of the YAML
// pipeline definition document accepted by ParseDefinition. It is consumed
// by the definitions editor (a later task) for client-side validation and
// autocomplete; correctness here matters more than cleverness, so it is kept
// as a hand-written, readable file (schema.json) rather than generated.
//
//go:embed schema.json
var configSchemaJSON []byte

// ConfigJSONSchema returns a copy of the embedded JSON Schema document
// describing the YAML pipeline definition format. Callers get their own
// copy so they can't mutate the embedded original.
func ConfigJSONSchema() []byte {
	out := make([]byte, len(configSchemaJSON))
	copy(out, configSchemaJSON)
	return out
}
