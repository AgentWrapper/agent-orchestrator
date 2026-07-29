package daytona

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"unicode/utf8"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// The adapter drives tmux INSIDE the sandbox through the toolbox exec API, so
// every command is a single shell string. These builders mirror
// adapters/runtime/tmux/commands.go semantics (exact-match targets, -l literal
// send-keys, capture-pane history window) with shell quoting applied here
// because exec takes a command line, not argv.

var sessionIDPattern = regexp.MustCompile(`^[a-zA-Z0-9_-]+$`)

// shellQuote single-quotes s for POSIX sh.
func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", "'\\''") + "'"
}

func shellJoin(argv []string) string {
	parts := make([]string, len(argv))
	for i, a := range argv {
		parts[i] = shellQuote(a)
	}
	return strings.Join(parts, " ")
}

// sessionName maps an AO session id onto a tmux session name, using the same
// sanitisation as the tmux adapter so ids stay consistent across runtimes.
func sessionName(id domain.SessionID) (string, error) {
	raw := string(id)
	if raw == "" {
		return "", fmt.Errorf("daytona runtime: session id is required")
	}
	if sessionIDPattern.MatchString(raw) && len(raw) <= 48 {
		return raw, nil
	}
	return sanitizedSessionName(raw), nil
}

func sanitizedSessionName(raw string) string {
	var b strings.Builder
	lastDash := false
	for _, r := range raw {
		valid := (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '_' || r == '-'
		if valid {
			b.WriteRune(r)
			lastDash = false
			continue
		}
		if !lastDash {
			b.WriteByte('-')
			lastDash = true
		}
	}
	base := strings.Trim(b.String(), "-")
	if base == "" {
		base = "session"
	}
	if len(base) > 32 {
		base = strings.TrimRight(base[:32], "-")
	}
	sum := sha256.Sum256([]byte(raw))
	return base + "-" + hex.EncodeToString(sum[:4])
}

func handleID(handle ports.RuntimeHandle) (string, error) {
	id := handle.ID
	if id == "" {
		return "", fmt.Errorf("daytona runtime: session id is required")
	}
	if !sessionIDPattern.MatchString(id) {
		return "", fmt.Errorf("daytona runtime: invalid handle id %q", id)
	}
	return id, nil
}

// exactTarget wraps id in tmux's exact-match prefix so session-selection
// commands never prefix-match a sibling session.
func exactTarget(id string) string {
	return "=" + id
}

func newSessionCommand(id, cwd, launchCmd string) string {
	return "tmux new-session -d -s " + shellQuote(id) +
		" -x 220 -y 50 -c " + shellQuote(cwd) +
		" sh -c " + shellQuote(launchCmd) +
		" && tmux set-option -t " + shellQuote(id) + " status off" +
		" && tmux set-option -t " + shellQuote(id) + " mouse on" +
		" && tmux set-option -t " + shellQuote(id) + " window-size largest"
}

func respawnPaneCommand(id, cwd, launchCmd string) string {
	return "tmux respawn-pane -k -t " + shellQuote(id+":0.0") +
		" -c " + shellQuote(cwd) +
		" sh -c " + shellQuote(launchCmd)
}

func hasSessionCommand(id string) string {
	return "tmux has-session -t " + shellQuote(exactTarget(id))
}

func killSessionCommand(id string) string {
	return "tmux kill-session -t " + shellQuote(exactTarget(id))
}

func sendKeysLiteralCommand(id, chunk string) string {
	return "tmux send-keys -t " + shellQuote(id) + " -l " + shellQuote(chunk)
}

func sendEnterCommand(id string) string {
	return "tmux send-keys -t " + shellQuote(id) + " Enter"
}

func sendInterruptCommand(id string) string {
	return "tmux send-keys -t " + shellQuote(id) + " C-c"
}

func capturePaneCommand(id string, lines int) string {
	return fmt.Sprintf("tmux capture-pane -t %s -p -S -%d", shellQuote(id), lines)
}

func panePIDCommand(id string) string {
	return "tmux display-message -p -t " + shellQuote(id+":0.0") + " '#{pane_pid}'"
}

func processTableCommand() string {
	return "ps -ww -axo pid=,ppid=,args="
}

// attachCommand is written as the first input line of a fresh PTY (Daytona's
// PTY create takes no command): exec replaces the shell so detach ends the
// PTY, -u forces UTF-8 (the toolbox PTY env has no locale; see tmux adapter
// issue #2484), and -T RGB advertises truecolor to match AO's xterm renderer.
func attachCommand(id string) string {
	return "exec tmux -u -T RGB attach-session -t " + shellQuote(exactTarget(id)) + "\n"
}

// buildLaunchCommand builds the sh -c command string that runs inside the
// sandbox's tmux pane. It mirrors the tmux adapter's launch line — cd guard,
// NO_COLOR unset, sorted env exports with PATH last, argv, then a keep-alive
// interactive shell — with one deliberate difference: when the caller supplies
// no PATH, none is exported (the daemon host's PATH is meaningless inside the
// sandbox, so the snapshot's own PATH must win).
func buildLaunchCommand(cfg ports.RuntimeConfig) string {
	var b strings.Builder
	b.WriteString("cd ")
	b.WriteString(shellQuote(cfg.WorkspacePath))
	b.WriteString(" || exit; ")
	if _, configured := cfg.Env["NO_COLOR"]; !configured {
		b.WriteString("unset NO_COLOR; ")
	}
	for _, key := range sortedKeys(cfg.Env) {
		if key == "PATH" || key == "COLORTERM" {
			continue
		}
		b.WriteString("export ")
		b.WriteString(key)
		b.WriteString("=")
		b.WriteString(shellQuote(cfg.Env[key]))
		b.WriteString("; ")
	}
	b.WriteString("export COLORTERM='truecolor'; ")
	if path := cfg.Env["PATH"]; path != "" {
		b.WriteString("export PATH=")
		b.WriteString(shellQuote(path))
		b.WriteString("; ")
	}
	b.WriteString(shellJoin(cfg.Argv))
	b.WriteString(`; exec "${SHELL:-/bin/sh}" -i`)
	return b.String()
}

func validateEnvKeys(env map[string]string) error {
	for key := range env {
		if !validEnvKey(key) {
			return fmt.Errorf("daytona runtime: invalid env key %q", key)
		}
	}
	return nil
}

func validEnvKey(key string) bool {
	if key == "" {
		return false
	}
	for i, r := range key {
		if r == '_' || (r >= 'A' && r <= 'Z') || (r >= 'a' && r <= 'z') {
			continue
		}
		if i > 0 && r >= '0' && r <= '9' {
			continue
		}
		return false
	}
	return true
}

func sortedKeys(m map[string]string) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// sessionMissingOutput reports whether a failed tmux command's output is
// definitively "session does not exist" rather than a transient failure.
func sessionMissingOutput(out string) bool {
	s := strings.ToLower(out)
	return strings.Contains(s, "can't find session") ||
		strings.Contains(s, "no server running") ||
		strings.Contains(s, "error connecting") ||
		strings.Contains(s, "session not found")
}

// -- text helpers (identical contracts to the tmux adapter) --

func chunks(s string, maxBytes int) []string {
	if s == "" {
		return []string{""}
	}
	if maxBytes <= 0 || len(s) <= maxBytes {
		return []string{s}
	}
	parts := []string{}
	for s != "" {
		if len(s) <= maxBytes {
			parts = append(parts, s)
			break
		}
		end := maxBytes
		for end > 0 && !utf8.ValidString(s[:end]) {
			end--
		}
		if end == 0 {
			_, size := utf8.DecodeRuneInString(s)
			end = size
		}
		parts = append(parts, s[:end])
		s = s[end:]
	}
	return parts
}

func tailLines(s string, n int) string {
	if n <= 0 || s == "" {
		return ""
	}
	lines := strings.SplitAfter(s, "\n")
	if lines[len(lines)-1] == "" {
		lines = lines[:len(lines)-1]
	}
	if len(lines) <= n {
		return s
	}
	return strings.Join(lines[len(lines)-n:], "")
}

func trimTrailingBlankLines(s string) string {
	if s == "" {
		return ""
	}
	lines := strings.SplitAfter(s, "\n")
	if lines[len(lines)-1] == "" {
		lines = lines[:len(lines)-1]
	}
	for len(lines) > 0 && strings.TrimRight(lines[len(lines)-1], "\r\n") == "" {
		lines = lines[:len(lines)-1]
	}
	return strings.Join(lines, "")
}
