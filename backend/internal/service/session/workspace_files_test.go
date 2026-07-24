package session

import (
	"strconv"
	"strings"
	"testing"
)

func TestSyntheticAddedFileDiffMatchesActualLineCount(t *testing.T) {
	tests := []struct {
		name      string
		content   string
		wantLines []string
	}{
		{
			name:      "trailing newline",
			content:   "hello\nworld\n",
			wantLines: []string{"+hello", "+world"},
		},
		{
			name:      "no trailing newline",
			content:   "hello\nworld",
			wantLines: []string{"+hello", "+world"},
		},
		{
			name:      "single line with trailing newline",
			content:   "hello\n",
			wantLines: []string{"+hello"},
		},
		{
			name:      "empty content",
			content:   "",
			wantLines: nil,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			diff := syntheticAddedFileDiff("new.txt", tt.content)

			gotLines := addedLinesFrom(diff)
			if !equalStrings(gotLines, tt.wantLines) {
				t.Fatalf("added lines = %#v, want %#v\ndiff:\n%s", gotLines, tt.wantLines, diff)
			}

			wantHeader := "@@ -0,0 +1," + strconv.Itoa(len(tt.wantLines)) + " @@"
			if !strings.Contains(diff, wantHeader) {
				t.Fatalf("diff missing hunk header %q:\n%s", wantHeader, diff)
			}

			// The hunk's declared count must equal the number of "+" lines
			// actually emitted, and both must equal the file's real line
			// count (textLineCount), which is what the changed-files list
			// displays. A mismatch here is the exact bug #2923 reported.
			if got, want := len(gotLines), textLineCount(tt.content); got != want {
				t.Fatalf("diff added-line count = %d, textLineCount = %d, want equal", got, want)
			}
		})
	}
}

// addedLinesFrom extracts the "+..." content lines from a synthetic diff,
// skipping the "+++ b/<path>" file-header line.
func addedLinesFrom(diff string) []string {
	var added []string
	for _, line := range strings.Split(diff, "\n") {
		if strings.HasPrefix(line, "+++ ") {
			continue
		}
		if strings.HasPrefix(line, "+") {
			added = append(added, line)
		}
	}
	return added
}

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
