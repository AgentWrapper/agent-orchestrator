package cli

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

func TestLabelsSyncCreatesOnlyMissingStandardLabels(t *testing.T) {
	var calls [][]string
	deps := Deps{
		CommandOutput: func(ctx context.Context, name string, args ...string) ([]byte, error) {
			calls = append(calls, append([]string{name}, args...))
			if name != "gh" {
				t.Fatalf("command = %q, want gh", name)
			}
			if strings.Join(args[:3], " ") == "label list --repo" {
				return []byte(`[{"name":"bug"},{"name":"No-AO"},{"name":"agent:codex"}]`), nil
			}
			if strings.Join(args[:2], " ") == "label create" {
				return []byte("{}"), nil
			}
			t.Fatalf("unexpected gh args: %v", args)
			return nil, nil
		},
	}

	out, errOut, err := executeCLI(t, deps, "labels", "sync", "--repo", "acme/demo")
	if err != nil {
		t.Fatalf("unexpected error: %v\nstderr=%s", err, errOut)
	}
	if !strings.Contains(out, "created:") || !strings.Contains(out, "feature") || !strings.Contains(out, "existing:") || !strings.Contains(out, "bug") {
		t.Fatalf("output missing created/existing report:\n%s", out)
	}

	created := createdLabelNames(calls)
	for _, unexpected := range []string{"bug", "no-ao", "agent:codex"} {
		if contains(created, unexpected) {
			t.Fatalf("created existing label %q; created labels = %v", unexpected, created)
		}
	}
	for _, want := range []string{"feature", "task", "deferred", "charter", "charter-audit", "human-review", "agent:fugu", "agent:claude", "nopool"} {
		if !contains(created, want) {
			t.Fatalf("missing create call for %q; created labels = %v", want, created)
		}
	}
}

func TestLabelsSyncJSONReportsCreatedAndExisting(t *testing.T) {
	deps := Deps{
		CommandOutput: func(ctx context.Context, name string, args ...string) ([]byte, error) {
			if strings.Join(args[:3], " ") == "label list --repo" {
				return []byte(`[{"name":"bug"},{"name":"feature"},{"name":"task"},{"name":"no-ao"},{"name":"deferred"},{"name":"charter"},{"name":"charter-audit"},{"name":"human-review"},{"name":"agent:codex"},{"name":"agent:fugu"},{"name":"agent:claude"},{"name":"nopool"}]`), nil
			}
			return nil, fmt.Errorf("unexpected command: %s %v", name, args)
		},
	}

	out, errOut, err := executeCLI(t, deps, "labels", "sync", "--repo", "acme/demo", "--json")
	if err != nil {
		t.Fatalf("unexpected error: %v\nstderr=%s", err, errOut)
	}
	var got labelsSyncResult
	if err := json.Unmarshal([]byte(out), &got); err != nil {
		t.Fatalf("decode json output: %v\n%s", err, out)
	}
	if got.Repo != "acme/demo" {
		t.Fatalf("repo = %q, want acme/demo", got.Repo)
	}
	if len(got.Created) != 0 {
		t.Fatalf("created = %v, want none", got.Created)
	}
	if len(got.Existing) != len(got.Labels) || len(got.Labels) != 12 {
		t.Fatalf("existing/labels counts = %d/%d, want 12/12", len(got.Existing), len(got.Labels))
	}
}

func TestLabelsSyncRequiresRepo(t *testing.T) {
	_, _, err := executeCLI(t, Deps{}, "labels", "sync")
	if err == nil {
		t.Fatal("expected usage error")
	}
	if got := ExitCode(err); got != 2 {
		t.Fatalf("ExitCode = %d, want 2", got)
	}
}

func createdLabelNames(calls [][]string) []string {
	var out []string
	for _, call := range calls {
		if len(call) >= 4 && call[0] == "gh" && call[1] == "label" && call[2] == "create" {
			out = append(out, call[3])
		}
	}
	return out
}

func contains(items []string, want string) bool {
	for _, item := range items {
		if item == want {
			return true
		}
	}
	return false
}
