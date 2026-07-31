// Package reviewgateway defines the capability boundary used by interactive
// reviewer TUIs. It deliberately exposes review operations, not a command
// runner or a project checkout.
package reviewgateway

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

const manifestVersion = 1

var (
	errUnauthorized = errors.New("review gateway: operation is not authorized by the task manifest")
	safeID          = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`)
	commitSHA       = regexp.MustCompile(`^[0-9a-fA-F]{7,64}$`)
)

// ErrUnauthorized is returned when a request is not an exact capability in
// the immutable task manifest.
var ErrUnauthorized = errUnauthorized

// Task is one immutable review capability. BaseSHA is optional; when absent,
// comparison operations are unavailable.
type Task struct {
	RunID          string `json:"runId"`
	PRURL          string `json:"prUrl"`
	TargetSHA      string `json:"targetSha"`
	BaseSHA        string `json:"baseSha,omitempty"`
	TaskPromptFile string `json:"taskPromptFile"`
}

// Manifest authorizes a reviewer process for one worker and an exact set of
// review runs. WorkspacePath is host-side gateway state and is never intended
// to be exposed as the TUI's working directory.
type Manifest struct {
	Version         int              `json:"version"`
	ReviewerID      string           `json:"reviewerId"`
	WorkerSessionID domain.SessionID `json:"workerSessionId"`
	WorkspacePath   string           `json:"workspacePath"`
	TaskPromptRoot  string           `json:"taskPromptRoot"`
	Tasks           []Task           `json:"tasks"`
}

// Environment is the neutral AO-owned filesystem presented to a reviewer.
// The source checkout is intentionally absent.
type Environment struct {
	DataDir          string
	Root             string
	WorkingDirectory string
	ConfigRoot       string
	StateRoot        string
	CacheRoot        string
	TempRoot         string
	ManifestPath     string
}

// TUIEnvironment returns provider-neutral directory overrides for an adapter's
// RuntimeConfig.Env. Provider-specific adapters may add only documented flags;
// the eventual OS sandbox remains responsible for excluding inherited host state.
func (e Environment) TUIEnvironment() map[string]string {
	return map[string]string{
		"HOME": e.ConfigRoot, "XDG_CONFIG_HOME": e.ConfigRoot,
		"XDG_STATE_HOME": e.StateRoot, "XDG_CACHE_HOME": e.CacheRoot,
		"TMPDIR": e.TempRoot, "TEMP": e.TempRoot, "TMP": e.TempRoot,
	}
}

// Operations is the capability surface an interactive reviewer adapter may
// consume. It intentionally has no arbitrary command or filesystem method.
type Operations interface {
	ListFiles(context.Context, string) ([]string, error)
	ReadFile(context.Context, string, string) ([]byte, error)
	Search(context.Context, string, string, int) ([]Match, error)
	Diff(context.Context, string) ([]byte, error)
	ShowCommit(context.Context, string) ([]byte, error)
	ReadTaskPrompt(string) ([]byte, error)
	PostReview(context.Context, string, string, string, string) (string, error)
	Submit(context.Context, []Result) error
}

// PrepareEnvironment creates a private reviewer root under AO_DATA_DIR and an
// immutable, content-addressed authorization manifest. It never creates files
// in the project checkout.
func PrepareEnvironment(dataDir string, manifest Manifest) (Environment, error) {
	if strings.TrimSpace(dataDir) == "" {
		return Environment{}, errors.New("review gateway: AO data directory is required")
	}
	if !filepath.IsAbs(dataDir) {
		return Environment{}, errors.New("review gateway: AO data directory must be absolute")
	}
	if err := validateManifest(&manifest); err != nil {
		return Environment{}, err
	}
	root := filepath.Join(dataDir, "reviewer-runtime", manifest.ReviewerID)
	env := Environment{
		DataDir:          dataDir,
		Root:             root,
		WorkingDirectory: filepath.Join(root, "workspace"),
		ConfigRoot:       filepath.Join(root, "config"),
		StateRoot:        filepath.Join(root, "state"),
		CacheRoot:        filepath.Join(root, "cache"),
		TempRoot:         filepath.Join(root, "tmp"),
	}
	for _, dir := range []string{filepath.Join(dataDir, "reviewer-runtime"), env.Root, env.WorkingDirectory, env.ConfigRoot, env.StateRoot, env.CacheRoot, env.TempRoot, filepath.Join(root, "manifests"), filepath.Join(root, "disabled-git-hooks")} {
		if err := ensurePrivateDir(dir); err != nil {
			return Environment{}, err
		}
	}
	raw, err := json.Marshal(manifest)
	if err != nil {
		return Environment{}, fmt.Errorf("review gateway: encode manifest: %w", err)
	}
	sum := sha256.Sum256(raw)
	env.ManifestPath = filepath.Join(root, "manifests", hex.EncodeToString(sum[:])+".json")
	if prior, readErr := os.ReadFile(env.ManifestPath); readErr == nil {
		if !bytes.Equal(prior, raw) {
			return Environment{}, errors.New("review gateway: content-addressed manifest collision")
		}
		return env, nil
	} else if !errors.Is(readErr, os.ErrNotExist) {
		return Environment{}, fmt.Errorf("review gateway: inspect manifest: %w", readErr)
	}
	f, err := os.OpenFile(env.ManifestPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return Environment{}, fmt.Errorf("review gateway: create manifest: %w", err)
	}
	if _, err = f.Write(raw); err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err != nil {
		return Environment{}, fmt.Errorf("review gateway: write manifest: %w", err)
	}
	if closeErr != nil {
		return Environment{}, fmt.Errorf("review gateway: close manifest: %w", closeErr)
	}
	return env, nil
}

// Command is a fixed executable invocation. There is intentionally no shell
// field and no caller-provided argv in Gateway operations.
type Command struct {
	Path  string
	Args  []string
	Dir   string
	Env   []string
	Stdin []byte
}

// Executor runs a fully constructed command. Production callers may use
// ExecExecutor; tests and future platform sandboxes can inject stricter ones.
type Executor interface {
	Execute(context.Context, Command) ([]byte, error)
}

// ExecExecutor invokes an executable directly, never through a shell.
type ExecExecutor struct{}

// Execute runs one gateway-constructed command without invoking a shell.
func (ExecExecutor) Execute(ctx context.Context, command Command) ([]byte, error) {
	cmd := exec.CommandContext(ctx, command.Path, command.Args...)
	cmd.Dir = command.Dir
	cmd.Env = command.Env
	cmd.Stdin = bytes.NewReader(command.Stdin)
	out, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("execute constrained review operation: %w", err)
	}
	return out, nil
}

// Gateway implements the reviewer's complete structured capability surface.
// Binary paths must be absolute and are selected by AO, never by the TUI.
type Gateway struct {
	manifest Manifest
	env      Environment
	exec     Executor
	gitPath  string
	ghPath   string
	aoPath   string
}

// Open verifies a prepared environment and returns its constrained gateway.
func Open(env Environment, executor Executor, gitPath, ghPath, aoPath string) (*Gateway, error) {
	for name, path := range map[string]string{"git": gitPath, "gh": ghPath, "ao": aoPath} {
		if !filepath.IsAbs(path) {
			return nil, fmt.Errorf("review gateway: %s executable path must be absolute", name)
		}
	}
	if executor == nil {
		return nil, errors.New("review gateway: executor is required")
	}
	info, err := os.Lstat(env.ManifestPath)
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0o077 != 0 {
		return nil, errors.New("review gateway: manifest is not a private regular file")
	}
	raw, err := os.ReadFile(env.ManifestPath)
	if err != nil {
		return nil, fmt.Errorf("review gateway: read manifest: %w", err)
	}
	var manifest Manifest
	if err := json.Unmarshal(raw, &manifest); err != nil {
		return nil, fmt.Errorf("review gateway: decode manifest: %w", err)
	}
	if err := validateManifest(&manifest); err != nil {
		return nil, err
	}
	sum := sha256.Sum256(raw)
	if filepath.Base(env.ManifestPath) != hex.EncodeToString(sum[:])+".json" {
		return nil, errors.New("review gateway: manifest content does not match its immutable identity")
	}
	wantRoot := filepath.Join(env.DataDir, "reviewer-runtime", manifest.ReviewerID)
	if !filepath.IsAbs(env.DataDir) || env.Root != wantRoot || env.WorkingDirectory != filepath.Join(wantRoot, "workspace") || env.ConfigRoot != filepath.Join(wantRoot, "config") || env.StateRoot != filepath.Join(wantRoot, "state") || env.CacheRoot != filepath.Join(wantRoot, "cache") || env.TempRoot != filepath.Join(wantRoot, "tmp") || !pathWithin(filepath.Join(wantRoot, "manifests"), env.ManifestPath) {
		return nil, errors.New("review gateway: invalid reviewer environment layout")
	}
	return &Gateway{manifest: manifest, env: env, exec: executor, gitPath: gitPath, ghPath: ghPath, aoPath: aoPath}, nil
}

// ListFiles returns the paths tracked at the task's pinned target commit.
func (g *Gateway) ListFiles(ctx context.Context, runID string) ([]string, error) {
	task, err := g.task(runID)
	if err != nil {
		return nil, err
	}
	out, err := g.git(ctx, "ls-tree", "-r", "-z", "--name-only", task.TargetSHA)
	if err != nil {
		return nil, err
	}
	parts := bytes.Split(out, []byte{0})
	files := make([]string, 0, len(parts))
	for _, part := range parts {
		if len(part) != 0 {
			files = append(files, string(part))
		}
	}
	return files, nil
}

// ReadFile reads a blob by first resolving its object id with fixed git
// arguments. This avoids rev:path parsing, traversal, filters and worktree IO.
func (g *Gateway) ReadFile(ctx context.Context, runID, path string) ([]byte, error) {
	if err := validateRepoPath(path); err != nil {
		return nil, err
	}
	task, err := g.task(runID)
	if err != nil {
		return nil, err
	}
	out, err := g.git(ctx, "ls-tree", "-z", task.TargetSHA, "--", path)
	if err != nil {
		return nil, err
	}
	record := strings.TrimSuffix(string(out), "\x00")
	fields := strings.Fields(record)
	if len(fields) < 3 || fields[1] != "blob" || !commitSHA.MatchString(fields[2]) {
		return nil, fmt.Errorf("review gateway: path is not a blob at target commit")
	}
	content, err := g.git(ctx, "cat-file", "blob", fields[2])
	if len(content) > 4<<20 {
		return nil, errors.New("review gateway: blob exceeds the read limit")
	}
	return content, err
}

// Match is one literal source-search result.
type Match struct {
	Path string
	Line int
	Text string
}

// Search performs a bounded literal search over blobs at the pinned commit.
// It does not invoke grep, project scripts, filters, or a shell.
func (g *Gateway) Search(ctx context.Context, runID, query string, maxResults int) ([]Match, error) {
	if query == "" || len(query) > 1024 || strings.ContainsRune(query, 0) || maxResults < 1 || maxResults > 200 {
		return nil, errors.New("review gateway: invalid search request")
	}
	files, err := g.ListFiles(ctx, runID)
	if err != nil {
		return nil, err
	}
	matches := make([]Match, 0, maxResults)
	for _, path := range files {
		content, readErr := g.ReadFile(ctx, runID, path)
		if readErr != nil || bytes.IndexByte(content, 0) >= 0 {
			continue
		}
		for index, line := range strings.Split(string(content), "\n") {
			if strings.Contains(line, query) {
				matches = append(matches, Match{Path: path, Line: index + 1, Text: line})
				if len(matches) == maxResults {
					return matches, nil
				}
			}
		}
	}
	return matches, nil
}

// ReadTaskPrompt reads only the AO-authored prompt bound to the requested run.
func (g *Gateway) ReadTaskPrompt(runID string) ([]byte, error) {
	task, err := g.task(runID)
	if err != nil {
		return nil, err
	}
	root, err := filepath.EvalSymlinks(g.manifest.TaskPromptRoot)
	if err != nil {
		return nil, fmt.Errorf("review gateway: resolve prompt root: %w", err)
	}
	path, err := filepath.EvalSymlinks(task.TaskPromptFile)
	if err != nil || !pathWithin(root, path) {
		return nil, errors.New("review gateway: prompt path escapes the AO prompt root")
	}
	content, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("review gateway: read task prompt: %w", err)
	}
	if len(content) > 1<<20 {
		return nil, errors.New("review gateway: task prompt exceeds the read limit")
	}
	return content, nil
}

// Diff returns only the manifest-pinned base-to-target comparison.
func (g *Gateway) Diff(ctx context.Context, runID string) ([]byte, error) {
	task, err := g.task(runID)
	if err != nil {
		return nil, err
	}
	if task.BaseSHA == "" {
		return nil, fmt.Errorf("%w: diff requires a pinned base commit", ErrUnauthorized)
	}
	return g.git(ctx, "diff", "--no-ext-diff", "--no-textconv", "--no-renames", task.BaseSHA, task.TargetSHA, "--")
}

// ShowCommit shows metadata and patch for only the pinned target commit.
func (g *Gateway) ShowCommit(ctx context.Context, runID string) ([]byte, error) {
	task, err := g.task(runID)
	if err != nil {
		return nil, err
	}
	return g.git(ctx, "show", "--no-ext-diff", "--no-textconv", "--format=fuller", task.TargetSHA, "--")
}

// PostReview posts a structured GitHub review to the exactly authorized PR.
func (g *Gateway) PostReview(ctx context.Context, runID, prURL, event, body string) (string, error) {
	task, err := g.task(runID)
	if err != nil || prURL != task.PRURL {
		return "", ErrUnauthorized
	}
	if event != "APPROVE" && event != "REQUEST_CHANGES" && event != "COMMENT" {
		return "", errors.New("review gateway: invalid GitHub review event")
	}
	if len(body) > 1<<20 {
		return "", errors.New("review gateway: review body is too large")
	}
	repo, number, err := parsePRURL(prURL)
	if err != nil {
		return "", err
	}
	payload, _ := json.Marshal(map[string]string{"event": event, "body": body, "commit_id": task.TargetSHA})
	out, err := g.exec.Execute(ctx, Command{
		Path: g.ghPath, Args: []string{"api", "--method", "POST", "repos/" + repo + "/pulls/" + number + "/reviews", "--input", "-", "--jq", ".id"},
		Dir: g.env.WorkingDirectory, Env: g.baseEnv(), Stdin: payload,
	})
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(out)), nil
}

// Result is one AO review result. Every run id is checked against the manifest.
type Result struct {
	RunID          string               `json:"runId"`
	Verdict        domain.ReviewVerdict `json:"verdict"`
	Body           string               `json:"body,omitempty"`
	GithubReviewID string               `json:"githubReviewId,omitempty"`
}

// Submit records structured results through AO's existing loopback client.
func (g *Gateway) Submit(ctx context.Context, results []Result) error {
	if len(results) == 0 || len(results) > len(g.manifest.Tasks) {
		return ErrUnauthorized
	}
	seen := make(map[string]bool, len(results))
	for _, result := range results {
		if _, err := g.task(result.RunID); err != nil || seen[result.RunID] || !result.Verdict.Valid() {
			return ErrUnauthorized
		}
		if result.Verdict == domain.VerdictChangesRequested && strings.TrimSpace(result.Body) == "" {
			return errors.New("review gateway: changes_requested requires a body")
		}
		seen[result.RunID] = true
	}
	payload, err := json.Marshal(map[string]any{"reviews": results})
	if err != nil {
		return fmt.Errorf("review gateway: encode results: %w", err)
	}
	_, err = g.exec.Execute(ctx, Command{
		Path: g.aoPath,
		Args: []string{"review", "submit", string(g.manifest.WorkerSessionID), "--reviews", "-"},
		Dir:  g.env.WorkingDirectory, Env: g.baseEnv(), Stdin: payload,
	})
	return err
}

func (g *Gateway) task(runID string) (Task, error) {
	for _, task := range g.manifest.Tasks {
		if task.RunID == runID {
			return task, nil
		}
	}
	return Task{}, ErrUnauthorized
}

func (g *Gateway) git(ctx context.Context, args ...string) ([]byte, error) {
	fixed := make([]string, 0, 7+len(args))
	fixed = append(fixed, "-c", "core.hooksPath="+filepath.Join(g.env.Root, "disabled-git-hooks"), "-c", "core.fsmonitor=false", "-c", "diff.external=", "--no-pager")
	fixed = append(fixed, args...)
	return g.exec.Execute(ctx, Command{Path: g.gitPath, Args: fixed, Dir: g.manifest.WorkspacePath, Env: g.baseEnv()})
}

func (g *Gateway) baseEnv() []string {
	return []string{
		"AO_DATA_DIR=" + g.env.DataDir,
		"HOME=" + g.env.ConfigRoot,
		"XDG_CONFIG_HOME=" + g.env.ConfigRoot,
		"XDG_STATE_HOME=" + g.env.StateRoot,
		"XDG_CACHE_HOME=" + g.env.CacheRoot,
		"TMPDIR=" + g.env.TempRoot,
		"TEMP=" + g.env.TempRoot,
		"TMP=" + g.env.TempRoot,
		"GIT_CONFIG_NOSYSTEM=1", "GIT_OPTIONAL_LOCKS=0", "GIT_PAGER=cat", "PAGER=cat", "TERM=dumb",
	}
}

func validateManifest(manifest *Manifest) error {
	if manifest.Version != 0 && manifest.Version != manifestVersion {
		return errors.New("review gateway: unsupported manifest version")
	}
	manifest.Version = manifestVersion
	if !safeID.MatchString(manifest.ReviewerID) || strings.TrimSpace(string(manifest.WorkerSessionID)) == "" {
		return errors.New("review gateway: invalid reviewer or worker id")
	}
	if !filepath.IsAbs(manifest.WorkspacePath) || !filepath.IsAbs(manifest.TaskPromptRoot) || len(manifest.Tasks) == 0 {
		return errors.New("review gateway: absolute workspace, prompt root, and tasks are required")
	}
	seen := make(map[string]bool, len(manifest.Tasks))
	for _, task := range manifest.Tasks {
		if !safeID.MatchString(task.RunID) || seen[task.RunID] || !commitSHA.MatchString(task.TargetSHA) || (task.BaseSHA != "" && !commitSHA.MatchString(task.BaseSHA)) {
			return errors.New("review gateway: invalid or duplicate task identity")
		}
		if _, _, err := parsePRURL(task.PRURL); err != nil {
			return err
		}
		prompt, err := filepath.Abs(task.TaskPromptFile)
		if err != nil || !pathWithin(manifest.TaskPromptRoot, prompt) {
			return errors.New("review gateway: task prompt is outside the AO prompt root")
		}
		seen[task.RunID] = true
	}
	return nil
}

func validateRepoPath(path string) error {
	clean := filepath.ToSlash(filepath.Clean(path))
	if path == "" || filepath.IsAbs(path) || clean != filepath.ToSlash(path) || clean == "." || clean == ".." || strings.HasPrefix(clean, "../") || strings.HasPrefix(clean, "-") || strings.ContainsAny(path, "\x00\r\n") {
		return errors.New("review gateway: invalid repository path")
	}
	return nil
}

func pathWithin(root, path string) bool {
	rel, err := filepath.Rel(root, path)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

func parsePRURL(raw string) (string, string, error) {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.Host != "github.com" || u.RawQuery != "" || u.Fragment != "" {
		return "", "", errors.New("review gateway: PR URL must be an https github.com pull URL")
	}
	parts := strings.Split(strings.Trim(u.Path, "/"), "/")
	if len(parts) != 4 || parts[2] != "pull" || !validGitHubSegment(parts[0]) || !validGitHubSegment(parts[1]) {
		return "", "", errors.New("review gateway: invalid GitHub pull URL")
	}
	n, err := strconv.Atoi(parts[3])
	if err != nil || n < 1 {
		return "", "", errors.New("review gateway: invalid pull request number")
	}
	return parts[0] + "/" + parts[1], strconv.Itoa(n), nil
}

func validGitHubSegment(segment string) bool {
	if segment == "." || segment == ".." || segment == "" {
		return false
	}
	for _, r := range segment {
		if (r < 'a' || r > 'z') && (r < 'A' || r > 'Z') && (r < '0' || r > '9') && r != '-' && r != '_' && r != '.' {
			return false
		}
	}
	return true
}

func ensurePrivateDir(path string) error {
	if err := os.MkdirAll(path, 0o700); err != nil {
		return fmt.Errorf("review gateway: create private directory: %w", err)
	}
	info, err := os.Lstat(path)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("review gateway: private path is not a real directory")
	}
	if err := os.Chmod(path, 0o700); err != nil { //nolint:gosec // directories require execute permission and remain owner-only
		return fmt.Errorf("review gateway: secure private directory: %w", err)
	}
	return nil
}
