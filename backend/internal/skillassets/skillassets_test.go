package skillassets

import (
	"os"
	"path/filepath"
	"testing"
)

// TestInstall_WritesSkillAndIsIdempotent: Install must lay down every embedded
// skill under <dataDir>/skills/<name>/, and a second run must clobber cleanly,
// leaving no stale files. This is the whole contract the daemon boot hook
// relies on.
func TestInstall_WritesSkillAndIsIdempotent(t *testing.T) {
	dataDir := t.TempDir()

	if err := Install(dataDir); err != nil {
		t.Fatalf("Install: %v", err)
	}

	// using-ao skill
	usingAo := filepath.Join(DirFor(dataDir, UsingAoName), "SKILL.md")
	if b, err := os.ReadFile(usingAo); err != nil {
		t.Fatalf("read %s: %v", usingAo, err)
	} else if len(b) == 0 {
		t.Fatalf("using-ao SKILL.md is empty")
	}
	if _, err := os.Stat(filepath.Join(DirFor(dataDir, UsingAoName), "commands", "spawn.md")); err != nil {
		t.Fatalf("commands/spawn.md missing: %v", err)
	}

	// markdown-preview skill
	mdPreview := filepath.Join(DirFor(dataDir, MarkdownPreviewName), "SKILL.md")
	if b, err := os.ReadFile(mdPreview); err != nil {
		t.Fatalf("read %s: %v", mdPreview, err)
	} else if len(b) == 0 {
		t.Fatalf("markdown-preview SKILL.md is empty")
	}

	// A stale file inside the skills dir must not survive a reinstall (clobber).
	stale := filepath.Join(DirFor(dataDir, UsingAoName), "stale.md")
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
