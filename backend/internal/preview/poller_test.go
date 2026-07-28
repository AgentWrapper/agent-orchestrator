package preview

import (
	"context"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

type fakePreviewSessions struct {
	sessions []domain.SessionRecord
	sets     []previewSet
}

type previewSet struct {
	id  domain.SessionID
	url string
}

func (f *fakePreviewSessions) ListAllSessions(_ context.Context) ([]domain.SessionRecord, error) {
	return append([]domain.SessionRecord(nil), f.sessions...), nil
}

func (f *fakePreviewSessions) SetPreview(_ context.Context, id domain.SessionID, previewURL string) (domain.Session, error) {
	f.sets = append(f.sets, previewSet{id: id, url: previewURL})
	for i, sess := range f.sessions {
		if sess.ID == id {
			sess.Metadata.PreviewURL = previewURL
			f.sessions[i] = sess
			return domain.Session{SessionRecord: sess}, nil
		}
	}
	return domain.Session{}, nil
}

func TestPollerSetsPreviewWhenWorkerEntryAppearsAfterBaseline(t *testing.T) {
	workspace := t.TempDir()
	svc := &fakePreviewSessions{sessions: []domain.SessionRecord{workerSession("ao-1", workspace, "")}}
	poller := NewPoller(svc, svc, "http://127.0.0.1:3001", PollerConfig{Logger: discardLogger()})

	if err := poller.Poll(context.Background()); err != nil {
		t.Fatalf("baseline Poll: %v", err)
	}
	writeFile(t, filepath.Join(workspace, "index.html"), "<main>hello</main>")
	if err := poller.Poll(context.Background()); err != nil {
		t.Fatalf("creation Poll: %v", err)
	}

	assertSets(t, svc.sets, previewSet{
		id:  "ao-1",
		url: mustFileURL(t, "http://127.0.0.1:3001", "ao-1", "index.html"),
	})
}

func TestPollerDoesNotPreviewExistingEntryWithoutSessionChange(t *testing.T) {
	workspace := t.TempDir()
	writeFile(t, filepath.Join(workspace, "index.html"), "<main>existing</main>")
	svc := &fakePreviewSessions{sessions: []domain.SessionRecord{workerSession("ao-1", workspace, "")}}
	poller := NewPoller(svc, svc, "http://127.0.0.1:3001", PollerConfig{Logger: discardLogger()})

	if err := poller.Poll(context.Background()); err != nil {
		t.Fatalf("first Poll: %v", err)
	}
	if err := poller.Poll(context.Background()); err != nil {
		t.Fatalf("second Poll: %v", err)
	}
	assertSets(t, svc.sets)
}

func TestPollerDefersChangedEntryUntilWorkerFinishesActiveWork(t *testing.T) {
	workspace := t.TempDir()
	sess := workerSession("ao-1", workspace, "")
	sess.Activity.State = domain.ActivityActive
	svc := &fakePreviewSessions{sessions: []domain.SessionRecord{sess}}
	poller := NewPoller(svc, svc, "http://127.0.0.1:3001", PollerConfig{Logger: discardLogger()})

	if err := poller.Poll(context.Background()); err != nil {
		t.Fatalf("baseline Poll: %v", err)
	}
	writeFile(t, filepath.Join(workspace, "index.html"), "<main>finished UI</main>")
	if err := poller.Poll(context.Background()); err != nil {
		t.Fatalf("active Poll: %v", err)
	}
	assertSets(t, svc.sets)

	svc.sessions[0].Activity.State = domain.ActivityIdle
	if err := poller.Poll(context.Background()); err != nil {
		t.Fatalf("idle Poll: %v", err)
	}
	assertSets(t, svc.sets, previewSet{
		id:  "ao-1",
		url: mustFileURL(t, "http://127.0.0.1:3001", "ao-1", "index.html"),
	})
}

func TestPollerUsesFirstExistingEntrypoint(t *testing.T) {
	workspace := t.TempDir()
	svc := &fakePreviewSessions{sessions: []domain.SessionRecord{workerSession("ao-1", workspace, "")}}
	poller := NewPoller(svc, svc, "http://127.0.0.1:3001", PollerConfig{Logger: discardLogger()})

	if err := poller.Poll(context.Background()); err != nil {
		t.Fatalf("baseline Poll: %v", err)
	}
	writeFile(t, filepath.Join(workspace, "dist", "index.html"), "<main>dist</main>")
	if err := poller.Poll(context.Background()); err != nil {
		t.Fatalf("creation Poll: %v", err)
	}

	assertSets(t, svc.sets, previewSet{
		id:  "ao-1",
		url: mustFileURL(t, "http://127.0.0.1:3001", "ao-1", "dist/index.html"),
	})
}

func TestPollerPreservesEntrypointPriority(t *testing.T) {
	workspace := t.TempDir()
	svc := &fakePreviewSessions{sessions: []domain.SessionRecord{workerSession("ao-1", workspace, "")}}
	poller := NewPoller(svc, svc, "http://127.0.0.1:3001", PollerConfig{Logger: discardLogger()})

	if err := poller.Poll(context.Background()); err != nil {
		t.Fatalf("baseline Poll: %v", err)
	}
	writeFile(t, filepath.Join(workspace, "public", "index.html"), "<main>public</main>")
	writeFile(t, filepath.Join(workspace, "dist", "index.html"), "<main>dist</main>")
	if err := poller.Poll(context.Background()); err != nil {
		t.Fatalf("creation Poll: %v", err)
	}

	assertSets(t, svc.sets, previewSet{
		id:  "ao-1",
		url: mustFileURL(t, "http://127.0.0.1:3001", "ao-1", "public/index.html"),
	})
}

func TestPollerRefreshesOnlyWhenEntrypointChanges(t *testing.T) {
	workspace := t.TempDir()
	entry := filepath.Join(workspace, "index.html")
	writeFile(t, entry, "<main>v1</main>")
	svc := &fakePreviewSessions{sessions: []domain.SessionRecord{workerSession("ao-1", workspace, "")}}
	poller := NewPoller(svc, svc, "http://127.0.0.1:3001", PollerConfig{Logger: discardLogger()})

	if err := poller.Poll(context.Background()); err != nil {
		t.Fatalf("first Poll: %v", err)
	}
	if err := poller.Poll(context.Background()); err != nil {
		t.Fatalf("second Poll: %v", err)
	}
	if len(svc.sets) != 0 {
		t.Fatalf("sets after unchanged entry = %#v, want none", svc.sets)
	}

	writeFile(t, entry, "<main>v2 changed</main>")
	nextMod := time.Now().Add(2 * time.Second)
	if err := os.Chtimes(entry, nextMod, nextMod); err != nil {
		t.Fatalf("chtimes entry: %v", err)
	}
	if err := poller.Poll(context.Background()); err != nil {
		t.Fatalf("third Poll: %v", err)
	}

	if len(svc.sets) != 1 {
		t.Fatalf("sets after changed entry = %#v, want one refresh set", svc.sets)
	}
}

func TestPollerRefreshesWhenStaticPreviewAssetChanges(t *testing.T) {
	workspace := t.TempDir()
	writeFile(t, filepath.Join(workspace, "dist", "index.html"), `<link rel="stylesheet" href="/app.css">`)
	asset := filepath.Join(workspace, "dist", "app.css")
	writeFile(t, asset, "body { color: red; }")
	target := mustFileURL(t, "http://127.0.0.1:3001", "ao-1", "dist/index.html")
	svc := &fakePreviewSessions{sessions: []domain.SessionRecord{workerSession("ao-1", workspace, target)}}
	poller := NewPoller(svc, svc, "http://127.0.0.1:3001", PollerConfig{Logger: discardLogger()})

	if err := poller.Poll(context.Background()); err != nil {
		t.Fatalf("first Poll: %v", err)
	}
	if err := poller.Poll(context.Background()); err != nil {
		t.Fatalf("second Poll: %v", err)
	}
	if len(svc.sets) != 0 {
		t.Fatalf("sets after unchanged tree = %#v, want none", svc.sets)
	}

	writeFile(t, asset, "body { color: blue; }")
	nextMod := time.Now().Add(2 * time.Second)
	if err := os.Chtimes(asset, nextMod, nextMod); err != nil {
		t.Fatalf("chtimes asset: %v", err)
	}
	if err := poller.Poll(context.Background()); err != nil {
		t.Fatalf("third Poll: %v", err)
	}

	if len(svc.sets) != 1 {
		t.Fatalf("sets after changed asset = %#v, want one preview refresh", svc.sets)
	}
	if svc.sets[0].url != target {
		t.Fatalf("refresh url = %q, want unchanged target %q", svc.sets[0].url, target)
	}
}

func TestPollerRefreshesWhenMarkdownPreviewChanges(t *testing.T) {
	for _, extension := range []string{".md", ".markdown"} {
		t.Run(extension, func(t *testing.T) {
			workspace := t.TempDir()
			entry := filepath.Join(workspace, "notes"+extension)
			writeFile(t, entry, "# Version one")
			svc := &fakePreviewSessions{sessions: []domain.SessionRecord{workerSession("ao-1", workspace, "")}}
			poller := NewPoller(svc, svc, "http://127.0.0.1:3001", PollerConfig{Logger: discardLogger()})

			if err := poller.Poll(context.Background()); err != nil {
				t.Fatalf("first Poll: %v", err)
			}
			if len(svc.sets) != 0 {
				t.Fatalf("sets for unchanged existing markdown = %#v, want none", svc.sets)
			}
			writeFile(t, entry, "# Version two")
			nextMod := time.Now().Add(2 * time.Second)
			if err := os.Chtimes(entry, nextMod, nextMod); err != nil {
				t.Fatalf("chtimes markdown: %v", err)
			}
			if err := poller.Poll(context.Background()); err != nil {
				t.Fatalf("second Poll: %v", err)
			}

			if len(svc.sets) != 1 {
				t.Fatalf("sets after markdown change = %#v, want preview refresh", svc.sets)
			}
			if want := mustFileURL(t, "http://127.0.0.1:3001", "ao-1", "notes"+extension); svc.sets[0].url != want {
				t.Fatalf("refresh url = %q, want %q", svc.sets[0].url, want)
			}
		})
	}
}

func TestPollerShowsMarkdownCreatedAfterEmptyWorkspaceBaseline(t *testing.T) {
	workspace := t.TempDir()
	svc := &fakePreviewSessions{sessions: []domain.SessionRecord{workerSession("ao-1", workspace, "")}}
	poller := NewPoller(svc, svc, "http://127.0.0.1:3001", PollerConfig{Logger: discardLogger()})

	if err := poller.Poll(context.Background()); err != nil {
		t.Fatalf("baseline Poll: %v", err)
	}
	writeFile(t, filepath.Join(workspace, "report.md"), "# New report")
	if err := poller.Poll(context.Background()); err != nil {
		t.Fatalf("creation Poll: %v", err)
	}

	assertSets(t, svc.sets, previewSet{
		id:  "ao-1",
		url: mustFileURL(t, "http://127.0.0.1:3001", "ao-1", "report.md"),
	})
}

func TestPollerShowsHTMLCreatedAfterExistingMarkdownBaseline(t *testing.T) {
	workspace := t.TempDir()
	writeFile(t, filepath.Join(workspace, "README.md"), "# Existing documentation")
	svc := &fakePreviewSessions{sessions: []domain.SessionRecord{workerSession("ao-1", workspace, "")}}
	poller := NewPoller(svc, svc, "http://127.0.0.1:3001", PollerConfig{Logger: discardLogger()})

	if err := poller.Poll(context.Background()); err != nil {
		t.Fatalf("baseline Poll: %v", err)
	}
	writeFile(t, filepath.Join(workspace, "index.html"), "<main>New UI</main>")
	if err := poller.Poll(context.Background()); err != nil {
		t.Fatalf("creation Poll: %v", err)
	}

	assertSets(t, svc.sets, previewSet{
		id:  "ao-1",
		url: mustFileURL(t, "http://127.0.0.1:3001", "ao-1", "index.html"),
	})
}

func TestPollerFingerprintsAssetsOnlyForActiveStaticPreview(t *testing.T) {
	workspace := t.TempDir()
	writeFile(t, filepath.Join(workspace, "README.md"), "# Existing documentation")
	svc := &fakePreviewSessions{sessions: []domain.SessionRecord{workerSession("ao-1", workspace, "")}}
	poller := NewPoller(svc, svc, "http://127.0.0.1:3001", PollerConfig{Logger: discardLogger()})

	if err := poller.Poll(context.Background()); err != nil {
		t.Fatalf("hidden markdown Poll: %v", err)
	}
	if got := poller.seen["ao-1"].signature; got != 0 {
		t.Fatalf("hidden markdown signature = %d, want no asset fingerprint", got)
	}

	svc.sessions[0].Metadata.PreviewURL = "http://localhost:5173"
	if err := poller.Poll(context.Background()); err != nil {
		t.Fatalf("external preview Poll: %v", err)
	}
	if got := poller.seen["ao-1"].signature; got != 0 {
		t.Fatalf("external preview signature = %d, want no asset fingerprint", got)
	}
}

func TestPollerDoesNotShowUnchangedMarkdownWhenSiblingAssetChanges(t *testing.T) {
	workspace := t.TempDir()
	writeFile(t, filepath.Join(workspace, "report.md"), "# Existing report")
	asset := filepath.Join(workspace, "diagram.svg")
	writeFile(t, asset, "<svg/>")
	svc := &fakePreviewSessions{sessions: []domain.SessionRecord{workerSession("ao-1", workspace, "")}}
	poller := NewPoller(svc, svc, "http://127.0.0.1:3001", PollerConfig{Logger: discardLogger()})

	if err := poller.Poll(context.Background()); err != nil {
		t.Fatalf("baseline Poll: %v", err)
	}
	writeFile(t, asset, "<svg><path/></svg>")
	nextMod := time.Now().Add(2 * time.Second)
	if err := os.Chtimes(asset, nextMod, nextMod); err != nil {
		t.Fatalf("chtimes asset: %v", err)
	}
	if err := poller.Poll(context.Background()); err != nil {
		t.Fatalf("asset Poll: %v", err)
	}

	if len(svc.sets) != 0 {
		t.Fatalf("sets after sibling change = %#v, want unchanged markdown to remain hidden", svc.sets)
	}
}

func TestPollerIgnoresChangesOutsideStaticPreviewRoot(t *testing.T) {
	workspace := t.TempDir()
	writeFile(t, filepath.Join(workspace, "dist", "index.html"), "<main>preview</main>")
	source := filepath.Join(workspace, "src", "server.go")
	writeFile(t, source, "package main")
	target := mustFileURL(t, "http://127.0.0.1:3001", "ao-1", "dist/index.html")
	svc := &fakePreviewSessions{sessions: []domain.SessionRecord{workerSession("ao-1", workspace, target)}}
	poller := NewPoller(svc, svc, "http://127.0.0.1:3001", PollerConfig{Logger: discardLogger()})

	if err := poller.Poll(context.Background()); err != nil {
		t.Fatalf("first Poll: %v", err)
	}
	writeFile(t, source, "package changed")
	nextMod := time.Now().Add(2 * time.Second)
	if err := os.Chtimes(source, nextMod, nextMod); err != nil {
		t.Fatalf("chtimes source: %v", err)
	}
	if err := poller.Poll(context.Background()); err != nil {
		t.Fatalf("second Poll: %v", err)
	}

	if len(svc.sets) != 0 {
		t.Fatalf("sets after change outside dist = %#v, want no refresh", svc.sets)
	}
}

func TestPollerIgnoresNodeModulesChangesForRootPreview(t *testing.T) {
	workspace := t.TempDir()
	writeFile(t, filepath.Join(workspace, "index.html"), "<main>preview</main>")
	dependency := filepath.Join(workspace, "node_modules", "pkg", "index.js")
	writeFile(t, dependency, "old")
	target := mustFileURL(t, "http://127.0.0.1:3001", "ao-1", "index.html")
	svc := &fakePreviewSessions{sessions: []domain.SessionRecord{workerSession("ao-1", workspace, target)}}
	poller := NewPoller(svc, svc, "http://127.0.0.1:3001", PollerConfig{Logger: discardLogger()})

	if err := poller.Poll(context.Background()); err != nil {
		t.Fatalf("first Poll: %v", err)
	}
	writeFile(t, dependency, "new")
	nextMod := time.Now().Add(2 * time.Second)
	if err := os.Chtimes(dependency, nextMod, nextMod); err != nil {
		t.Fatalf("chtimes dependency: %v", err)
	}
	if err := poller.Poll(context.Background()); err != nil {
		t.Fatalf("second Poll: %v", err)
	}

	if len(svc.sets) != 0 {
		t.Fatalf("sets after node_modules change = %#v, want no refresh", svc.sets)
	}
}

func TestPollerRediscoverEntryAfterDeleteAndRecreate(t *testing.T) {
	workspace := t.TempDir()
	entry := filepath.Join(workspace, "index.html")
	writeFile(t, entry, "<main>v1</main>")
	wantURL := mustFileURL(t, "http://127.0.0.1:3001", "ao-1", "index.html")
	svc := &fakePreviewSessions{sessions: []domain.SessionRecord{workerSession("ao-1", workspace, wantURL)}}
	poller := NewPoller(svc, svc, "http://127.0.0.1:3001", PollerConfig{Logger: discardLogger()})

	// First poll baselines the already-active preview.
	if err := poller.Poll(context.Background()); err != nil {
		t.Fatalf("first Poll: %v", err)
	}
	assertSets(t, svc.sets)

	// Delete the entry — poller must clear the preview and mark the session cleared.
	if err := os.Remove(entry); err != nil {
		t.Fatalf("remove index.html: %v", err)
	}
	if err := poller.Poll(context.Background()); err != nil {
		t.Fatalf("second Poll (delete): %v", err)
	}
	if len(svc.sets) != 1 {
		t.Fatalf("sets after delete = %#v, want clear", svc.sets)
	}
	if svc.sets[0].url != "" {
		t.Fatalf("clear set.url = %q, want empty", svc.sets[0].url)
	}

	// Recreate the entry — poller must re-discover.
	writeFile(t, entry, "<main>v2</main>")
	if err := poller.Poll(context.Background()); err != nil {
		t.Fatalf("third Poll (recreate): %v", err)
	}
	if len(svc.sets) != 2 {
		t.Fatalf("sets after recreate = %#v, want clear + rediscover", svc.sets)
	}
	if svc.sets[1].url != wantURL {
		t.Fatalf("rediscovered set.url = %q, want %q", svc.sets[1].url, wantURL)
	}
}

func TestPollerDoesNotRestoreClearedPreviewAfterRestart(t *testing.T) {
	workspace := t.TempDir()
	writeFile(t, filepath.Join(workspace, "index.html"), "<main>hello</main>")
	sess := workerSession("ao-1", workspace, "")
	sess.Metadata.PreviewRevision = 2
	svc := &fakePreviewSessions{sessions: []domain.SessionRecord{sess}}
	poller := NewPoller(svc, svc, "http://127.0.0.1:3001", PollerConfig{Logger: discardLogger()})

	if err := poller.Poll(context.Background()); err != nil {
		t.Fatalf("Poll: %v", err)
	}

	if len(svc.sets) != 0 {
		t.Fatalf("sets = %#v, want cleared preview to remain empty after restart", svc.sets)
	}
}

func TestPollerDoesNotOverrideExplicitPreviewTarget(t *testing.T) {
	workspace := t.TempDir()
	writeFile(t, filepath.Join(workspace, "index.html"), "<main>hello</main>")
	svc := &fakePreviewSessions{sessions: []domain.SessionRecord{workerSession("ao-1", workspace, "file:///C:/tmp/other.html")}}
	poller := NewPoller(svc, svc, "http://127.0.0.1:3001", PollerConfig{Logger: discardLogger()})

	if err := poller.Poll(context.Background()); err != nil {
		t.Fatalf("Poll: %v", err)
	}

	if len(svc.sets) != 0 {
		t.Fatalf("sets = %#v, want no automatic override", svc.sets)
	}
}

func TestPollerMigratesLegacyWorkspacePreviewURL(t *testing.T) {
	workspace := t.TempDir()
	writeFile(t, filepath.Join(workspace, "index.html"), "<main>hello</main>")
	writeFile(t, filepath.Join(workspace, "docs", "report.html"), "<main>chosen report</main>")
	legacy := "http://127.0.0.1:3001/api/v1/sessions/ao-1/preview/files/docs/report.html"
	svc := &fakePreviewSessions{sessions: []domain.SessionRecord{workerSession("ao-1", workspace, legacy)}}
	poller := NewPoller(svc, svc, "http://127.0.0.1:3001", PollerConfig{Logger: discardLogger()})

	if err := poller.Poll(context.Background()); err != nil {
		t.Fatalf("Poll: %v", err)
	}

	assertSets(t, svc.sets, previewSet{
		id:  "ao-1",
		url: mustFileURL(t, "http://127.0.0.1:3001", "ao-1", "docs/report.html"),
	})
}

func TestPollerPreservesStoredRelativeEntry(t *testing.T) {
	workspace := t.TempDir()
	writeFile(t, filepath.Join(workspace, "index.html"), "<main>default</main>")
	writeFile(t, filepath.Join(workspace, "docs", "report.html"), "<main>chosen report</main>")
	svc := &fakePreviewSessions{sessions: []domain.SessionRecord{workerSession("ao-1", workspace, "docs/report.html")}}
	poller := NewPoller(svc, svc, "http://127.0.0.1:3001", PollerConfig{Logger: discardLogger()})

	if err := poller.Poll(context.Background()); err != nil {
		t.Fatalf("Poll: %v", err)
	}

	assertSets(t, svc.sets, previewSet{
		id:  "ao-1",
		url: mustFileURL(t, "http://127.0.0.1:3001", "ao-1", "docs/report.html"),
	})
}

func TestPollerRewritesStoredOriginToActualDaemonPortWithoutChangingEntry(t *testing.T) {
	workspace := t.TempDir()
	writeFile(t, filepath.Join(workspace, "index.html"), "<main>default</main>")
	writeFile(t, filepath.Join(workspace, "docs", "report.html"), "<main>chosen report</main>")
	old := mustFileURL(t, "http://127.0.0.1:3001", "ao-1", "docs/report.html")
	svc := &fakePreviewSessions{sessions: []domain.SessionRecord{workerSession("ao-1", workspace, old)}}
	poller := NewPoller(svc, svc, "http://127.0.0.1:49152", PollerConfig{Logger: discardLogger()})

	if err := poller.Poll(context.Background()); err != nil {
		t.Fatalf("Poll: %v", err)
	}

	assertSets(t, svc.sets, previewSet{
		id:  "ao-1",
		url: mustFileURL(t, "http://127.0.0.1:49152", "ao-1", "docs/report.html"),
	})
}

func TestPollerDoesNotAutoPreviewMarkdownOnlyNewSession(t *testing.T) {
	// A brand-new session (never explicitly previewed) whose workspace contains
	// only Markdown documents — no index.html — must NOT be auto-previewed.
	// Surfacing an arbitrary repo README as the initial browser target is noise.
	// See issue #2859.
	workspace := t.TempDir()
	writeFile(t, filepath.Join(workspace, "README.md"), "# project")
	writeFile(t, filepath.Join(workspace, "docs", "setup.md"), "# setup")
	svc := &fakePreviewSessions{sessions: []domain.SessionRecord{workerSession("ao-1", workspace, "")}}
	poller := NewPoller(svc, svc, "http://127.0.0.1:3001", PollerConfig{Logger: discardLogger()})

	if err := poller.Poll(context.Background()); err != nil {
		t.Fatalf("Poll: %v", err)
	}
	if len(svc.sets) != 0 {
		t.Fatalf("sets = %#v, want no auto-preview for a Markdown-only new session", svc.sets)
	}
}

func TestPollerKeepsMarkdownPreviewFreshOnceExplicitlySet(t *testing.T) {
	// Once a session has been explicitly previewed against a workspace Markdown
	// file (workspaceOwned), the poller must still keep that preview fresh — the
	// document-fallback restriction only applies to never-previewed sessions.
	workspace := t.TempDir()
	writeFile(t, filepath.Join(workspace, "docs", "report.md"), "# report")
	relative := "docs/report.md"
	svc := &fakePreviewSessions{sessions: []domain.SessionRecord{workerSession("ao-1", workspace, relative)}}
	poller := NewPoller(svc, svc, "http://127.0.0.1:3001", PollerConfig{Logger: discardLogger()})

	if err := poller.Poll(context.Background()); err != nil {
		t.Fatalf("Poll: %v", err)
	}
	assertSets(t, svc.sets, previewSet{
		id:  "ao-1",
		url: mustFileURL(t, "http://127.0.0.1:3001", "ao-1", relative),
	})
}

func TestPollerSkipsNonWorkerSessions(t *testing.T) {
	workspace := t.TempDir()
	writeFile(t, filepath.Join(workspace, "index.html"), "<main>hello</main>")
	svc := &fakePreviewSessions{sessions: []domain.SessionRecord{{
		ID:   "ao-orch",
		Kind: domain.KindOrchestrator,
		Metadata: domain.SessionMetadata{
			WorkspacePath: workspace,
		},
	}}}
	poller := NewPoller(svc, svc, "http://127.0.0.1:3001", PollerConfig{Logger: discardLogger()})

	if err := poller.Poll(context.Background()); err != nil {
		t.Fatalf("Poll: %v", err)
	}

	if len(svc.sets) != 0 {
		t.Fatalf("sets = %#v, want no preview updates for orchestrator sessions", svc.sets)
	}
}

func workerSession(id domain.SessionID, workspace, previewURL string) domain.SessionRecord {
	return domain.SessionRecord{
		ID:       id,
		Kind:     domain.KindWorker,
		Activity: domain.Activity{State: domain.ActivityIdle},
		Metadata: domain.SessionMetadata{
			WorkspacePath: workspace,
			PreviewURL:    previewURL,
		},
	}
}

func writeFile(t *testing.T, path string, contents string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", filepath.Dir(path), err)
	}
	if err := os.WriteFile(path, []byte(contents), 0o644); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}

func assertSets(t *testing.T, got []previewSet, want ...previewSet) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("sets = %#v, want %#v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("sets[%d] = %#v, want %#v", i, got[i], want[i])
		}
	}
}

func discardLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}
