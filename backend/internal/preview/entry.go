package preview

import (
	"io/fs"
	"net/url"
	"os"
	"path"
	"path/filepath"
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
		info, err := os.Stat(file)
		if err == nil && !info.IsDir() {
			return Entry{Path: candidate, AbsPath: file, ModTime: info.ModTime(), Size: info.Size()}, true
		}
	}
	return mostRecentPreviewable(workspacePath)
}

// mostRecentPreviewable walks the workspace and returns the newest previewable
// file. Ties (equal mod times) break on the slash path so the result is
// deterministic. Hidden directories and node_modules are skipped, and the scan
// is bounded by maxPreviewWalkFiles.
func mostRecentPreviewable(workspacePath string) (Entry, bool) {
	root, err := filepath.Abs(workspacePath)
	if err != nil {
		return Entry{}, false
	}
	var best Entry
	found := false
	seen := 0
	_ = filepath.WalkDir(root, func(p string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			//nolint:nilerr // skip unreadable entries rather than aborting the whole scan
			return nil
		}
		if d.IsDir() {
			if p != root && skipPreviewDir(d.Name()) {
				return filepath.SkipDir
			}
			return nil
		}
		if _, ok := previewableExts[strings.ToLower(filepath.Ext(d.Name()))]; !ok {
			return nil
		}
		seen++
		if seen > maxPreviewWalkFiles {
			return filepath.SkipAll
		}
		info, err := d.Info()
		if err != nil {
			//nolint:nilerr // skip this file, keep scanning the rest of the workspace
			return nil
		}
		rel, err := filepath.Rel(root, p)
		if err != nil {
			//nolint:nilerr // skip this file, keep scanning the rest of the workspace
			return nil
		}
		relSlash := filepath.ToSlash(rel)
		if !found || newerPreviewable(info, relSlash, best) {
			best = Entry{Path: relSlash, AbsPath: p, ModTime: info.ModTime(), Size: info.Size()}
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
// escape the workspace root.
func ConfinedPath(workspacePath, assetPath string) (string, bool) {
	root, err := filepath.Abs(workspacePath)
	if err != nil || root == "" {
		return "", false
	}
	clean := strings.TrimPrefix(path.Clean("/"+strings.TrimSpace(assetPath)), "/")
	if clean == "" || clean == "." {
		clean = "index.html"
	}
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
