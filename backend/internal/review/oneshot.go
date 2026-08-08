package review

import (
	"bytes"
	"context"
	"errors"
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
const terminalReviewRetention = 7 * 24 * time.Hour

type oneShotJob struct {
	id         uint64
	cancel     context.CancelFunc
	terminal   bool
	terminalID string
	done       bool
}

type oneShotExecutor func(ctx context.Context, workspacePath string, command ports.ReviewCommandSpec) (stdout, stderr []byte, err error)

func (l *agentLauncher) startOneShot(spec LaunchSpec, reviewer ports.OneShotReviewer) (LaunchResult, error) {
	if l.onComplete == nil {
		return LaunchResult{}, fmt.Errorf("one-shot reviewer completion handler is not configured")
	}
	handleID := reviewerHandleID(spec.WorkerID)
	jobCtx, job := l.registerOneShotJob(handleID)

	if terminalReviewer, terminalOK := reviewer.(ports.TerminalOneShotReviewer); terminalOK {
		if _, runtimeOK := l.runtime.(reviewerTerminalRuntime); runtimeOK {
			return l.startTerminalOneShot(jobCtx, handleID, job.id, spec, terminalReviewer)
		}
	}

	go l.runOneShotBatch(jobCtx, handleID, job.id, spec, reviewer)
	return LaunchResult{HandleID: handleID}, nil
}

func (l *agentLauncher) registerOneShotJob(handleID string) (context.Context, oneShotJob) {
	jobCtx, cancel := context.WithCancel(l.rootCtx)
	l.jobsMu.Lock()
	if previous, ok := l.jobs[handleID]; ok {
		previous.cancel()
	}
	l.nextJob++
	job := oneShotJob{id: l.nextJob, cancel: cancel}
	l.jobs[handleID] = job
	l.jobsMu.Unlock()
	return jobCtx, job
}

func (l *agentLauncher) startTerminalOneShot(ctx context.Context, handleID string, jobID uint64, spec LaunchSpec, reviewer ports.TerminalOneShotReviewer) (LaunchResult, error) {
	tasks := spec.ReviewQueue
	if len(tasks) == 0 {
		tasks = []ports.ReviewTask{{
			RunID:         spec.RunID,
			PRURL:         spec.PRURL,
			TargetSHA:     spec.TargetSHA,
			WorkspacePath: spec.WorkspacePath,
		}}
	}
	requestPath, err := terminalRequestPath(l.dataDir, spec, jobID)
	if err != nil {
		l.abortOneShot(handleID, jobID)
		return LaunchResult{}, err
	}
	command, err := reviewer.PrepareTerminalRequest(requestPath, tasks)
	if err != nil {
		l.abortOneShot(handleID, jobID)
		return LaunchResult{}, fmt.Errorf("prepare reviewer terminal: %w", err)
	}
	// The stable handle is also the terminal identity. Replacing a stale pane
	// before Create keeps a harness switch from leaving the old review visible.
	if err := l.runtime.Destroy(ctx, ports.RuntimeHandle{ID: handleID}); err != nil {
		l.abortOneShot(handleID, jobID)
		return LaunchResult{}, fmt.Errorf("reviewer terminal replace stale pane: %w", err)
	}
	handle, err := l.runtime.Create(ctx, ports.RuntimeConfig{
		SessionID:        domain.SessionID(handleID),
		WorkspacePath:    spec.WorkspacePath,
		Argv:             command.Argv,
		Env:              l.runtimeEnv(ctx, spec, command.Argv, command.Env),
		TerminalBehavior: ports.TerminalOutputOnly,
	})
	if err != nil {
		l.abortOneShot(handleID, jobID)
		return LaunchResult{}, fmt.Errorf("reviewer terminal: %w", err)
	}
	l.jobsMu.Lock()
	if current, ok := l.jobs[handleID]; ok && current.id == jobID {
		current.terminal = true
		current.terminalID = handle.ID
		l.jobs[handleID] = current
	}
	l.jobsMu.Unlock()
	go l.runTerminalBatch(ctx, handleID, jobID, spec, reviewer, reviewer.TerminalResultPath(requestPath), tasks, time.Now().Add(oneShotResultWaitLimit))
	return LaunchResult{HandleID: handle.ID}, nil
}

func (l *agentLauncher) runTerminalBatch(ctx context.Context, handleID string, jobID uint64, spec LaunchSpec, reviewer ports.TerminalOneShotReviewer, resultPath string, tasks []ports.ReviewTask, deadlineAt time.Time) {
	defer l.finishOneShot(handleID, jobID)
	remaining := time.Until(deadlineAt)
	if remaining <= 0 {
		remaining = time.Nanosecond
	}
	deadline := time.NewTimer(remaining)
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
			_ = l.maybeCleanupTerminalReview(resultPath, spec.WorkerID, tasks)
			return
		case <-ticker.C:
			raw, err := os.ReadFile(resultPath)
			if err == nil {
				result, parseErr := reviewer.ParseTerminalResult(raw)
				if parseErr == nil && result.Complete {
					completions := terminalCompletions(tasks, result)
					if len(completions) > 0 && l.onComplete != nil {
						l.onComplete(ctx, spec.WorkerID, completions)
					}
					_ = l.maybeCleanupTerminalReview(resultPath, spec.WorkerID, tasks)
					return
				}
			}
			if processRuntime, ok := l.runtime.(reviewerTerminalProcessRuntime); ok {
				processAlive, probeErr := processRuntime.IsProcessAlive(ctx, ports.RuntimeHandle{ID: handleID})
				if probeErr != nil {
					// A transient process probe must not turn a still-running
					// review into a failure; the next tick can read the sidecar or
					// retry the probe.
					continue
				}
				if !processAlive {
					if l.onComplete != nil {
						completions := make([]ReviewCompletion, 0, len(tasks))
						for _, task := range tasks {
							completions = append(completions, ReviewCompletion{RunID: task.RunID, PRURL: task.PRURL, TargetSHA: task.TargetSHA, Err: fmt.Errorf("greptile terminal ended before publishing a complete result")})
						}
						l.onComplete(ctx, spec.WorkerID, completions)
					}
					_ = l.maybeCleanupTerminalReview(resultPath, spec.WorkerID, tasks)
					return
				}
			}
		}
	}
}

