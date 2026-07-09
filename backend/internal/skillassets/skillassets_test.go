package skillassets

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestInstall_WritesSkillAndIsIdempotent: Install must lay down the embedded
// skill (SKILL.md plus a commands file) under <dataDir>/skills/using-ao, and a
// second run must clobber cleanly, leaving no stale files. This is the whole
// contract the daemon boot hook relies on.
func TestInstall_WritesSkillAndIsIdempotent(t *testing.T) {
	dataDir := t.TempDir()

	if err := Install(dataDir); err != nil {
		t.Fatalf("Install: %v", err)
	}

	skillFile := filepath.Join(Dir(dataDir), "SKILL.md")
	if b, err := os.ReadFile(skillFile); err != nil {
		t.Fatalf("read %s: %v", skillFile, err)
	} else if len(b) == 0 {
		t.Fatalf("SKILL.md is empty")
	}
	if _, err := os.Stat(filepath.Join(Dir(dataDir), "commands", "spawn.md")); err != nil {
		t.Fatalf("commands/spawn.md missing: %v", err)
	}

	// A stale file inside the skill dir must not survive a reinstall (clobber).
	stale := filepath.Join(Dir(dataDir), "stale.md")
	if err := os.WriteFile(stale, []byte("old"), 0o644); err != nil {
		t.Fatalf("seed stale file: %v", err)
	}
	if err := Install(dataDir); err != nil {
		t.Fatalf("reinstall: %v", err)
	}
	if _, err := os.Stat(stale); !os.IsNotExist(err) {
		t.Fatalf("stale file survived reinstall (err=%v)", err)
	}
}

// The using-ao skill is what agents read before they run `ao spawn`. If it
// tells them to pass --name, they will — and an explicit name outranks the
// daemon's computed `<repoKey> #<issue> <slug>` (session_manager.launchTitle),
// which reintroduces the untraceable session labels issue #146 removed. The
// daemon owning the name is only true if its own documentation says so.
func TestUsingAoSkill_DoesNotTeachSpawningWithAName(t *testing.T) {
	dataDir := t.TempDir()
	if err := Install(dataDir); err != nil {
		t.Fatalf("Install: %v", err)
	}

	// Each file is required, not best-effort: a guard that silently skips a
	// missing file would pass vacuously the day one gets renamed.
	for _, name := range []string{
		filepath.Join("commands", "spawn.md"),
		"references.md",
		"SKILL.md",
	} {
		path := filepath.Join(Dir(dataDir), name)
		body, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("read %s (the guard must cover it, so it must exist): %v", name, err)
		}
		for i, line := range strings.Split(string(body), "\n") {
			if strings.Contains(line, "ao spawn") && strings.Contains(line, "--name") {
				t.Errorf("%s:%d teaches `ao spawn --name`; the daemon computes the name:\n  %s", name, i+1, strings.TrimSpace(line))
			}
		}
	}

	spawnDoc, err := os.ReadFile(filepath.Join(Dir(dataDir), "commands", "spawn.md"))
	if err != nil {
		t.Fatalf("read spawn.md: %v", err)
	}
	for _, line := range strings.Split(string(spawnDoc), "\n") {
		if strings.Contains(line, "`--name string`") && strings.Contains(line, "Required") {
			t.Errorf("spawn.md still documents --name as required:\n  %s", strings.TrimSpace(line))
		}
	}
}
