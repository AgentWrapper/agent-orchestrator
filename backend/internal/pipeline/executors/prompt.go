package executors

import (
	"fmt"
	"os"
	"strings"

	"github.com/aoagents/agent-orchestrator/backend/internal/pipeline"
)

// buildAgentPrompt puts the v2 preamble in front of the stage's own prompt.
//
// The preamble is pointer-style on purpose (spec section 12.1): it names the
// stage, pastes the current Context.md verbatim, names $AO_OUTPUT when the
// stage declares an artifact, and states the settlement contract. Upstream
// output files are never pasted, so prompt size stays bounded no matter how
// much the run has produced.
func buildAgentPrompt(in StartInput) string {
	folder := pipeline.RunFolder{Dir: in.RunDir}
	attempt := in.Attempt
	if attempt < 1 {
		attempt = 1
	}

	var b strings.Builder
	fmt.Fprintf(&b, "You are running stage `%s` of pipeline run %s (attempt %d of 2 at most).\n\n", in.Stage.ID, in.RunID, attempt)

	contextPath := folder.ContextPath()
	if text := strings.TrimRight(readContextFile(contextPath), "\n"); text != "" {
		fmt.Fprintf(&b, "$AO_CONTEXT (%s) indexes what earlier stages produced. It currently reads:\n\n%s\n\nRead those files off disk if you need the detail.\n\n", contextPath, text)
	} else {
		fmt.Fprintf(&b, "$AO_CONTEXT (%s) indexes what earlier stages produced. It is empty: nothing ran before you.\n\n", contextPath)
	}

	if out := folder.OutputPath(&in.Stage); out != "" {
		fmt.Fprintf(&b, "Write your output to $AO_OUTPUT (%s). The stage only succeeds if that file exists and is not empty.\n\n", out)
	}

	b.WriteString("When you are finished run `ao pipeline done`. " +
		"If the task cannot be completed run `ao pipeline fail --reason \"...\"` instead of stopping. " +
		"Nothing else settles this stage.\n\n---\n\n")
	b.WriteString(in.Stage.Prompt)
	return b.String()
}

// readContextFile returns Context.md's current text, or "" when the run has not
// written one yet. A read failure is not worth failing a stage over: the file
// is an index, and the prompt says so either way.
func readContextFile(path string) string {
	raw, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return string(raw)
}
