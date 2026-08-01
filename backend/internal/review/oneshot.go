package review

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	aoprocess "github.com/aoagents/agent-orchestrator/backend/internal/process"
)

const oneShotErrorOutputLimit = 16 * 1024
const oneShotResultWaitLimit = 30 * time.Minute

type oneShotJob struct {
	id         uint64
	cancel     context.CancelFunc
	terminal   bool
	terminalID string
	done       bool
}

type oneShotExecutor func(ctx context.Context, workspacePath string, command ports.ReviewCommandSpec) (stdout, stderr []byte, err error)

func (l *agentLauncher) startOneShot(spec LaunchSpec, reviewer ports.OneShotReviewer) (string, error) {
	if l.onComplete == nil {
		return "", fmt.Errorf("one-shot reviewer completion handler is not configured")
	}
	handleID := reviewerHandleID(spec.WorkerID)
	jobCtx, cancel := context.WithCancel(l.rootCtx)

	l.jobsMu.Lock()
	if previous, ok := l.jobs[handleID]; ok {
		previous.cancel()
	}
	l.nextJob++
	job := oneShotJob{id: l.nextJob, cancel: cancel}
	l.jobs[handleID] = job
	l.jobsMu.Unlock()

	if terminalReviewer, terminalOK := reviewer.(ports.TerminalOneShotReviewer); terminalOK {
		if _, runtimeOK := l.runtime.(reviewerTerminalRuntime); runtimeOK {
			return l.startTerminalOneShot(jobCtx, handleID, job.id, spec, terminalReviewer)
		}
	}

	go l.runOneShotBatch(jobCtx, handleID, job.id, spec, reviewer)
	return handleID, nil
}

func (l *agentLauncher) startTerminalOneShot(ctx context.Context, handleID string, jobID uint64, spec LaunchSpec, reviewer ports.TerminalOneShotReviewer) (string, error) {
	tasks := spec.ReviewQueue
	if len(tasks) == 0 {
		tasks = []ports.ReviewTask{{
			RunID:         spec.RunID,
			PRURL:         spec.PRURL,
			TargetSHA:     spec.TargetSHA,
			WorkspacePath: spec.WorkspacePath,
		}}
	}
	requestDir := filepath.Join(l.dataDir, "reviews", string(spec.WorkerID), "terminal")
	requestPath := filepath.Join(requestDir, fmt.Sprintf("review-%d.json", jobID))
	command, err := reviewer.PrepareTerminalRequest(requestPath, tasks)
	if err != nil {
		l.abortOneShot(handleID, jobID)
		return "", fmt.Errorf("prepare reviewer terminal: %w", err)
	}
	// The stable handle is also the terminal identity. Replacing a stale pane
	// before Create keeps a harness switch from leaving the old review visible.
	if err := l.runtime.Destroy(ctx, ports.RuntimeHandle{ID: handleID}); err != nil {
		l.abortOneShot(handleID, jobID)
		return "", fmt.Errorf("reviewer terminal replace stale pane: %w", err)
	}
	handle, err := l.runtime.Create(ctx, ports.RuntimeConfig{
		SessionID:     domain.SessionID(handleID),
		WorkspacePath: spec.WorkspacePath,
		Argv:          command.Argv,
		Env:           pinnedEnv(command.Env),
	})
	if err != nil {
		l.abortOneShot(handleID, jobID)
		return "", fmt.Errorf("reviewer terminal: %w", err)
	}
	l.jobsMu.Lock()
	if current, ok := l.jobs[handleID]; ok && current.id == jobID {
		current.terminal = true
		current.terminalID = handle.ID
		l.jobs[handleID] = current
	}
	l.jobsMu.Unlock()
	go l.runTerminalBatch(ctx, handleID, jobID, spec, reviewer, reviewer.TerminalResultPath(requestPath), tasks)
	return handle.ID, nil
}

func (l *agentLauncher) runTerminalBatch(ctx context.Context, handleID string, jobID uint64, spec LaunchSpec, reviewer ports.TerminalOneShotReviewer, resultPath string, tasks []ports.ReviewTask) {
	defer l.finishOneShot(handleID, jobID)
	deadline := time.NewTimer(oneShotResultWaitLimit)
	defer deadline.Stop()
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-deadline.C:
			if l.onComplete != nil {
				completions := make([]ReviewCompletion, 0, len(tasks))
				for _, task := range tasks {
					completions = append(completions, ReviewCompletion{RunID: task.RunID, PRURL: task.PRURL, TargetSHA: task.TargetSHA, Err: fmt.Errorf("greptile terminal did not publish a result within %s", oneShotResultWaitLimit)})
				}
				l.onComplete(ctx, spec.WorkerID, completions)
			}
			return
		case <-ticker.C:
			raw, err := os.ReadFile(resultPath)
			if err != nil {
				continue
			}
			result, err := reviewer.ParseTerminalResult(raw)
			if err != nil || !result.Complete {
				continue
			}
			completions := terminalCompletions(tasks, result)
			if len(completions) > 0 && l.onComplete != nil {
				l.onComplete(ctx, spec.WorkerID, completions)
			}
			return
		}
	}
}

