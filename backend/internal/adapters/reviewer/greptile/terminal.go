package greptile

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	aoprocess "github.com/aoagents/agent-orchestrator/backend/internal/process"
)

const terminalRequestVersion = 1
const terminalStdoutLimit = 4 * 1024 * 1024
const terminalStderrLimit = 16 * 1024
const terminalRequestWaitLimit = 30 * time.Minute

// terminalRequest is intentionally private: it is an AO-owned handoff file,
// not a public CLI contract. Keeping the schema here means the daemon and the
// hidden terminal command use exactly the same task list.
type terminalRequest struct {
	Version    int            `json:"version"`
	WorkerID   string         `json:"workerId,omitempty"`
	BatchID    string         `json:"batchId,omitempty"`
	Harness    string         `json:"harness,omitempty"`
	ResultPath string         `json:"resultPath"`
	CreatedAt  time.Time      `json:"createdAt"`
	DeadlineAt time.Time      `json:"deadlineAt"`
	Tasks      []terminalTask `json:"tasks"`
}

type terminalTask struct {
	RunID         string `json:"runId"`
	PRURL         string `json:"prUrl"`
	TargetSHA     string `json:"targetSha"`
	TargetBranch  string `json:"targetBranch,omitempty"`
	WorkspacePath string `json:"workspacePath"`
}

type terminalResult struct {
	Complete bool                 `json:"complete"`
	Results  []terminalResultItem `json:"results"`
}

type terminalResultItem struct {
	RunID     string            `json:"runId"`
	PRURL     string            `json:"prUrl"`
	TargetSHA string            `json:"targetSha"`
	Verdict   string            `json:"verdict,omitempty"`
	Body      string            `json:"body,omitempty"`
	Comments  []terminalComment `json:"comments,omitempty"`
	Error     string            `json:"error,omitempty"`
}

type terminalComment struct {
	Path          string `json:"path"`
	StartLine     int    `json:"startLine,omitempty"`
	EndLine       int    `json:"endLine,omitempty"`
	Side          string `json:"side,omitempty"`
	Body          string `json:"body,omitempty"`
	Suggestion    string `json:"suggestion,omitempty"`
	Severity      string `json:"severity,omitempty"`
	SecurityIssue bool   `json:"securityIssue,omitempty"`
}

// PrepareTerminalRequest writes the immutable task handoff and returns the
// hidden AO command that displays the review in the current runtime terminal.
func (Adapter) PrepareTerminalRequest(path string, tasks []ports.ReviewTask) (ports.ReviewCommandSpec, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return ports.ReviewCommandSpec{}, fmt.Errorf("greptile terminal request path is required")
	}
	if len(tasks) == 0 {
		return ports.ReviewCommandSpec{}, fmt.Errorf("greptile terminal request has no review tasks")
	}
	aoExecutable, err := resolveAOExecutable()
	if err != nil {
		return ports.ReviewCommandSpec{}, err
	}
	createdAt := time.Now().UTC()
	workerID, batchID := terminalPathMetadata(path)
	request := terminalRequest{
		Version:    terminalRequestVersion,
		WorkerID:   workerID,
		BatchID:    batchID,
		Harness:    string(domain.ReviewerGreptile),
		ResultPath: TerminalResultPath(path),
		CreatedAt:  createdAt,
		DeadlineAt: createdAt.Add(terminalRequestWaitLimit),
		Tasks:      make([]terminalTask, 0, len(tasks)),
	}
	for _, task := range tasks {
		if strings.TrimSpace(task.RunID) == "" || strings.TrimSpace(task.WorkspacePath) == "" {
			return ports.ReviewCommandSpec{}, fmt.Errorf("greptile terminal review task requires run id and workspace path")
		}
		request.Tasks = append(request.Tasks, terminalTask{
			RunID:         task.RunID,
			PRURL:         task.PRURL,
			TargetSHA:     task.TargetSHA,
			TargetBranch:  task.TargetBranch,
			WorkspacePath: task.WorkspacePath,
		})
	}
	if err := verifyTerminalRequestReplacement(path, request); err != nil {
		return ports.ReviewCommandSpec{}, err
	}
	if err := writeJSONFile(path, request); err != nil {
		return ports.ReviewCommandSpec{}, fmt.Errorf("write greptile terminal request: %w", err)
	}
	// Always reset the paired sidecar before launching. Durable request paths
	// are unique, but replacing an existing sidecar defensively prevents an old
	// complete result from being consumed if a caller retries the same request.
	if err := writeTerminalResult(request.ResultPath, terminalResult{Results: []terminalResultItem{}}); err != nil {
		return ports.ReviewCommandSpec{}, fmt.Errorf("initialize greptile terminal result: %w", err)
	}
	return ports.ReviewCommandSpec{Argv: []string{aoExecutable, "review-terminal", path}}, nil
}