// terminalRequestPath derives a request identity from durable review ids. The
// in-memory generation remains only a fallback for legacy/unit callers that do
// not provide a batch or run id; production review triggers always provide
// both, so daemon restarts cannot collide with a prior request.
func terminalRequestPath(dataDir string, spec LaunchSpec, jobID uint64) (string, error) {
	if strings.TrimSpace(dataDir) == "" {
		return "", fmt.Errorf("reviewer terminal data directory is required")
	}
	worker, err := safeReviewPathComponent(string(spec.WorkerID))
	if err != nil {
		return "", fmt.Errorf("invalid review worker id: %w", err)
	}
	batch := strings.TrimSpace(spec.BatchID)
	if batch == "" {
		batch = strings.TrimSpace(spec.RunID)
	}
	if batch == "" {
		batch = fmt.Sprintf("legacy-%d", jobID)
	}
	run := strings.TrimSpace(spec.RunID)
	if run == "" {
		run = fmt.Sprintf("legacy-%d", jobID)
	}
	batch, err = safeReviewPathComponent(batch)
	if err != nil {
		return "", fmt.Errorf("invalid review batch id: %w", err)
	}
	run, err = safeReviewPathComponent(run)
	if err != nil {
		return "", fmt.Errorf("invalid review run id: %w", err)
	}
	return filepath.Join(dataDir, "reviews", worker, "terminal", batch, run+".json"), nil
}

func safeReviewPathComponent(value string) (string, error) {
	if value == "" || value == "." || value == ".." || filepath.Base(value) != value {
		return "", fmt.Errorf("path component %q is not safe", value)
	}
	for _, r := range value {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '-' || r == '_' || r == '.' {
			continue
		}
		return "", fmt.Errorf("path component %q contains unsupported character", value)
	}
	return value, nil
}

