package telemetrymeta

import "strings"

// NormalizeCommandPath canonicalizes command paths received from current CLIs
// and best-effort legacy loopback callers before cost-control classification.
func NormalizeCommandPath(commandPath string) string {
	return strings.ToLower(strings.Join(strings.Fields(commandPath), " "))
}

// IsRoutineInternalCLICommand reports whether a successful CLI invocation is
// routine desktop/agent plumbing rather than product usage.
func IsRoutineInternalCLICommand(commandPath string) bool {
	normalized := NormalizeCommandPath(commandPath)
	for _, routine := range routineInternalCLICommands {
		if normalized == routine || strings.HasPrefix(normalized, routine+" ") {
			return true
		}
	}
	return false
}

var routineInternalCLICommands = []string{
	"ao status",
	"ao session ls",
	"ao session get",
	"ao project ls",
	"ao project get",
	"ao orchestrator ls",
	"ao hooks",
	"ao pty-host",
}
