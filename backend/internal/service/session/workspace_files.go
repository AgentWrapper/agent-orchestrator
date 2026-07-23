package session

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apierr"
	aoprocess "github.com/aoagents/agent-orchestrator/backend/internal/process"
)

const (
	maxWorkspaceFiles     = 5000
	maxWorkspaceFileBytes = 256 * 1024
	maxWorkspaceDiffBytes = 512 * 1024
)

// WorkspaceFileStatus describes a session-worktree file relative to HEAD.
type WorkspaceFileStatus string

// Workspace file status values reported by the session workspace browser.
const (
	WorkspaceFileUnmodified WorkspaceFileStatus = "unmodified"
	WorkspaceFileModified   WorkspaceFileStatus = "modified"
	WorkspaceFileAdded      WorkspaceFileStatus = "added"
	WorkspaceFileDeleted    WorkspaceFileStatus = "deleted"
	WorkspaceFileRenamed    WorkspaceFileStatus = "renamed"
)

// WorkspaceFiles is the read model for the session workspace file browser.
type WorkspaceFiles struct {
	SessionID domain.SessionID
	Files     []WorkspaceFileSummary
	Truncated bool
}

// WorkspaceFileSummary is one file row in the session workspace browser.
type WorkspaceFileSummary struct {
	Path      string
	Status    WorkspaceFileStatus
	Additions int
	Deletions int
	Size      int64
	Binary    bool
}

// WorkspaceFileDetail is the selected file's current content and diff.
type WorkspaceFileDetail struct {
	SessionID          domain.SessionID
	Path               string
	Status             WorkspaceFileStatus
	Additions          int
	Deletions          int
	Size               int64
	Binary             bool
	Deleted            bool
	Content            string
	ContentTruncated   bool
	Diff               string
	DiffTruncated      bool
	WorkspaceTruncated bool
}

// ListWorkspaceFiles returns all tracked and untracked, non-ignored files in a
// session worktree, annotated with their current git status against HEAD.
func (s *Service) ListWorkspaceFiles(ctx context.Context, id domain.SessionID) (WorkspaceFiles, error) {
	rec, err := s.sessionWorkspaceRecord(ctx, id)
	if err != nil {
		return WorkspaceFiles{}, err
	}
	scratch, err := s.isScratchSession(ctx, rec)
	if err != nil {
		return WorkspaceFiles{}, err
	}
	if scratch {
		files, truncated, err := scratchWorkspaceFiles(rec.Metadata.WorkspacePath)
		if err != nil {
			return WorkspaceFiles{}, err
		}
		return WorkspaceFiles{SessionID: id, Files: files, Truncated: truncated}, nil
	}
	statuses, counts, err := workspaceChangeMaps(ctx, rec.Metadata.WorkspacePath)
	if err != nil {
		return WorkspaceFiles{}, err
	}
	paths, truncated, err := workspaceGitFiles(ctx, rec.Metadata.WorkspacePath)
	if err != nil {
		return WorkspaceFiles{}, err
	}
	files := make([]WorkspaceFileSummary, 0, len(paths))
	for _, rel := range paths {
		status := statuses[rel]
		if status == "" {
			status = WorkspaceFileUnmodified
		}
		additions, deletions := counts[rel][0], counts[rel][1]
		size, binary := workspaceFileSizeAndBinary(rec.Metadata.WorkspacePath, rel, status)
		files = append(files, WorkspaceFileSummary{
			Path:      rel,
			Status:    status,
			Additions: additions,
			Deletions: deletions,
			Size:      size,
			Binary:    binary,
		})
	}
	sort.Slice(files, func(i, j int) bool { return files[i].Path < files[j].Path })
	return WorkspaceFiles{SessionID: id, Files: files, Truncated: truncated}, nil
}

