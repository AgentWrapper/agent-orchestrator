package pipelinesvc

import (
	"context"
	"errors"
	"fmt"
	"os"

	"github.com/aoagents/agent-orchestrator/backend/internal/pipeline"
)

// Run-folder read errors. The controller maps them onto the log and output
// routes: 404 for all four, because "no such run", "no such stage", "that file
// is not a declared output" and "it has not been written yet" are all the same
// answer to a caller asking for a URL that serves nothing.
var (
	// ErrRunFolderMissing means the run carries no run folder, so there is
	// nothing on disk to read. A run that failed before its folder was created
	// looks like this.
	ErrRunFolderMissing = errors.New("pipeline run has no run folder")
	// ErrStageLogMissing means the stage exists but has not written a log yet.
	ErrStageLogMissing = errors.New("pipeline stage has no log yet")
	// ErrOutputMissing means the filename is a declared output of the run, but
	// the file is not on disk (the producing stage has not run, or settled
	// no_output).
	ErrOutputMissing = errors.New("pipeline run output has not been written")
)

// maxOutputBytes caps what the outputs endpoint will read into memory. Declared
// artifacts are agent-written markdown, so this is a guard rail against a rogue
// producer rather than a real limit anyone should hit.
const maxOutputBytes = 32 << 20

// StageLog is one stage's captured stdout and stderr.
type StageLog struct {
	StageID string
	Content string
	// TailLines is the number of trailing lines requested, 0 for the whole log.
	TailLines int
	// Truncated says the content is a tail rather than the complete log.
	Truncated bool
}

// RunOutput is one declared artifact, read from the run folder.
type RunOutput struct {
	Filename string
	Content  []byte
}

// StageLog reads a stage's log from the run folder, keeping the last tailLines
// lines (0 or less for the whole log).
func (s *Service) StageLog(ctx context.Context, runID pipeline.RunID, stageID string, tailLines int) (StageLog, error) {
	run, err := s.GetRun(ctx, runID)
	if err != nil {
		return StageLog{}, err
	}
	if stage, ok := run.Stages[stageID]; !ok || stage == nil {
		return StageLog{}, fmt.Errorf("%w: %s/%s", ErrStageNotFound, runID, stageID)
	}
	folder, err := runFolder(run)
	if err != nil {
		return StageLog{}, err
	}

	content, exists, truncated, err := folder.ReadLogTail(stageID, tailLines)
	if err != nil {
		return StageLog{}, err
	}
	if !exists {
		return StageLog{}, fmt.Errorf("%w: %s/%s", ErrStageLogMissing, runID, stageID)
	}
	return StageLog{StageID: stageID, Content: content, TailLines: tailLines, Truncated: truncated}, nil
}

// RunOutput reads one declared artifact out of the run's agent-outputs
// directory.
//
// filename is checked against the run's frozen `produces` set before it is
// resolved to a path at all, so an undeclared name, a traversal or an absolute
// path never reaches the filesystem. The resolved path must then be a regular
// file, which is what stops a symlink planted in agent-outputs from serving
// something outside the run folder.
func (s *Service) RunOutput(ctx context.Context, runID pipeline.RunID, filename string) (RunOutput, error) {
	run, err := s.GetRun(ctx, runID)
	if err != nil {
		return RunOutput{}, err
	}
	folder, err := runFolder(run)
	if err != nil {
		return RunOutput{}, err
	}
	path, err := folder.DeclaredOutput(&run.Def, filename)
	if err != nil {
		return RunOutput{}, err
	}

	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return RunOutput{}, fmt.Errorf("%w: %s/%s", ErrOutputMissing, runID, filename)
	}
	if err != nil {
		return RunOutput{}, fmt.Errorf("stat pipeline output %s: %w", filename, err)
	}
	// Lstat, not Stat: a symlink is not a regular file, so this rejects one
	// rather than following it out of the run folder.
	if !info.Mode().IsRegular() {
		return RunOutput{}, fmt.Errorf("%w: %s/%s is not a regular file", pipeline.ErrOutputNotDeclared, runID, filename)
	}
	if info.Size() > maxOutputBytes {
		return RunOutput{}, fmt.Errorf("pipeline output %s is %d bytes, over the %d byte limit", filename, info.Size(), maxOutputBytes)
	}

	content, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return RunOutput{}, fmt.Errorf("%w: %s/%s", ErrOutputMissing, runID, filename)
	}
	if err != nil {
		return RunOutput{}, fmt.Errorf("read pipeline output %s: %w", filename, err)
	}
	return RunOutput{Filename: filename, Content: content}, nil
}

// runFolder is the run's directory on disk, or ErrRunFolderMissing.
func runFolder(run pipeline.RunState) (pipeline.RunFolder, error) {
	if run.RunDir == "" {
		return pipeline.RunFolder{}, fmt.Errorf("%w: %s", ErrRunFolderMissing, run.RunID)
	}
	return pipeline.RunFolder{Dir: run.RunDir}, nil
}
