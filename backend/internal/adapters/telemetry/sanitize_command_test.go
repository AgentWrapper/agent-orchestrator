package telemetry

import (
	"strings"
	"testing"
)

func TestSanitizeRemoteValueHashesInvalidCommandValues(t *testing.T) {
	invalid := []string{
		"https://github.com/org/repo/pull/1",
		"/Users/example/private-project",
		"ao Review this PR; ping @security",
		"customer acme launch",
		"secret_project",
		"ao private customer",
		"严格审查必须完成",
		strings.Repeat("x", maxCommandShapeLength+1),
	}

	for _, key := range []string{"command", "command_path"} {
		for _, value := range invalid {
			t.Run(key+"/"+value, func(t *testing.T) {
				first, ok := sanitizeRemoteValue(key, value)
				if !ok {
					t.Fatal("invalid command value was dropped")
				}
				second, ok := sanitizeRemoteValue(key, value)
				if !ok || second != first {
					t.Fatalf("hash is not stable: first=%v second=%v", first, second)
				}
				token, ok := first.(string)
				if !ok || len(token) != len("sha256:")+16 || !strings.HasPrefix(token, "sha256:") {
					t.Fatalf("sanitized value = %#v, want sha256:<16 hex>", first)
				}
				if strings.Contains(token, value) {
					t.Fatalf("sanitized value leaked raw input: %q", token)
				}
			})
		}
	}
}

func TestSanitizeRemoteValuePreservesValidCommands(t *testing.T) {
	tests := []struct {
		key   string
		value string
	}{
		{key: "command", value: "status"},
		{key: "command", value: "resolve-comments"},
		{key: "command_path", value: "ao pr resolve-comments"},
		{key: "command_path", value: "ao session get <unknown>"},
	}

	for _, test := range tests {
		got, ok := sanitizeRemoteValue(test.key, test.value)
		if !ok || got != test.value {
			t.Errorf("%s=%q: got (%v, %v), want unchanged", test.key, test.value, got, ok)
		}
	}
}

func TestSanitizeRemoteValueDoesNotApplyCommandValidationToOtherKeys(t *testing.T) {
	const value = "http_request_panic"
	got, ok := sanitizeRemoteValue("operation", value)
	if !ok || got != value {
		t.Fatalf("operation=%q: got (%v, %v), want unchanged", value, got, ok)
	}
}
