// Package skillassets embeds skills (the ao CLI catalog, markdown preview,
// etc.) and installs them into the AO data dir at daemon boot. Worker sessions
// run in a worktree of whatever project they were spawned in, so a
// repo-relative skills/ path only resolves when that project happens to be the
// AO repo itself. Installing under the data dir gives every session, in any
// project, a stable absolute path to read.
//
// Each embedded copy is the single source of truth. Install clobbers the
// on-disk copy on every boot, so a new daemon build always refreshes it and the
// two can never drift; there is no version marker or hash to keep in sync
// because the daemon binary already is the version.
package skillassets

import (
	"fmt"
	"io/fs"
	"os"
	"path/filepath"

	"embed"
)

//go:embed using-ao markdown-preview
var files embed.FS

// Skill directory names under <dataDir>/skills.
const (
	UsingAoName         = "using-ao"
	MarkdownPreviewName = "markdown-preview"
)

// Dir returns the absolute directory for the using-ao skill. It is a
// convenience wrapper around DirFor.
func Dir(dataDir string) string {
	return DirFor(dataDir, UsingAoName)
}

// DirFor returns the absolute directory a named skill installs into for a
// given data dir. Callers building prompts use this so the path they cite
// always matches where Install writes.
func DirFor(dataDir, skillName string) string {
	return filepath.Join(dataDir, "skills", skillName)
}

// Install writes every embedded skill into <dataDir>/skills/<skill-name>,
// replacing any existing copy. It runs once at daemon boot, before any session
// spawns, so a plain clobber-and-write needs no locking: there are no
// concurrent readers yet. A failure is returned but is non-fatal to boot (the
// skills enhance `ao --help` and session output; they are not load-bearing).
func Install(dataDir string) error {
	skillsDir := filepath.Join(dataDir, "skills")
	if err := os.RemoveAll(skillsDir); err != nil {
		return fmt.Errorf("clear skills dir %q: %w", skillsDir, err)
	}
	// embed.FS always uses forward-slash paths; map each entry onto
	// <dataDir>/skills/<same path> with the platform separator.
	return fs.WalkDir(files, ".", func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if p == "." {
			return nil // skip root
		}
		target := filepath.Join(skillsDir, filepath.FromSlash(p))
		if d.IsDir() {
			return os.MkdirAll(target, 0o750)
		}
		b, err := files.ReadFile(p)
		if err != nil {
			return fmt.Errorf("read embedded %q: %w", p, err)
		}
		if err := os.WriteFile(target, b, 0o600); err != nil {
			return fmt.Errorf("write %q: %w", target, err)
		}
		return nil
	})
}
