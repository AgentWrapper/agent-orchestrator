package domain

import "testing"

func TestWorkerMixValidate(t *testing.T) {
	tests := []struct {
		name    string
		mix     WorkerMix
		wantErr bool
	}{
		{"empty ok", WorkerMix{}, false},
		{"nil ok", nil, false},
		{
			"valid 60/30/10",
			WorkerMix{
				{Harness: HarnessCodex, Weight: 60},
				{Harness: HarnessCodexFugu, Weight: 30},
				{Harness: HarnessClaudeCode, Weight: 10},
			},
			false,
		},
		{"single 100", WorkerMix{{Harness: HarnessClaudeCode, Weight: 100}}, false},
		{
			"sum under 100",
			WorkerMix{{Harness: HarnessCodex, Weight: 60}, {Harness: HarnessClaudeCode, Weight: 30}},
			true,
		},
		{
			"sum over 100",
			WorkerMix{{Harness: HarnessCodex, Weight: 60}, {Harness: HarnessClaudeCode, Weight: 60}},
			true,
		},
		{"unknown harness", WorkerMix{{Harness: "nope", Weight: 100}}, true},
		{"weight zero", WorkerMix{{Harness: HarnessClaudeCode, Weight: 0}, {Harness: HarnessCodex, Weight: 100}}, true},
		{"weight over 100", WorkerMix{{Harness: HarnessClaudeCode, Weight: 101}}, true},
		{"negative weight", WorkerMix{{Harness: HarnessClaudeCode, Weight: -10}, {Harness: HarnessCodex, Weight: 110}}, true},
		{
			"compatible model ok",
			WorkerMix{{Harness: HarnessClaudeCode, Model: "opus", Weight: 100}},
			false,
		},
		{
			"cross-provider model rejected",
			WorkerMix{{Harness: HarnessCodex, Model: "claude-opus-4-8", Weight: 100}},
			true,
		},
		{
			// Fable is explicitly allowed as a user-weighted bucket (GH #61 bans
			// only auto-defaulting to fable, never an explicit weight).
			"explicit fable allowed",
			WorkerMix{{Harness: HarnessClaudeCode, Model: "claude-fable-5", Weight: 100}},
			false,
		},
		{
			"duplicate bucket rejected",
			WorkerMix{
				{Harness: HarnessClaudeCode, Model: "opus", Weight: 50},
				{Harness: HarnessClaudeCode, Model: "opus", Weight: 50},
			},
			true,
		},
		{
			// A padded model validates its provider but would count against a
			// different (trimmed) bucket key at spawn, so it is rejected outright.
			"whitespace-padded model rejected",
			WorkerMix{{Harness: HarnessClaudeCode, Model: " opus ", Weight: 100}},
			true,
		},
		{
			// Same harness, different model is NOT a duplicate — the model is part
			// of the bucket identity.
			"same harness different model ok",
			WorkerMix{
				{Harness: HarnessClaudeCode, Model: "opus", Weight: 50},
				{Harness: HarnessClaudeCode, Model: "sonnet", Weight: 50},
			},
			false,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if err := tt.mix.Validate(); (err != nil) != tt.wantErr {
				t.Fatalf("Validate() err = %v, wantErr = %v", err, tt.wantErr)
			}
		})
	}
}

func TestWorkerMixSelectEmpty(t *testing.T) {
	if _, ok := (WorkerMix{}).Select(nil); ok {
		t.Fatal("empty mix should select nothing")
	}
}

func TestWorkerMixSelectSingle(t *testing.T) {
	mix := WorkerMix{{Harness: HarnessClaudeCode, Model: "opus", Weight: 100}}
	got, ok := mix.Select(map[BucketKey]int{{HarnessClaudeCode, "opus"}: 99})
	if !ok || got.Harness != HarnessClaudeCode || got.Model != "opus" {
		t.Fatalf("single-bucket select = %+v ok=%v, want claude-code/opus", got, ok)
	}
}

