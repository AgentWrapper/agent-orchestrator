package pipeline

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Run folder layout, spec section 3:
//
//	<base>/<project-id>/<run-id>/
//	  definition.yaml            frozen copy, what actually ran
//	  run.json                   projection of RunState for humans
//	  Context.md                 engine-written index
//	  agent-outputs/<produces>   declared artifacts
//	  stage-logs/<stage>.log     stdout+stderr, both executors
//	  workspace/                 if any stage uses `workspace: run`
//	  workspaces/<stage>/        if any stage uses `workspace: stage`
//
// The base dir is always <AO_DATA_DIR>/pipelines, which defaults under ~/.ao.
// No app state ever lands in an OS-default application-data location.
const (
	agentOutputsDir = "agent-outputs"
	stageLogsDir    = "stage-logs"
	definitionFile  = "definition.yaml"
	runJSONFile     = "run.json"
	contextFile     = "Context.md"

	runFolderDirPerm  os.FileMode = 0o750
	runFolderFilePerm os.FileMode = 0o600
)

// RunFolder is one run's directory on disk. Run id keys the folder, so
// concurrent runs of the same pipeline cannot collide.
type RunFolder struct{ Dir string }

// CreateRunFolder makes <base>/<projectID>/<runID> with its agent-outputs and
// stage-logs subdirectories, and freezes defYAML into definition.yaml
// byte-identical to the input. The run executes that copy, so editing a
// definition can never corrupt a run in flight (spec section 3).
//
// It is safe to call twice for the same run: the directories are created if
// missing and the frozen definition is rewritten as-is.
func CreateRunFolder(baseDir, projectID string, runID RunID, defYAML []byte) (RunFolder, error) {
	if err := checkPathComponent("project id", projectID); err != nil {
		return RunFolder{}, err
	}
	if err := checkPathComponent("run id", string(runID)); err != nil {
		return RunFolder{}, err
	}

	dir := filepath.Join(baseDir, projectID, string(runID))
	for _, sub := range []string{agentOutputsDir, stageLogsDir} {
		if err := os.MkdirAll(filepath.Join(dir, sub), runFolderDirPerm); err != nil {
			return RunFolder{}, fmt.Errorf("create run folder %s: %w", dir, err)
		}
	}

	defPath := filepath.Join(dir, definitionFile)
	if err := os.WriteFile(defPath, defYAML, runFolderFilePerm); err != nil {
		return RunFolder{}, fmt.Errorf("freeze definition %s: %w", defPath, err)
	}
	return RunFolder{Dir: dir}, nil
}

// checkPathComponent keeps a caller-supplied id from escaping the base dir.
// Project and run ids are engine-generated, so this is a guard rail rather
// than a parser: anything with a separator or a dot-segment is rejected
// outright instead of being sanitized into something surprising.
func checkPathComponent(what, value string) error {
	switch {
	case value == "":
		return fmt.Errorf("run folder: %s is empty", what)
	case value == "." || value == "..":
		return fmt.Errorf("run folder: %s %q is a path segment", what, value)
	case strings.ContainsAny(value, `/\`) || strings.ContainsRune(value, os.PathSeparator):
		return fmt.Errorf("run folder: %s %q contains a path separator", what, value)
	}
	return nil
}

// OutputPath is where a stage's declared artifact lives. It is empty when the
// stage declares no `produces`, because then there is no artifact to name.
// Validation guarantees `produces` is a bare filename.
func (f RunFolder) OutputPath(stage *Stage) string {
	if stage == nil || stage.Produces == "" {
		return ""
	}
	return filepath.Join(f.Dir, agentOutputsDir, stage.Produces)
}

// LogPath is where a stage's combined stdout and stderr is streamed. Both
// executors always capture one.
func (f RunFolder) LogPath(stageID string) string {
	return filepath.Join(f.Dir, stageLogsDir, stageID+".log")
}

// ErrOutputNotDeclared means the requested filename is not the `produces` of
// any stage in the run. It is the whole authorization rule for the outputs
// endpoint: the declared set is a closed allowlist, so a filename that is not
// in it never becomes a path at all.
var ErrOutputNotDeclared = errors.New("pipeline run declares no such output")

// DeclaredOutput resolves one declared artifact filename to its path inside the
// run folder, or ErrOutputNotDeclared.
//
// The filename is matched against the run's `produces` set by exact string
// equality and never joined onto the folder as caller input. That is what makes
// traversal ("../../id_rsa"), absolute paths and encoded separators
// unreachable rather than merely filtered: validation guarantees every declared
// `produces` is a bare filename, so anything that matches one is a bare
// filename too.
func (f RunFolder) DeclaredOutput(p *Pipeline, filename string) (string, error) {
	if p == nil || filename == "" {
		return "", ErrOutputNotDeclared
	}
	for i := range p.Stages {
		if p.Stages[i].Produces != filename {
			continue
		}
		// Belt and braces: a definition frozen by an older build, or hand-edited
		// in the run folder, could carry a `produces` the current validator
		// would reject. Re-check rather than trust the frozen copy.
		if checkPathComponent("output filename", filename) != nil {
			return "", ErrOutputNotDeclared
		}
		return filepath.Join(f.Dir, agentOutputsDir, filename), nil
	}
	return "", ErrOutputNotDeclared
}

// ReadLogTail returns the last n lines of a stage's log, or the whole log when
// n <= 0. A missing log is not an error: a stage that has not started yet
// simply has nothing to show, and exists says which it was. truncated reports
// whether lines were dropped off the front.
//
// ponytail: reads the whole file, then keeps the tail. Stage logs are capped by
// the executor, so this is bounded in practice; switch to a seek-from-end
// reader if a stage ever streams gigabytes.
func (f RunFolder) ReadLogTail(stageID string, n int) (content string, exists, truncated bool, err error) {
	raw, err := os.ReadFile(f.LogPath(stageID))
	if errors.Is(err, os.ErrNotExist) {
		return "", false, false, nil
	}
	if err != nil {
		return "", false, false, fmt.Errorf("read stage log %s: %w", stageID, err)
	}
	tail := tailLines(string(raw), n)
	return tail, true, len(tail) < len(raw), nil
}

// tailLines keeps the last n lines of s, preserving its trailing newline.
func tailLines(s string, n int) string {
	if n <= 0 || s == "" {
		return s
	}
	body, trailer := s, ""
	if strings.HasSuffix(body, "\n") {
		body, trailer = body[:len(body)-1], "\n"
	}
	lines := strings.Split(body, "\n")
	if len(lines) <= n {
		return s
	}
	return strings.Join(lines[len(lines)-n:], "\n") + trailer
}

// WriteRunJSON writes a pretty-printed projection of the run state. SQLite
// stays the store of record; this file exists for humans and debugging
// (decision D2), so it is rewritten in full on every persist.
func (f RunFolder) WriteRunJSON(run RunState) error {
	raw, err := json.MarshalIndent(run, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal run.json: %w", err)
	}
	path := filepath.Join(f.Dir, runJSONFile)
	if err := os.WriteFile(path, append(raw, '\n'), runFolderFilePerm); err != nil {
		return fmt.Errorf("write %s: %w", path, err)
	}
	return nil
}

// RunWorkspaceDir is the single worktree shared by every `workspace: run`
// stage, created at first use.
func RunWorkspaceDir(f RunFolder) string { return filepath.Join(f.Dir, "workspace") }

// StageWorkspaceDir is the fresh worktree a `workspace: stage` stage gets each
// time it is entered.
func StageWorkspaceDir(f RunFolder, stageID string) string {
	return filepath.Join(f.Dir, "workspaces", stageID)
}
