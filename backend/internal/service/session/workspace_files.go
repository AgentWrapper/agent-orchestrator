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

// WorkspaceFileStatus describes a session-worktree file relative to its compare base.
type WorkspaceFileStatus string

// Workspace file status values reported by the session workspace browser.
const (
	WorkspaceFileUnmodified WorkspaceFileStatus = "unmodified"
	WorkspaceFileModified   WorkspaceFileStatus = "modified"
	WorkspaceFileAdded      WorkspaceFileStatus = "added"
	WorkspaceFileDeleted    WorkspaceFileStatus = "deleted"
	WorkspaceFileRenamed    WorkspaceFileStatus = "renamed"
)

// WorkspaceCompareMode describes the Git revision used for workspace diffs.
type WorkspaceCompareMode string

const (
	// WorkspaceCompareBase means diffs are against the session's recorded base.
	WorkspaceCompareBase WorkspaceCompareMode = "base"
	// WorkspaceCompareHeadFallback means AO could not resolve a base and used the
	// previous HEAD-only behavior.
	WorkspaceCompareHeadFallback WorkspaceCompareMode = "head_fallback"
)

// WorkspaceFiles is the read model for the session workspace file browser.
type WorkspaceFiles struct {
	SessionID      domain.SessionID
	CompareBaseSHA string
	CompareBaseRef string
	CompareMode    WorkspaceCompareMode
	Files          []WorkspaceFileSummary
	Truncated      bool
}

// WorkspaceFileSummary is one file row in the session workspace browser.
type WorkspaceFileSummary struct {
	Path         string
	PreviousPath string
	Status       WorkspaceFileStatus
	Additions    int
	Deletions    int
	Size         int64
	Binary       bool
}

// WorkspaceFileDetail is the selected file's current content and diff.
type WorkspaceFileDetail struct {
	SessionID          domain.SessionID
	Path               string
	PreviousPath       string
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
	CompareBaseSHA     string
	CompareBaseRef     string
	CompareMode        WorkspaceCompareMode
}

// WorkspaceWatchPaths returns every worktree that contributes files to a
// session workspace read model. Workspace projects include child repositories
// that are deliberately ignored by the parent Git repository.
func (s *Service) WorkspaceWatchPaths(ctx context.Context, id domain.SessionID) ([]string, error) {
	rec, err := s.sessionWorkspaceRecord(ctx, id)
	if err != nil {
		return nil, err
	}
	paths := []string{rec.Metadata.WorkspacePath}
	seen := map[string]struct{}{filepath.Clean(rec.Metadata.WorkspacePath): {}}
	rows, err := s.store.ListSessionWorktrees(ctx, id)
	if err != nil {
		return nil, fmt.Errorf("list workspace project rows: %w", err)
	}
	for _, row := range rows {
		workspacePath := strings.TrimSpace(row.WorktreePath)
		if workspacePath == "" {
			continue
		}
		workspacePath = filepath.Clean(workspacePath)
		if _, ok := seen[workspacePath]; ok {
			continue
		}
		info, statErr := os.Stat(workspacePath)
		if statErr != nil || !info.IsDir() {
			continue
		}
		seen[workspacePath] = struct{}{}
		paths = append(paths, workspacePath)
	}
	return paths, nil
}

