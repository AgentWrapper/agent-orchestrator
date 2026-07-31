package pipeline

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// ContextPath is the engine-written index pasted verbatim into the next
// agent's prompt as $AO_CONTEXT (spec section 12.1).
func (f RunFolder) ContextPath() string { return filepath.Join(f.Dir, contextFile) }

// AppendContext adds one pointer line to Context.md, creating the file if it
// is missing. Context.md holds pointers, never content: agent output files are
// read off disk by whoever wants the detail, which keeps prompt size bounded
// regardless of output size.
//
//	stage `review` finished, its output is at agent-outputs/review.md
func (f RunFolder) AppendContext(line string) error {
	path := f.ContextPath()
	file, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, runFolderFilePerm)
	if err != nil {
		return fmt.Errorf("open %s: %w", path, err)
	}
	if !strings.HasSuffix(line, "\n") {
		line += "\n"
	}
	if _, err := file.WriteString(line); err != nil {
		_ = file.Close()
		return fmt.Errorf("append to %s: %w", path, err)
	}
	if err := file.Close(); err != nil {
		return fmt.Errorf("close %s: %w", path, err)
	}
	return nil
}

// VerifyArtifact reports whether the stage honoured its `produces` contract.
// A stage that declares no artifact has nothing to verify and always passes;
// otherwise the declared file must exist and be non-empty. This is what
// separates `succeeded` from `no_output`, and it gates the Context.md line.
func (f RunFolder) VerifyArtifact(stage *Stage) bool {
	path := f.OutputPath(stage)
	if path == "" {
		return true
	}
	info, err := os.Stat(path)
	if err != nil {
		return false
	}
	return info.Mode().IsRegular() && info.Size() > 0
}
