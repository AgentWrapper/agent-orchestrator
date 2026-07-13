package preview

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func writeEntryFile(t *testing.T, path, contents string, mod time.Time) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", filepath.Dir(path), err)
	}
	if err := os.WriteFile(path, []byte(contents), 0o644); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
	if !mod.IsZero() {
		if err := os.Chtimes(path, mod, mod); err != nil {
			t.Fatalf("chtimes %s: %v", path, err)
		}
	}
}

func TestDiscoverEntryPrefersIndexOverNewerFile(t *testing.T) {
	ws := t.TempDir()
	base := time.Now()
	writeEntryFile(t, filepath.Join(ws, "index.html"), "<main>app</main>", base)
	// A newer report must not win against the conventional index.html anchor.
	writeEntryFile(t, filepath.Join(ws, "report.html"), "<main>report</main>", base.Add(time.Hour))

	entry, ok := DiscoverEntry(ws)
	if !ok {
		t.Fatal("DiscoverEntry: ok=false, want entry")
	}
	if entry.Path != "index.html" {
		t.Fatalf("entry.Path = %q, want index.html", entry.Path)
	}
}

func TestDiscoverEntryFallsBackToMostRecentPreviewable(t *testing.T) {
	ws := t.TempDir()
	base := time.Now()
	writeEntryFile(t, filepath.Join(ws, "old.html"), "<main>old</main>", base)
	writeEntryFile(t, filepath.Join(ws, "docs", "notes.md"), "# notes", base.Add(30*time.Minute))
	writeEntryFile(t, filepath.Join(ws, "fresh.html"), "<main>fresh</main>", base.Add(time.Hour))

	entry, ok := DiscoverEntry(ws)
	if !ok {
		t.Fatal("DiscoverEntry: ok=false, want fallback entry")
	}
	if entry.Path != "fresh.html" {
		t.Fatalf("entry.Path = %q, want fresh.html", entry.Path)
	}
}

func TestDiscoverEntryFallsBackToMarkdown(t *testing.T) {
	ws := t.TempDir()
	writeEntryFile(t, filepath.Join(ws, "REPORT.md"), "# report", time.Now())

	entry, ok := DiscoverEntry(ws)
	if !ok {
		t.Fatal("DiscoverEntry: ok=false, want markdown fallback")
	}
	if entry.Path != "REPORT.md" {
		t.Fatalf("entry.Path = %q, want REPORT.md", entry.Path)
	}
}

func TestDiscoverEntrySkipsHiddenAndNodeModules(t *testing.T) {
	ws := t.TempDir()
	base := time.Now()
	// Newest files live in skipped dirs; the visible one must win.
	writeEntryFile(t, filepath.Join(ws, "node_modules", "pkg", "index.html"), "x", base.Add(time.Hour))
	writeEntryFile(t, filepath.Join(ws, ".cache", "cached.html"), "x", base.Add(2*time.Hour))
	writeEntryFile(t, filepath.Join(ws, "visible.html"), "ok", base)

	entry, ok := DiscoverEntry(ws)
	if !ok {
		t.Fatal("DiscoverEntry: ok=false, want visible entry")
	}
	if entry.Path != "visible.html" {
		t.Fatalf("entry.Path = %q, want visible.html", entry.Path)
	}
}

func TestDiscoverEntryTieBreaksOnPath(t *testing.T) {
	ws := t.TempDir()
	mod := time.Now()
	writeEntryFile(t, filepath.Join(ws, "b.html"), "b", mod)
	writeEntryFile(t, filepath.Join(ws, "a.html"), "a", mod)

	entry, ok := DiscoverEntry(ws)
	if !ok {
		t.Fatal("DiscoverEntry: ok=false, want tie-break entry")
	}
	if entry.Path != "a.html" {
		t.Fatalf("entry.Path = %q, want a.html (lexical tie-break)", entry.Path)
	}
}

func TestDiscoverEntryEmptyWorkspace(t *testing.T) {
	if _, ok := DiscoverEntry(t.TempDir()); ok {
		t.Fatal("DiscoverEntry: ok=true for empty workspace, want false")
	}
}

func TestIsMarkdownPath(t *testing.T) {
	cases := map[string]bool{
		"a.md":       true,
		"A.MARKDOWN": true,
		"dir/x.md":   true,
		"index.html": false,
		"notes.txt":  false,
		"noext":      false,
	}
	for in, want := range cases {
		if got := IsMarkdownPath(in); got != want {
			t.Errorf("IsMarkdownPath(%q) = %v, want %v", in, got, want)
		}
	}
}