// RecoverTerminalReviews reattaches the Greptile terminal watcher after a
// daemon restart. Completion is deliberately sent through the normal handler;
// the service/store layer decides whether each referenced run is still
// Running, which makes repeated recovery and stale sidecars harmless.
func (l *agentLauncher) RecoverTerminalReviews(ctx context.Context) error {
	if strings.TrimSpace(l.dataDir) == "" {
		return nil
	}
	reviewer, ok := l.reviewers.Reviewer(domain.ReviewerGreptile)
	if !ok {
		return nil
	}
	terminalReviewer, ok := reviewer.(ports.TerminalOneShotReviewer)
	if !ok {
		return nil
	}
	reader, ok := reviewer.(ports.TerminalReviewRequestReader)
	if !ok {
		return fmt.Errorf("greptile reviewer does not support terminal recovery")
	}
	runtime, ok := l.runtime.(reviewerTerminalRuntime)
	if !ok {
		return nil
	}
	root := filepath.Join(l.dataDir, "reviews")
	workers, err := os.ReadDir(root)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("scan reviewer terminal requests: %w", err)
	}
	var firstErr error
	for _, workerEntry := range workers {
		if !workerEntry.IsDir() {
			continue
		}
		terminalDir := filepath.Join(root, workerEntry.Name(), "terminal")
		if _, statErr := os.Stat(terminalDir); errors.Is(statErr, os.ErrNotExist) {
			continue
		}
		err := filepath.WalkDir(terminalDir, func(path string, entry os.DirEntry, walkErr error) error {
			if walkErr != nil {
				return walkErr
			}
			if entry.Type()&os.ModeSymlink != 0 {
				// Request/result files are AO-owned and must remain below the
				// worker's terminal directory. Do not follow an externally-created
				// symlink during restart recovery.
				return nil
			}
			if entry.IsDir() || filepath.Ext(path) != ".json" || strings.HasSuffix(path, ".result.json") {
				return nil
			}
			l.jobsMu.Lock()
			_, alreadyRecovered := l.recovered[path]
			l.jobsMu.Unlock()
			if alreadyRecovered {
				return nil
			}
			markRecovered := func() {
				l.jobsMu.Lock()
				if l.recovered == nil {
					l.recovered = make(map[string]struct{})
				}
				l.recovered[path] = struct{}{}
				l.jobsMu.Unlock()
			}
			request, readErr := reader.ReadTerminalRequest(path)
			if readErr != nil {
				if firstErr == nil {
					firstErr = readErr
				}
				return nil
			}
			workerID := domain.SessionID(workerEntry.Name())
			if request.WorkerID != "" && request.WorkerID != workerID {
				if firstErr == nil {
					firstErr = fmt.Errorf("greptile terminal request worker id %q does not match its path", request.WorkerID)
				}
				return nil
			}
			if request.Harness != "" && request.Harness != domain.ReviewerGreptile {
				if firstErr == nil {
					firstErr = fmt.Errorf("unsupported reviewer harness %q in Greptile terminal request", request.Harness)
				}
				return nil
			}
			if l.active != nil {
				runIDs := make([]string, 0, len(request.Tasks))
				for _, task := range request.Tasks {
					runIDs = append(runIDs, task.RunID)
				}
				active, activeErr := l.active(ctx, workerID, runIDs)
				if activeErr != nil {
					if firstErr == nil {
						firstErr = fmt.Errorf("check active Greptile terminal runs: %w", activeErr)
					}
					return nil
				}
				if !active {
					// The DB already resolved every run in this request. Do not
					// register a watcher that could cancel a newer batch for the
					// same worker's stable terminal handle.
					if cleanupErr := l.maybeCleanupTerminalReview(terminalReviewer.TerminalResultPath(path), workerID, request.Tasks); cleanupErr != nil && firstErr == nil {
						firstErr = cleanupErr
					}
					markRecovered()
					return nil
				}
			}
			handleID := reviewerHandleID(workerID)
			resultPath := request.ResultPath
			if strings.TrimSpace(resultPath) == "" {
				resultPath = terminalReviewer.TerminalResultPath(path)
			}
			if resultInfo, resultStatErr := os.Lstat(resultPath); resultStatErr == nil && resultInfo.Mode()&os.ModeSymlink != 0 {
				if firstErr == nil {
					firstErr = fmt.Errorf("refusing symlinked Greptile terminal result %s", resultPath)
				}
				return nil
			}
			if raw, resultErr := os.ReadFile(resultPath); resultErr == nil {
				if result, parseErr := terminalReviewer.ParseTerminalResult(raw); parseErr == nil && result.Complete {
					if l.onComplete != nil {
						l.onComplete(ctx, workerID, terminalCompletions(request.Tasks, result))
					}
					if cleanupErr := l.maybeCleanupTerminalReview(resultPath, workerID, request.Tasks); cleanupErr != nil && firstErr == nil {
						firstErr = cleanupErr
					}
					markRecovered()
					return nil
				}
			}
			createdAt := request.CreatedAt
			if createdAt.IsZero() {
				if info, statErr := entry.Info(); statErr == nil {
					createdAt = info.ModTime()
				}
			}
			if createdAt.IsZero() {
				createdAt = time.Now()
			}
			deadlineAt := request.DeadlineAt
			maxDeadline := createdAt.Add(oneShotResultWaitLimit)
			if deadlineAt.IsZero() || deadlineAt.After(maxDeadline) {
				deadlineAt = maxDeadline
			}
			if deadlineAt.Before(createdAt) {
				deadlineAt = createdAt
			}
			if deadlineAt.IsZero() {
				deadlineAt = createdAt.Add(oneShotResultWaitLimit)
			}
			if time.Now().Before(deadlineAt) {
				alive, probeErr := runtime.IsAlive(ctx, ports.RuntimeHandle{ID: handleID})
				if processRuntime, processProbe := l.runtime.(reviewerTerminalProcessRuntime); processProbe {
					alive, probeErr = processRuntime.IsProcessAlive(ctx, ports.RuntimeHandle{ID: handleID})
				}
				if probeErr != nil {
					if firstErr == nil {
						firstErr = fmt.Errorf("probe recovered Greptile terminal %s: %w", handleID, probeErr)
					}
					return nil
				}
				if alive {
					jobCtx, job := l.registerOneShotJob(handleID)
					batchID := request.BatchID
					if batchID == "" {
						batchID = filepath.Base(filepath.Dir(path))
					}
					spec := LaunchSpec{RunID: request.Tasks[0].RunID, BatchID: batchID, WorkerID: workerID, Harness: domain.ReviewerGreptile, WorkspacePath: request.Tasks[0].WorkspacePath, PRURL: request.Tasks[0].PRURL, TargetSHA: request.Tasks[0].TargetSHA, ReviewQueue: request.Tasks}
					go l.runTerminalBatch(jobCtx, handleID, job.id, spec, terminalReviewer, resultPath, request.Tasks, deadlineAt)
					markRecovered()
					return nil
				}
			}
			if l.onComplete != nil {
				completions := make([]ReviewCompletion, 0, len(request.Tasks))
				for _, task := range request.Tasks {
					completions = append(completions, ReviewCompletion{RunID: task.RunID, PRURL: task.PRURL, TargetSHA: task.TargetSHA, Err: fmt.Errorf("greptile terminal ended before publishing a complete result")})
				}
				l.onComplete(ctx, workerID, completions)
			}
			if cleanupErr := l.maybeCleanupTerminalReview(resultPath, workerID, request.Tasks); cleanupErr != nil && firstErr == nil {
				firstErr = cleanupErr
			}
			markRecovered()
			return nil
		})
		if err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}