func terminalCompletions(tasks []ports.ReviewTask, result ports.TerminalReviewResult) []ReviewCompletion {
	byRun := make(map[string]ports.TerminalReviewItem, len(result.Results))
	for _, item := range result.Results {
		byRun[item.RunID] = item
	}
	completions := make([]ReviewCompletion, 0, len(tasks))
	for _, task := range tasks {
		item, ok := byRun[task.RunID]
		if !ok {
			completions = append(completions, ReviewCompletion{RunID: task.RunID, PRURL: task.PRURL, TargetSHA: task.TargetSHA, Err: fmt.Errorf("greptile terminal omitted result for run %s", task.RunID)})
			continue
		}
		completion := ReviewCompletion{RunID: item.RunID, PRURL: item.PRURL, TargetSHA: item.TargetSHA, Verdict: item.Verdict, Body: item.Body, Comments: item.Comments}
		if item.Error != "" {
			completion.Err = fmt.Errorf("%s", item.Error)
		}
		completions = append(completions, completion)
	}
	return completions
}

func (l *agentLauncher) abortOneShot(handleID string, jobID uint64) {
	l.jobsMu.Lock()
	if current, ok := l.jobs[handleID]; ok && current.id == jobID {
		delete(l.jobs, handleID)
		current.cancel()
	}
	l.jobsMu.Unlock()
}

func (l *agentLauncher) runOneShotBatch(ctx context.Context, handleID string, jobID uint64, spec LaunchSpec, reviewer ports.OneShotReviewer) {
	defer l.finishOneShot(handleID, jobID)

	tasks := spec.ReviewQueue
	if len(tasks) == 0 {
		tasks = []ports.ReviewTask{{
			RunID:         spec.RunID,
			PRURL:         spec.PRURL,
			TargetSHA:     spec.TargetSHA,
			WorkspacePath: spec.WorkspacePath,
		}}
	}

	completions := make([]ReviewCompletion, 0, len(tasks))
	for index, task := range tasks {
		if ctx.Err() != nil {
			return
		}
		taskSpec := spec
		taskSpec.RunID = task.RunID
		taskSpec.PRURL = task.PRURL
		taskSpec.TargetSHA = task.TargetSHA
		if task.WorkspacePath != "" {
			taskSpec.WorkspacePath = task.WorkspacePath
		}
		taskSpec.ReviewQueue = tasks
		taskSpec.ReviewIndex = index

		inv := l.invocation(taskSpec)
		command, err := reviewer.ReviewCommand(ctx, inv)
		if err != nil {
			completions = append(completions, ReviewCompletion{RunID: task.RunID, PRURL: task.PRURL, TargetSHA: task.TargetSHA, Err: fmt.Errorf("reviewer command: %w", err)})
			continue
		}
		if len(command.Argv) == 0 {
			completions = append(completions, ReviewCompletion{RunID: task.RunID, PRURL: task.PRURL, TargetSHA: task.TargetSHA, Err: fmt.Errorf("reviewer produced empty command")})
			continue
		}

		stdout, stderr, err := l.execute(ctx, taskSpec.WorkspacePath, command)
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			completions = append(completions, ReviewCompletion{
				RunID: task.RunID,
				Err:   commandFailure(err, string(stderr)),
			})
			continue
		}

		result, err := reviewer.ParseReviewResult(stdout)
		if err != nil {
			completions = append(completions, ReviewCompletion{RunID: task.RunID, PRURL: task.PRURL, TargetSHA: task.TargetSHA, Err: err})
			continue
		}
		completions = append(completions, ReviewCompletion{
			RunID:     task.RunID,
			PRURL:     task.PRURL,
			TargetSHA: task.TargetSHA,
			Verdict:   result.Verdict,
			Body:      result.Body,
			Comments:  result.Comments,
		})
	}
	if ctx.Err() == nil && len(completions) > 0 {
		l.onComplete(ctx, spec.WorkerID, completions)
	}
}

func executeOneShot(ctx context.Context, workspacePath string, command ports.ReviewCommandSpec) ([]byte, []byte, error) {
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	cmd := aoprocess.CommandContext(ctx, command.Argv[0], command.Argv[1:]...)
	configureOneShotCancellation(cmd)
	cmd.Dir = workspacePath
	cmd.Env = commandEnv(command.Env)
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	return stdout.Bytes(), stderr.Bytes(), err
}

func (l *agentLauncher) finishOneShot(handleID string, jobID uint64) {
	l.jobsMu.Lock()
	defer l.jobsMu.Unlock()
	if current, ok := l.jobs[handleID]; ok && current.id == jobID {
		if current.terminal {
			current.done = true
			l.jobs[handleID] = current
		} else {
			delete(l.jobs, handleID)
		}
	}
}

func (l *agentLauncher) oneShotAlive(handleID string) (alive, handled bool) {
	l.jobsMu.Lock()
	defer l.jobsMu.Unlock()
	_, ok := l.jobs[handleID]
	return ok, ok
}

func (l *agentLauncher) cancelOneShot(ctx context.Context, handleID string) (bool, error) {
	l.jobsMu.Lock()
	job, ok := l.jobs[handleID]
	if ok {
		delete(l.jobs, handleID)
	}
	l.jobsMu.Unlock()
	if !ok {
		return false, nil
	}
	job.cancel()
	if job.terminal {
		if err := l.runtime.Destroy(ctx, ports.RuntimeHandle{ID: handleID}); err != nil {
			return true, err
		}
	}
	return true, nil
}

func commandEnv(extra map[string]string) []string {
	if len(extra) == 0 {
		return os.Environ()
	}
	env := append([]string(nil), os.Environ()...)
	for key, value := range extra {
		env = append(env, key+"="+value)
	}
	return env
}

func commandFailure(err error, stderr string) error {
	detail := strings.TrimSpace(stderr)
	if len(detail) > oneShotErrorOutputLimit {
		detail = detail[len(detail)-oneShotErrorOutputLimit:]
	}
	if detail == "" {
		return fmt.Errorf("one-shot reviewer failed: %w", err)
	}
	return fmt.Errorf("one-shot reviewer failed: %w: %s", err, detail)
}
