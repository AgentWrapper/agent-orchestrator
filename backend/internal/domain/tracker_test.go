package domain

import (
	"reflect"
	"testing"
)

func TestStandardIssueLabelsIncludesTypesStatusesAndRoutingWithoutAdmissionControls(t *testing.T) {
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
		"deferred":     IssueLabelKindStatus,
		"human-review": IssueLabelKindStatus,
	} {
		if got[name] != kind {
			t.Fatalf("standard label %q kind = %q, want %q", name, got[name], kind)
		}
	}
	for _, forbidden := range []string{"no-ao", "nopool"} {
		if _, ok := got[forbidden]; ok {
			t.Fatalf("standard labels still advertise admission control %q", forbidden)
		}
	}
}

func TestTrackerIntakeWithDefaultsDoesNotMaterializeLabelAdmissionRules(t *testing.T) {
	got := TrackerIntakeConfig{Enabled: true}.WithDefaults()
	if got.ExcludeLabels != nil || got.Labels != nil {
		t.Fatalf("WithDefaults materialized label admission fields: %#v", got)
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

func TestTrackerIntakeWithDefaultsUsesZeroRespawnRetries(t *testing.T) {
	got := TrackerIntakeConfig{Enabled: true}.WithDefaults()
	policy := got.EffectiveRespawnPolicy()
	if policy.EffectiveMaxRetries() != 0 || DefaultWorkerRespawnMaxRetries != 0 {
		t.Fatalf("default respawn retries = %d (constant %d), want 0", policy.EffectiveMaxRetries(), DefaultWorkerRespawnMaxRetries)
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

func TestTrackerIntakeValidateRequiresOneAssignmentGateAndFiniteCap(t *testing.T) {
	for _, cfg := range []TrackerIntakeConfig{
		{Enabled: true, MaxConcurrent: 2},
		{Enabled: true, Assignee: "none", MaxConcurrent: 2},
		{Enabled: true, Assignee: "*"},
		{Enabled: true, Assignee: "*", MaxConcurrent: -1},
	} {
		if err := cfg.Validate(); err == nil {
			t.Fatalf("Validate accepted unsafe intake config: %#v", cfg)
		}
	}
	if err := (TrackerIntakeConfig{Enabled: true, Assignee: "*", MaxConcurrent: 2}).Validate(); err != nil {
		t.Fatalf("Validate rejected assignment-gated bounded intake: %v", err)
	}
}

func TestTrackerIntakeValidateRejectsNegativeRespawnRetries(t *testing.T) {
	negative := -1
	cfg := TrackerIntakeConfig{Enabled: true, Assignee: "*", MaxConcurrent: 2, Respawn: &TrackerRespawnPolicy{MaxRetries: &negative}}
	if err := cfg.Validate(); err == nil {
		t.Fatal("Validate accepted negative respawn max retries")
	}
}