// ReadTerminalRequest implements ports.TerminalReviewRequestReader for daemon
// restart recovery. The private schema is validated here and normalized before
// the generic launcher sees it.
func (Adapter) ReadTerminalRequest(path string) (ports.TerminalReviewRequest, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return ports.TerminalReviewRequest{}, fmt.Errorf("read greptile terminal request: %w", err)
	}
	var request terminalRequest
	if err := json.Unmarshal(raw, &request); err != nil {
		return ports.TerminalReviewRequest{}, fmt.Errorf("decode greptile terminal request: %w", err)
	}
	if request.Version != 0 && request.Version != terminalRequestVersion {
		return ports.TerminalReviewRequest{}, fmt.Errorf("unsupported greptile terminal request version %d", request.Version)
	}
	if request.Version == 0 {
		// Requests written by the first Greptile terminal implementation had no
		// explicit version. Accept them during an upgrade so a daemon restart
		// does not strand an already-running review; all new requests are v1.
		request.Version = terminalRequestVersion
	}
	if strings.TrimSpace(request.ResultPath) == "" || len(request.Tasks) == 0 {
		return ports.TerminalReviewRequest{}, fmt.Errorf("greptile terminal request is incomplete")
	}
	expectedResultPath := TerminalResultPath(path)
	gotResultPath, err := filepath.Abs(request.ResultPath)
	if err != nil {
		return ports.TerminalReviewRequest{}, fmt.Errorf("resolve greptile terminal result path: %w", err)
	}
	wantResultPath, err := filepath.Abs(expectedResultPath)
	if err != nil || filepath.Clean(gotResultPath) != filepath.Clean(wantResultPath) {
		return ports.TerminalReviewRequest{}, fmt.Errorf("greptile terminal result path does not match request")
	}
	result := ports.TerminalReviewRequest{Version: request.Version, WorkerID: domain.SessionID(request.WorkerID), BatchID: request.BatchID, Harness: domain.ReviewerHarness(request.Harness), ResultPath: wantResultPath, CreatedAt: request.CreatedAt, DeadlineAt: request.DeadlineAt, Tasks: make([]ports.ReviewTask, 0, len(request.Tasks))}
	for _, task := range request.Tasks {
		if strings.TrimSpace(task.RunID) == "" || strings.TrimSpace(task.WorkspacePath) == "" {
			return ports.TerminalReviewRequest{}, fmt.Errorf("greptile terminal request task is incomplete")
		}
		result.Tasks = append(result.Tasks, ports.ReviewTask{RunID: task.RunID, PRURL: task.PRURL, TargetSHA: task.TargetSHA, TargetBranch: task.TargetBranch, WorkspacePath: task.WorkspacePath})
	}
	return result, nil
}

func terminalPathMetadata(path string) (workerID, batchID string) {
	batchDir := filepath.Dir(path)
	terminalDir := filepath.Dir(batchDir)
	if filepath.Base(terminalDir) != "terminal" {
		return "", ""
	}
	workerDir := filepath.Dir(terminalDir)
	return filepath.Base(workerDir), filepath.Base(batchDir)
}

