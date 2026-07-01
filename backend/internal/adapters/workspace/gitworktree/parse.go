package gitworktree

import (
	"bufio"
	"strconv"
	"strings"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// parseDiffChangedRegions parses `git diff --unified=0` output into a map of
// repo-relative path → changed line ranges in the new revision. It tracks the
// current file from the `+++ b/<path>` header (falling back to the `--- a/<path>`
// header for deletions where `+++` is /dev/null) and reads each `@@ -a,b +c,d @@`
// hunk header for the `+c,d` span. A hunk with count 0 (pure deletion) is
// recorded as a single-line range at the anchor position. Files that change with
// no parseable hunks (e.g. binary or mode-only changes) still appear with an
// empty range slice so callers can treat them as file-level overlaps.
func parseDiffChangedRegions(out string) map[string][]ports.LineRange {
	regions := map[string][]ports.LineRange{}
	var curPath string
	var minusPath string

	s := bufio.NewScanner(strings.NewReader(out))
	s.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for s.Scan() {
		line := strings.TrimRight(s.Text(), "\r")
		switch {
		case strings.HasPrefix(line, "--- "):
			minusPath = stripDiffPathPrefix(strings.TrimPrefix(line, "--- "))
		case strings.HasPrefix(line, "+++ "):
			p := stripDiffPathPrefix(strings.TrimPrefix(line, "+++ "))
			if p == "" {
				p = minusPath // deletion: +++ is /dev/null, use the old path.
			}
			curPath = p
			if curPath != "" {
				if _, ok := regions[curPath]; !ok {
					regions[curPath] = []ports.LineRange{}
				}
			}
		case strings.HasPrefix(line, "@@ ") && curPath != "":
			if r, ok := parseHunkNewRange(line); ok {
				regions[curPath] = append(regions[curPath], r)
			}
		}
	}
	if s.Err() != nil {
		return regions
	}
	return regions
}

// stripDiffPathPrefix removes git's a//b/ diff prefix and resolves /dev/null to
// the empty string. It does not attempt to unquote core.quotePath-escaped paths;
// those rare paths degrade to file-level overlaps, which is acceptable.
func stripDiffPathPrefix(p string) string {
	p = strings.TrimSpace(p)
	if p == "/dev/null" || p == "" {
		return ""
	}
	if strings.HasPrefix(p, "a/") || strings.HasPrefix(p, "b/") {
		return p[2:]
	}
	return p
}

// parseHunkNewRange extracts the new-revision span from an `@@ -a,b +c,d @@`
// header. A missing count means 1; a zero count (insertion point / deletion)
// yields a single-line range at the anchor.
func parseHunkNewRange(line string) (ports.LineRange, bool) {
	plus := strings.Index(line, "+")
	if plus < 0 {
		return ports.LineRange{}, false
	}
	rest := line[plus+1:]
	if sp := strings.IndexAny(rest, " \t"); sp >= 0 {
		rest = rest[:sp]
	}
	startStr, countStr, hasCount := strings.Cut(rest, ",")
	start, err := strconv.Atoi(startStr)
	if err != nil {
		return ports.LineRange{}, false
	}
	count := 1
	if hasCount {
		if c, err := strconv.Atoi(countStr); err == nil {
			count = c
		}
	}
	if count <= 0 {
		return ports.LineRange{Start: start, End: start}, true
	}
	return ports.LineRange{Start: start, End: start + count - 1}, true
}

type worktreeRecord struct {
	Path     string
	Branch   string
	Head     string
	Bare     bool
	Detached bool
	Locked   bool
	Prunable bool
}

func parseWorktreePorcelain(out string) ([]worktreeRecord, error) {
	var records []worktreeRecord
	var cur *worktreeRecord

	flush := func() {
		if cur != nil && cur.Path != "" {
			records = append(records, *cur)
		}
		cur = nil
	}

	s := bufio.NewScanner(strings.NewReader(out))
	for s.Scan() {
		line := strings.TrimRight(s.Text(), "\r")
		if line == "" {
			flush()
			continue
		}
		key, val, hasValue := strings.Cut(line, " ")
		switch key {
		case "worktree":
			flush()
			cur = &worktreeRecord{}
			if hasValue {
				cur.Path = val
			}
		case "HEAD":
			if cur != nil && hasValue {
				cur.Head = val
			}
		case "branch":
			if cur != nil && hasValue {
				cur.Branch = strings.TrimPrefix(val, "refs/heads/")
			}
		case "bare":
			if cur != nil {
				cur.Bare = true
			}
		case "detached":
			if cur != nil {
				cur.Detached = true
			}
		case "locked":
			if cur != nil {
				cur.Locked = true
			}
		case "prunable":
			if cur != nil {
				cur.Prunable = true
			}
		}
	}
	if err := s.Err(); err != nil {
		return nil, err
	}
	flush()
	return records, nil
}
