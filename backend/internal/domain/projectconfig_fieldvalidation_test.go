package domain_test

import (
	"strings"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

// Field validation gaps from issue #298 R2. Each of these persisted cleanly with
// a 200 and only failed — silently, and far from the Settings page — at spawn.

func TestValidateRejectsAnIllegalDefaultBranch(t *testing.T) {
	t.Parallel()

	for _, tc := range []struct {
		name   string
		branch string
	}{
		{"leading whitespace", " main"},
		{"trailing whitespace", "main "},
		{"whitespace only", "   "},
		{"embedded space", "my branch"},
		{"leading dash", "-main"},
		{"double dot", "feat..x"},
		{"trailing lock", "main.lock"},
		{"trailing slash", "main/"},
		{"control character", "ma\tin"},
		{"tilde", "main~1"},
		{"caret", "main^"},
		{"colon", "refs:main"},
		{"question mark", "main?"},
		{"backslash", `main\x`},
		{"at-brace", "main@{0}"},
	} {
		cfg := domain.ProjectConfig{DefaultBranch: tc.branch}
		if err := cfg.Validate(); err == nil {
			t.Errorf("%s: %q must be rejected as an illegal git ref", tc.name, tc.branch)
		}
	}
}

func TestValidateAcceptsLegalDefaultBranches(t *testing.T) {
	t.Parallel()

	for _, branch := range []string{"", "main", "master", "develop", "release/1.2", "feat/some-thing", "v1.0.0"} {
		cfg := domain.ProjectConfig{DefaultBranch: branch}
		if err := cfg.Validate(); err != nil {
			t.Errorf("%q is a legal branch name but was rejected: %v", branch, err)
		}
	}
}

// A bad env key does not fail loudly — it is forwarded into every session
// runtime, where an illegal name is silently dropped by the OS or the shell.
func TestValidateRejectsIllegalEnvKeys(t *testing.T) {
	t.Parallel()

	for _, tc := range []struct {
		name string
		key  string
	}{
		{"embedded space", "A B"},
		{"empty", ""},
		{"leading digit", "1FOO"},
		{"equals sign", "FOO=BAR"},
		{"dash", "FOO-BAR"},
		{"null byte", "FOO\x00BAR"},
		{"leading whitespace", " FOO"},
	} {
		cfg := domain.ProjectConfig{Env: map[string]string{tc.key: "v"}}
		if err := cfg.Validate(); err == nil {
			t.Errorf("%s: env key %q must be rejected", tc.name, tc.key)
		}
	}
}

func TestValidateAcceptsLegalEnvKeys(t *testing.T) {
	t.Parallel()

	cfg := domain.ProjectConfig{Env: map[string]string{
		"POLYPOWERS_REPO":  "owner/repo",
		"_UNDERSCORE":      "ok",
		"MiXeD_case_9":     "ok",
		"POLYPOWERS_AUTO1": "1",
	}}
	if err := cfg.Validate(); err != nil {
		t.Fatalf("legal env keys were rejected: %v", err)
	}
}

// The session display name is capped at 20 runes. An over-long project prefix
// eats that budget and truncates the issue number out of every worker session
// name — `polymath-ventures #281` became `polymath-ventures #2`.
func TestValidateCapsTheProjectPrefixSoItCannotCorruptSessionNames(t *testing.T) {
	t.Parallel()

	tooLong := strings.Repeat("x", domain.MaxProjectPrefixRunes+1)
	cfg := domain.ProjectConfig{ProjectPrefix: tooLong}
	err := cfg.Validate()
	if err == nil {
		t.Fatalf("a %d-rune prefix must be rejected: it truncates the issue number out of session names", len(tooLong))
	}
	if !strings.Contains(err.Error(), "projectPrefix") {
		t.Fatalf("error must name the field, got %q", err)
	}

	atCap := domain.ProjectConfig{ProjectPrefix: strings.Repeat("x", domain.MaxProjectPrefixRunes)}
	if err := atCap.Validate(); err != nil {
		t.Fatalf("a prefix exactly at the cap must be accepted, got %v", err)
	}
}

// The cap is measured in runes, not bytes: a multi-byte prefix that fits the
// display budget must not be rejected for its byte length.
func TestProjectPrefixCapIsMeasuredInRunes(t *testing.T) {
	t.Parallel()

	// Each of these is 3 bytes but 1 rune.
	cfg := domain.ProjectConfig{ProjectPrefix: strings.Repeat("é", domain.MaxProjectPrefixRunes)}
	if err := cfg.Validate(); err != nil {
		t.Fatalf("a prefix at the rune cap must be accepted regardless of byte length, got %v", err)
	}
}

// The legacy sessionPrefix alias feeds the same 20-rune budget, so the cap has
// to survive normalization rather than being bypassed by the old field name.
func TestProjectPrefixCapAppliesToTheLegacySessionPrefixAlias(t *testing.T) {
	t.Parallel()

	cfg := domain.ProjectConfig{SessionPrefix: strings.Repeat("x", domain.MaxProjectPrefixRunes+1)}
	if err := cfg.Validate(); err == nil {
		t.Fatal("the cap must apply to the legacy sessionPrefix alias too")
	}
}
