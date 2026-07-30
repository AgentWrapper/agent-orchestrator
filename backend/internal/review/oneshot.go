package review

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"strings"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	aoprocess "github.com/aoagents/agent-orchestrator/backend/internal/process"
)

const oneShotErrorOutputLimit = 16 * 1024

type oneShotJob struct {
	id     uint64
	cancel context.CancelFunc
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

	go l.runOneShotBatch(jobCtx, handleID, job.id, spec, reviewer)
	return handleID, nil
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
			completions = append(completions, ReviewCompletion{RunID: task.RunID, Err: fmt.Errorf("reviewer command: %w", err)})
			continue
		}
		if len(command.Argv) == 0 {
			completions = append(completions, ReviewCompletion{RunID: task.RunID, Err: fmt.Errorf("reviewer produced empty command")})
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
			completions = append(completions, ReviewCompletion{RunID: task.RunID, Err: err})
			continue
		}
		completions = append(completions, ReviewCompletion{
			RunID:   task.RunID,
			Verdict: result.Verdict,
			Body:    result.Body,
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
		delete(l.jobs, handleID)
	}
}

func (l *agentLauncher) oneShotAlive(handleID string) (alive, handled bool) {
	l.jobsMu.Lock()
	defer l.jobsMu.Unlock()
	_, ok := l.jobs[handleID]
	return ok, ok
}

func (l *agentLauncher) cancelOneShot(handleID string) bool {
	l.jobsMu.Lock()
	job, ok := l.jobs[handleID]
	if ok {
		delete(l.jobs, handleID)
	}
	l.jobsMu.Unlock()
	if ok {
		job.cancel()
	}
	return ok
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