// GetWorkspaceFile returns one session-worktree file's current text content and
// the git diff for that path. Binary or deleted files omit content.
func (s *Service) GetWorkspaceFile(ctx context.Context, id domain.SessionID, rawPath string) (WorkspaceFileDetail, error) {
	rec, err := s.sessionWorkspaceRecord(ctx, id)
	if err != nil {
		return WorkspaceFileDetail{}, err
	}
	rel, err := cleanWorkspaceRelativePath(rawPath)
	if err != nil {
		return WorkspaceFileDetail{}, err
	}
	scratch, err := s.isScratchSession(ctx, rec)
	if err != nil {
		return WorkspaceFileDetail{}, err
	}
	if scratch {
		return scratchWorkspaceFile(rec.Metadata.WorkspacePath, id, rel)
	}
	statuses, counts, err := workspaceChangeMaps(ctx, rec.Metadata.WorkspacePath)
	if err != nil {
		return WorkspaceFileDetail{}, err
	}
	status := statuses[rel]
	if status == "" {
		status = WorkspaceFileUnmodified
	}
	additions, deletions := counts[rel][0], counts[rel][1]
	detail := WorkspaceFileDetail{
		SessionID: id,
		Path:      rel,
		Status:    status,
		Additions: additions,
		Deletions: deletions,
		Deleted:   status == WorkspaceFileDeleted,
	}
	if !detail.Deleted {
		file, info, err := confinedWorkspaceFile(rec.Metadata.WorkspacePath, rel)
		if err != nil {
			return WorkspaceFileDetail{}, err
		}
		detail.Size = info.Size()
		content, binary, truncated, err := readWorkspaceTextFile(file, maxWorkspaceFileBytes)
		if err != nil {
			return WorkspaceFileDetail{}, err
		}
		detail.Binary = binary
		detail.ContentTruncated = truncated
		if !binary {
			detail.Content = content
		}
	}
	diff, truncated, err := workspaceFileDiff(ctx, rec.Metadata.WorkspacePath, rel, status, detail.Content, detail.Binary)
	if err != nil {
		return WorkspaceFileDetail{}, err
	}
	detail.Diff = diff
	detail.DiffTruncated = truncated
	return detail, nil
}

func (s *Service) sessionWorkspaceRecord(ctx context.Context, id domain.SessionID) (domain.SessionRecord, error) {
	rec, ok, err := s.store.GetSession(ctx, id)
	if err != nil {
		return domain.SessionRecord{}, fmt.Errorf("get %s: %w", id, err)
	}
	if !ok {
		return domain.SessionRecord{}, apierr.NotFound("SESSION_NOT_FOUND", "Unknown session")
	}
	if strings.TrimSpace(rec.Metadata.WorkspacePath) == "" {
		return domain.SessionRecord{}, apierr.NotFound("SESSION_WORKSPACE_NOT_FOUND", "Session workspace not found")
	}
	info, err := os.Stat(rec.Metadata.WorkspacePath)
	if err != nil || !info.IsDir() {
		return domain.SessionRecord{}, apierr.NotFound("SESSION_WORKSPACE_NOT_FOUND", "Session workspace not found")
	}
	return rec, nil
}

func (s *Service) isScratchSession(ctx context.Context, rec domain.SessionRecord) (bool, error) {
	if s.store == nil || rec.ProjectID == "" {
		return false, nil
	}
	project, ok, err := s.store.GetProject(ctx, string(rec.ProjectID))
	if err != nil {
		return false, fmt.Errorf("get project %s: %w", rec.ProjectID, err)
	}
	if !ok {
		return false, nil
	}
	return project.Kind.WithDefault() == domain.ProjectKindScratch, nil
}

