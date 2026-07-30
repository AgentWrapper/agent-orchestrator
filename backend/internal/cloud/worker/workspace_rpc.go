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
	"time"
	"unicode/utf8"

	"github.com/creack/pty"

	cloudworkerhub "github.com/aoagents/agent-orchestrator/backend/internal/cloud/workerhub"
)

const (
	maxInspectorFileBytes = 1 << 20
	maxPreviewBodyBytes   = 4 << 20
)

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

func (r *Runner) startWorkspaceShell(ctx context.Context, environment []string) (func(), error) {
	command := exec.CommandContext(ctx, "/bin/bash", "--noprofile", "--norc")
	command.Dir = r.workspaceDir
	command.Env = append([]string(nil), environment...)
	command.Env = append(command.Env, "TERM=xterm-256color", `PS1=\[\e[38;5;75m\]\w\[\e[0m\] \$ `)
	terminal, err := pty.Start(command)
	if err != nil {
		return nil, fmt.Errorf("start workspace shell: %w", err)
	}
	r.shellWriteMu.Lock()
	r.shellTerminal = terminal
	r.shellWriteMu.Unlock()

	done := make(chan struct{})
	go func() {
		defer close(done)
		if err := r.streamOutput(ctx, terminal); err != nil &&
			!errors.Is(err, io.EOF) &&
			ctx.Err() == nil {
			_ = r.client.Event(ctx, "terminal.shell_failed", map[string]string{"error": err.Error()})
		}
		_ = command.Wait()
	}()

	return func() {
		r.shellWriteMu.Lock()
		if r.shellTerminal == terminal {
			r.shellTerminal = nil
		}
		_ = terminal.Close()
		r.shellWriteMu.Unlock()
		if command.Process != nil {
			_ = command.Process.Kill()
		}
		<-done
	}, nil
}

func (r *Runner) dispatchWorkspaceCommand(
	ctx context.Context,
	command cloudworkerhub.Command,
) bool {
	switch command.Type {
	case "input":
		decoded, err := base64.StdEncoding.DecodeString(command.Data)
		if err != nil {
			return true
		}
		r.shellWriteMu.Lock()
		if r.shellTerminal != nil {
			_, _ = r.shellTerminal.Write(decoded)
		}
		r.shellWriteMu.Unlock()
		return true
	case "resize":
		r.shellWriteMu.Lock()
		if r.shellTerminal != nil {
			_ = pty.Setsize(r.shellTerminal, &pty.Winsize{Rows: command.Rows, Cols: command.Cols})
		}
		r.shellWriteMu.Unlock()
		return true
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
	status, err := limitedCommandOutput(ctx, r.workspaceDir, maxInspectorFileBytes, "git", "status", "--short")
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
	return map[string]any{
		"status":   string(status),
		"unstaged": string(unstaged),
		"staged":   string(staged),
	}, nil
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
	command := exec.CommandContext(ctx, name, args...)
	command.Dir = dir
	var output bytes.Buffer
	command.Stdout = &output
	command.Stderr = &output
	if err := command.Run(); err != nil {
		return nil, fmt.Errorf("%s: %w: %s", name, err, strings.TrimSpace(output.String()))
	}
	if int64(output.Len()) > limit {
		return nil, errors.New("workspace output exceeds the inspector limit")
	}
	return output.Bytes(), nil
}
