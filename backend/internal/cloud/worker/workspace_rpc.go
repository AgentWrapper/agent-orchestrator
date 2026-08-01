package worker

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	cloudworkerhub "github.com/aoagents/agent-orchestrator/backend/internal/cloud/workerhub"
	"github.com/aoagents/agent-orchestrator/backend/internal/contract"
)

const (
	maxInspectorFileBytes = 1 << 20
	maxPreviewBodyBytes   = 4 << 20
)

var errWorkspaceOutputLimit = errors.New("workspace output exceeds the inspector limit")

type cappedCommandBuffer struct {
	mu       sync.Mutex
	buffer   bytes.Buffer
	limit    int64
	exceeded bool
	cancel   context.CancelFunc
}

func (w *cappedCommandBuffer) Write(value []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.exceeded {
		return len(value), nil
	}
	remaining := w.limit - int64(w.buffer.Len())
	if remaining <= 0 {
		w.exceeded = true
		w.cancel()
		return len(value), nil
	}
	if int64(len(value)) > remaining {
		_, _ = w.buffer.Write(value[:int(remaining)])
		w.exceeded = true
		w.cancel()
		return len(value), nil
	}
	_, _ = w.buffer.Write(value)
	return len(value), nil
}

func (w *cappedCommandBuffer) result() ([]byte, bool) {
	w.mu.Lock()
	defer w.mu.Unlock()
	return append([]byte(nil), w.buffer.Bytes()...), w.exceeded
}

type workspaceRequest struct {
	Path   string `json:"path,omitempty"`
	Port   int    `json:"port,omitempty"`
	Method string `json:"method,omitempty"`
}

type workspaceEntry struct {
	Name    string `json:"name"`
	Path    string `json:"path"`
	IsDir   bool   `json:"isDir"`
	Size    int64  `json:"size"`
	Mode    string `json:"mode"`
	ModTime string `json:"modTime"`
}

type workspaceDiffFile = contract.WorkspaceDiffFile

func (r *Runner) dispatchWorkspaceCommand(
	ctx context.Context,
	command cloudworkerhub.Command,
) bool {
	switch command.Type {
	case "workspace_request":
		go r.respondToWorkspaceRequest(ctx, command)
		return true
	default:
		return false
	}
}

func (r *Runner) respondToWorkspaceRequest(parent context.Context, command cloudworkerhub.Command) {
	ctx, cancel := context.WithTimeout(parent, 20*time.Second)
	defer cancel()

	var input workspaceRequest
	decoded, err := base64.StdEncoding.DecodeString(command.Data)
	if err == nil && len(decoded) > 0 {
		err = json.Unmarshal(decoded, &input)
	}
	var payload any
	if err == nil {
		payload, err = r.runWorkspaceRequest(ctx, command.Action, input)
	}
	responseError := ""
	if err != nil {
		responseError = err.Error()
	}
	_ = r.client.WorkspaceResponse(ctx, command.RequestID, payload, responseError)
}

func (r *Runner) runWorkspaceRequest(
	ctx context.Context,
	action string,
	input workspaceRequest,
) (any, error) {
	switch action {
	case "list":
		return r.listWorkspace(input.Path)
	case "read":
		return r.readWorkspaceFile(input.Path)
	case "diff":
		return r.workspaceDiff(ctx)
	case "preview":
		return r.previewLocalhost(ctx, input)
	case "preview_file":
		return r.previewWorkspaceFile(input)
	default:
		return nil, fmt.Errorf("unsupported workspace action %q", action)
	}
}

func (r *Runner) previewWorkspaceFile(input workspaceRequest) (map[string]any, error) {
	method := strings.ToUpper(strings.TrimSpace(input.Method))
	if method == "" {
		method = http.MethodGet
	}
	if method != http.MethodGet && method != http.MethodHead {
		return nil, errors.New("file preview only supports GET and HEAD")
	}
	fullPath, _, err := r.resolveWorkspacePath(input.Path)
	if err != nil {
		return nil, err
	}
	info, err := os.Stat(fullPath)
	if err != nil {
		if os.IsNotExist(err) {
			return map[string]any{
				"status":      http.StatusNotFound,
				"contentType": "text/plain; charset=utf-8",
				"body":        base64.StdEncoding.EncodeToString([]byte("File not found.")),
			}, nil
		}
		return nil, fmt.Errorf("stat preview file: %w", err)
	}
	if info.IsDir() {
		fullPath = filepath.Join(fullPath, "index.html")
		info, err = os.Stat(fullPath)
		if err != nil {
			return nil, fmt.Errorf("open directory preview index: %w", err)
		}
	}
	if info.Size() > maxPreviewBodyBytes {
		return nil, errors.New("preview file exceeds the 4 MiB limit")
	}
	body, err := os.ReadFile(fullPath)
	if err != nil {
		return nil, fmt.Errorf("read preview file: %w", err)
	}
	contentType := mime.TypeByExtension(strings.ToLower(filepath.Ext(fullPath)))
	if contentType == "" {
		contentType = http.DetectContentType(body)
	}
	return map[string]any{
		"status":      http.StatusOK,
		"contentType": contentType,
		"body":        base64.StdEncoding.EncodeToString(body),
	}, nil
}

