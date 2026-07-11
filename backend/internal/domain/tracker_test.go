package domain

import (
	"reflect"
	"testing"
)

// The opt-out taxonomy (issue #80) is materialized by WithDefaults when intake
// is enabled and the project left ExcludeLabels unset. The list is the
// authoritative set Nick pinned: no-ao, deferred, charter, charter-audit,
// human-review. "charter" prefix-matches charter:* at filter time (observer),
// so charter:* is not enumerated here.
func TestDefaultOptOutLabels(t *testing.T) {
	want := []string{"no-ao", "deferred", "charter", "charter-audit", "human-review"}
	if !reflect.DeepEqual(DefaultOptOutLabels, want) {
		t.Fatalf("DefaultOptOutLabels = %v, want %v", DefaultOptOutLabels, want)
	}
}

func TestStandardIssueLabelsAreSingleSourceForOptOutTaxonomy(t *testing.T) {
	var got []string
	for _, label := range StandardIssueLabels() {
		if label.Kind == IssueLabelKindOptOut {
			got = append(got, label.Name)
		}
	}
	if !reflect.DeepEqual(got, DefaultOptOutLabels) {
		t.Fatalf("opt-out standard labels = %v, want %v", got, DefaultOptOutLabels)
	}
}

func TestStandardIssueLabelsIncludesRoutingAndPoolEscape(t *testing.T) {
	got := map[string]IssueLabelKind{}
	for _, label := range StandardIssueLabels() {
		got[label.Name] = label.Kind
		if label.Color == "" || label.Description == "" {
			t.Fatalf("standard label %q missing color or description: %#v", label.Name, label)
		}
	}
	for name, kind := range map[string]IssueLabelKind{
		"bug":          IssueLabelKindType,
		"feature":      IssueLabelKindType,
		"task":         IssueLabelKindType,
		"agent:codex":  IssueLabelKindRouting,
		"agent:fugu":   IssueLabelKindRouting,
		"agent:claude": IssueLabelKindRouting,
		"nopool":       IssueLabelKindPoolEscape,
	} {
		if got[name] != kind {
			t.Fatalf("standard label %q kind = %q, want %q", name, got[name], kind)
		}
	}
}

func TestTrackerIntakeWithDefaultsMaterializesOptOut(t *testing.T) {
	// Enabled + unset ExcludeLabels → the default opt-out taxonomy is filled in
	// (opt-out-by-default). The materialized slice must be a copy, not an alias
	// of the package-level DefaultOptOutLabels, so a later append can't mutate
	// the shared default.
	got := TrackerIntakeConfig{Enabled: true}.WithDefaults()
	if !reflect.DeepEqual(got.ExcludeLabels, DefaultOptOutLabels) {
		t.Fatalf("ExcludeLabels = %v, want %v", got.ExcludeLabels, DefaultOptOutLabels)
	}
	if len(got.ExcludeLabels) > 0 && &got.ExcludeLabels[0] == &DefaultOptOutLabels[0] {
		t.Fatal("WithDefaults aliased the shared DefaultOptOutLabels slice; expected a copy")
	}
}

func TestTrackerIntakeWithDefaultsRespectsExplicitExcludeLabels(t *testing.T) {
	// An explicitly-set list is preserved verbatim.
	custom := TrackerIntakeConfig{Enabled: true, ExcludeLabels: []string{"only-this"}}.WithDefaults()
	if !reflect.DeepEqual(custom.ExcludeLabels, []string{"only-this"}) {
		t.Fatalf("explicit ExcludeLabels overwritten: got %v", custom.ExcludeLabels)
	}

	// An explicitly-empty (non-nil) list means "opt into working everything" and
	// must NOT be re-filled with the defaults. WithDefaults distinguishes nil
	// (unset) from [] (explicit) in memory via its nil check. (JSON persistence
	// with omitempty collapses [] back to nil, i.e. clearing restores defaults —
	// that is a storage-layer property, tested separately from this domain rule.)
	empty := TrackerIntakeConfig{Enabled: true, ExcludeLabels: []string{}}.WithDefaults()
	if empty.ExcludeLabels == nil || len(empty.ExcludeLabels) != 0 {
		t.Fatalf("explicit empty ExcludeLabels replaced with defaults: got %v", empty.ExcludeLabels)
	}
}

func TestTrackerIntakeWithDefaultsDisabledLeavesExcludeLabelsNil(t *testing.T) {
	// Disabled intake stays fully zero so empty project configs still store NULL.
	got := TrackerIntakeConfig{}.WithDefaults()
	if got.ExcludeLabels != nil {
		t.Fatalf("disabled intake materialized ExcludeLabels: %v", got.ExcludeLabels)
	}
}

func TestTrackerIntakeWithDefaultsEnablesRespawnPolicy(t *testing.T) {
	got := TrackerIntakeConfig{Enabled: true}.WithDefaults()
	policy := got.EffectiveRespawnPolicy()
	if !policy.IsEnabled() {
		t.Fatal("respawn policy should default on when intake is enabled")
	}
	if policy.EffectiveMaxRetries() != DefaultWorkerRespawnMaxRetries {
		t.Fatalf("respawn max retries = %d, want %d", policy.EffectiveMaxRetries(), DefaultWorkerRespawnMaxRetries)
	}
	if got.Respawn != nil {
		t.Fatalf("WithDefaults should not persist materialized respawn defaults, got %#v", got.Respawn)
	}
}

func TestTrackerIntakeRespawnPolicyCanDisableOrSetZeroRetries(t *testing.T) {
	zero := 0
	got := TrackerIntakeConfig{
		Enabled: true,
		Respawn: &TrackerRespawnPolicy{
			Disabled:   true,
			MaxRetries: &zero,
		},
	}.WithDefaults()
	policy := got.EffectiveRespawnPolicy()
	if policy.IsEnabled() {
		t.Fatal("explicit disabled respawn policy should stay disabled")
	}
	if policy.EffectiveMaxRetries() != 0 {
		t.Fatalf("explicit zero retries = %d, want 0", policy.EffectiveMaxRetries())
	}
}

func TestTrackerIntakeValidateNoLongerRequiresAssignee(t *testing.T) {
	// Issue #80 flips intake to opt-out-by-default: the work gate is opt-out
	// labels only, so an assignee is no longer required to enable intake. The
	// backlog-drain protection that once justified the requirement is now carried
	// by the default opt-out labels + MaxConcurrent cap.
	cfg := TrackerIntakeConfig{Enabled: true}.WithDefaults()
	if err := cfg.Validate(); err != nil {
		t.Fatalf("Validate rejected enabled intake without assignee: %v", err)
	}
}

func TestTrackerIntakeValidateStillRejectsPaddedLabels(t *testing.T) {
	// Internal spaces are legal (GitHub labels like "good first issue"); only
	// leading/trailing padding is rejected, and that guard still applies to
	// exclude labels after the assignee requirement was dropped.
	cfg := TrackerIntakeConfig{Enabled: true, ExcludeLabels: []string{" no-ao"}}
	if err := cfg.Validate(); err == nil {
		t.Fatal("Validate accepted an exclude label with leading whitespace")
	}
}

func TestTrackerIntakeValidateRejectsNegativeRespawnRetries(t *testing.T) {
	negative := -1
	cfg := TrackerIntakeConfig{Enabled: true, Respawn: &TrackerRespawnPolicy{MaxRetries: &negative}}
	if err := cfg.Validate(); err == nil {
		t.Fatal("Validate accepted negative respawn max retries")
	}
}