// ListWorkspaceFiles returns all tracked and untracked, non-ignored files in a
// session worktree, annotated with their current git status against the
// session's recorded base when available.
func (s *Service) ListWorkspaceFiles(ctx context.Context, id domain.SessionID) (WorkspaceFiles, error) {
	rec, err := s.sessionWorkspaceRecord(ctx, id)
	if err != nil {
		return WorkspaceFiles{}, err
	}
	project, projectOK, err := s.sessionProject(ctx, rec)
	if err != nil {
		return WorkspaceFiles{}, err
	}
	projectKind := domain.ProjectKindSingleRepo
	if projectOK {
		projectKind = project.Kind.WithDefault()
	}
	if projectKind == domain.ProjectKindScratch {
		files, truncated, err := scratchWorkspaceFiles(rec.Metadata.WorkspacePath)
		if err != nil {
			return WorkspaceFiles{}, err
		}
		return WorkspaceFiles{SessionID: id, Files: files, Truncated: truncated}, nil
	}
	if projectKind == domain.ProjectKindWorkspace {
		return s.listWorkspaceProjectFiles(ctx, rec, project)
	}
	prs, err := s.workspaceComparePRs(ctx, rec.ID)
	if err != nil {
		return WorkspaceFiles{}, err
	}
	compare := resolveWorkspaceCompare(ctx, rec.Metadata.WorkspacePath, rec.Metadata.DiffBaseSHA, rec.Metadata.DiffBaseRef, defaultBranchForProject(project, projectOK), prs)
	files, truncated, err := workspaceFileSummaries(ctx, rec.Metadata.WorkspacePath, "", nil, compare)
	if err != nil {
		return WorkspaceFiles{}, err
	}
	sort.Slice(files, func(i, j int) bool { return files[i].Path < files[j].Path })
	return WorkspaceFiles{
		SessionID:      id,
		CompareBaseSHA: compare.BaseSHA,
		CompareBaseRef: compare.BaseRef,
		CompareMode:    compare.Mode,
		Files:          files,
		Truncated:      truncated,
	}, nil
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
	project, projectOK, err := s.sessionProject(ctx, rec)
	if err != nil {
		return WorkspaceFileDetail{}, err
	}
	projectKind := domain.ProjectKindSingleRepo
	if projectOK {
		projectKind = project.Kind.WithDefault()
	}
	if projectKind == domain.ProjectKindScratch {
		return scratchWorkspaceFile(rec.Metadata.WorkspacePath, id, rel)
	}
	if projectKind == domain.ProjectKindWorkspace {
		return s.getWorkspaceProjectFile(ctx, rec, project, rel)
	}
	prs, err := s.workspaceComparePRs(ctx, rec.ID)
	if err != nil {
		return WorkspaceFileDetail{}, err
	}
	compare := resolveWorkspaceCompare(ctx, rec.Metadata.WorkspacePath, rec.Metadata.DiffBaseSHA, rec.Metadata.DiffBaseRef, defaultBranchForProject(project, projectOK), prs)
	return workspaceFileDetail(ctx, id, rec.Metadata.WorkspacePath, "", rel, compare)
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

func (s *Service) sessionProject(ctx context.Context, rec domain.SessionRecord) (domain.ProjectRecord, bool, error) {
	if s.store == nil || rec.ProjectID == "" {
		return domain.ProjectRecord{}, false, nil
	}
	project, ok, err := s.store.GetProject(ctx, string(rec.ProjectID))
	if err != nil {
		return domain.ProjectRecord{}, false, fmt.Errorf("get project %s: %w", rec.ProjectID, err)
	}
	return project, ok, nil
}

func defaultBranchForProject(project domain.ProjectRecord, ok bool) string {
	if !ok {
		return domain.DefaultBranchName
	}
	return project.Config.WithDefaults().DefaultBranch
}

type workspaceCompareTarget struct {
	BaseSHA string
	BaseRef string
	Mode    WorkspaceCompareMode
}

func (c workspaceCompareTarget) gitBase() string {
	if c.Mode == WorkspaceCompareBase && strings.TrimSpace(c.BaseSHA) != "" {
		return c.BaseSHA
	}
	return "HEAD"
}

func (s *Service) workspaceComparePRs(ctx context.Context, id domain.SessionID) ([]domain.PullRequest, error) {
	if s.store == nil {
		return nil, nil
	}
	prs, err := s.store.ListPRsBySession(ctx, id)
	if err != nil {
		return nil, fmt.Errorf("list PRs for compare base: %w", err)
	}
	return prs, nil
}

func resolveWorkspaceCompare(ctx context.Context, root, recordedSHA, recordedRef, defaultBranch string, prs []domain.PullRequest) workspaceCompareTarget {
	recordedSHA = strings.TrimSpace(recordedSHA)
	recordedRef = strings.TrimSpace(recordedRef)
	if recordedRef != "" && recordedRef != "HEAD" {
		for _, ref := range workspaceBaseRefCandidates(recordedRef) {
			if sha, ok := gitMergeBase(ctx, root, ref); ok {
				return workspaceCompareTarget{BaseSHA: sha, BaseRef: ref, Mode: WorkspaceCompareBase}
			}
		}
	}
	if recordedSHA != "" && gitCommitExists(ctx, root, recordedSHA) {
		return workspaceCompareTarget{BaseSHA: recordedSHA, BaseRef: recordedRef, Mode: WorkspaceCompareBase}
	}
	if pr, ok := selectWorkspaceComparePR(prs, defaultBranch); ok {
		baseSHA := strings.TrimSpace(pr.BaseSHA)
		if gitCommitExists(ctx, root, baseSHA) {
			return workspaceCompareTarget{BaseSHA: baseSHA, BaseRef: strings.TrimSpace(pr.TargetBranch), Mode: WorkspaceCompareBase}
		}
	}
	for _, ref := range workspaceBaseRefCandidates(defaultBranch) {
		if sha, ok := gitMergeBase(ctx, root, ref); ok {
			return workspaceCompareTarget{BaseSHA: sha, BaseRef: ref, Mode: WorkspaceCompareBase}
		}
	}
	return workspaceCompareTarget{Mode: WorkspaceCompareHeadFallback}
}

func resolveWorkspaceProjectCompare(ctx context.Context, root, recordedSHA, defaultBranch string) workspaceCompareTarget {
	defaultBranch = workspaceDefaultBranch(defaultBranch)
	for _, ref := range workspaceBaseRefCandidates(defaultBranch) {
		if sha, ok := gitMergeBase(ctx, root, ref); ok {
			return workspaceCompareTarget{BaseSHA: sha, BaseRef: ref, Mode: WorkspaceCompareBase}
		}
	}
	recordedSHA = strings.TrimSpace(recordedSHA)
	if recordedSHA != "" && gitCommitExists(ctx, root, recordedSHA) {
		return workspaceCompareTarget{BaseSHA: recordedSHA, BaseRef: defaultBranch, Mode: WorkspaceCompareBase}
	}
	return workspaceCompareTarget{Mode: WorkspaceCompareHeadFallback}
}

func workspaceBaseRefCandidates(defaultBranch string) []string {
	defaultBranch = workspaceDefaultBranch(defaultBranch)
	seen := map[string]struct{}{}
	var refs []string
	add := func(ref string) {
		ref = strings.TrimSpace(ref)
		if ref == "" {
			return
		}
		if _, ok := seen[ref]; ok {
			return
		}
		seen[ref] = struct{}{}
		refs = append(refs, ref)
	}
	if !strings.HasPrefix(defaultBranch, "origin/") && !strings.HasPrefix(defaultBranch, "refs/") {
		add("origin/" + defaultBranch)
		add("refs/remotes/origin/" + defaultBranch)
	}
	add(defaultBranch)
	return refs
}

func workspaceDefaultBranch(defaultBranch string) string {
	defaultBranch = strings.TrimSpace(defaultBranch)
	if defaultBranch == "" {
		return domain.DefaultBranchName
	}
	return defaultBranch
}

func selectWorkspaceComparePR(prs []domain.PullRequest, defaultBranch string) (domain.PullRequest, bool) {
	if len(prs) == 0 {
		return domain.PullRequest{}, false
	}
	defaultBranch = strings.TrimSpace(defaultBranch)
	candidates := append([]domain.PullRequest(nil), prs...)
	sort.SliceStable(candidates, func(i, j int) bool {
		leftDefault := prTargetsDefaultBranch(candidates[i], defaultBranch)
		rightDefault := prTargetsDefaultBranch(candidates[j], defaultBranch)
		if leftDefault != rightDefault {
			return leftDefault
		}
		leftOpen := !candidates[i].Merged && !candidates[i].Closed
		rightOpen := !candidates[j].Merged && !candidates[j].Closed
		if leftOpen != rightOpen {
			return leftOpen
		}
		leftCreated := candidates[i].CreatedAtProvider
		rightCreated := candidates[j].CreatedAtProvider
		if !leftCreated.IsZero() && !rightCreated.IsZero() && !leftCreated.Equal(rightCreated) {
			return leftCreated.Before(rightCreated)
		}
		if candidates[i].Number != candidates[j].Number {
			if candidates[i].Number == 0 {
				return false
			}
			if candidates[j].Number == 0 {
				return true
			}
			return candidates[i].Number < candidates[j].Number
		}
		return candidates[i].URL < candidates[j].URL
	})
	for _, pr := range candidates {
		if strings.TrimSpace(pr.BaseSHA) != "" {
			return pr, true
		}
	}
	return domain.PullRequest{}, false
}

func prTargetsDefaultBranch(pr domain.PullRequest, defaultBranch string) bool {
	target := strings.TrimSpace(pr.TargetBranch)
	if target == "" || defaultBranch == "" {
		return false
	}
	if target == defaultBranch {
		return true
	}
	if !strings.HasPrefix(defaultBranch, "origin/") && !strings.HasPrefix(defaultBranch, "refs/") {
		return target == "origin/"+defaultBranch || target == "refs/heads/"+defaultBranch || target == "refs/remotes/origin/"+defaultBranch
	}
	return false
}

func gitCommitExists(ctx context.Context, root, rev string) bool {
	_, err := gitWorkspaceOutput(ctx, root, "cat-file", "-e", rev+"^{commit}")
	return err == nil
}

func gitMergeBase(ctx context.Context, root, ref string) (string, bool) {
	out, err := gitWorkspaceOutput(ctx, root, "merge-base", "HEAD", ref)
	if err != nil {
		return "", false
	}
	sha := strings.TrimSpace(out)
	return sha, sha != ""
}

func (s *Service) listWorkspaceProjectFiles(ctx context.Context, rec domain.SessionRecord, project domain.ProjectRecord) (WorkspaceFiles, error) {
	rows, err := s.store.ListSessionWorktrees(ctx, rec.ID)
	if err != nil {
		return WorkspaceFiles{}, fmt.Errorf("list workspace project rows: %w", err)
	}
	if len(rows) == 0 {
		prs, err := s.workspaceComparePRs(ctx, rec.ID)
		if err != nil {
			return WorkspaceFiles{}, err
		}
		compare := resolveWorkspaceCompare(ctx, rec.Metadata.WorkspacePath, rec.Metadata.DiffBaseSHA, rec.Metadata.DiffBaseRef, defaultBranchForProject(project, true), prs)
		files, truncated, err := workspaceFileSummaries(ctx, rec.Metadata.WorkspacePath, "", nil, compare)
		if err != nil {
			return WorkspaceFiles{}, err
		}
		sort.Slice(files, func(i, j int) bool { return files[i].Path < files[j].Path })
		return WorkspaceFiles{SessionID: rec.ID, CompareBaseSHA: compare.BaseSHA, CompareBaseRef: compare.BaseRef, CompareMode: compare.Mode, Files: files, Truncated: truncated}, nil
	}

	prefixes := workspaceProjectPrefixes(rec.Metadata.WorkspacePath, rows)
	childPrefixes := nonEmptyWorkspacePrefixes(prefixes)
	defaultBranch := defaultBranchForProject(project, true)
	var files []WorkspaceFileSummary
	truncated := false
	compares := make([]workspaceCompareTarget, 0, len(rows))
	for _, row := range rows {
		if strings.TrimSpace(row.WorktreePath) == "" {
			continue
		}
		prefix, ok := prefixes[row.RepoName]
		if !ok {
			continue
		}
		exclude := []string(nil)
		if prefix == "" {
			exclude = childPrefixes
		}
		compare := resolveWorkspaceProjectCompare(ctx, row.WorktreePath, row.BaseSHA, defaultBranch)
		compares = append(compares, compare)
		repoFiles, repoTruncated, err := workspaceFileSummaries(ctx, row.WorktreePath, prefix, exclude, compare)
		if err != nil {
			return WorkspaceFiles{}, err
		}
		files, truncated = appendWorkspaceFilesWithCap(files, repoFiles, truncated)
		truncated = truncated || repoTruncated
	}
	sort.Slice(files, func(i, j int) bool { return files[i].Path < files[j].Path })
	compare := aggregateWorkspaceCompare(compares)
	return WorkspaceFiles{
		SessionID:      rec.ID,
		CompareBaseSHA: compare.BaseSHA,
		CompareBaseRef: compare.BaseRef,
		CompareMode:    compare.Mode,
		Files:          files,
		Truncated:      truncated,
	}, nil
}

func (s *Service) getWorkspaceProjectFile(ctx context.Context, rec domain.SessionRecord, project domain.ProjectRecord, rel string) (WorkspaceFileDetail, error) {
	rows, err := s.store.ListSessionWorktrees(ctx, rec.ID)
	if err != nil {
		return WorkspaceFileDetail{}, fmt.Errorf("list workspace project rows: %w", err)
	}
	if len(rows) == 0 {
		prs, err := s.workspaceComparePRs(ctx, rec.ID)
		if err != nil {
			return WorkspaceFileDetail{}, err
		}
		compare := resolveWorkspaceCompare(ctx, rec.Metadata.WorkspacePath, rec.Metadata.DiffBaseSHA, rec.Metadata.DiffBaseRef, defaultBranchForProject(project, true), prs)
		return workspaceFileDetail(ctx, rec.ID, rec.Metadata.WorkspacePath, "", rel, compare)
	}
	row, prefix, repoRel, ok := workspaceProjectFileTarget(rec.Metadata.WorkspacePath, rows, rel)
	if !ok {
		return WorkspaceFileDetail{}, apierr.NotFound("WORKSPACE_FILE_NOT_FOUND", "Workspace file not found")
	}
	compare := resolveWorkspaceProjectCompare(ctx, row.WorktreePath, row.BaseSHA, defaultBranchForProject(project, true))
	return workspaceFileDetail(ctx, rec.ID, row.WorktreePath, prefix, repoRel, compare)
}

func appendWorkspaceFilesWithCap(files, repoFiles []WorkspaceFileSummary, truncated bool) ([]WorkspaceFileSummary, bool) {
	remaining := maxWorkspaceFiles - len(files)
	if remaining <= 0 {
		if len(repoFiles) > 0 {
			truncated = true
		}
		return files, truncated
	}
	if len(repoFiles) > remaining {
		files = append(files, repoFiles[:remaining]...)
		return files, true
	}
	return append(files, repoFiles...), truncated
}

func workspaceFileSummaries(ctx context.Context, root, prefix string, excludePrefixes []string, compare workspaceCompareTarget) ([]WorkspaceFileSummary, bool, error) {
	changes, err := workspaceChangeMaps(ctx, root, compare.gitBase())
	if err != nil {
		return nil, false, err
	}
	paths, truncated, err := workspaceGitFiles(ctx, root, changes.changedPaths())
	if err != nil {
		return nil, false, err
	}
	files := make([]WorkspaceFileSummary, 0, len(paths))
	for _, rel := range paths {
		if workspacePathExcluded(rel, excludePrefixes) {
			continue
		}
		status := changes.statuses[rel]
		if status == "" {
			status = WorkspaceFileUnmodified
		}
		additions, deletions := changes.counts[rel][0], changes.counts[rel][1]
		size, binary := workspaceFileSizeAndBinary(root, rel, status)
		files = append(files, WorkspaceFileSummary{
			Path:         joinWorkspaceRelative(prefix, rel),
			PreviousPath: joinWorkspaceRelative(prefix, changes.previous[rel]),
			Status:       status,
			Additions:    additions,
			Deletions:    deletions,
			Size:         size,
			Binary:       binary,
		})
	}
	return files, truncated, nil
}

func workspaceFileDetail(ctx context.Context, id domain.SessionID, root, prefix, rel string, compare workspaceCompareTarget) (WorkspaceFileDetail, error) {
	changes, err := workspaceChangeMaps(ctx, root, compare.gitBase())
	if err != nil {
		return WorkspaceFileDetail{}, err
	}
	status := changes.statuses[rel]
	if status == "" {
		status = WorkspaceFileUnmodified
	}
	additions, deletions := changes.counts[rel][0], changes.counts[rel][1]
	previousPath := changes.previous[rel]
	detail := WorkspaceFileDetail{
		SessionID:      id,
		Path:           joinWorkspaceRelative(prefix, rel),
		PreviousPath:   joinWorkspaceRelative(prefix, previousPath),
		Status:         status,
		Additions:      additions,
		Deletions:      deletions,
		Deleted:        status == WorkspaceFileDeleted,
		CompareBaseSHA: compare.BaseSHA,
		CompareBaseRef: compare.BaseRef,
		CompareMode:    compare.Mode,
	}
	if !detail.Deleted {
		file, info, err := confinedWorkspaceFile(root, rel)
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
	diff, truncated, err := workspaceFileDiff(ctx, root, compare.gitBase(), rel, status, previousPath, detail.Content, detail.Binary)
	if err != nil {
		return WorkspaceFileDetail{}, err
	}
	detail.Diff = diff
	detail.DiffTruncated = truncated
	return detail, nil
}

func workspaceProjectPrefixes(root string, rows []domain.SessionWorktreeRecord) map[string]string {
	prefixes := map[string]string{}
	for _, row := range rows {
		prefix, ok := workspaceProjectPrefix(root, row.WorktreePath)
		if !ok {
			continue
		}
		prefixes[row.RepoName] = prefix
	}
	return prefixes
}

func workspaceProjectPrefix(root, worktree string) (string, bool) {
	rootAbs, err := filepath.Abs(root)
	if err != nil {
		return "", false
	}
	worktreeAbs, err := filepath.Abs(worktree)
	if err != nil {
		return "", false
	}
	rel, err := filepath.Rel(rootAbs, worktreeAbs)
	if err != nil {
		return "", false
	}
	if rel == "." {
		return "", true
	}
	if rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", false
	}
	return filepath.ToSlash(rel), true
}

func nonEmptyWorkspacePrefixes(prefixes map[string]string) []string {
	out := make([]string, 0, len(prefixes))
	for _, prefix := range prefixes {
		if prefix != "" {
			out = append(out, prefix)
		}
	}
	sort.Slice(out, func(i, j int) bool { return len(out[i]) > len(out[j]) })
	return out
}

func workspaceProjectFileTarget(root string, rows []domain.SessionWorktreeRecord, rel string) (domain.SessionWorktreeRecord, string, string, bool) {
	var best domain.SessionWorktreeRecord
	bestPrefix := ""
	bestRel := rel
	found := false
	for _, row := range rows {
		prefix, ok := workspaceProjectPrefix(root, row.WorktreePath)
		if !ok {
			continue
		}
		if prefix == "" {
			if !found {
				best = row
				bestPrefix = ""
				bestRel = rel
				found = true
			}
			continue
		}
		if !strings.HasPrefix(rel, prefix+"/") {
			continue
		}
		if !found || len(prefix) > len(bestPrefix) {
			best = row
			bestPrefix = prefix
			bestRel = strings.TrimPrefix(rel, prefix+"/")
			found = true
		}
	}
	return best, bestPrefix, bestRel, found
}

func aggregateWorkspaceCompare(compares []workspaceCompareTarget) workspaceCompareTarget {
	if len(compares) == 0 {
		return workspaceCompareTarget{Mode: WorkspaceCompareHeadFallback}
	}
	baseFound := false
	fallbackFound := false
	baseSHA := ""
	baseRef := ""
	for _, compare := range compares {
		if compare.Mode != WorkspaceCompareBase {
			fallbackFound = true
			continue
		}
		if !baseFound {
			baseFound = true
			baseSHA = compare.BaseSHA
			baseRef = compare.BaseRef
			continue
		}
		if compare.BaseSHA != baseSHA {
			baseSHA = ""
		}
		if compare.BaseRef != baseRef {
			baseRef = ""
		}
	}
	if !baseFound {
		return workspaceCompareTarget{Mode: WorkspaceCompareHeadFallback}
	}
	if fallbackFound {
		baseSHA = ""
		baseRef = ""
	}
	return workspaceCompareTarget{BaseSHA: baseSHA, BaseRef: baseRef, Mode: WorkspaceCompareBase}
}

func workspacePathExcluded(rel string, prefixes []string) bool {
	for _, prefix := range prefixes {
		if prefix == "" {
			continue
		}
		if rel == prefix || strings.HasPrefix(rel, prefix+"/") {
			return true
		}
	}
	return false
}

func joinWorkspaceRelative(prefix, rel string) string {
	if rel == "" {
		return ""
	}
	if prefix == "" {
		return rel
	}
	return prefix + "/" + rel
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

func workspaceGitFiles(ctx context.Context, root string, extraPaths map[string]struct{}) ([]string, bool, error) {
	out, err := gitWorkspaceOutput(ctx, root, "ls-files", "-z", "-co", "--exclude-standard")
	if err != nil {
		return nil, false, err
	}
	parts := splitNUL(out)
	paths := make([]string, 0, len(parts))
	seen := map[string]struct{}{}
	truncated := false
	addPath := func(part string) {
		rel := filepath.ToSlash(part)
		if rel == "" {
			return
		}
		if _, ok := seen[rel]; ok {
			return
		}
		seen[rel] = struct{}{}
		if len(paths) >= maxWorkspaceFiles {
			truncated = true
			return
		}
		paths = append(paths, rel)
	}
	extra := make([]string, 0, len(extraPaths))
	for rel := range extraPaths {
		extra = append(extra, rel)
	}
	sort.Strings(extra)
	for _, rel := range extra {
		addPath(rel)
	}
	for _, part := range parts {
		addPath(part)
	}
	return paths, truncated, nil
}

type workspaceChangeSet struct {
	statuses map[string]WorkspaceFileStatus
	counts   map[string][2]int
	previous map[string]string
}

func (c workspaceChangeSet) changedPaths() map[string]struct{} {
	paths := map[string]struct{}{}
	for rel := range c.statuses {
		paths[rel] = struct{}{}
	}
	for rel := range c.counts {
		paths[rel] = struct{}{}
	}
	return paths
}

func workspaceChangeMaps(ctx context.Context, root, base string) (workspaceChangeSet, error) {
	diffStatuses, diffPrevious, err := workspaceDiffStatuses(ctx, root, base)
	if err != nil {
		return workspaceChangeSet{}, err
	}
	statusStatuses, statusPrevious, err := workspaceStatuses(ctx, root)
	if err != nil {
		return workspaceChangeSet{}, err
	}
	counts, err := workspaceNumstat(ctx, root, base)
	if err != nil {
		return workspaceChangeSet{}, err
	}
	statuses := map[string]WorkspaceFileStatus{}
	previous := map[string]string{}
	for rel, status := range diffStatuses {
		statuses[rel] = status
	}
	for rel, prev := range diffPrevious {
		previous[rel] = prev
	}
	for rel, status := range statusStatuses {
		if _, ok := statuses[rel]; ok {
			continue
		}
		statuses[rel] = status
	}
	for rel, prev := range statusPrevious {
		if _, ok := previous[rel]; ok {
			continue
		}
		previous[rel] = prev
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
	return workspaceChangeSet{statuses: statuses, counts: counts, previous: previous}, nil
}

func workspaceStatuses(ctx context.Context, root string) (map[string]WorkspaceFileStatus, map[string]string, error) {
	out, err := gitWorkspaceOutput(ctx, root, "status", "--porcelain=v1", "-z", "--untracked-files=all")
	if err != nil {
		return nil, nil, err
	}
	parts := splitNUL(out)
	statuses := map[string]WorkspaceFileStatus{}
	previous := map[string]string{}
	for i := 0; i < len(parts); i++ {
		entry := parts[i]
		if len(entry) < 4 {
			continue
		}
		xy := entry[:2]
		rel := filepath.ToSlash(entry[3:])
		statuses[rel] = classifyWorkspaceStatus(xy)
		if strings.ContainsAny(xy, "RC") && i+1 < len(parts) {
			previous[rel] = filepath.ToSlash(parts[i+1])
			i++
		}
	}
	return statuses, previous, nil
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

func workspaceDiffStatuses(ctx context.Context, root, base string) (map[string]WorkspaceFileStatus, map[string]string, error) {
	out, err := gitWorkspaceOutput(ctx, root, "diff", "--name-status", "--find-renames", "-z", base, "--")
	if err != nil {
		return nil, nil, err
	}
	parts := splitNUL(out)
	statuses := map[string]WorkspaceFileStatus{}
	previous := map[string]string{}
	for i := 0; i < len(parts); {
		statusCode, paths, next := parseGitStatusRecord(parts, i)
		i = next
		if statusCode == "" || len(paths) == 0 {
			continue
		}
		status := classifyNameStatus(statusCode)
		rel := filepath.ToSlash(paths[len(paths)-1])
		statuses[rel] = status
		if status == WorkspaceFileRenamed && len(paths) > 1 {
			previous[rel] = filepath.ToSlash(paths[0])
		}
	}
	return statuses, previous, nil
}

func parseGitStatusRecord(parts []string, i int) (string, []string, int) {
	if i >= len(parts) {
		return "", nil, i + 1
	}
	token := parts[i]
	if fields := strings.Split(token, "\t"); len(fields) >= 2 {
		status := fields[0]
		if status == "" {
			return "", nil, i + 1
		}
		if strings.HasPrefix(status, "R") || strings.HasPrefix(status, "C") {
			if len(fields) >= 3 {
				return status, []string{fields[1], fields[2]}, i + 1
			}
			return status, fields[1:], i + 1
		}
		return status, []string{fields[1]}, i + 1
	}
	status := token
	if strings.HasPrefix(status, "R") || strings.HasPrefix(status, "C") {
		if i+2 >= len(parts) {
			return status, nil, len(parts)
		}
		return status, []string{parts[i+1], parts[i+2]}, i + 3
	}
	if i+1 >= len(parts) {
		return status, nil, len(parts)
	}
	return status, []string{parts[i+1]}, i + 2
}

func classifyNameStatus(status string) WorkspaceFileStatus {
	switch status[0] {
	case 'A':
		return WorkspaceFileAdded
	case 'D':
		return WorkspaceFileDeleted
	case 'R', 'C':
		return WorkspaceFileRenamed
	case 'M', 'T':
		return WorkspaceFileModified
	default:
		return WorkspaceFileModified
	}
}

func workspaceNumstat(ctx context.Context, root, base string) (map[string][2]int, error) {
	out, err := gitWorkspaceOutput(ctx, root, "diff", "--numstat", "--find-renames", "-z", base, "--")
	if err != nil {
		return nil, err
	}
	counts := map[string][2]int{}
	parts := splitNUL(out)
	for i := 0; i < len(parts); {
		fields := strings.Split(parts[i], "\t")
		i++
		if len(fields) < 3 {
			continue
		}
		additions, addOK := parseNumstatField(fields[0])
		deletions, delOK := parseNumstatField(fields[1])
		if !addOK || !delOK {
			if fields[2] == "" && i+2 <= len(parts) {
				i += 2
			}
			continue
		}
		rel := fields[2]
		if rel == "" && i+2 <= len(parts) {
			rel = parts[i+1]
			i += 2
		}
		if rel == "" {
			continue
		}
		counts[filepath.ToSlash(rel)] = [2]int{additions, deletions}
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

func workspaceFileDiff(ctx context.Context, root, base, rel string, status WorkspaceFileStatus, previousPath, content string, binary bool) (string, bool, error) {
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
	args := []string{"diff", "--no-ext-diff", "--find-renames", "--unified=3", base, "--"}
	if status == WorkspaceFileRenamed && previousPath != "" {
		args = append(args, previousPath)
	}
	args = append(args, rel)
	out, err := gitWorkspaceOutput(ctx, root, args...)
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