func (r *Runner) listWorkspace(path string) (map[string]any, error) {
	fullPath, relativePath, err := r.resolveWorkspacePath(path)
	if err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(fullPath)
	if err != nil {
		return nil, fmt.Errorf("read workspace directory: %w", err)
	}
	if len(entries) > 500 {
		entries = entries[:500]
	}
	result := make([]workspaceEntry, 0, len(entries))
	for _, entry := range entries {
		info, infoErr := entry.Info()
		if infoErr != nil {
			continue
		}
		entryPath := filepath.ToSlash(filepath.Join(relativePath, entry.Name()))
		result = append(result, workspaceEntry{
			Name:    entry.Name(),
			Path:    strings.TrimPrefix(entryPath, "./"),
			IsDir:   entry.IsDir(),
			Size:    info.Size(),
			Mode:    info.Mode().String(),
			ModTime: info.ModTime().UTC().Format(time.RFC3339),
		})
	}
	return map[string]any{"path": relativePath, "entries": result}, nil
}

func (r *Runner) readWorkspaceFile(path string) (map[string]any, error) {
	fullPath, relativePath, err := r.resolveWorkspacePath(path)
	if err != nil {
		return nil, err
	}
	info, err := os.Stat(fullPath)
	if err != nil {
		return nil, fmt.Errorf("stat workspace file: %w", err)
	}
	if info.IsDir() {
		return nil, errors.New("workspace path is a directory")
	}
	if info.Size() > maxInspectorFileBytes {
		return nil, errors.New("workspace file exceeds the 1 MiB inspector limit")
	}
	contents, err := os.ReadFile(fullPath)
	if err != nil {
		return nil, fmt.Errorf("read workspace file: %w", err)
	}
	if !utf8.Valid(contents) {
		return nil, errors.New("binary files cannot be displayed")
	}
	return map[string]any{
		"path":    relativePath,
		"content": string(contents),
		"size":    len(contents),
	}, nil
}

func (r *Runner) workspaceDiff(ctx context.Context) (map[string]any, error) {
	baseRef, baseSHA := r.workspaceDiffBase(ctx)
	status, err := limitedCommandOutput(
		ctx,
		r.workspaceDir,
		maxInspectorFileBytes,
		"git",
		"status",
		"--short",
		"--untracked-files=all",
	)
	if err != nil {
		return nil, err
	}
	statusFiles, untracked := parseWorkspaceStatus(string(status))
	stats, statsTruncated, err := r.workspaceDiffStats(ctx, baseRef)
	if err != nil {
		return nil, err
	}
	unstaged, err := limitedCommandOutput(
		ctx,
		r.workspaceDir,
		maxInspectorFileBytes,
		"git",
		"diff",
		"--no-ext-diff",
		"--no-color",
	)
	if err != nil {
		return nil, err
	}
	staged, err := limitedCommandOutput(
		ctx,
		r.workspaceDir,
		maxInspectorFileBytes,
		"git",
		"diff",
		"--cached",
		"--no-ext-diff",
		"--no-color",
	)
	if err != nil {
		return nil, err
	}
	combined, combinedTruncated, err := r.workspaceCombinedDiff(ctx, baseRef)
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"status":         string(status),
		"unstaged":       string(unstaged),
		"staged":         string(staged),
		"combined":       string(combined),
		"diffBaseRef":    baseRef,
		"diffBaseSha":    baseSHA,
		"files":          mergeWorkspaceDiffFiles(statusFiles, stats),
		"untrackedFiles": untracked,
		"truncated": map[string]bool{
			"combined": combinedTruncated,
			"stats":    statsTruncated,
		},
	}, nil
}

func (r *Runner) workspaceDiffBase(ctx context.Context) (string, string) {
	defaultBranch := strings.TrimSpace(r.bootstrap.Launch.DefaultBranch)
	if defaultBranch == "" {
		defaultBranch = "main"
	}
	candidates := []string{"origin/" + defaultBranch, defaultBranch, "HEAD~1"}
	for _, candidate := range candidates {
		sha, err := commandOutput(ctx, r.workspaceDir, "git", "merge-base", "HEAD", candidate)
		if err == nil && strings.TrimSpace(string(sha)) != "" {
			return candidate, strings.TrimSpace(string(sha))
		}
	}
	sha, err := commandOutput(ctx, r.workspaceDir, "git", "rev-parse", "HEAD")
	if err != nil {
		return "HEAD", ""
	}
	return "HEAD", strings.TrimSpace(string(sha))
}

