package runtimeenv

import (
	"os"
	"strings"
	"testing"
)

func sep() string { return string(os.PathListSeparator) }

func TestWithFallbackPathAppendsMissingFloorDirs(t *testing.T) {
	// A minimal PATH (the classic headless/systemd case) must gain the floor so
	// tmux at /opt/homebrew/bin becomes resolvable.
	got := WithFallbackPath("/usr/bin" + sep() + "/bin")
	for _, dir := range FallbackPathDirs {
		if !strings.Contains(sep()+got+sep(), sep()+dir+sep()) {
			t.Fatalf("result %q missing floor dir %q", got, dir)
		}
	}
}

func TestWithFallbackPathPreservesExistingOrderAndPrecedence(t *testing.T) {
	// The user's own entries must stay first (keep precedence); floor dirs append.
	got := WithFallbackPath("/my/tools" + sep() + "/usr/bin")
	parts := strings.Split(got, sep())
	if parts[0] != "/my/tools" || parts[1] != "/usr/bin" {
		t.Fatalf("existing order not preserved: %v", parts)
	}
	if got != "/my/tools"+sep()+"/usr/bin"+sep()+strings.Join(dropDir(FallbackPathDirs, "/usr/bin"), sep()) {
		t.Fatalf("unexpected composition: %q", got)
	}
}

func TestWithFallbackPathDeduplicates(t *testing.T) {
	got := WithFallbackPath("/opt/homebrew/bin" + sep() + "/opt/homebrew/bin" + sep() + "/usr/bin")
	if strings.Count(sep()+got+sep(), sep()+"/opt/homebrew/bin"+sep()) != 1 {
		t.Fatalf("expected /opt/homebrew/bin exactly once, got %q", got)
	}
}

func TestWithFallbackPathEmptyYieldsFloorOnly(t *testing.T) {
	if got := WithFallbackPath(""); got != strings.Join(FallbackPathDirs, sep()) {
		t.Fatalf("empty PATH should yield the floor, got %q", got)
	}
}

func TestWithFallbackPathDropsEmptySegments(t *testing.T) {
	got := WithFallbackPath(sep() + "/usr/bin" + sep() + sep())
	if strings.HasPrefix(got, sep()) || strings.Contains(got, sep()+sep()) {
		t.Fatalf("empty segments not dropped: %q", got)
	}
}

// dropDir returns dirs without the given entry (test helper for the precedence case).
func dropDir(dirs []string, drop string) []string {
	out := make([]string, 0, len(dirs))
	for _, d := range dirs {
		if d != drop {
			out = append(out, d)
		}
	}
	return out
}
