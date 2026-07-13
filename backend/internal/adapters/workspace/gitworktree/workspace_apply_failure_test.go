package gitworktree

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// failingCherryPickGit writes a git wrapper that proxies every subcommand to the
// real git EXCEPT cherry-pick, which fails the way an operational problem fails:
// non-zero exit, nothing merged, no unmerged index entries. This stands in for a
// disk-full, permission-denied, cancelled-context or unwritable-index apply.
func failingCherryPickGit(t *testing.T, realGit, dir string) string {
	t.Helper()
	script := filepath.Join(dir, "git-cherry-pick-fails")
	body := "#!/bin/sh\nfor arg in \"$@\"; do\n  if [ \"$arg\" = \"cherry-pick\" ]; then\n    echo 'fatal: Unable to write new index file' >&2\n    exit 128\n  fi\ndone\nexec " + realGit + " \"$@\"\n"
	if err := os.WriteFile(script, []byte(body), 0o755); err != nil {
		t.Fatalf("write git wrapper: %v", err)
	}
	return script
}

// TestApplyPreservedOperationalFailureIsNotConflict pins #293 M3's production
// half: ApplyPreserved classified EVERY non-zero cherry-pick exit as an
// intentional merge conflict. That classification is what the session manager
// keys on — ErrPreservedConflict means "markers are in the tree, relaunch the
// agent and consume the retry marker" — so an operational failure (disk full,
// permission denied, unwritable index) silently discarded the agent's preserved
// work. Only a real conflict, which leaves unmerged entries in the index, may
// carry the sentinel.
func TestApplyPreservedOperationalFailureIsNotConflict(t *testing.T) {
	realGit := requireGit(t)
	tmp := t.TempDir()
	repo := setupOriginClone(t, realGit, tmp)
	root := filepath.Join(tmp, "managed")

	// Capture a preserve ref with a working git...
	ws, err := New(Options{Binary: realGit, ManagedRoot: root, RepoResolver: StaticRepoResolver{"proj": repo}})
	if err != nil {
		t.Fatalf("new: %v", err)
	}
	ctx := context.Background()
	cfg := ports.WorkspaceConfig{ProjectID: "proj", SessionID: "sess-oper", Branch: "feature/oper"}
	info, err := ws.Create(ctx, cfg)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if err := os.WriteFile(filepath.Join(info.Path, "README.md"), []byte("agent work\n"), 0o644); err != nil {
		t.Fatalf("write README: %v", err)
	}
	ref, err := ws.StashUncommitted(ctx, info)
	if err != nil {
		t.Fatalf("StashUncommitted: %v", err)
	}
	if ref == "" {
		t.Fatal("StashUncommitted returned an empty ref for a dirty worktree")
	}
	// Drop the in-flight edit, as tearing the worktree down and re-adding it does
	// on the real restore path: the preserved work is now genuinely missing from
	// the worktree, so a failed replay really does lose it.
	runGit(t, realGit, info.Path, "checkout", "--", "README.md")

	// ...then replay it with a git whose merge step fails operationally.
	broken, err := New(Options{
		Binary:       failingCherryPickGit(t, realGit, tmp),
		ManagedRoot:  root,
		RepoResolver: StaticRepoResolver{"proj": repo},
	})
	if err != nil {
		t.Fatalf("new broken: %v", err)
	}

	applyErr := broken.ApplyPreserved(ctx, info, ref)
	if applyErr == nil {
		t.Fatal("ApplyPreserved returned nil for a failed merge step")
	}
	if errors.Is(applyErr, ErrPreservedConflict) {
		t.Fatalf("operational failure classified as an intentional conflict: %v", applyErr)
	}

	// The preserve ref must survive so the replay stays retryable.
	if _, err := ws.run(ctx, ws.binary, revParseVerifyArgs(repo, ref)...); err != nil {
		t.Fatalf("preserve ref %q was deleted after a failed apply: %v", ref, err)
	}
}