// verifyTerminalRequestReplacement prevents a retry from reusing a durable
// request path for a different batch or task list. Request paths are derived
// from durable IDs and should never collide, but refusing an unexpected
// existing request/result pair is safer than allowing a stale sidecar to be
// reset and later attributed to another run.
func verifyTerminalRequestReplacement(path string, request terminalRequest) error {
	requestInfo, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		resultPath := TerminalResultPath(path)
		if resultInfo, resultErr := os.Lstat(resultPath); resultErr == nil {
			if resultInfo.Mode()&os.ModeSymlink != 0 {
				return fmt.Errorf("refusing to replace symlinked greptile terminal result")
			}
			return fmt.Errorf("greptile terminal result exists without its request")
		} else if !errors.Is(resultErr, os.ErrNotExist) {
			return fmt.Errorf("inspect existing greptile terminal result: %w", resultErr)
		}
		return nil
	}
	if err != nil {
		return fmt.Errorf("inspect existing greptile terminal request: %w", err)
	}
	if requestInfo.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("refusing to replace symlinked greptile terminal request")
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("read existing greptile terminal request: %w", err)
	}
	var existing terminalRequest
	if err := json.Unmarshal(raw, &existing); err != nil {
		return fmt.Errorf("decode existing greptile terminal request: %w", err)
	}
	if existing.Version != 0 && existing.Version != terminalRequestVersion {
		return fmt.Errorf("existing greptile terminal request has unsupported version %d", existing.Version)
	}
	if existing.WorkerID != "" && request.WorkerID != "" && existing.WorkerID != request.WorkerID {
		return fmt.Errorf("existing greptile terminal request belongs to worker %q, want %q", existing.WorkerID, request.WorkerID)
	}
	if existing.BatchID != "" && request.BatchID != "" && existing.BatchID != request.BatchID {
		return fmt.Errorf("existing greptile terminal request belongs to batch %q, want %q", existing.BatchID, request.BatchID)
	}
	if existing.Harness != "" && existing.Harness != string(domain.ReviewerGreptile) {
		return fmt.Errorf("existing greptile terminal request has harness %q", existing.Harness)
	}
	if len(existing.Tasks) != len(request.Tasks) {
		return fmt.Errorf("existing greptile terminal request task list does not match")
	}
	for index := range request.Tasks {
		oldTask, newTask := existing.Tasks[index], request.Tasks[index]
		if oldTask.RunID != newTask.RunID || oldTask.PRURL != newTask.PRURL || oldTask.TargetSHA != newTask.TargetSHA || oldTask.TargetBranch != newTask.TargetBranch || oldTask.WorkspacePath != newTask.WorkspacePath {
			return fmt.Errorf("existing greptile terminal request task list does not match")
		}
	}
	resultPath := TerminalResultPath(path)
	resultInfo, err := os.Lstat(resultPath)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("inspect existing greptile terminal result: %w", err)
	}
	if resultInfo.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("refusing to replace symlinked greptile terminal result")
	}
	raw, err = os.ReadFile(resultPath)
	if err != nil {
		return fmt.Errorf("read existing greptile terminal result: %w", err)
	}
	var existingResult terminalResult
	if err := json.Unmarshal(raw, &existingResult); err != nil {
		return fmt.Errorf("decode existing greptile terminal result: %w", err)
	}
	allowedRuns := make(map[string]struct{}, len(request.Tasks))
	for _, task := range request.Tasks {
		allowedRuns[task.RunID] = struct{}{}
	}
	for _, item := range existingResult.Results {
		if _, ok := allowedRuns[item.RunID]; !ok {
			return fmt.Errorf("existing greptile terminal result contains an unrelated run %q", item.RunID)
		}
	}
	return nil
}

// resolveAOExecutable returns the exact AO binary that is currently running.
// Reviewer terminals may start in a worker worktree where the bare `ao`
// command is not on PATH (notably when the dev daemon was started with
// `go run`), so the terminal must not depend on PATH or its working directory
// to find AO's hidden command.
func resolveAOExecutable() (string, error) {
	executable, err := os.Executable()
	if err != nil {
		return "", fmt.Errorf("resolve AO executable: %w", err)
	}
	if strings.TrimSpace(executable) == "" {
		return "", fmt.Errorf("resolve AO executable: empty executable path")
	}
	if !filepath.IsAbs(executable) {
		executable, err = filepath.Abs(executable)
		if err != nil {
			return "", fmt.Errorf("resolve AO executable path: %w", err)
		}
	}
	return executable, nil
}

// TerminalResultPath returns the result sidecar paired with a request file.
func TerminalResultPath(requestPath string) string { return requestPath + ".result.json" }

