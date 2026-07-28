package domain

import (
	"strings"
	"unicode"
)

// SanitizeControlChars removes control characters that are unsafe to deliver
// into a live terminal pane, while preserving the whitespace that legitimate
// multi-line text relies on (newline, carriage return, tab).
//
// Any text that reaches an agent's PTY must pass through here. The session
// runtime pastes messages straight into the live pane, so an unfiltered escape
// sequence (cursor control, screen clear, OSC) embedded in attacker-influenced
// content — a GitHub reviewer comment, a CI job log tail — would be interpreted
// by the terminal instead of read as plain text. Both the HTTP send endpoint
// and the lifecycle nudge path share this one definition so neither can drift
// into delivering raw control bytes.
func SanitizeControlChars(s string) string {
	return strings.Map(func(r rune) rune {
		if unicode.IsControl(r) && r != '\n' && r != '\r' && r != '\t' {
			return -1
		}
		return r
	}, s)
}
