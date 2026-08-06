package claudecode

import "testing"

func TestComposerIsEmptyUsesClaudePromptMarker(t *testing.T) {
	if !(&Plugin{}).ComposerIsEmpty("\x1b[39m❯\u00a0") {
		t.Fatal("blank Claude composer was not recognized")
	}
}