// TerminalResultPath implements ports.TerminalOneShotReviewer.
func (Adapter) TerminalResultPath(requestPath string) string { return TerminalResultPath(requestPath) }

// ParseTerminalResult decodes the sidecar emitted by RunTerminal.
func (Adapter) ParseTerminalResult(output []byte) (ports.TerminalReviewResult, error) {
	var raw terminalResult
	if err := json.Unmarshal(output, &raw); err != nil {
		return ports.TerminalReviewResult{}, fmt.Errorf("decode greptile terminal result: %w", err)
	}
	result := ports.TerminalReviewResult{Complete: raw.Complete, Results: make([]ports.TerminalReviewItem, 0, len(raw.Results))}
	for _, item := range raw.Results {
		converted := ports.TerminalReviewItem{
			RunID:     item.RunID,
			PRURL:     item.PRURL,
			TargetSHA: item.TargetSHA,
			Verdict:   portsReviewVerdict(item.Verdict),
			Body:      item.Body,
			Error:     item.Error,
			Comments:  make([]ports.ReviewComment, 0, len(item.Comments)),
		}
		for _, comment := range item.Comments {
			converted.Comments = append(converted.Comments, ports.ReviewComment{
				Path:          comment.Path,
				StartLine:     comment.StartLine,
				EndLine:       comment.EndLine,
				Side:          comment.Side,
				Body:          comment.Body,
				Suggestion:    comment.Suggestion,
				Severity:      comment.Severity,
				SecurityIssue: comment.SecurityIssue,
			})
		}
		result.Results = append(result.Results, converted)
	}
	return result, nil
}

// RunTerminal executes the queued Greptile commands and prints a readable,
// non-interactive transcript. It writes the sidecar after every task so the
// daemon can recover completed items even while the terminal is still running.
func RunTerminal(ctx context.Context, requestPath string, out io.Writer) error {
	raw, err := os.ReadFile(requestPath)
	if err != nil {
		return fmt.Errorf("read greptile terminal request: %w", err)
	}
	var request terminalRequest
	if err := json.Unmarshal(raw, &request); err != nil {
		return fmt.Errorf("decode greptile terminal request: %w", err)
	}
	if request.Version != 0 && request.Version != terminalRequestVersion {
		return fmt.Errorf("unsupported greptile terminal request version %d", request.Version)
	}
	if request.ResultPath == "" {
		return fmt.Errorf("greptile terminal request has no result path")
	}
	if len(request.Tasks) == 0 {
		return fmt.Errorf("greptile terminal request has no review tasks")
	}
	expectedResultPath, err := filepath.Abs(TerminalResultPath(requestPath))
	if err != nil {
		return fmt.Errorf("resolve greptile terminal result path: %w", err)
	}
	actualResultPath, err := filepath.Abs(request.ResultPath)
	if err != nil || filepath.Clean(actualResultPath) != filepath.Clean(expectedResultPath) {
		return fmt.Errorf("greptile terminal result path does not match request")
	}
	for _, task := range request.Tasks {
		if strings.TrimSpace(task.RunID) == "" || strings.TrimSpace(task.WorkspacePath) == "" {
			return fmt.Errorf("greptile terminal review task requires run id and workspace path")
		}
	}

	_, _ = fmt.Fprintln(out, "Greptile review (display-only)")
	results := make([]terminalResultItem, 0, len(request.Tasks))
	succeeded := 0
	failed := 0
	adapter := New()
	for index, task := range request.Tasks {
		if err := ctx.Err(); err != nil {
			_, _ = fmt.Fprintln(out, "\nGreptile review cancelled.")
			return err
		}
		_, _ = fmt.Fprintf(out, "\n[%d/%d] Reviewing %s\n", index+1, len(request.Tasks), task.PRURL)
		inv := ports.ReviewInvocation{
			ReviewerID:    "greptile-terminal",
			RunID:         task.RunID,
			PRURL:         task.PRURL,
			TargetSHA:     task.TargetSHA,
			WorkspacePath: task.WorkspacePath,
			ReviewQueue:   []ports.ReviewTask{{RunID: task.RunID, PRURL: task.PRURL, TargetSHA: task.TargetSHA, TargetBranch: task.TargetBranch, WorkspacePath: task.WorkspacePath}},
			ReviewIndex:   0,
		}
		command, commandErr := adapter.ReviewCommand(ctx, inv)
		item := terminalResultItem{RunID: task.RunID, PRURL: task.PRURL, TargetSHA: task.TargetSHA}
		var stdout []byte
		if commandErr == nil {
			if binary, resolveErr := adapter.ResolveBinary(ctx); resolveErr == nil && len(command.Argv) > 0 {
				command.Argv[0] = binary
			}
			var stderr []byte
			stdout, stderr, commandErr = runCommand(ctx, task.WorkspacePath, command)
			if commandErr != nil {
				if ctx.Err() != nil {
					_, _ = fmt.Fprintln(out, "\nGreptile review cancelled.")
					return ctx.Err()
				}
				// Greptile normally writes failures to stderr, but a few CLI
				// versions print auth diagnostics on stdout. Classify the combined
				// bounded streams while retaining the same redaction/limit.
				commandErr = commandFailure(commandErr, string(stderr)+"\n"+string(stdout))
			}
		}
		if commandErr != nil {
			item.Error = redactGreptileText(commandErr.Error())
			failed++
			_, _ = fmt.Fprintf(out, "  Greptile could not complete this review: %s\n", item.Error)
		} else {
			parsed, parseErr := adapter.ParseReviewResult(stdout)
			if parseErr != nil {
				item.Error = redactGreptileText(parseErr.Error())
				failed++
				_, _ = fmt.Fprintf(out, "  Greptile returned an unreadable result: %s\n", item.Error)
			} else {
				item.Verdict = string(parsed.Verdict)
				item.Body = redactGreptileText(parsed.Body)
				item.Comments = reviewComments(parsed.Comments)
				succeeded++
				_, _ = fmt.Fprintln(out, item.Body)
			}
		}
		results = append(results, item)
		if err := writeTerminalResult(request.ResultPath, terminalResult{Results: results}); err != nil {
			return err
		}
	}
	if err := writeTerminalResult(request.ResultPath, terminalResult{Complete: true, Results: results}); err != nil {
		return err
	}
	_, _ = fmt.Fprintln(out, "\n"+terminalSummary(succeeded, failed, len(request.Tasks)))
	return nil
}

