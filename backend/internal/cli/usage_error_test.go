package cli

import (
	"strings"
	"testing"
)

// usageErrorCommand must never propagate raw positional text (URLs, paths, prose)
// into the telemetry command / command_path — only registered command names.
func TestUsageErrorCommandRedactsFreeText(t *testing.T) {
	known := map[string]bool{"list": true, "status": true, "spawn": true}

	cases := []struct {
		name     string
		args     []string
		wantCmd  string
		wantPath string
	}{
		{"url", []string{"https://gitlab.com/org/repo/-/merge_requests/9"}, "<unknown>", "ao <unknown>"},
		{"abs path", []string{"/Users/fora/Sites/internal-tool"}, "<unknown>", "ao <unknown>"},
		{"prose", []string{"Review this PR and merge if CI is green; ping @security first"}, "<unknown>", "ao <unknown>"},
		{"non-ascii", []string{"严格审查必须由当前主会话单独完成"}, "<unknown>", "ao <unknown>"},
		{"known then free text", []string{"list", "some-secret-project"}, "list", "ao list <unknown>"},
		{"known then bad flag", []string{"status", "--bogus"}, "status", "ao status"},
		{"no args", nil, "ao", "ao"},
		{"leading flag", []string{"--help"}, "ao", "ao"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			cmd, path := usageErrorCommand(known, tc.args)
			if cmd != tc.wantCmd || path != tc.wantPath {
				t.Fatalf("usageErrorCommand(%v) = (%q, %q), want (%q, %q)", tc.args, cmd, path, tc.wantCmd, tc.wantPath)
			}
			// Hard guarantee: no raw positional token appears anywhere in the output.
			for _, arg := range tc.args {
				if strings.HasPrefix(arg, "-") {
					continue
				}
				if !known[arg] && (strings.Contains(cmd, arg) || strings.Contains(path, arg)) {
					t.Fatalf("raw arg %q leaked into (%q, %q)", arg, cmd, path)
				}
			}
		})
	}
}

func TestKnownCommandNamesIncludesSubcommandsAndAliases(t *testing.T) {
	known := knownCommandNames(NewRootCommand(DefaultDeps().withDefaults()))
	// A few commands that must exist in the tree; guards against the collector
	// silently returning empty (which would make everything "<unknown>").
	for _, name := range []string{"status", "spawn", "list"} {
		if !known[name] {
			t.Fatalf("known command set missing %q; got %d entries", name, len(known))
		}
	}
}
