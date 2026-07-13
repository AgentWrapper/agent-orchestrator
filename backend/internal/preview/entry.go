package preview

import (
	"io/fs"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

var entryCandidates = []string{"index.html", "public/index.html", "dist/index.html", "build/index.html"}

// previewableExts are the file extensions the browser panel can render: HTML
// verbatim and Markdown converted to HTML by the preview/files route.
var previewableExts = map[string]struct{}{
	".html":     {},
	".htm":      {},
	".md":       {},
	".markdown": {},
}

// maxPreviewWalkFiles bounds the most-recent fallback scan so a pathological
// workspace cannot stall the preview poller.
const maxPreviewWalkFiles = 5000

// Entry is a workspace-local static frontend entrypoint.
type Entry struct {
	Path    string
	AbsPath string
	ModTime time.Time
	Size    int64
}

// DiscoverEntry returns the entry the browser panel should preview for a
// workspace. A conventional index.html (or its public/dist/build variants)
// always wins; when none exists it falls back to the most-recently-modified
// previewable file (.html/.htm/.md/.markdown) anywhere in the workspace, so a
// freshly generated report or document shows up automatically.
func DiscoverEntry(workspacePath string) (Entry, bool) {
	if strings.TrimSpace(workspacePath) == "" {
		return Entry{}, false
	}
	for _, candidate := range entryCandidates {
		file, ok := ConfinedPath(workspacePath, candidate)
		if !ok {
			continue
		}
		// Open beneath the workspace: an index.html that is a symlink to a host
		// file is not a workspace entry point, and must not be advertised as one.
		f, _, err := OpenConfined(workspacePath, candidate)
		if err != nil {
			continue
		}
		info, statErr := f.Stat()
		_ = f.Close()
		if statErr == nil {
			return Entry{Path: candidate, AbsPath: file, ModTime: info.ModTime(), Size: info.Size()}, true
		}
	}
	return mostRecentPreviewable(workspacePath)
}

// mostRecentPreviewable walks the workspace and returns the newest previewable
// file. Ties (equal mod times) break on the slash path so the result is
// deterministic. Hidden directories and node_modules are skipped, and the scan
// is bounded by maxPreviewWalkFiles.
//
// The walk runs beneath the confined workspace root (see openWorkspaceRoot), so
// it cannot be steered out of the workspace by a symlinked ancestor and never
// descends a symlinked directory: what it advertises is exactly what
// OpenConfined is willing to serve.
func mostRecentPreviewable(workspacePath string) (Entry, bool) {
	root, err := filepath.Abs(workspacePath)
	if err != nil {
		return Entry{}, false
	}
	dir, err := openWorkspaceRoot(root)
	if err != nil {
		return Entry{}, false
	}
	defer func() { _ = dir.Close() }()

	var best Entry
	found := false
	seen := 0
	_ = fs.WalkDir(dir.FS(), ".", func(p string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			//nolint:nilerr // skip unreadable entries rather than aborting the whole scan
			return nil
		}
		if d.IsDir() {
			if p != "." && skipPreviewDir(d.Name()) {
				return fs.SkipDir
			}
			return nil
		}
		if !d.Type().IsRegular() {
			// A symlink is never a workspace entry point, however it resolves.
			return nil
		}
		if _, ok := previewableExts[strings.ToLower(path.Ext(d.Name()))]; !ok {
			return nil
		}
		seen++
		if seen > maxPreviewWalkFiles {
			return fs.SkipAll
		}
		info, err := d.Info()
		if err != nil {
			//nolint:nilerr // skip this file, keep scanning the rest of the workspace
			return nil
		}
		if !found || newerPreviewable(info, p, best) {
			best = Entry{
				Path:    p,
				AbsPath: filepath.Join(root, filepath.FromSlash(p)),
				ModTime: info.ModTime(),
				Size:    info.Size(),
			}
			found = true
		}
		return nil
	})
	return best, found
}