func scratchWorkspaceFiles(root string) ([]WorkspaceFileSummary, bool, error) {
	rootResolved, err := resolvedWorkspaceRoot(root)
	if err != nil {
		return nil, false, err
	}
	var files []WorkspaceFileSummary
	truncated := false
	err = filepath.WalkDir(rootResolved, func(fullPath string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if fullPath == rootResolved {
			return nil
		}
		relPath, err := filepath.Rel(rootResolved, fullPath)
		if err != nil {
			return err
		}
		rel := filepath.ToSlash(relPath)
		if rel == ".git" || strings.HasPrefix(rel, ".git/") {
			if entry.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if entry.IsDir() {
			return nil
		}
		info, include, err := scratchWorkspaceFileInfo(rootResolved, fullPath, entry)
		if err != nil {
			return err
		}
		if !include {
			return nil
		}
		if len(files) >= maxWorkspaceFiles {
			truncated = true
			return filepath.SkipAll
		}
		_, binary, _, err := readWorkspaceTextFile(fullPath, 8192)
		if err != nil {
			return err
		}
		files = append(files, WorkspaceFileSummary{
			Path:      rel,
			Status:    WorkspaceFileAdded,
			Additions: 0,
			Deletions: 0,
			Size:      info.Size(),
			Binary:    binary,
		})
		return nil
	})
	if err != nil {
		return nil, false, err
	}
	sort.Slice(files, func(i, j int) bool { return files[i].Path < files[j].Path })
	return files, truncated, nil
}

func scratchWorkspaceFile(root string, id domain.SessionID, rel string) (WorkspaceFileDetail, error) {
	file, info, err := confinedWorkspaceFile(root, rel)
	if err != nil {
		return WorkspaceFileDetail{}, err
	}
	content, binary, truncated, err := readWorkspaceTextFile(file, maxWorkspaceFileBytes)
	if err != nil {
		return WorkspaceFileDetail{}, err
	}
	additions := 0
	if !binary {
		additions = textLineCount(content)
	}
	detail := WorkspaceFileDetail{
		SessionID:        id,
		Path:             rel,
		Status:           WorkspaceFileAdded,
		Additions:        additions,
		Deletions:        0,
		Size:             info.Size(),
		Binary:           binary,
		ContentTruncated: truncated,
	}
	if !binary {
		detail.Content = content
	}
	return detail, nil
}

func resolvedWorkspaceRoot(root string) (string, error) {
	rootAbs, err := filepath.Abs(root)
	if err != nil {
		return "", apierr.NotFound("SESSION_WORKSPACE_NOT_FOUND", "Session workspace not found")
	}
	rootResolved, err := resolvedFilesystemPath(rootAbs)
	if err != nil {
		return "", apierr.NotFound("SESSION_WORKSPACE_NOT_FOUND", "Session workspace not found")
	}
	info, err := os.Stat(rootResolved)
	if err != nil || !info.IsDir() {
		return "", apierr.NotFound("SESSION_WORKSPACE_NOT_FOUND", "Session workspace not found")
	}
	return rootResolved, nil
}

func scratchWorkspaceFileInfo(rootResolved, fullPath string, entry fs.DirEntry) (os.FileInfo, bool, error) {
	info, err := entry.Info()
	if err != nil {
		return nil, false, err
	}
	if info.Mode()&os.ModeSymlink == 0 {
		if !info.Mode().IsRegular() {
			return nil, false, nil
		}
		abs, err := filepath.Abs(fullPath)
		if err != nil {
			return nil, false, err
		}
		if !pathWithin(rootResolved, abs) {
			return nil, false, nil
		}
		return info, true, nil
	}
	targetInfo, ok := statScratchFileTarget(fullPath)
	if !ok {
		return nil, false, nil
	}
	resolved, ok := resolvedScratchPath(fullPath)
	if !ok {
		return nil, false, nil
	}
	if !pathWithin(rootResolved, resolved) {
		return nil, false, nil
	}
	return targetInfo, true, nil
}

func statScratchFileTarget(filePath string) (os.FileInfo, bool) {
	info, err := os.Stat(filePath)
	return info, err == nil && !info.IsDir()
}

func resolvedScratchPath(filePath string) (string, bool) {
	resolved, err := resolvedFilesystemPath(filePath)
	return resolved, err == nil
}

func workspaceGitFiles(ctx context.Context, root string) ([]string, bool, error) {
	out, err := gitWorkspaceOutput(ctx, root, "ls-files", "-z", "-co", "--exclude-standard")
	if err != nil {
		return nil, false, err
	}
	parts := splitNUL(out)
	paths := make([]string, 0, len(parts))
	seen := map[string]struct{}{}
	truncated := false
	for _, part := range parts {
		rel := filepath.ToSlash(part)
		if rel == "" {
			continue
		}
		if _, ok := seen[rel]; ok {
			continue
		}
		seen[rel] = struct{}{}
		if len(paths) >= maxWorkspaceFiles {
			truncated = true
			continue
		}
		paths = append(paths, rel)
	}
	return paths, truncated, nil
}

func workspaceChangeMaps(ctx context.Context, root string) (map[string]WorkspaceFileStatus, map[string][2]int, error) {
	statuses, err := workspaceStatuses(ctx, root)
	if err != nil {
		return nil, nil, err
	}
	counts, err := workspaceNumstat(ctx, root)
	if err != nil {
		return nil, nil, err
	}
	for rel, status := range statuses {
		if status != WorkspaceFileAdded {
			continue
		}
		if _, ok := counts[rel]; ok {
			continue
		}
		additions, ok := countUntrackedTextLines(root, rel)
		if ok {
			counts[rel] = [2]int{additions, 0}
		}
	}
	return statuses, counts, nil
}

func workspaceStatuses(ctx context.Context, root string) (map[string]WorkspaceFileStatus, error) {
	out, err := gitWorkspaceOutput(ctx, root, "status", "--porcelain=v1", "-z", "--untracked-files=all")
	if err != nil {
		return nil, err
	}
	parts := splitNUL(out)
	statuses := map[string]WorkspaceFileStatus{}
	for i := 0; i < len(parts); i++ {
		entry := parts[i]
		if len(entry) < 4 {
			continue
		}
		xy := entry[:2]
		rel := filepath.ToSlash(entry[3:])
		statuses[rel] = classifyWorkspaceStatus(xy)
		if strings.ContainsAny(xy, "RC") && i+1 < len(parts) {
			i++
		}
	}
	return statuses, nil
}

func classifyWorkspaceStatus(xy string) WorkspaceFileStatus {
	switch {
	case xy == "??", strings.Contains(xy, "A"):
		return WorkspaceFileAdded
	case strings.ContainsAny(xy, "RC"):
		return WorkspaceFileRenamed
	case strings.Contains(xy, "D"):
		return WorkspaceFileDeleted
	case strings.ContainsAny(xy, "M"):
		return WorkspaceFileModified
	default:
		return WorkspaceFileModified
	}
}

func workspaceNumstat(ctx context.Context, root string) (map[string][2]int, error) {
	out, err := gitWorkspaceOutput(ctx, root, "diff", "--numstat", "HEAD", "--")
	if err != nil {
		return nil, err
	}
	counts := map[string][2]int{}
	for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		fields := strings.Split(line, "\t")
		if len(fields) < 3 {
			continue
		}
		additions, addOK := parseNumstatField(fields[0])
		deletions, delOK := parseNumstatField(fields[1])
		if !addOK || !delOK {
			continue
		}
		counts[filepath.ToSlash(fields[2])] = [2]int{additions, deletions}
	}
	return counts, nil
}

