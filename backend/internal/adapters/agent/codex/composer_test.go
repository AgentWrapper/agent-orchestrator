package codex

import "testing"

func TestComposerIsEmptyUsesCodexPromptMarker(t *testing.T) {
	if !(&Plugin{}).ComposerIsEmpty("› \x1b[2mExplain this codebase\x1b[0m\n\x1b[2mmodel · workspace\x1b[0m") {
		t.Fatal("dim placeholder should prove an empty Codex composer")
	}
}