// TestApplyPreservedRerereResolvedConflictIsStillAConflict pins #293 M3 cycle 2:
// the index test only tells a conflict apart from an operational failure if the
// index is allowed to keep the conflict. With rerere.enabled + rerere.autoupdate
// — an ordinary developer config, inherited by every worktree of the repo — git
// replays a recorded resolution and STAGES it, so a conflicted cherry-pick exits
// non-zero with ZERO unmerged entries. Classified as an operational failure, the
// session manager leaves the session terminated and keeps its retry marker
// forever: data-safe, but restoration never completes.
func TestApplyPreservedRerereResolvedConflictIsStillAConflict(t *testing.T) {
	git := requireGit(t)
	tmp := t.TempDir()
	repo := setupOriginClone(t, git, tmp)
	root := filepath.Join(tmp, "managed")
	ws, err := New(Options{Binary: git, ManagedRoot: root, RepoResolver: StaticRepoResolver{"proj": repo}})
	if err != nil {
		t.Fatalf("new: %v", err)
	}
	ctx := context.Background()
	cfg := ports.WorkspaceConfig{ProjectID: "proj", SessionID: "sess-rerere", Branch: "feature/rerere"}

	// The repo — and therefore every worktree of it — reuses recorded conflict
	// resolutions and stages them automatically.
	runGit(t, git, repo, "config", "rerere.enabled", "true")
	runGit(t, git, repo, "config", "rerere.autoupdate", "true")

	info, err := ws.Create(ctx, cfg)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	shared := filepath.Join(info.Path, "shared.txt")
	writeFile(t, shared, "A\n")
	runGit(t, git, info.Path, "add", "shared.txt")
	runGit(t, git, info.Path, "commit", "-m", "base: A")

	// The agent's in-flight edit (A -> B), captured on close.
	writeFile(t, shared, "B\n")
	ref, err := ws.StashUncommitted(ctx, info)
	if err != nil {
		t.Fatalf("StashUncommitted: %v", err)
	}

	// The worktree diverges (A -> C), so replaying B conflicts.
	writeFile(t, shared, "C\n")
	runGit(t, git, info.Path, "add", "shared.txt")

	// Teach rerere this exact conflict once: apply, resolve, record.
	if applyErr := ws.ApplyPreserved(ctx, info, ref); !errors.Is(applyErr, ErrPreservedConflict) {
		t.Fatalf("seeding apply: error = %v, want ErrPreservedConflict", applyErr)
	}
	writeFile(t, shared, "R\n")
	runGit(t, git, info.Path, "add", "shared.txt")
	runGit(t, git, info.Path, "rerere")

	// Re-stage the diverging tree and replay the same conflict. rerere now
	// resolves it and (autoupdate) leaves the index with no unmerged entries.
	runGit(t, git, info.Path, "reset", "--hard", "HEAD")
	writeFile(t, shared, "C\n")
	runGit(t, git, info.Path, "add", "shared.txt")

	applyErr := ws.ApplyPreserved(ctx, info, ref)
	if applyErr == nil {
		t.Fatal("ApplyPreserved returned nil for a conflicting replay")
	}
	if !errors.Is(applyErr, ErrPreservedConflict) {
		t.Fatalf("rerere-resolved conflict classified as an operational failure: %v", applyErr)
	}
	if _, err := ws.run(ctx, ws.binary, revParseVerifyArgs(repo, ref)...); err != nil {
		t.Fatalf("preserve ref %q was deleted after a conflicting apply: %v", ref, err)
	}
}

// TestApplyPreservedRedundantApplyIsNotAnOperationalFailure pins the other half
// of the classifier: a cherry-pick that fails with nothing left to apply — the
// preserved work is ALREADY in the worktree — is not an operational failure.
// Reporting it as one keeps the session's retry marker forever and stalls
// restoration on every subsequent boot, on work that is not even missing. The
// worktree already matching the preserved snapshot is a completed apply: drop
// the ref and let the restore proceed.
func TestApplyPreservedRedundantApplyIsNotAnOperationalFailure(t *testing.T) {
	realGit := requireGit(t)
	tmp := t.TempDir()
	repo := setupOriginClone(t, realGit, tmp)
	root := filepath.Join(tmp, "managed")
	ws, err := New(Options{Binary: realGit, ManagedRoot: root, RepoResolver: StaticRepoResolver{"proj": repo}})
	if err != nil {
		t.Fatalf("new: %v", err)
	}
	ctx := context.Background()
	cfg := ports.WorkspaceConfig{ProjectID: "proj", SessionID: "sess-redundant", Branch: "feature/redundant"}
	info, err := ws.Create(ctx, cfg)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	writeFile(t, filepath.Join(info.Path, "README.md"), "agent work\n")
	ref, err := ws.StashUncommitted(ctx, info)
	if err != nil {
		t.Fatalf("StashUncommitted: %v", err)
	}

	// The worktree still holds exactly the preserved snapshot, so replaying it
	// has nothing to do. Stand in for the gits that exit non-zero on that empty
	// apply rather than silently succeeding.
	broken, err := New(Options{
		Binary:       failingCherryPickGit(t, realGit, tmp),
		ManagedRoot:  root,
		RepoResolver: StaticRepoResolver{"proj": repo},
	})
	if err != nil {
		t.Fatalf("new broken: %v", err)
	}

	if applyErr := broken.ApplyPreserved(ctx, info, ref); applyErr != nil {
		t.Fatalf("ApplyPreserved on an already-applied snapshot = %v, want nil", applyErr)
	}
	// The ref is consumed: the work is present, and a ref left behind would be
	// replayed on the next boot.
	if _, err := ws.run(ctx, ws.binary, revParseVerifyArgs(repo, ref)...); err == nil {
		t.Fatalf("preserve ref %q survived a completed apply", ref)
	}
}

