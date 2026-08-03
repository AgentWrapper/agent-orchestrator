package codex

import (
	"regexp"
	"strings"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

var codexTerminalEscape = regexp.MustCompile(`\x1b(?:\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]|\][^\x07]*(?:\x07|\x1b\\))`)

// DetectTerminalActivity reports idle only when Codex's composer and footer are visible.
func (p *Plugin) DetectTerminalActivity(output string) (domain.ActivityState, bool) {
	lines := terminalLines(output)
	if len(lines) < 2 {
		return "", false
	}
	start := len(lines) - 12
	if start < 0 {
		start = 0
	}
	for _, line := range lines[start:] {
		if strings.Contains(strings.ToLower(line), "esc to interrupt") {
			return "", false
		}
	}
	for i := len(lines) - 2; i >= start; i-- {
		if !strings.HasPrefix(strings.TrimSpace(lines[i]), "›") {
			continue
		}
		if strings.Contains(lines[i+1], " · ") {
			return domain.ActivityIdle, true
		}
	}
	return "", false
}

func terminalLines(output string) []string {
	plain := codexTerminalEscape.ReplaceAllString(strings.ReplaceAll(output, "\r", "\n"), "")
	raw := strings.Split(plain, "\n")
	lines := raw[:0]
	for _, line := range raw {
		line = strings.TrimSpace(line)
		if line != "" {
			lines = append(lines, line)
		}
	}
	return lines
}
