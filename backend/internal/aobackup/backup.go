// Package aobackup creates and restores zip archives of durable AO state under
// the canonical ~/.ao directory (or the directory that holds running.json when
// AO_RUN_FILE is overridden).
//
// Ephemeral runtime files are excluded so a reinstall can recover projects,
// sessions, settings, worktrees, and related durable data without carrying over
// live-process handshakes or Chromium cache.
package aobackup

import (
	"archive/zip"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

const (
	// FormatID is the manifest format marker written into every archive.
	FormatID = "ao-state-backup"
	// SchemaVersion is the current manifest schema.
	SchemaVersion = 1
	// ManifestName is the zip entry that carries backup metadata.
	ManifestName = "ao-backup.json"
)

// Top-level names under the AO state dir that must never be archived or
// restored. These are either live-process handshakes, regenerable caches, or
// download staging.
var topLevelExcludes = map[string]struct{}{
	"running.json":           {},
	"windows-pty-hosts.json": {},
	"electron":               {}, // Chromium userData; large and regenerable
	"staging":                {}, // ao start download staging
	"daemon.log":             {},
}

// Manifest is embedded in every archive as ao-backup.json.
type Manifest struct {
	Format        string    `json:"format"`
	SchemaVersion int       `json:"schemaVersion"`
	CreatedAt     time.Time `json:"createdAt"`
	Files         int       `json:"files"`
	Bytes         int64     `json:"bytes"`
	// Excluded lists top-level names that were skipped during create.
	Excluded []string `json:"excluded,omitempty"`
}

// CreateReport is the structured outcome of Create.
type CreateReport struct {
	Archive  string   `json:"archive"`
	StateDir string   `json:"stateDir"`
	Files    int      `json:"files"`
	Bytes    int64    `json:"bytes"`
	Excluded []string `json:"excluded,omitempty"`
}

// RestoreReport is the structured outcome of Restore.
type RestoreReport struct {
	Archive      string   `json:"archive"`
	StateDir     string   `json:"stateDir"`
	Files        int      `json:"files"`
	Replaced     []string `json:"replaced,omitempty"`
	PreRestoreDir string  `json:"preRestoreDir,omitempty"`
}

// ShouldExclude reports whether rel (slash- or OS-separated, relative to the
// state dir) should be omitted from a backup. Empty, ".", and the manifest
// name itself are excluded.
func ShouldExclude(rel string) bool {
	rel = filepath.ToSlash(filepath.Clean(rel))
	if rel == "" || rel == "." || rel == ManifestName {
		return true
	}
	parts := strings.Split(rel, "/")
	if len(parts) == 0 {
		return true
	}
	if _, ok := topLevelExcludes[parts[0]]; ok {
		return true
	}
	for _, p := range parts {
		if isEphemeralName(p) {
			return true
		}
	}
	return false
}

// isEphemeralName matches lock/temp/atomic-write scratch names at any path
// depth. Durable hidden files are uncommon under ~/.ao; the patterns here
// cover known writers (runfile, app-state, mobile config).
func isEphemeralName(name string) bool {
	if name == "" || name == "." || name == ".." {
		return true
	}
	// Pre-restore / staging leftovers from a prior restore attempt.
	if strings.HasPrefix(name, ".ao-pre-restore-") ||
		strings.HasPrefix(name, ".ao-restore-staging-") {
		return true
	}
	lower := strings.ToLower(name)
	if strings.HasSuffix(lower, ".tmp") ||
		strings.HasSuffix(lower, ".lock") ||
		strings.HasSuffix(lower, ".swp") {
		return true
	}
	// Atomic-write temp files used by runfile / app-state / mobile config.
	if strings.HasPrefix(name, ".running-") ||
		strings.HasPrefix(name, ".app-state-") ||
		strings.HasPrefix(name, ".config-") {
		return true
	}
	return false
}

// Create writes a zip archive of durable files under stateDir to archivePath.
// Parent directories of archivePath are created as needed. The archive path is
// skipped if it lies inside stateDir.
func Create(stateDir, archivePath string) (CreateReport, error) {
	stateDir, err := filepath.Abs(stateDir)
	if err != nil {
		return CreateReport{}, fmt.Errorf("resolve state dir: %w", err)
	}
	archivePath, err = filepath.Abs(archivePath)
	if err != nil {
		return CreateReport{}, fmt.Errorf("resolve archive path: %w", err)
	}
	info, err := os.Stat(stateDir)
	if err != nil {
		return CreateReport{}, fmt.Errorf("state dir: %w", err)
	}
	if !info.IsDir() {
		return CreateReport{}, fmt.Errorf("state dir %s is not a directory", stateDir)
	}

	if err := os.MkdirAll(filepath.Dir(archivePath), 0o750); err != nil {
		return CreateReport{}, fmt.Errorf("create archive parent: %w", err)
	}

	// Refuse to clobber an existing archive: create must be explicit about the
	// destination so a mistyped path does not silently destroy a prior backup.
	if _, err := os.Stat(archivePath); err == nil {
		return CreateReport{}, fmt.Errorf("archive already exists: %s", archivePath)
	} else if !os.IsNotExist(err) {
		return CreateReport{}, fmt.Errorf("stat archive: %w", err)
	}

	entries, excluded, err := collectEntries(stateDir, archivePath)
	if err != nil {
		return CreateReport{}, err
	}

	// Write via temp + rename so a failed create never leaves a partial zip at
	// the requested path.
	tmp, err := os.CreateTemp(filepath.Dir(archivePath), ".ao-backup-*.zip.tmp")
	if err != nil {
		return CreateReport{}, fmt.Errorf("create temp archive: %w", err)
	}
	tmpName := tmp.Name()
	cleanup := true
	defer func() {
		_ = tmp.Close()
		if cleanup {
			_ = os.Remove(tmpName)
		}
	}()

	zw := zip.NewWriter(tmp)
	var totalBytes int64
	for _, e := range entries {
		n, err := writeFileEntry(zw, stateDir, e)
		if err != nil {
			_ = zw.Close()
			return CreateReport{}, err
		}
		totalBytes += n
	}

	manifest := Manifest{
		Format:        FormatID,
		SchemaVersion: SchemaVersion,
		CreatedAt:     time.Now().UTC(),
		Files:         len(entries),
		Bytes:         totalBytes,
		Excluded:      excluded,
	}
	if err := writeManifest(zw, manifest); err != nil {
		_ = zw.Close()
		return CreateReport{}, err
	}
	if err := zw.Close(); err != nil {
		return CreateReport{}, fmt.Errorf("close archive: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return CreateReport{}, fmt.Errorf("close temp archive: %w", err)
	}
	if err := os.Rename(tmpName, archivePath); err != nil {
		return CreateReport{}, fmt.Errorf("finalize archive: %w", err)
	}
	cleanup = false

	return CreateReport{
		Archive:  archivePath,
		StateDir: stateDir,
		Files:    len(entries),
		Bytes:    totalBytes,
		Excluded: excluded,
	}, nil
}

// RestoreOptions configure Restore.
type RestoreOptions struct {
	// DryRun validates the archive and reports what would be replaced without
	// writing anything under stateDir.
	DryRun bool
}

// Restore replaces durable files under stateDir with the contents of the
// archive. Ephemeral top-level names already present (running.json, electron,
// etc.) are left alone. On success, any overwritten top-level durable items
// are first moved under stateDir/.ao-pre-restore-<timestamp>/ so a failed
// mid-swap can be recovered manually.
//
// The full archive is extracted to a sibling staging directory before any
// stateDir mutation. If extraction fails, stateDir is untouched.
func Restore(archivePath, stateDir string, opts RestoreOptions) (RestoreReport, error) {
	stateDir, err := filepath.Abs(stateDir)
	if err != nil {
		return RestoreReport{}, fmt.Errorf("resolve state dir: %w", err)
	}
	archivePath, err = filepath.Abs(archivePath)
	if err != nil {
		return RestoreReport{}, fmt.Errorf("resolve archive path: %w", err)
	}

	zr, err := zip.OpenReader(archivePath)
	if err != nil {
		return RestoreReport{}, fmt.Errorf("open archive: %w", err)
	}
	defer zr.Close()

	manifest, err := readManifest(&zr.Reader)
	if err != nil {
		return RestoreReport{}, err
	}
	if err := validateManifest(manifest); err != nil {
		return RestoreReport{}, err
	}

	members, err := listRestorableMembers(&zr.Reader)
	if err != nil {
		return RestoreReport{}, err
	}
	if len(members) == 0 {
		return RestoreReport{}, fmt.Errorf("archive contains no restorable files")
	}

	// Top-level names that will land in stateDir (for replace reporting).
	topLevels := uniqueTopLevels(members)
	replaced := existingTopLevels(stateDir, topLevels)

	if opts.DryRun {
		return RestoreReport{
			Archive:  archivePath,
			StateDir: stateDir,
			Files:    len(members),
			Replaced: replaced,
		}, nil
	}

	if err := os.MkdirAll(stateDir, 0o750); err != nil {
		return RestoreReport{}, fmt.Errorf("create state dir: %w", err)
	}

	stagingParent := filepath.Dir(stateDir)
	staging, err := os.MkdirTemp(stagingParent, ".ao-restore-staging-*")
	if err != nil {
		return RestoreReport{}, fmt.Errorf("create restore staging: %w", err)
	}
	defer func() { _ = os.RemoveAll(staging) }()

	// Extract every restorable member into staging. Nothing under stateDir is
	// touched until this completes cleanly.
	for _, m := range members {
		if err := extractMember(staging, m); err != nil {
			return RestoreReport{}, err
		}
	}

	// Move existing durable top-level items aside, then promote staged ones.
	stamp := time.Now().UTC().Format("20060102-150405")
	preRestoreDir := filepath.Join(stateDir, ".ao-pre-restore-"+stamp)
	var movedAside []string
	for _, name := range topLevels {
		src := filepath.Join(stateDir, name)
		if _, err := os.Lstat(src); err != nil {
			if os.IsNotExist(err) {
				continue
			}
			return RestoreReport{}, fmt.Errorf("stat existing %s: %w", name, err)
		}
		if err := os.MkdirAll(preRestoreDir, 0o750); err != nil {
			return RestoreReport{}, fmt.Errorf("create pre-restore dir: %w", err)
		}
		dst := filepath.Join(preRestoreDir, name)
		if err := os.Rename(src, dst); err != nil {
			return RestoreReport{}, fmt.Errorf("move aside %s: %w (pre-restore partial at %s)", name, err, preRestoreDir)
		}
		movedAside = append(movedAside, name)
	}

	for _, name := range topLevels {
		src := filepath.Join(staging, name)
		dst := filepath.Join(stateDir, name)
		if err := os.Rename(src, dst); err != nil {
			// Best-effort: try to put moved-aside items back so the user is not
			// left with a half-empty state dir.
			for i := len(movedAside) - 1; i >= 0; i-- {
				n := movedAside[i]
				_ = os.Rename(filepath.Join(preRestoreDir, n), filepath.Join(stateDir, n))
			}
			return RestoreReport{}, fmt.Errorf("promote %s into state dir: %w", name, err)
		}
	}

	rep := RestoreReport{
		Archive:  archivePath,
		StateDir: stateDir,
		Files:    len(members),
		Replaced: replaced,
	}
	if len(movedAside) > 0 {
		rep.PreRestoreDir = preRestoreDir
	}
	return rep, nil
}

// ReadManifest opens archivePath and returns its validated manifest.
func ReadManifest(archivePath string) (Manifest, error) {
	zr, err := zip.OpenReader(archivePath)
	if err != nil {
		return Manifest{}, fmt.Errorf("open archive: %w", err)
	}
	defer zr.Close()
	m, err := readManifest(&zr.Reader)
	if err != nil {
		return Manifest{}, err
	}
	if err := validateManifest(m); err != nil {
		return Manifest{}, err
	}
	return m, nil
}

func collectEntries(stateDir, archivePath string) ([]string, []string, error) {
	var entries []string
	excludedSet := map[string]struct{}{}

	// Record top-level excludes that actually exist so the report is useful.
	if dents, err := os.ReadDir(stateDir); err == nil {
		for _, d := range dents {
			if _, ok := topLevelExcludes[d.Name()]; ok {
				excludedSet[d.Name()] = struct{}{}
			}
		}
	}

	err := filepath.WalkDir(stateDir, func(path string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if path == stateDir {
			return nil
		}
		// Never archive the destination zip if the user pointed it inside stateDir.
		if sameFilePath(path, archivePath) {
			return nil
		}
		rel, err := filepath.Rel(stateDir, path)
		if err != nil {
			return err
		}
		if ShouldExclude(rel) {
			if d.IsDir() {
				// Record first path component as excluded when it is a known top-level skip.
				top := strings.Split(filepath.ToSlash(rel), "/")[0]
				if _, ok := topLevelExcludes[top]; ok {
					excludedSet[top] = struct{}{}
				}
				return fs.SkipDir
			}
			return nil
		}
		if d.IsDir() {
			return nil
		}
		// Skip non-regular files (sockets, devices); symlinks to files are followed
		// by WalkDir as the target type when resolved — we only archive regular files.
		info, err := d.Info()
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() {
			return nil
		}
		entries = append(entries, rel)
		return nil
	})
	if err != nil {
		return nil, nil, fmt.Errorf("walk state dir: %w", err)
	}
	sort.Strings(entries)

	excluded := make([]string, 0, len(excludedSet))
	for name := range excludedSet {
		excluded = append(excluded, name)
	}
	sort.Strings(excluded)
	return entries, excluded, nil
}

func writeFileEntry(zw *zip.Writer, stateDir, rel string) (int64, error) {
	full := filepath.Join(stateDir, rel)
	f, err := os.Open(full)
	if err != nil {
		return 0, fmt.Errorf("open %s: %w", rel, err)
	}
	defer f.Close()

	info, err := f.Stat()
	if err != nil {
		return 0, fmt.Errorf("stat %s: %w", rel, err)
	}
	hdr, err := zip.FileInfoHeader(info)
	if err != nil {
		return 0, fmt.Errorf("header %s: %w", rel, err)
	}
	hdr.Name = filepath.ToSlash(rel)
	hdr.Method = zip.Deflate

	w, err := zw.CreateHeader(hdr)
	if err != nil {
		return 0, fmt.Errorf("create zip entry %s: %w", rel, err)
	}
	n, err := io.Copy(w, f)
	if err != nil {
		return 0, fmt.Errorf("write zip entry %s: %w", rel, err)
	}
	return n, nil
}

func writeManifest(zw *zip.Writer, m Manifest) error {
	data, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal manifest: %w", err)
	}
	data = append(data, '\n')
	w, err := zw.Create(ManifestName)
	if err != nil {
		return fmt.Errorf("create manifest entry: %w", err)
	}
	if _, err := w.Write(data); err != nil {
		return fmt.Errorf("write manifest: %w", err)
	}
	return nil
}

func readManifest(zr *zip.Reader) (Manifest, error) {
	for _, f := range zr.File {
		if f.Name == ManifestName {
			rc, err := f.Open()
			if err != nil {
				return Manifest{}, fmt.Errorf("open manifest: %w", err)
			}
			defer rc.Close()
			var m Manifest
			if err := json.NewDecoder(rc).Decode(&m); err != nil {
				return Manifest{}, fmt.Errorf("parse manifest: %w", err)
			}
			return m, nil
		}
	}
	return Manifest{}, fmt.Errorf("archive missing %s (not an AO state backup?)", ManifestName)
}

func validateManifest(m Manifest) error {
	if m.Format != FormatID {
		return fmt.Errorf("unsupported backup format %q (want %q)", m.Format, FormatID)
	}
	if m.SchemaVersion < 1 || m.SchemaVersion > SchemaVersion {
		return fmt.Errorf("unsupported backup schema version %d", m.SchemaVersion)
	}
	return nil
}

func listRestorableMembers(zr *zip.Reader) ([]*zip.File, error) {
	var out []*zip.File
	for _, f := range zr.File {
		name := filepath.ToSlash(f.Name)
		if name == ManifestName || strings.HasSuffix(name, "/") {
			continue
		}
		// Zip-slip: reject absolute paths and .. components.
		if err := safeRelPath(name); err != nil {
			return nil, err
		}
		if ShouldExclude(name) {
			continue
		}
		out = append(out, f)
	}
	return out, nil
}

func safeRelPath(name string) error {
	name = filepath.ToSlash(name)
	if name == "" || name == "." {
		return fmt.Errorf("invalid empty archive path")
	}
	if strings.HasPrefix(name, "/") || strings.Contains(name, ":") {
		return fmt.Errorf("archive path %q is absolute; refusing restore", name)
	}
	for _, p := range strings.Split(name, "/") {
		if p == ".." {
			return fmt.Errorf("archive path %q escapes target; refusing restore", name)
		}
	}
	return nil
}

func extractMember(destRoot string, f *zip.File) error {
	name := filepath.ToSlash(f.Name)
	if err := safeRelPath(name); err != nil {
		return err
	}
	target := filepath.Join(destRoot, filepath.FromSlash(name))
	// Double-check Join did not escape (Windows volume quirks).
	rel, err := filepath.Rel(destRoot, target)
	if err != nil || strings.HasPrefix(rel, "..") {
		return fmt.Errorf("archive path %q escapes staging dir", name)
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o750); err != nil {
		return fmt.Errorf("mkdir for %s: %w", name, err)
	}
	rc, err := f.Open()
	if err != nil {
		return fmt.Errorf("open archive entry %s: %w", name, err)
	}
	defer rc.Close()

	// Write via temp + rename inside staging so a partial file is never left as
	// the final name if we crash mid-entry.
	tmp, err := os.CreateTemp(filepath.Dir(target), ".extract-*.tmp")
	if err != nil {
		return fmt.Errorf("create temp for %s: %w", name, err)
	}
	tmpName := tmp.Name()
	ok := false
	defer func() {
		_ = tmp.Close()
		if !ok {
			_ = os.Remove(tmpName)
		}
	}()
	if _, err := io.Copy(tmp, rc); err != nil {
		return fmt.Errorf("extract %s: %w", name, err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("close temp for %s: %w", name, err)
	}
	if err := os.Rename(tmpName, target); err != nil {
		return fmt.Errorf("finalize %s: %w", name, err)
	}
	ok = true
	return nil
}

func uniqueTopLevels(members []*zip.File) []string {
	set := map[string]struct{}{}
	for _, m := range members {
		top := strings.Split(filepath.ToSlash(m.Name), "/")[0]
		if top == "" || top == ManifestName {
			continue
		}
		set[top] = struct{}{}
	}
	out := make([]string, 0, len(set))
	for k := range set {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func existingTopLevels(stateDir string, names []string) []string {
	var out []string
	for _, name := range names {
		if _, err := os.Lstat(filepath.Join(stateDir, name)); err == nil {
			out = append(out, name)
		}
	}
	return out
}

func sameFilePath(a, b string) bool {
	a = filepath.Clean(a)
	b = filepath.Clean(b)
	return strings.EqualFold(a, b) || a == b
}
