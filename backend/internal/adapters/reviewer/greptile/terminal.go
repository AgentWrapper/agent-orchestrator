package greptile

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	aoprocess "github.com/aoagents/agent-orchestrator/backend/internal/process"
)

// terminalRequest is intentionally private: it is an AO-owned handoff file,
// not a public CLI contract. Keeping the schema here means the daemon and the
// hidden terminal command use exactly the same task list.
type terminalRequest struct {
	ResultPath string         `json:"resultPath"`
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
	request := terminalRequest{
		ResultPath: TerminalResultPath(path),
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
	if err := writeJSONFile(path, request); err != nil {
		return ports.ReviewCommandSpec{}, fmt.Errorf("write greptile terminal request: %w", err)
	}
	return ports.ReviewCommandSpec{Argv: []string{"ao", "review-terminal", path}}, nil
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
	if request.ResultPath == "" {
		return fmt.Errorf("greptile terminal request has no result path")
	}
	if len(request.Tasks) == 0 {
		return fmt.Errorf("greptile terminal request has no review tasks")
	}

	_, _ = fmt.Fprintln(out, "Greptile review (display-only)")
	results := make([]terminalResultItem, 0, len(request.Tasks))
	adapter := New()
	for index, task := range request.Tasks {
		if err := ctx.Err(); err != nil {
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
			var stderr []byte
			stdout, stderr, commandErr = runCommand(ctx, task.WorkspacePath, command)
			if commandErr != nil {
				commandErr = commandFailure(commandErr, string(stderr))
			}
		}
		if commandErr != nil {
			item.Error = commandErr.Error()
			_, _ = fmt.Fprintf(out, "  Greptile could not complete this review: %s\n", item.Error)
		} else {
			parsed, parseErr := adapter.ParseReviewResult(stdout)
			if parseErr != nil {
				item.Error = parseErr.Error()
				_, _ = fmt.Fprintf(out, "  Greptile returned an unreadable result: %s\n", item.Error)
			} else {
				item.Verdict = string(parsed.Verdict)
				item.Body = parsed.Body
				item.Comments = reviewComments(parsed.Comments)
				_, _ = fmt.Fprintln(out, parsed.Body)
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
	_, _ = fmt.Fprintln(out, "\nGreptile review complete. AO will post any findings to GitHub.")
	return nil
}

func reviewComments(comments []ports.ReviewComment) []terminalComment {
	out := make([]terminalComment, 0, len(comments))
	for _, comment := range comments {
		out = append(out, terminalComment{
			Path: comment.Path, StartLine: comment.StartLine, EndLine: comment.EndLine,
			Side: comment.Side, Body: comment.Body, Suggestion: comment.Suggestion,
			Severity: comment.Severity, SecurityIssue: comment.SecurityIssue,
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
	var stdout, stderr strings.Builder
	cmd := aoprocess.CommandContext(ctx, command.Argv[0], command.Argv[1:]...)
	cmd.Dir = workspacePath
	cmd.Env = append(os.Environ(), envAssignments(command.Env)...)
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	return []byte(stdout.String()), []byte(stderr.String()), err
}

func envAssignments(extra map[string]string) []string {
	values := make([]string, 0, len(extra))
	for key, value := range extra {
		values = append(values, key+"="+value)
	}
	return values
}

func commandFailure(err error, stderr string) error {
	detail := strings.TrimSpace(stderr)
	if detail == "" {
		return fmt.Errorf("greptile failed: %w", err)
	}
	return fmt.Errorf("greptile failed: %w: %s", err, detail)
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
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		return err
	}
	return nil
}
