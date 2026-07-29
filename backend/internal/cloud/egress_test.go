package cloud

import (
	"strings"
	"testing"
)

func TestEgressAllowList_HostedIncludesCPHarnessBase(t *testing.T) {
	s := NewSupervisor(SupervisorConfig{
		APIKey:          func() string { return "k" },
		ControlPlaneURL: "https://aocphi-controlplane.example.centralindia.azurecontainerapps.io",
	})
	recipe, _ := recipeFor("claude-code")
	got := s.egressAllowList(recipe)
	for _, want := range []string{
		"aocphi-controlplane.example.centralindia.azurecontainerapps.io", // CP host (no scheme)
		"*.anthropic.com", "*.npmjs.org", // harness
		"*.github.com", "*.githubusercontent.com", "*.debian.org", "*.ubuntu.com", // base
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("allowlist %q missing %q", got, want)
		}
	}
	if strings.Contains(got, "https://") {
		t.Fatalf("allowlist must be bare hostnames, got %q", got)
	}
	if n := len(strings.Split(got, ",")); n > 20 {
		t.Fatalf("allowlist has %d entries, exceeds Daytona's 20 cap", n)
	}
}

func TestEgressAllowList_LocalDaemonIsEmpty(t *testing.T) {
	s := NewSupervisor(SupervisorConfig{APIKey: func() string { return "k" }}) // no ControlPlaneURL
	recipe, _ := recipeFor("claude-code")
	if got := s.egressAllowList(recipe); got != "" {
		t.Fatalf("local daemon must inherit Daytona default (empty), got %q", got)
	}
}

func TestEgressAllowList_DedupesAndFakeHarness(t *testing.T) {
	s := NewSupervisor(SupervisorConfig{APIKey: func() string { return "k" }, ControlPlaneURL: "https://cp.example.com"})
	recipe, _ := recipeFor("fake")
	got := s.egressAllowList(recipe)
	if !strings.HasPrefix(got, "cp.example.com,") {
		t.Fatalf("CP host should lead the list, got %q", got)
	}
	// no duplicate entries
	seen := map[string]bool{}
	for _, d := range strings.Split(got, ",") {
		if seen[d] {
			t.Fatalf("duplicate entry %q in %q", d, got)
		}
		seen[d] = true
	}
}