func parseNumstatField(raw string) (int, bool) {
	if raw == "-" {
		return 0, false
	}
	n, err := strconv.Atoi(raw)
	return n, err == nil
}

func workspaceFileSizeAndBinary(root, rel string, status WorkspaceFileStatus) (int64, bool) {
	if status == WorkspaceFileDeleted {
		return 0, false
	}
	file, info, err := confinedWorkspaceFile(root, rel)
	if err != nil {
		return 0, false
	}
	_, binary, _, err := readWorkspaceTextFile(file, 8192)
	if err != nil {
		return info.Size(), false
	}
	return info.Size(), binary
}

func workspaceFileDiff(ctx context.Context, root, rel string, status WorkspaceFileStatus, content string, binary bool) (string, bool, error) {
	if status == WorkspaceFileUnmodified {
		return "", false, nil
	}
	if status == WorkspaceFileAdded && !gitTracked(ctx, root, rel) {
		if binary {
			return "", false, nil
		}
		diff := syntheticAddedFileDiff(rel, content)
		truncatedDiff, truncated := truncateUTF8(diff, maxWorkspaceDiffBytes)
		return truncatedDiff, truncated, nil
	}
	out, err := gitWorkspaceOutput(ctx, root, "diff", "--no-ext-diff", "--unified=3", "HEAD", "--", rel)
	if err != nil {
		return "", false, err
	}
	truncatedDiff, truncated := truncateUTF8(out, maxWorkspaceDiffBytes)
	return truncatedDiff, truncated, nil
}

func gitTracked(ctx context.Context, root, rel string) bool {
	_, err := gitWorkspaceOutput(ctx, root, "ls-files", "--error-unmatch", "--", rel)
	return err == nil
}

func syntheticAddedFileDiff(rel, content string) string {
	lines := strings.SplitAfter(content, "\n")
	if len(lines) == 1 && lines[0] == "" {
		lines = nil
	}
	var b strings.Builder
	fmt.Fprintf(&b, "diff --git a/%s b/%s\n", rel, rel)
	b.WriteString("new file mode 100644\n")
	b.WriteString("--- /dev/null\n")
	fmt.Fprintf(&b, "+++ b/%s\n", rel)
	fmt.Fprintf(&b, "@@ -0,0 +1,%d @@\n", len(lines))
	for _, line := range lines {
		b.WriteByte('+')
		b.WriteString(line)
		if !strings.HasSuffix(line, "\n") {
			b.WriteByte('\n')
		}
	}
	return b.String()
}

