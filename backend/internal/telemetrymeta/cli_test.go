package telemetrymeta

import "testing"

func TestNormalizeCommandPath(t *testing.T) {
	if got := NormalizeCommandPath("  AO   Hooks  claude-code  post-tool-use "); got != "ao hooks claude-code post-tool-use" {
		t.Fatalf("NormalizeCommandPath = %q, want normalized lowercase fields", got)
	}
}

func TestIsRoutineInternalCLICommandNormalizesLegacyShapes(t *testing.T) {
	for _, commandPath := range []string{
		"ao hooks",
		"ao  hooks",
		"AO HOOKS",
		"ao hooks claude-code post-tool-use",
		"ao session get sess-123",
		"ao project ls",
		"ao pty-host session-1",
	} {
		if !IsRoutineInternalCLICommand(commandPath) {
			t.Errorf("IsRoutineInternalCLICommand(%q) = false, want true", commandPath)
		}
	}
}
