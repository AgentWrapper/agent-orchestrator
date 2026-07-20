package telemetry

import (
	"strings"
	"testing"
)

// Defense-in-depth: even if an emitter puts raw free text in a command-shaped
// property, the sink must not ship it — command/command_path values that aren't
// command-shaped are replaced with a stable non-reversible token (#2813).
func TestSanitizeRemoteValueRedactsNonCommandShapedCommandKeys(t *testing.T) {
	leaky := []string{
		"https://gitlab.com/org/repo/-/merge_requests/9",
		"/Users/fora/Sites/internal-tool",
		"ao Review this PR and merge if CI is green; ping @security",
		"严格审查必须由当前主会话单独完成",
	}
	for _, key := range []string{"command", "command_path"} {
		for _, raw := range leaky {
			got, ok := sanitizeRemoteValue(key, raw)
			if !ok {
				t.Fatalf("%s=%q: dropped, expected a redacted token", key, raw)
			}
			s, _ := got.(string)
			if !strings.HasPrefix(s, "sha256:") {
				t.Fatalf("%s=%q: got %q, want a sha256: token", key, raw, s)
			}
			if strings.Contains(s, raw) || strings.Contains(s, "gitlab") || strings.Contains(s, "/Users/") {
				t.Fatalf("%s: raw text leaked through: %q", key, s)
			}
		}
	}
}

func TestSanitizeRemoteValueAllowsRealCommands(t *testing.T) {
	cases := map[string]string{
		"command":      "status",
		"command_path": "ao status",
	}
	for key, val := range cases {
		got, ok := sanitizeRemoteValue(key, val)
		if !ok || got != val {
			t.Fatalf("%s=%q: got (%v,%v), want it passed through unchanged", key, val, got, ok)
		}
	}
	// The "<unknown>" sentinel the client emits must pass the shape check.
	if got, ok := sanitizeRemoteValue("command_path", "ao list <unknown>"); !ok || got != "ao list <unknown>" {
		t.Fatalf(`"ao list <unknown>" should pass, got (%v,%v)`, got, ok)
	}
}

func TestSanitizeRemoteValueLengthBackstop(t *testing.T) {
	// Non-command string keys are truncated to the backstop cap, never unbounded.
	got, ok := sanitizeRemoteValue("error_kind", strings.Repeat("x", maxRemoteStringLen+500))
	if !ok {
		t.Fatal("long value dropped, expected truncation")
	}
	if s := got.(string); len(s) != maxRemoteStringLen {
		t.Fatalf("length backstop not applied: got len %d, want %d", len(s), maxRemoteStringLen)
	}
}