func (r *Runner) workspaceDiffStats(ctx context.Context, baseRef string) (map[string]workspaceDiffFile, bool, error) {
	output, err := limitedCommandOutput(
		ctx,
		r.workspaceDir,
		maxInspectorFileBytes,
		"git",
		"diff",
		"--numstat",
		"--find-renames",
		baseRef+"...HEAD",
	)
	if errors.Is(err, errWorkspaceOutputLimit) {
		return nil, true, nil
	}
	if err != nil {
		return nil, false, err
	}
	return parseWorkspaceNumstat(string(output)), false, nil
}

func (r *Runner) workspaceCombinedDiff(ctx context.Context, baseRef string) ([]byte, bool, error) {
	output, err := limitedCommandOutput(
		ctx,
		r.workspaceDir,
		maxInspectorFileBytes,
		"git",
		"diff",
		"--no-ext-diff",
		"--no-color",
		"--find-renames",
		baseRef+"...HEAD",
	)
	if errors.Is(err, errWorkspaceOutputLimit) {
		return nil, true, nil
	}
	if err != nil {
		return nil, false, err
	}
	return output, false, nil
}

func parseWorkspaceStatus(status string) (map[string]workspaceDiffFile, []string) {
	files := make(map[string]workspaceDiffFile)
	untracked := make([]string, 0)
	for _, line := range strings.Split(status, "\n") {
		if len(line) < 4 {
			continue
		}
		staged := line[:1]
		unstaged := line[1:2]
		pathText := strings.TrimSpace(line[3:])
		if pathText == "" {
			continue
		}
		oldPath := ""
		pathValue := pathText
		if before, after, ok := strings.Cut(pathText, " -> "); ok {
			oldPath = before
			pathValue = after
		}
		if staged == "?" && unstaged == "?" {
			untracked = append(untracked, pathValue)
		}
		file := files[pathValue]
		file.Path = pathValue
		file.OldPath = oldPath
		file.Status = workspaceStatusLabel(staged, unstaged)
		file.Staged = strings.TrimSpace(staged)
		file.Unstaged = strings.TrimSpace(unstaged)
		files[pathValue] = file
	}
	return files, untracked
}

func workspaceStatusLabel(staged, unstaged string) contract.WorkspaceFileStatus {
	if staged == "?" && unstaged == "?" {
		return contract.WorkspaceFileUntracked
	}
	code := staged
	if code == " " {
		code = unstaged
	}
	switch code {
	case "A":
		return contract.WorkspaceFileAdded
	case "D":
		return contract.WorkspaceFileDeleted
	case "R":
		return contract.WorkspaceFileRenamed
	case "C":
		return contract.WorkspaceFileCopied
	case "M":
		return contract.WorkspaceFileModified
	default:
		return contract.WorkspaceFileChanged
	}
}

func parseWorkspaceNumstat(output string) map[string]workspaceDiffFile {
	result := make(map[string]workspaceDiffFile)
	for _, line := range strings.Split(output, "\n") {
		fields := strings.Split(line, "\t")
		if len(fields) < 3 {
			continue
		}
		additions, binary := parseNumstatCount(fields[0])
		deletions, binaryDeletes := parseNumstatCount(fields[1])
		pathValue := fields[2]
		oldPath := ""
		if strings.Contains(pathValue, " => ") {
			oldPath, pathValue = parseRenamePath(pathValue)
		}
		file := result[pathValue]
		file.Path = pathValue
		file.OldPath = oldPath
		file.Additions = additions
		file.Deletions = deletions
		file.Binary = binary || binaryDeletes
		result[pathValue] = file
	}
	return result
}

func parseNumstatCount(value string) (int, bool) {
	if value == "-" {
		return 0, true
	}
	count, err := strconv.Atoi(value)
	if err != nil {
		return 0, false
	}
	return count, false
}

func parseRenamePath(value string) (string, string) {
	open := strings.Index(value, "{")
	close := strings.Index(value, "}")
	if open < 0 || close < open {
		parts := strings.Split(value, " => ")
		return parts[0], parts[len(parts)-1]
	}
	prefix := value[:open]
	suffix := value[close+1:]
	middle := value[open+1 : close]
	before, after, ok := strings.Cut(middle, " => ")
	if !ok {
		parts := strings.Split(value, " => ")
		return parts[0], parts[len(parts)-1]
	}
	return prefix + before + suffix, prefix + after + suffix
}

