package authprobe

import (
	"context"
	"os/exec"
	"strings"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// DefaultCommands are cheap local auth/status probes common across agent CLIs.
// Unsupported commands usually exit quickly with help text and are treated as
// unknown rather than unauthorized.
var DefaultCommands = [][]string{
	{"auth", "status"},
	{"login", "status"},
	{"providers", "list"},
}

// CmdRunner runs the command and returns the combined stdout/stderr.
// It is exposed as a package variable to allow mocking in tests.
var CmdRunner = func(ctx context.Context, name string, arg ...string) ([]byte, error) {
	return exec.CommandContext(ctx, name, arg...).CombinedOutput()
}

// CLIStatus runs bounded local CLI probes and classifies their output.
func CLIStatus(ctx context.Context, binary string, commands [][]string) (ports.AgentAuthStatus, error) {
	if err := ctx.Err(); err != nil {
		return ports.AgentAuthStatusUnknown, err
	}
	if binary == "" {
		return ports.AgentAuthStatusUnknown, nil
	}
	if len(commands) == 0 {
		commands = DefaultCommands
	}
	for _, args := range commands {
		status, err := commandStatus(ctx, binary, args)
		if err != nil {
			return ports.AgentAuthStatusUnknown, err
		}
		if status != ports.AgentAuthStatusUnknown {
			return status, nil
		}
	}
	return ports.AgentAuthStatusUnknown, nil
}

func commandStatus(ctx context.Context, binary string, args []string) (ports.AgentAuthStatus, error) {
	probeCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()

	out, err := CmdRunner(probeCtx, binary, args...)
	if probeCtx.Err() != nil {
		return ports.AgentAuthStatusUnknown, probeCtx.Err()
	}
	status := StatusFromText(string(out))
	if status != ports.AgentAuthStatusUnknown {
		return status, nil
	}
	if err != nil {
		return ports.AgentAuthStatusUnknown, nil
	}
	return ports.AgentAuthStatusUnknown, nil
}

// StatusFromText classifies common CLI auth/status output.
func StatusFromText(out string) ports.AgentAuthStatus {
	text := strings.ToLower(out)
	compactText := compact(text)
	if hasAny(text,
		"not logged in",
		"not currently logged in",
		"logged out",
		"not authenticated",
		"unauthenticated",
		"authentication required",
		"not authorized",
		"unauthorized",
		"login required",
		"no credentials",
		"0 credentials",
		"no api key",
		"no token",
		`"loggedin": false`,
		`"loggedin":false`,
	) || hasAny(compactText,
		`"authenticated":false`,
		`'authenticated':false`,
		"authenticated:false",
		"authenticated=false",
		`"authorized":false`,
		`'authorized':false`,
		"authorized:false",
		"authorized=false",
		`"logged_in":false`,
		`'logged_in':false`,
		"logged_in:false",
		"logged_in=false",
		`"loggedin":false`,
		`'loggedin':false`,
		"loggedin:false",
		"loggedin=false",
	) {
		return ports.AgentAuthStatusUnauthorized
	}
	if hasAny(text,
		"logged in",
		"authenticated",
		"authorized",
		"token valid",
		"api key found",
		"credentials found",
		`"loggedin": true`,
		`"loggedin":true`,
	) {
		return ports.AgentAuthStatusAuthorized
	}
	return ports.AgentAuthStatusUnknown
}

func compact(text string) string {
	return strings.NewReplacer(" ", "", "\t", "", "\n", "", "\r", "").Replace(text)
}

func hasAny(text string, needles ...string) bool {
	for _, needle := range needles {
		if strings.Contains(text, needle) {
			return true
		}
	}
	return false
}