// TestOpenConfinedRejectsSymlinkedWorkspaceRoot pins #293 H2's remaining hole:
// os.OpenRoot follows symlinks in the ROOT's own name, so a workspace directory
// replaced by a symlink to the host filesystem (an agent can do this inside its
// own workspace) would silently re-root confinement at the link's target and
// serve host files. Confinement must be acquired without following the
// workspace's final path component.
func TestOpenConfinedRejectsSymlinkedWorkspaceRoot(t *testing.T) {
	tmp := t.TempDir()
	outside := filepath.Join(tmp, "outside")
	if err := os.MkdirAll(filepath.Join(outside, "etc"), 0o755); err != nil {
		t.Fatalf("mkdir outside: %v", err)
	}
	writeEntryFile(t, filepath.Join(outside, "etc", "passwd"), "root:x:0:0", time.Time{})

	// The session's workspace directory IS a symlink pointing out of the managed
	// tree — the escape the nested-symlink guard does not see.
	ws := filepath.Join(tmp, "workspace")
	if err := os.Symlink(outside, ws); err != nil {
		t.Fatalf("symlink workspace: %v", err)
	}

	f, _, err := OpenConfined(ws, "etc/passwd")
	if err == nil {
		_ = f.Close()
		t.Fatal("OpenConfined served a file through a symlinked workspace root; confinement escaped")
	}
}

// TestOpenConfinedRejectsSymlinkedWorkspaceParent pins the managed-worktree
// shape of #293 H2 cycle 2: protecting only the workspace's FINAL component is
// not enough. os.OpenRoot(parent) resolves `parent` — and everything above it —
// like any other path, so an agent that renames its workspace's parent
// directory and drops a symlink to the host tree in its place re-roots
// confinement at the link's target while the stored workspace path is
// unchanged. Every component of the workspace path is agent-writable; none of
// them may be followed through a symlink.
func TestOpenConfinedRejectsSymlinkedWorkspaceParent(t *testing.T) {
	tmp := realTempDir(t)
	// The host tree the agent wants read: it carries the SAME final component
	// name as the workspace, so the stored path still resolves after the swap.
	host := filepath.Join(tmp, "host")
	writeEntryFile(t, filepath.Join(host, "session", "secret.html"), "<main>host secret</main>", time.Time{})
	// The real managed tree.
	writeEntryFile(t, filepath.Join(tmp, "real", "session", "index.html"), "<main>app</main>", time.Time{})

	// The agent renames `<tmp>/managed` away and replaces it with a symlink to
	// the host tree. The daemon still holds `<tmp>/managed/session`.
	if err := os.Symlink(host, filepath.Join(tmp, "managed")); err != nil {
		t.Fatalf("symlink managed root: %v", err)
	}
	ws := filepath.Join(tmp, "managed", "session")

	f, _, err := OpenConfined(ws, "secret.html")
	if err == nil {
		_ = f.Close()
		t.Fatal("OpenConfined served a host file through a symlinked workspace PARENT; confinement escaped")
	}
	if _, ok := DiscoverEntry(ws); ok {
		t.Fatal("DiscoverEntry advertised an entry through a symlinked workspace PARENT")
	}
}

// TestOpenConfinedRejectsSymlinkedWorkspaceAncestor pins the in-place shape: an
// in-place session's workspace is an arbitrary registered repository path, so
// the escape needs no daemon-managed directory at all — swapping ANY ancestor
// component (here the grandparent) for a symlink re-roots the preview surface
// at the link's target.
func TestOpenConfinedRejectsSymlinkedWorkspaceAncestor(t *testing.T) {
	tmp := realTempDir(t)
	// `<tmp>/home/user/.ssh/id_ed25519.html`: the host material an escape reaches.
	host := filepath.Join(tmp, "home")
	writeEntryFile(t, filepath.Join(host, "user", ".ssh", "id.html"), "<main>host key</main>", time.Time{})
	// The registered in-place repo `<tmp>/sandbox/user/.ssh` (a real repo path).
	writeEntryFile(t, filepath.Join(tmp, "real", "user", ".ssh", "index.html"), "<main>app</main>", time.Time{})

	if err := os.Symlink(host, filepath.Join(tmp, "sandbox")); err != nil {
		t.Fatalf("symlink sandbox: %v", err)
	}
	ws := filepath.Join(tmp, "sandbox", "user", ".ssh")

	f, _, err := OpenConfined(ws, "id.html")
	if err == nil {
		_ = f.Close()
		t.Fatal("OpenConfined served a host file through a symlinked workspace ANCESTOR; confinement escaped")
	}
}

// realTempDir returns a t.TempDir() with every symlink resolved, so a test that
// asserts on symlink handling is asserting on the symlinks it created and not
// on one the platform put in TMPDIR (macOS resolves /var -> /private/var).
func realTempDir(t *testing.T) string {
	t.Helper()
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatalf("eval symlinks in temp dir: %v", err)
	}
	return dir
}

// A workspace root that is a real directory still serves its own files: the
// root-symlink guard must not break the ordinary preview path.
func TestOpenConfinedServesRealWorkspaceRoot(t *testing.T) {
	ws := t.TempDir()
	writeEntryFile(t, filepath.Join(ws, "sub", "index.html"), "<main>app</main>", time.Time{})

	f, name, err := OpenConfined(ws, "sub/index.html")
	if err != nil {
		t.Fatalf("OpenConfined: %v", err)
	}
	defer func() { _ = f.Close() }()
	if name != "sub/index.html" {
		t.Fatalf("name = %q, want sub/index.html", name)
	}
}