func confinedWorkspaceFile(root, rel string) (string, os.FileInfo, error) {
	clean, err := cleanWorkspaceRelativePath(rel)
	if err != nil {
		return "", nil, err
	}
	rootAbs, err := filepath.Abs(root)
	if err != nil {
		return "", nil, apierr.NotFound("SESSION_WORKSPACE_NOT_FOUND", "Session workspace not found")
	}
	rootResolved, err := resolvedFilesystemPath(rootAbs)
	if err != nil {
		return "", nil, apierr.NotFound("SESSION_WORKSPACE_NOT_FOUND", "Session workspace not found")
	}
	rootInfo, err := os.Stat(rootResolved)
	if err != nil || !rootInfo.IsDir() {
		return "", nil, apierr.NotFound("SESSION_WORKSPACE_NOT_FOUND", "Session workspace not found")
	}
	target := filepath.Join(rootResolved, filepath.FromSlash(clean))
	targetAbs, err := filepath.Abs(target)
	if err != nil || !pathWithin(rootResolved, targetAbs) {
		return "", nil, apierr.Invalid("INVALID_WORKSPACE_PATH", "path escapes session workspace", nil)
	}
	resolved := rootResolved
	for _, part := range strings.Split(clean, "/") {
		resolved = filepath.Join(resolved, part)
		resolved, err = resolvedFilesystemPath(resolved)
		if err != nil {
			return "", nil, apierr.NotFound("WORKSPACE_FILE_NOT_FOUND", "Workspace file not found")
		}
		if !pathWithin(rootResolved, resolved) {
			return "", nil, apierr.Invalid("INVALID_WORKSPACE_PATH", "path escapes session workspace", nil)
		}
	}
	info, err := os.Stat(resolved)
	if err != nil {
		return "", nil, apierr.NotFound("WORKSPACE_FILE_NOT_FOUND", "Workspace file not found")
	}
	if info.IsDir() {
		return "", nil, apierr.Invalid("WORKSPACE_PATH_IS_DIRECTORY", "Workspace path is a directory", nil)
	}
	return resolved, info, nil
}

func cleanWorkspaceRelativePath(raw string) (string, error) {
	trimmed := strings.TrimSpace(strings.ReplaceAll(raw, "\\", "/"))
	if trimmed == "" || path.IsAbs(trimmed) || filepath.IsAbs(raw) || filepath.VolumeName(raw) != "" {
		return "", apierr.Invalid("INVALID_WORKSPACE_PATH", "workspace path must be relative", nil)
	}
	clean := path.Clean(trimmed)
	if clean == "." || clean == ".." || strings.HasPrefix(clean, "../") {
		return "", apierr.Invalid("INVALID_WORKSPACE_PATH", "path escapes session workspace", nil)
	}
	return clean, nil
}

func pathWithin(root, target string) bool {
	rel, err := filepath.Rel(root, target)
	return err == nil && rel != "." && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

func readWorkspaceTextFile(file string, limit int) (string, bool, bool, error) {
	handle, err := os.Open(file)
	if err != nil {
		return "", false, false, apierr.NotFound("WORKSPACE_FILE_NOT_FOUND", "Workspace file not found")
	}
	defer func() { _ = handle.Close() }()
	data, err := io.ReadAll(io.LimitReader(handle, int64(limit+1)))
	if err != nil {
		return "", false, false, err
	}
	truncated := len(data) > limit
	if truncated {
		data = data[:limit]
	}
	if isBinary(data) {
		return "", true, truncated, nil
	}
	content := string(data)
	if !utf8.ValidString(content) {
		return "", true, truncated, nil
	}
	return content, false, truncated, nil
}

func isBinary(data []byte) bool {
	return bytes.IndexByte(data, 0) >= 0 || !utf8.Valid(data)
}

func countUntrackedTextLines(root, rel string) (int, bool) {
	file, _, err := confinedWorkspaceFile(root, rel)
	if err != nil {
		return 0, false
	}
	content, binary, _, err := readWorkspaceTextFile(file, maxWorkspaceFileBytes)
	if err != nil || binary {
		return 0, false
	}
	if content == "" {
		return 0, true
	}
	return textLineCount(content), true
}

func textLineCount(content string) int {
	if content == "" {
		return 0
	}
	return strings.Count(content, "\n") + btoi(!strings.HasSuffix(content, "\n"))
}

func truncateUTF8(in string, limit int) (string, bool) {
	if len(in) <= limit {
		return in, false
	}
	end := 0
	for i := range in {
		if i > limit {
			break
		}
		end = i
	}
	if end == 0 {
		end = limit
	}
	return in[:end], true
}

func gitWorkspaceOutput(ctx context.Context, root string, args ...string) (string, error) {
	cmd := aoprocess.CommandContext(ctx, "git", append([]string{"-C", root}, args...)...)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		detail := strings.TrimSpace(stderr.String())
		if stdout := strings.TrimSpace(string(out)); stdout != "" {
			if detail != "" {
				detail += ": "
			}
			detail += stdout
		}
		return "", fmt.Errorf("git -C %s %s: %w: %s", root, strings.Join(args, " "), err, detail)
	}
	return string(out), nil
}

func splitNUL(out string) []string {
	raw := strings.TrimRight(out, "\x00")
	if raw == "" {
		return nil
	}
	return strings.Split(raw, "\x00")
}

func btoi(v bool) int {
	if v {
		return 1
	}
	return 0
}
