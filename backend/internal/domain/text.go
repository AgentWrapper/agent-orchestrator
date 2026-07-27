package domain

import (
	"fmt"
	"strings"
	"unicode"
	"unicode/utf8"
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

const (
	reviewBodyMaxRunes        = 20000
	reviewBodyMaxTokenRunes   = 512
	reviewBodyMinMixedRunes   = 40
	reviewBodyMaxMixedScripts = 3
)

// ValidateReviewBody rejects reviewer output that is unsafe to post or feed
// back to a worker session. It is intentionally conservative: normal Markdown,
// code snippets, URLs, and a review written in one non-Latin language pass, but
// obvious mojibake/token-salad does not.
func ValidateReviewBody(body string) error {
	if body == "" {
		return nil
	}
	if !utf8.ValidString(body) {
		return errorsNewInvalidReviewBody("body must be valid UTF-8")
	}
	runeCount := 0
	tokenRunes := 0
	letterRunes := 0
	nonLatinLetters := 0
	scripts := map[string]struct{}{}
	for _, r := range body {
		runeCount++
		if runeCount > reviewBodyMaxRunes {
			return errorsNewInvalidReviewBody(fmt.Sprintf("body exceeds %d characters", reviewBodyMaxRunes))
		}
		if unicode.IsControl(r) && r != '\n' && r != '\r' && r != '\t' {
			return errorsNewInvalidReviewBody("body contains unsafe control characters")
		}
		if unicode.IsSpace(r) {
			tokenRunes = 0
		} else {
			tokenRunes++
			if tokenRunes > reviewBodyMaxTokenRunes {
				return errorsNewInvalidReviewBody(fmt.Sprintf("body contains a token longer than %d characters", reviewBodyMaxTokenRunes))
			}
		}
		if !unicode.IsLetter(r) {
			continue
		}
		letterRunes++
		if unicode.In(r, unicode.Latin) {
			continue
		}
		nonLatinLetters++
		scripts[reviewBodyScript(r)] = struct{}{}
	}
	if len(scripts) > reviewBodyMaxMixedScripts && nonLatinLetters >= reviewBodyMinMixedRunes && nonLatinLetters*2 >= letterRunes {
		return errorsNewInvalidReviewBody("body mixes too many writing systems and looks corrupted")
	}
	return nil
}

func errorsNewInvalidReviewBody(reason string) error {
	return fmt.Errorf("invalid review body: %s", reason)
}

func reviewBodyScript(r rune) string {
	switch {
	case unicode.In(r, unicode.Arabic):
		return "Arabic"
	case unicode.In(r, unicode.Armenian):
		return "Armenian"
	case unicode.In(r, unicode.Bengali):
		return "Bengali"
	case unicode.In(r, unicode.Cyrillic):
		return "Cyrillic"
	case unicode.In(r, unicode.Devanagari):
		return "Devanagari"
	case unicode.In(r, unicode.Georgian):
		return "Georgian"
	case unicode.In(r, unicode.Greek):
		return "Greek"
	case unicode.In(r, unicode.Gujarati):
		return "Gujarati"
	case unicode.In(r, unicode.Gurmukhi):
		return "Gurmukhi"
	case unicode.In(r, unicode.Hangul), unicode.In(r, unicode.Hiragana), unicode.In(r, unicode.Katakana), unicode.In(r, unicode.Han):
		return "CJK"
	case unicode.In(r, unicode.Hebrew):
		return "Hebrew"
	case unicode.In(r, unicode.Thai):
		return "Thai"
	default:
		return "Other"
	}
}
