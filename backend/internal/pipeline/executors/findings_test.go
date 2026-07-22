package executors

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/pipeline"
)

func writeFindings(t *testing.T, lines ...string) string {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, pipeline.FindingsFilename)
	// Join with newlines and add a trailing newline: every line is a "complete"
	// line, matching how the agent's write-then-rename drop looks.
	content := ""
	if len(lines) > 0 {
		content = strings.Join(lines, "\n") + "\n"
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("write findings: %v", err)
	}
	return path
}

func findingLine(t *testing.T, confidence float64, severity string) string {
	t.Helper()
	b, err := json.Marshal(map[string]any{
		"kind":        "finding",
		"filePath":    "src/foo.go",
		"startLine":   1,
		"endLine":     2,
		"title":       "x",
		"description": "y",
		"category":    "general",
		"severity":    severity,
		"confidence":  confidence,
	})
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestParseFindings_ValidJSONL(t *testing.T) {
	path := writeFindings(t,
		findingLine(t, 0.9, "error"),
		`{"kind":"json","data":{"answer":42}}`,
	)
	res, err := parseFindingsFile(path)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(res.artifacts) != 2 {
		t.Fatalf("want 2 artifacts, got %d", len(res.artifacts))
	}
	if res.artifacts[0].Kind != pipeline.ArtifactKindFinding || res.artifacts[0].FilePath != "src/foo.go" {
		t.Errorf("finding not parsed: %+v", res.artifacts[0])
	}
	if res.artifacts[1].Kind != pipeline.ArtifactKindJSON || res.artifacts[1].Data["answer"].(float64) != 42 {
		t.Errorf("json artifact not parsed: %+v", res.artifacts[1])
	}
	if res.truncated {
		t.Error("did not expect truncation")
	}
}

func TestParseFindings_BlankLinesSkipped(t *testing.T) {
	path := writeFindings(t, findingLine(t, 0.5, "info"), "", "   ")
	res, err := parseFindingsFile(path)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(res.artifacts) != 1 {
		t.Fatalf("want 1 artifact, got %d", len(res.artifacts))
	}
}

func TestParseFindings_EmptyFile(t *testing.T) {
	path := writeFindings(t)
	res, err := parseFindingsFile(path)
	if err != nil {
		t.Fatalf("empty file must not error: %v", err)
	}
	if len(res.artifacts) != 0 {
		t.Fatalf("want 0 artifacts, got %d", len(res.artifacts))
	}
}

func TestParseFindings_TornFinalLineTolerated(t *testing.T) {
	// A valid line followed by a torn (no trailing newline, incomplete JSON)
	// final line: the torn tail is dropped, the good line survives.
	dir := t.TempDir()
	path := filepath.Join(dir, pipeline.FindingsFilename)
	content := findingLine(t, 0.7, "warning") + "\n" + `{"kind":"finding","filePath":"src/b`
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	res, err := parseFindingsFile(path)
	if err != nil {
		t.Fatalf("torn final line must be tolerated, got error: %v", err)
	}
	if len(res.artifacts) != 1 {
		t.Fatalf("want 1 surviving artifact, got %d", len(res.artifacts))
	}
}

func TestParseFindings_CompleteMalformedLineFails(t *testing.T) {
	// A malformed line that IS terminated by a newline (a complete line) is a
	// hard error, not tolerated.
	path := writeFindings(t, "not-json {{{")
	_, err := parseFindingsFile(path)
	if err == nil {
		t.Fatal("expected error on complete malformed line")
	}
}

func TestParseFindings_RejectsBadShape(t *testing.T) {
	cases := map[string]string{
		"confidence out of range": findingLine(t, 7, "info"),
		"bad severity":            findingLine(t, 0.5, "critical"),
		"unknown kind":            `{"kind":"weird"}`,
		"json without data":       `{"kind":"json"}`,
		"finding missing title":   `{"kind":"finding","filePath":"a","startLine":1,"endLine":1,"description":"d","category":"c","severity":"info","confidence":0.5}`,
	}
	for name, line := range cases {
		t.Run(name, func(t *testing.T) {
			path := writeFindings(t, line)
			if _, err := parseFindingsFile(path); err == nil {
				t.Fatalf("%s: expected error", name)
			}
		})
	}
}

func TestParseFindings_CapTriggersTruncation(t *testing.T) {
	// Build a file larger than the cap out of valid finding lines. Each line is
	// well under the cap; their sum crosses it.
	dir := t.TempDir()
	path := filepath.Join(dir, pipeline.FindingsFilename)
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	line := findingLine(t, 0.5, "info") + "\n"
	written := 0
	// Write ~6MB worth to exceed the 5MB cap.
	for written <= findingsFileSizeCapBytes+len(line) {
		if _, err := f.WriteString(line); err != nil {
			t.Fatal(err)
		}
		written += len(line)
	}
	f.Close()

	res, err := parseFindingsFile(path)
	if err != nil {
		t.Fatalf("truncation must not error: %v", err)
	}
	if !res.truncated {
		t.Fatal("expected truncated=true when the cap fires")
	}
	if res.bytesRead > findingsFileSizeCapBytes+int64(len(line)) {
		t.Errorf("bytesRead %d ran well past the cap", res.bytesRead)
	}
	if len(res.artifacts) == 0 {
		t.Error("expected the pre-cap lines to still be returned")
	}
}

func TestParseFindings_StatusRecords(t *testing.T) {
	path := writeFindings(t,
		findingLine(t, 0.9, "error"),
		`{"kind":"status","fingerprint":"abc123","status":"resolved"}`,
		`{"kind":"status","fingerprint":"def456","status":"dismissed"}`,
		`{"kind":"status","fingerprint":"ghi789","status":"open"}`,
	)
	res, err := parseFindingsFile(path)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(res.artifacts) != 1 {
		t.Fatalf("want 1 artifact (status records are not artifacts), got %d", len(res.artifacts))
	}
	if len(res.statusChanges) != 3 {
		t.Fatalf("want 3 status changes, got %d", len(res.statusChanges))
	}
	want := []pipeline.FindingStatusChange{
		{Fingerprint: "abc123", Status: pipeline.ArtifactStatusResolved},
		{Fingerprint: "def456", Status: pipeline.ArtifactStatusDismissed},
		{Fingerprint: "ghi789", Status: pipeline.ArtifactStatusOpen},
	}
	for i, w := range want {
		if res.statusChanges[i] != w {
			t.Errorf("statusChanges[%d] = %+v, want %+v", i, res.statusChanges[i], w)
		}
	}
}

func TestParseFindings_StatusRecordBadShapeFails(t *testing.T) {
	cases := map[string]string{
		"bad status value":     `{"kind":"status","fingerprint":"abc","status":"nonsense"}`,
		"sent_to_agent barred": `{"kind":"status","fingerprint":"abc","status":"sent_to_agent"}`,
		"missing fingerprint":  `{"kind":"status","status":"resolved"}`,
		"empty fingerprint":    `{"kind":"status","fingerprint":"   ","status":"resolved"}`,
		"missing status":       `{"kind":"status","fingerprint":"abc"}`,
	}
	for name, line := range cases {
		t.Run(name, func(t *testing.T) {
			path := writeFindings(t, line)
			if _, err := parseFindingsFile(path); err == nil {
				t.Fatalf("%s: expected a hard parse error", name)
			}
		})
	}
}

func TestParseFindings_MissingFile(t *testing.T) {
	_, err := parseFindingsFile(filepath.Join(t.TempDir(), "nope.jsonl"))
	if err == nil {
		t.Fatal("expected error for a missing file")
	}
	if !os.IsNotExist(err) {
		t.Errorf("want not-exist error, got %v", err)
	}
}
