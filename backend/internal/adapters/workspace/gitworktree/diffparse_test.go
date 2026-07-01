package gitworktree

import (
	"reflect"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func TestParseDiffChangedRegions_MultiHunk(t *testing.T) {
	out := `diff --git a/config.go b/config.go
index 1111111..2222222 100644
--- a/config.go
+++ b/config.go
@@ -10,2 +10,3 @@ func A() {
-old
+new
+new2
@@ -40,0 +42,2 @@ func B() {
+added
+added2
`
	got := parseDiffChangedRegions(out)
	want := map[string][]ports.LineRange{
		"config.go": {{Start: 10, End: 12}, {Start: 42, End: 43}},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v, want %+v", got, want)
	}
}

func TestParseDiffChangedRegions_SingleLineNoCount(t *testing.T) {
	// `@@ -5 +5 @@` (no comma) means a one-line change at line 5.
	out := `--- a/x.go
+++ b/x.go
@@ -5 +5 @@
-a
+b
`
	got := parseDiffChangedRegions(out)
	want := map[string][]ports.LineRange{"x.go": {{Start: 5, End: 5}}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v, want %+v", got, want)
	}
}

func TestParseDiffChangedRegions_PureDeletionHunk(t *testing.T) {
	// `+0,0` is a pure deletion; the new-side anchor is reported as a 1-line range.
	out := `--- a/y.go
+++ b/y.go
@@ -7,3 +6,0 @@
-gone1
-gone2
-gone3
`
	got := parseDiffChangedRegions(out)
	want := map[string][]ports.LineRange{"y.go": {{Start: 6, End: 6}}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v, want %+v", got, want)
	}
}

func TestParseDiffChangedRegions_DeletedFileKeepsPath(t *testing.T) {
	// A deleted file has `+++ /dev/null`; the old path must still be recorded.
	out := `diff --git a/dead.go b/dead.go
deleted file mode 100644
--- a/dead.go
+++ /dev/null
@@ -1,2 +0,0 @@
-line1
-line2
`
	got := parseDiffChangedRegions(out)
	if _, ok := got["dead.go"]; !ok {
		t.Fatalf("deleted file path missing: %+v", got)
	}
}

func TestParseDiffChangedRegions_NewFile(t *testing.T) {
	out := `diff --git a/new.go b/new.go
new file mode 100644
--- /dev/null
+++ b/new.go
@@ -0,0 +1,3 @@
+a
+b
+c
`
	got := parseDiffChangedRegions(out)
	want := map[string][]ports.LineRange{"new.go": {{Start: 1, End: 3}}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v, want %+v", got, want)
	}
}

func TestParseDiffChangedRegions_Empty(t *testing.T) {
	if got := parseDiffChangedRegions(""); len(got) != 0 {
		t.Fatalf("empty diff should yield no regions, got %+v", got)
	}
}