func newerPreviewable(info fs.FileInfo, relSlash string, best Entry) bool {
	mod := info.ModTime()
	if mod.After(best.ModTime) {
		return true
	}
	if mod.Equal(best.ModTime) {
		return relSlash < best.Path
	}
	return false
}

func skipPreviewDir(name string) bool {
	return strings.HasPrefix(name, ".") || name == "node_modules"
}

// IsMarkdownPath reports whether p names a Markdown file the preview/files
// route should render to HTML rather than serve verbatim.
func IsMarkdownPath(p string) bool {
	switch strings.ToLower(filepath.Ext(p)) {
	case ".md", ".markdown":
		return true
	}
	return false
}

// ConfinedPath maps an asset path into workspacePath and rejects paths that
// LEXICALLY escape the workspace root.
//
// It is a naming helper only. A lexically-confined path can still resolve
// outside the workspace through a symlink, so it must never be handed to an
// opener that follows links (os.Open, http.ServeFile): every read of a
// workspace asset goes through OpenConfined instead.
func ConfinedPath(workspacePath, assetPath string) (string, bool) {
	root, err := filepath.Abs(workspacePath)
	if err != nil || root == "" {
		return "", false
	}
	clean := cleanAssetPath(assetPath)
	file := filepath.Join(root, filepath.FromSlash(clean))
	absFile, err := filepath.Abs(file)
	if err != nil {
		return "", false
	}
	rel, err := filepath.Rel(root, absFile)
	if err != nil || rel == "." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || rel == ".." {
		return "", false
	}
	return absFile, true
}

// OpenConfined opens a workspace asset for reading — beneath workspacePath and
// nowhere else. Confinement is enforced by the open-beneath primitive (os.Root,
// which uses openat2/RESOLVE_BENEATH where the platform provides it), so it
// holds AFTER symlink resolution and against a workspace the agent is
// concurrently mutating: a workspace-local symlink pointing at a host file
// (`secret -> /etc/passwd`) is refused, not followed.
//
// The workspace root itself is acquired through its parent directory (see
// openWorkspaceRoot), because os.Root only confines paths opened BENEATH it —
// it still follows symlinks in the root's own name.
//
// Only regular files open; a directory yields fs.ErrNotExist so the preview
// surface never lists a workspace tree. It returns the opened file (the
// caller's to close) and the cleaned workspace-relative path.
func OpenConfined(workspacePath, assetPath string) (*os.File, string, error) {
	root, err := filepath.Abs(strings.TrimSpace(workspacePath))
	if err != nil || root == "" {
		return nil, "", fs.ErrNotExist
	}
	clean := cleanAssetPath(assetPath)
	dir, err := openWorkspaceRoot(root)
	if err != nil {
		return nil, "", err
	}
	defer func() { _ = dir.Close() }()

	file, err := dir.Open(filepath.FromSlash(clean))
	if err != nil {
		return nil, "", err
	}
	info, err := file.Stat()
	if err != nil {
		_ = file.Close()
		return nil, "", err
	}
	if !info.Mode().IsRegular() {
		_ = file.Close()
		return nil, "", fs.ErrNotExist
	}
	return file, clean, nil
}