func reviewComments(comments []ports.ReviewComment) []terminalComment {
	out := make([]terminalComment, 0, len(comments))
	for _, comment := range comments {
		out = append(out, terminalComment{
			Path: redactGreptileText(comment.Path), StartLine: comment.StartLine, EndLine: comment.EndLine,
			Side: comment.Side, Body: redactGreptileText(comment.Body), Suggestion: redactGreptileText(comment.Suggestion),
			Severity: redactGreptileText(comment.Severity), SecurityIssue: comment.SecurityIssue,
		})
	}
	return out
}

func portsReviewVerdict(value string) domain.ReviewVerdict {
	return domain.ReviewVerdict(strings.TrimSpace(value))
}

func runCommand(ctx context.Context, workspacePath string, command ports.ReviewCommandSpec) ([]byte, []byte, error) {
	if len(command.Argv) == 0 {
		return nil, nil, fmt.Errorf("greptile produced empty command")
	}
	stdout := &boundedBuffer{limit: terminalStdoutLimit}
	stderr := &boundedBuffer{limit: terminalStderrLimit}
	cmd := aoprocess.CommandContext(ctx, command.Argv[0], command.Argv[1:]...)
	cmd.Dir = workspacePath
	cmd.Env = append(os.Environ(), envAssignments(command.Env)...)
	cmd.Stdout = stdout
	cmd.Stderr = stderr
	err := cmd.Run()
	return stdout.Bytes(), stderr.Bytes(), err
}

func envAssignments(extra map[string]string) []string {
	values := make([]string, 0, len(extra))
	for key, value := range extra {
		values = append(values, key+"="+value)
	}
	return values
}