func (l *agentLauncher) maybeCleanupTerminalReview(resultPath string, workerID domain.SessionID, tasks []ports.ReviewTask) error {
	if l.consumed == nil || strings.TrimSpace(resultPath) == "" || len(tasks) == 0 {
		return nil
	}
	requestPath := strings.TrimSuffix(resultPath, ".result.json")
	requestInfo, err := os.Lstat(requestPath)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("inspect Greptile terminal request for cleanup: %w", err)
	}
	if requestInfo.Mode()&os.ModeSymlink != 0 || time.Since(requestInfo.ModTime()) < terminalReviewRetention {
		return nil
	}
	resultInfo, err := os.Lstat(resultPath)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("inspect Greptile terminal result for cleanup: %w", err)
	}
	if resultInfo.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("refusing to clean symlinked Greptile terminal result")
	}
	root, err := filepath.Abs(filepath.Join(l.dataDir, "reviews"))
	if err != nil {
		return fmt.Errorf("resolve Greptile terminal cleanup root: %w", err)
	}
	workerComponent, err := safeReviewPathComponent(string(workerID))
	if err != nil {
		return fmt.Errorf("resolve Greptile terminal cleanup worker: %w", err)
	}
	workerRoot := filepath.Join(root, workerComponent, "terminal")
	resolvedWorkerRoot := workerRoot
	if evaluatedRoot, evalErr := filepath.EvalSymlinks(workerRoot); evalErr == nil {
		resolvedWorkerRoot = evaluatedRoot
	}
	for _, target := range []string{requestPath, resultPath} {
		abs, absErr := filepath.Abs(target)
		if absErr != nil {
			return fmt.Errorf("resolve Greptile terminal cleanup path: %w", absErr)
		}
		rel, relErr := filepath.Rel(workerRoot, abs)
		if relErr != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			return fmt.Errorf("refusing Greptile terminal cleanup outside worker terminal directory")
		}
		resolvedParent := filepath.Dir(abs)
		if evaluatedParent, resolveErr := filepath.EvalSymlinks(filepath.Dir(abs)); resolveErr == nil {
			resolvedParent = evaluatedParent
		}
		resolvedRel, resolvedRelErr := filepath.Rel(resolvedWorkerRoot, resolvedParent)
		if resolvedRelErr != nil || resolvedRel == ".." || strings.HasPrefix(resolvedRel, ".."+string(filepath.Separator)) {
			return fmt.Errorf("refusing Greptile terminal cleanup through symlink outside worker terminal directory")
		}
	}
	runIDs := make([]string, 0, len(tasks))
	for _, task := range tasks {
		runIDs = append(runIDs, task.RunID)
	}
	if !l.consumed(context.Background(), workerID, runIDs) {
		return nil
	}
	if err := os.Remove(resultPath); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("remove consumed Greptile terminal result: %w", err)
	}
	if err := os.Remove(requestPath); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("remove consumed Greptile terminal request: %w", err)
	}
	return nil
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
		completion := ReviewCompletion{RunID: task.RunID, PRURL: task.PRURL, TargetSHA: task.TargetSHA, Verdict: item.Verdict, Body: item.Body, Comments: item.Comments}
		if item.PRURL != "" && task.PRURL != "" && item.PRURL != task.PRURL {
			completion.Err = fmt.Errorf("greptile terminal result PR does not match run %s", task.RunID)
		}
		if item.TargetSHA != "" && task.TargetSHA != "" && item.TargetSHA != task.TargetSHA {
			completion.Err = fmt.Errorf("greptile terminal result commit does not match run %s", task.RunID)
		}
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
		if resolved, resolveErr := resolveReviewerCommand(ctx, reviewer, command); resolveErr == nil {
			command = resolved
		} else if ctx.Err() != nil {
			return
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
	job, ok := l.jobs[handleID]
	if !ok {
		return false, false
	}
	// A completed terminal job still owns a retained output pane, but it is no
	// longer an actively watched review. Returning handled=true with alive=false
	// makes the next trigger replace that pane instead of trying to Notify a
	// one-shot CLI that has already exited.
	return !job.done, true
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