func mergeWorkspaceDiffFiles(
	statusFiles map[string]workspaceDiffFile,
	stats map[string]workspaceDiffFile,
) []workspaceDiffFile {
	for pathValue, stat := range stats {
		file := statusFiles[pathValue]
		file.Path = pathValue
		if file.Status == "" {
			file.Status = contract.WorkspaceFileModified
		}
		if file.OldPath == "" {
			file.OldPath = stat.OldPath
		}
		file.Additions = stat.Additions
		file.Deletions = stat.Deletions
		file.Binary = stat.Binary
		statusFiles[pathValue] = file
	}
	files := make([]workspaceDiffFile, 0, len(statusFiles))
	for _, file := range statusFiles {
		files = append(files, file)
	}
	return files
}

func (r *Runner) previewLocalhost(
	ctx context.Context,
	input workspaceRequest,
) (map[string]any, error) {
	if input.Port < 1024 || input.Port > 65535 {
		return nil, errors.New("preview port must be between 1024 and 65535")
	}
	method := strings.ToUpper(strings.TrimSpace(input.Method))
	if method == "" {
		method = http.MethodGet
	}
	if method != http.MethodGet && method != http.MethodHead {
		return nil, errors.New("preview only supports GET and HEAD")
	}
	path := strings.TrimSpace(input.Path)
	if path == "" {
		path = "/"
	}
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}
	target := "http://127.0.0.1:" + strconv.Itoa(input.Port) + path
	request, err := http.NewRequestWithContext(ctx, method, target, http.NoBody)
	if err != nil {
		return nil, fmt.Errorf("build preview request: %w", err)
	}
	client := &http.Client{
		Timeout: 15 * time.Second,
		Transport: &http.Transport{
			Proxy: nil,
			DialContext: (&net.Dialer{
				Timeout: 5 * time.Second,
			}).DialContext,
		},
		CheckRedirect: func(request *http.Request, _ []*http.Request) error {
			if request.URL.Hostname() != "127.0.0.1" && request.URL.Hostname() != "localhost" {
				return errors.New("preview redirect left localhost")
			}
			if request.URL.Port() != strconv.Itoa(input.Port) {
				return errors.New("preview redirect changed ports")
			}
			return nil
		},
	}
	response, err := client.Do(request)
	if err != nil {
		return nil, fmt.Errorf("open localhost preview: %w", err)
	}
	defer func() { _ = response.Body.Close() }()
	body, err := io.ReadAll(io.LimitReader(response.Body, maxPreviewBodyBytes+1))
	if err != nil {
		return nil, fmt.Errorf("read preview response: %w", err)
	}
	if len(body) > maxPreviewBodyBytes {
		return nil, errors.New("preview response exceeds the 4 MiB limit")
	}
	return map[string]any{
		"status":      response.StatusCode,
		"contentType": response.Header.Get("Content-Type"),
		"location":    response.Header.Get("Location"),
		"body":        base64.StdEncoding.EncodeToString(body),
		"url":         target,
	}, nil
}

func (r *Runner) resolveWorkspacePath(path string) (string, string, error) {
	relativePath := filepath.Clean(strings.TrimPrefix(strings.TrimSpace(path), "/"))
	if relativePath == "." {
		relativePath = ""
	}
	fullPath := filepath.Join(r.workspaceDir, relativePath)
	resolved, err := filepath.EvalSymlinks(fullPath)
	if err != nil {
		return "", "", fmt.Errorf("resolve workspace path: %w", err)
	}
	workspaceResolved, err := filepath.EvalSymlinks(r.workspaceDir)
	if err != nil {
		return "", "", fmt.Errorf("resolve workspace root: %w", err)
	}
	relativeResolved, err := filepath.Rel(workspaceResolved, resolved)
	if err != nil || relativeResolved == ".." || strings.HasPrefix(relativeResolved, ".."+string(os.PathSeparator)) {
		return "", "", errors.New("workspace path escapes the repository")
	}
	return resolved, filepath.ToSlash(relativeResolved), nil
}

func limitedCommandOutput(
	ctx context.Context,
	dir string,
	limit int64,
	name string,
	args ...string,
) ([]byte, error) {
	commandContext, cancel := context.WithCancel(ctx)
	defer cancel()
	command := exec.CommandContext(commandContext, name, args...)
	command.Dir = dir
	output := &cappedCommandBuffer{limit: limit, cancel: cancel}
	command.Stdout = output
	command.Stderr = output
	runErr := command.Run()
	value, exceeded := output.result()
	if exceeded {
		return nil, errWorkspaceOutputLimit
	}
	if runErr != nil {
		return nil, fmt.Errorf("%s: %w: %s", name, runErr, strings.TrimSpace(string(value)))
	}
	return value, nil
}

func commandOutput(
	ctx context.Context,
	dir string,
	name string,
	args ...string,
) ([]byte, error) {
	command := exec.CommandContext(ctx, name, args...)
	command.Dir = dir
	output, err := command.Output()
	if err != nil {
		return nil, fmt.Errorf("%s: %w", name, err)
	}
	return output, nil
}
