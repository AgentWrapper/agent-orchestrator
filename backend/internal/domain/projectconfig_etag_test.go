package domain_test

import (
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

// The config ETag (issue #298, decision D1). It is what lets a stale write be
// rejected instead of silently clobbering fields the writer never saw.

func TestETagChangesWithContent(t *testing.T) {
	t.Parallel()

	base := domain.ProjectConfig{}.WithStandardDefaults()
	changed := base
	changed.DefaultBranch = "trunk"

	if base.ETag() == changed.ETag() {
		t.Fatal("a content change must change the ETag, or a stale write cannot be detected")
	}
}

func TestETagIsStableAcrossEqualConfigs(t *testing.T) {
	t.Parallel()

	// Two independently-built but equal configs must agree, or every second write
	// would spuriously conflict.
	a := domain.ProjectConfig{}.WithStandardDefaults()
	b := domain.ProjectConfig{}.WithStandardDefaults()
	if a.ETag() != b.ETag() {
		t.Fatalf("equal configs must produce equal ETags: %q vs %q", a.ETag(), b.ETag())
	}

	// Map iteration order must not leak into the token.
	multi := domain.ProjectConfig{Env: map[string]string{"A": "1", "B": "2", "C": "3", "D": "4"}}
	first := multi.ETag()
	for range 50 {
		if got := multi.ETag(); got != first {
			t.Fatalf("ETag is not deterministic across map iterations: %q vs %q", got, first)
		}
	}
}

// The deprecated sessionPrefix alias normalizes into projectPrefix, so two
// configs that STORE identically must not carry different tokens — that would be
// a conflict with no content difference behind it.
func TestETagIsComputedOverTheNormalizedConfig(t *testing.T) {
	t.Parallel()

	legacy := domain.ProjectConfig{SessionPrefix: "ao"}
	canonical := domain.ProjectConfig{ProjectPrefix: "ao"}
	if legacy.ETag() != canonical.ETag() {
		t.Fatal("configs that normalize to the same stored value must share an ETag")
	}
}

// A project with no config needs a real token. Without one, "I read an empty
// config" and "I read nothing" are indistinguishable, and the first write cannot
// prove it is not stale.
func TestEmptyConfigHasAConcreteETag(t *testing.T) {
	t.Parallel()

	var empty domain.ProjectConfig
	if empty.ETag() != domain.EmptyConfigETag {
		t.Fatalf("empty config ETag = %q, want %q", empty.ETag(), domain.EmptyConfigETag)
	}
	if empty.ETag() == "" {
		t.Fatal("the empty-config ETag must not itself be empty")
	}

	emptyContainers := domain.ProjectConfig{
		Env:           map[string]string{},
		Symlinks:      []string{},
		PostCreate:    []string{},
		WorkerMix:     domain.WorkerMix{},
		Reviewers:     []domain.ReviewerConfig{},
		TrackerIntake: domain.TrackerIntakeConfig{Labels: []string{}, ExcludeLabels: []string{}},
	}
	if !emptyContainers.IsZero() {
		t.Fatalf("empty containers should still be zero: %#v", emptyContainers)
	}
	if emptyContainers.ETag() != domain.EmptyConfigETag {
		t.Fatalf("empty-container config ETag = %q, want %q", emptyContainers.ETag(), domain.EmptyConfigETag)
	}
}

func TestETagMatchesAcceptsTheWildcardButNotAStaleToken(t *testing.T) {
	t.Parallel()

	cfg := domain.ProjectConfig{}.WithStandardDefaults()

	if !cfg.ETagMatches(cfg.ETag()) {
		t.Fatal("the current token must authorize a write")
	}
	if !cfg.ETagMatches(`"` + cfg.ETag() + `"`) {
		t.Fatal("a quoted strong ETag must authorize a write")
	}
	if !cfg.ETagMatches(`W/"` + cfg.ETag() + `"`) {
		t.Fatal("a weak ETag form must authorize a write")
	}
	if !cfg.ETagMatches(`"some-older-token", "` + cfg.ETag() + `"`) {
		t.Fatal("an If-Match list containing the current token must authorize a write")
	}
	// "*" is how a deliberate whole-object writer — the config-as-code restore
	// path, whose entire job is to overwrite drift — opts out of the check.
	if !cfg.ETagMatches("*") {
		t.Fatal("the wildcard must authorize a write")
	}
	if cfg.ETagMatches("some-older-token") {
		t.Fatal("a stale token must NOT authorize a write; this is the clobber")
	}
	if cfg.ETagMatches("") {
		t.Fatal("an empty token must not match a real config")
	}
}