// TestWorkerMixSelectConverges drives the selector the way Spawn does — pick a
// bucket, increment its running count, repeat — and asserts the fleet lands on
// the exact target apportionment. 60/30/10 over 10 spawns is 6/3/1, and the
// deterministic earliest-row tie-break makes the whole sequence reproducible.
func TestWorkerMixSelectConverges(t *testing.T) {
	mix := WorkerMix{
		{Harness: HarnessCodex, Weight: 60},
		{Harness: HarnessCodexFugu, Weight: 30},
		{Harness: HarnessClaudeCode, Weight: 10},
	}
	running := map[BucketKey]int{}
	for i := 0; i < 10; i++ {
		pick, ok := mix.Select(running)
		if !ok {
			t.Fatalf("spawn %d: mix selected nothing", i)
		}
		running[BucketKey{pick.Harness, pick.Model}]++
	}
	want := map[AgentHarness]int{HarnessCodex: 6, HarnessCodexFugu: 3, HarnessClaudeCode: 1}
	for h, w := range want {
		if got := running[BucketKey{Harness: h}]; got != w {
			t.Fatalf("after 10 spawns %s = %d, want %d (running=%v)", h, got, w, running)
		}
	}
}

// TestWorkerMixSelectKeyTrimsModel confirms bucket identity is trimmed, so a
// selector fed a padded config model still matches the trimmed model recorded on
// running sessions rather than over-serving that bucket forever.
func TestWorkerMixSelectKeyTrimsModel(t *testing.T) {
	mix := WorkerMix{
		{Harness: HarnessClaudeCode, Model: " opus", Weight: 50},
		{Harness: HarnessCodex, Weight: 50},
	}
	// The claude bucket already has one running session, counted under the trimmed
	// model as Spawn would persist it.
	running := map[BucketKey]int{{Harness: HarnessClaudeCode, Model: "opus"}: 1}
	got, ok := mix.Select(running)
	if !ok || got.Harness != HarnessCodex {
		t.Fatalf("select = %+v ok=%v, want codex (claude bucket already served)", got, ok)
	}
}

// TestWorkerMixSelectIgnoresForeignBuckets confirms running sessions that match
// no configured bucket (e.g. an explicit haiku deploy) don't perturb selection.
func TestWorkerMixSelectIgnoresForeignBuckets(t *testing.T) {
	mix := WorkerMix{
		{Harness: HarnessCodex, Weight: 50},
		{Harness: HarnessClaudeCode, Weight: 50},
	}
	running := map[BucketKey]int{
		{Harness: HarnessClaudeCode, Model: "haiku"}: 5, // foreign: bucket has no model pin
		{Harness: HarnessDroid}:                      3, // foreign: harness not in mix
	}
	// Both configured buckets are still at count 0, so the earliest row wins.
	got, ok := mix.Select(running)
	if !ok || got.Harness != HarnessCodex {
		t.Fatalf("select = %+v ok=%v, want codex (foreign buckets ignored)", got, ok)
	}
}

func TestRoutingHarnessForIssueLabels(t *testing.T) {
	tests := []struct {
		name   string
		labels []string
		want   AgentHarness
		ok     bool
	}{
		{"codex", []string{"bug", "agent:codex"}, HarnessCodex, true},
		{"fugu alias", []string{"agent:fugu"}, HarnessCodexFugu, true},
		{"codex fugu alias", []string{"agent:codex-fugu"}, HarnessCodexFugu, true},
		{"claude", []string{"Agent:Claude"}, HarnessClaudeCode, true},
		{"unknown ignored", []string{"agent:goose"}, "", false},
		{"whitespace padded ignored", []string{" agent:codex "}, "", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, ok := RoutingHarnessForIssueLabels(tt.labels)
			if ok != tt.ok || got != tt.want {
				t.Fatalf("RoutingHarnessForIssueLabels(%v) = (%q,%v), want (%q,%v)", tt.labels, got, ok, tt.want, tt.ok)
			}
		})
	}
}