// openWorkspaceRoot opens the workspace directory as an os.Root reached without
// following a symlink ANYWHERE in its path — not in the workspace's own name,
// and not in any ancestor.
//
// os.OpenRoot(dir) resolves `dir` like any other path, so anchoring on the
// workspace's parent still leaves every component above the workspace
// unprotected. No component of a workspace path is trustworthy: an in-place
// session runs in an arbitrary registered repository path, a managed worktree
// sits under several mutable directories, and the agent — same user, no sandbox
// — can rename any of them. An agent that renames `…/sandbox` and drops a
// symlink to its home directory in its place leaves the stored workspace path
// (`…/sandbox/<repo>`) resolving into the host tree, and the preview endpoint
// serves whatever lives there.
//
// The one anchor that cannot be a symlink is the filesystem root. Descend from
// it one component at a time, refusing any component that is not a real
// directory, so confinement is acquired through a chain of directories the
// kernel opened by name and never through a link.
//
// A workspace path that legitimately crosses a symlink therefore has no
// preview: the surface fails closed rather than resolving a link it cannot
// attribute to the daemon.
func openWorkspaceRoot(workspacePath string) (*os.Root, error) {
	anchor, components := splitAtFilesystemRoot(workspacePath)
	if len(components) == 0 {
		// A filesystem root is never a session workspace.
		return nil, fs.ErrNotExist
	}
	root, err := os.OpenRoot(anchor)
	if err != nil {
		return nil, err
	}
	for _, name := range components {
		next, err := openDirNoSymlink(root, name)
		_ = root.Close()
		if err != nil {
			return nil, err
		}
		root = next
	}
	return root, nil
}

// openDirNoSymlink opens name — a single component directly beneath root — as
// its own os.Root, refusing a symlink at that component.
//
// The workspace is agent-writable while the daemon reads it, so the name is
// checked and then re-verified against what was actually opened: os.SameFile
// refuses a component whose identity changed between the check and the open
// (renamed away and replaced with a symlink or another directory). Either the
// directory now held is the one that was checked to be a real directory, or the
// open fails.
func openDirNoSymlink(root *os.Root, name string) (*os.Root, error) {
	checked, err := root.Lstat(name)
	if err != nil {
		return nil, err
	}
	if !checked.IsDir() {
		// Lstat does not follow the final component, so a symlink reports as one
		// here — never as the directory it points at.
		return nil, fs.ErrNotExist
	}
	next, err := root.OpenRoot(name)
	if err != nil {
		return nil, err
	}
	opened, err := next.Stat(".")
	if err != nil {
		_ = next.Close()
		return nil, err
	}
	if !os.SameFile(checked, opened) {
		_ = next.Close()
		return nil, fs.ErrNotExist
	}
	return next, nil
}

// splitAtFilesystemRoot splits an absolute path into its filesystem root (the
// trusted anchor: "/" on unix, the volume root on windows) and the components
// below it, outermost first.
func splitAtFilesystemRoot(abs string) (string, []string) {
	var components []string
	for {
		parent := filepath.Dir(abs)
		if parent == abs {
			slices.Reverse(components)
			return abs, components
		}
		base := filepath.Base(abs)
		if base == "." || base == ".." {
			// Not reachable for a cleaned absolute path; refuse rather than guess.
			return abs, nil
		}
		components = append(components, base)
		abs = parent
	}
}

// cleanAssetPath normalizes a requested asset path to a workspace-relative
// slash path, defaulting to index.html. Physical confinement is OpenConfined's
// job, not this function's.
func cleanAssetPath(assetPath string) string {
	clean := strings.TrimPrefix(path.Clean("/"+strings.TrimSpace(assetPath)), "/")
	if clean == "" || clean == "." {
		return "index.html"
	}
	return clean
}

// FileURL builds the daemon preview/files URL for a workspace-local entry.
func FileURL(baseURL string, id domain.SessionID, entry string) string {
	u := normalizedBaseURL(baseURL)
	u.Path = "/api/v1/sessions/" + url.PathEscape(string(id)) + "/preview/files/" + escapePath(entry)
	u.RawQuery = ""
	u.Fragment = ""
	return u.String()
}

func normalizedBaseURL(raw string) url.URL {
	raw = strings.TrimRight(strings.TrimSpace(raw), "/")
	if raw == "" {
		raw = "http://127.0.0.1:3001"
	}
	if !strings.Contains(raw, "://") {
		raw = "http://" + raw
	}
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return url.URL{Scheme: "http", Host: raw}
	}
	return *u
}

func escapePath(raw string) string {
	parts := strings.Split(raw, "/")
	for i, part := range parts {
		parts[i] = url.PathEscape(part)
	}
	return strings.Join(parts, "/")
}
