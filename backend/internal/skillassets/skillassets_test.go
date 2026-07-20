package skillassets

import (
	"os"
	"path/filepath"
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

// TestMaterialize_WritesIntoArbitraryDest covers the opencode adapter path:
// materialize the skill into .opencode/skills/using-ao (not the data-dir layout).
func TestMaterialize_WritesIntoArbitraryDest(t *testing.T) {
	dest := filepath.Join(t.TempDir(), ".opencode", "skills", SkillName)
	if err := Materialize(dest); err != nil {
		t.Fatalf("Materialize: %v", err)
	}
	if b, err := os.ReadFile(filepath.Join(dest, "SKILL.md")); err != nil {
		t.Fatalf("read SKILL.md: %v", err)
	} else if len(b) == 0 {
		t.Fatal("SKILL.md is empty")
	}
	if _, err := os.Stat(filepath.Join(dest, "commands", "spawn.md")); err != nil {
		t.Fatalf("commands/spawn.md missing: %v", err)
	}
}