func commandFailure(err error, stderr string) error {
	if errors.Is(err, exec.ErrNotFound) {
		return fmt.Errorf("Greptile CLI is not installed. Install it, then run greptile login and retry: %w", ports.ErrAgentBinaryNotFound)
	}
	if status, ok := greptileAuthStatusFromOutput([]byte(stderr)); ok && status == ports.AgentAuthStatusUnauthorized {
		return errors.New("Greptile CLI is not authenticated. Run greptile login and retry.")
	}
	detail := redactGreptileText(strings.TrimSpace(stderr))
	if detail == "" {
		return fmt.Errorf("greptile failed: %w", err)
	}
	if len(detail) > terminalStderrLimit {
		detail = detail[len(detail)-terminalStderrLimit:]
	}
	return fmt.Errorf("greptile failed: %w: %s", err, detail)
}

func terminalSummary(succeeded, failed, total int) string {
	switch {
	case failed == 0 && succeeded == total:
		return "Greptile review finished. AO will process the result and attempt to post any findings to GitHub."
	case succeeded == 0 && failed == total:
		return "Greptile review failed. No review result was posted."
	default:
		return fmt.Sprintf("Greptile review finished with %d of %d reviews failed. See the errors above.", failed, total)
	}
}

type boundedBuffer struct {
	bytes.Buffer
	limit     int
	truncated bool
}

func (b *boundedBuffer) Write(p []byte) (int, error) {
	if b.limit <= 0 {
		return len(p), nil
	}
	remaining := b.limit - b.Len()
	if remaining > 0 {
		if remaining < len(p) {
			_, _ = b.Buffer.Write(p[:remaining])
			b.truncated = true
		} else {
			_, _ = b.Buffer.Write(p)
		}
	} else if len(p) > 0 {
		b.truncated = true
	}
	return len(p), nil
}

func (b *boundedBuffer) Bytes() []byte {
	out := append([]byte(nil), b.Buffer.Bytes()...)
	if b.truncated {
		out = append(out, []byte("\n...[output truncated]")...)
	}
	return out
}

var (
	greptileBearerPattern = regexp.MustCompile(`(?i)(bearer\s+)[A-Za-z0-9._~+/=-]+`)
	greptileKeyPattern    = regexp.MustCompile(`(?i)((?:greptile[_ -]?api[_ -]?key|api[_ -]?key)\s*[:=]\s*)[^\s]+`)
)

func redactGreptileText(value string) string {
	value = greptileBearerPattern.ReplaceAllString(value, `${1}[REDACTED]`)
	return greptileKeyPattern.ReplaceAllString(value, `${1}[REDACTED]`)
}

func writeTerminalResult(path string, result terminalResult) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return fmt.Errorf("create greptile result directory: %w", err)
	}
	raw, err := json.Marshal(result)
	if err != nil {
		return fmt.Errorf("encode greptile terminal result: %w", err)
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".greptile-result-*.tmp")
	if err != nil {
		return fmt.Errorf("create greptile result temp file: %w", err)
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if err := tmp.Chmod(0o600); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("protect greptile result temp file: %w", err)
	}
	if _, err := tmp.Write(raw); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("write greptile terminal result: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("close greptile terminal result: %w", err)
	}
	if err := os.Rename(tmpName, path); err != nil {
		// Windows does not replace an existing destination with Rename. The
		// result is already fully written and the daemon retries reads, so a
		// remove-then-rename fallback keeps incremental updates portable.
		if removeErr := os.Remove(path); removeErr != nil {
			return fmt.Errorf("publish greptile terminal result: %w", err)
		}
		if retryErr := os.Rename(tmpName, path); retryErr != nil {
			return fmt.Errorf("publish greptile terminal result: %w", retryErr)
		}
	}
	return nil
}

func writeJSONFile(path string, value any) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	raw, err := json.Marshal(value)
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".greptile-request-*.tmp")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if err := tmp.Chmod(0o600); err != nil {
		_ = tmp.Close()
		return err
	}
	if _, err := tmp.Write(raw); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmpName, path); err != nil {
		// Windows cannot replace an existing destination atomically through
		// Rename. The path is durable and private, so remove the old request only
		// after the complete temporary file has been closed.
		if removeErr := os.Remove(path); removeErr != nil {
			return err
		}
		if retryErr := os.Rename(tmpName, path); retryErr != nil {
			return retryErr
		}
	}
	return nil
}