// TestApplyPreservedMalformedRefIsNotMissing pins #293 M3 cycle 3: ApplyPreserved
// resolved the preserve ref with `git for-each-ref <ref>` and read "exit 0 with
// empty output" as the unambiguous "the ref is GONE" signal — the typed outcome
// the session manager reads as "already consumed", clearing the row and dropping
// the retry marker. But for-each-ref exits 0 and prints nothing for a MALFORMED
// ref name too ("refs/bad name", "refs/*"), so gone and malformed were
// indistinguishable and a malformed name silently orphaned the agent's preserved
// work. A malformed name must be a loud error that keeps the ref and the marker.
func TestApplyPreservedMalformedRefIsNotMissing(t *testing.T) {
	git := requireGit(t)
	tmp := t.TempDir()
	repo := setupOriginClone(t, git, tmp)
	root := filepath.Join(tmp, "managed")
	ws, err := New(Options{Binary: git, ManagedRoot: root, RepoResolver: StaticRepoResolver{"proj": repo}})
	if err != nil {
		t.Fatalf("new: %v", err)
	}
	ctx := context.Background()
	info, err := ws.Create(ctx, ports.WorkspaceConfig{ProjectID: "proj", SessionID: "sess-malformed", Branch: "feature/malformed"})
	if err != nil {
		t.Fatalf("create: %v", err)
	}

	for _, ref := range []string{
		"refs/ao/preserved/bad name", // a space is not allowed in a ref name
		"refs/ao/preserved/a..b",     // ".." is not allowed in a ref name
		"refs/ao/preserved/*",        // a glob names no single ref
	} {
		applyErr := ws.ApplyPreserved(ctx, info, ref)
		if applyErr == nil {
			t.Fatalf("ApplyPreserved(%q) = nil, want a hard error for a malformed ref name", ref)
		}
		if errors.Is(applyErr, ErrPreservedRefMissing) {
			t.Fatalf("malformed ref %q classified as already-consumed (ErrPreservedRefMissing): %v", ref, applyErr)
		}
	}
}

// TestApplyPreservedRefResolutionIsExact pins the other half of the same
// ambiguity: for-each-ref treats its argument as a PATTERN and prefix-matches at
// "/" boundaries, so a missing refs/ao/preserved/<id> resolves to the object of
// an unrelated refs/ao/preserved/<id>/<child>. That is worse than misreading the
// empty case — it replays somebody else's commit into the worktree. Resolution
// must be exact: no exact hit means the ref is genuinely gone.
func TestApplyPreservedRefResolutionIsExact(t *testing.T) {
	git := requireGit(t)
	tmp := t.TempDir()
	repo := setupOriginClone(t, git, tmp)
	root := filepath.Join(tmp, "managed")
	ws, err := New(Options{Binary: git, ManagedRoot: root, RepoResolver: StaticRepoResolver{"proj": repo}})
	if err != nil {
		t.Fatalf("new: %v", err)
	}
	ctx := context.Background()
	info, err := ws.Create(ctx, ports.WorkspaceConfig{ProjectID: "proj", SessionID: "sess-exact", Branch: "feature/exact"})
	if err != nil {
		t.Fatalf("create: %v", err)
	}

	// A real preserve commit, parked under a ref that is a "/"-child of the ref
	// the caller will ask for. The asked-for ref itself never exists.
	writeFile(t, filepath.Join(info.Path, "README.md"), "other session's work\n")
	child, err := ws.StashUncommitted(ctx, info)
	if err != nil {
		t.Fatalf("StashUncommitted: %v", err)
	}
	preserved := strings.TrimSpace(string(mustRun(ctx, t, ws, revParseVerifyArgs(repo, child))))
	// git forbids a ref and a ref/<child> coexisting, so retire the parent first:
	// the end state is exactly the one that matters — only the /child ref exists.
	runGit(t, git, repo, "update-ref", "-d", child)
	runGit(t, git, repo, "update-ref", child+"/child", preserved)
	runGit(t, git, info.Path, "checkout", "--", ".")

	applyErr := ws.ApplyPreserved(ctx, info, child)
	if !errors.Is(applyErr, ErrPreservedRefMissing) {
		t.Fatalf("ApplyPreserved(%q) = %v, want ErrPreservedRefMissing — the ref does not exist; only its /child does", child, applyErr)
	}
}

func mustRun(ctx context.Context, t *testing.T, ws *Workspace, args []string) []byte {
	t.Helper()
	out, err := ws.run(ctx, ws.binary, args...)
	if err != nil {
		t.Fatalf("git %v: %v", args, err)
	}
	return out
}

func writeFile(t *testing.T, path, contents string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(contents), 0o644); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}
