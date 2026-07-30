package tmux

import (
	"strings"
	"testing"
)

// display-message resolves an exact session target but reports nothing for a
// pane-scoped format, so the probe returned empty — which callers read as
// "cannot tell" and therefore never acted on. list-panes answers properly.
func TestForegroundCommandArgsUseListPanes(t *testing.T) {
	args := foregroundCommandArgs("review-w1")
	joined := strings.Join(args, " ")
	if args[0] != "list-panes" {
		t.Fatalf("args = %v, want list-panes", args)
	}
	if !strings.Contains(joined, "=review-w1") {
		t.Fatalf("args = %v, want the exact session target", args)
	}
	if !strings.Contains(joined, "#{pane_current_command}") {
		t.Fatalf("args = %v, want the pane command format", args)
	}
	if strings.Contains(joined, "display-message") {
		t.Fatal("display-message returns empty for a pane format under an exact target")
	}
}
