// Package commandguard implements AO Cloud's built-in destructive-command guard.
package commandguard

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

const stateFileName = "command-guard-enabled"

// ErrBlocked is returned when guarded input contains a destructive operation.
var ErrBlocked = errors.New("command guard blocked that command")

var contentRules = []struct {
	name    string
	pattern *regexp.Regexp
}{
	{
		name: "destructive Python filesystem operation",
		pattern: regexp.MustCompile(
			`(?i)\b(?:shutil\.rmtree|os\.(?:remove|unlink|rmdir|removedirs)|pathlib\.[a-z_][a-z0-9_]*\.unlink)\s*\(`,
		),
	},
	{
		name:    "destructive path unlink",
		pattern: regexp.MustCompile(`(?i)(?:\bpath\s*\([^)]*\)|\.[a-z_][a-z0-9_]*)\.unlink\s*\(`),
	},
	{
		name:    "scripted recursive deletion",
		pattern: regexp.MustCompile(`(?i)\b(?:subprocess\.(?:run|call|popen)|os\.system)\s*\([^)\n]{0,500}\brm\b[^)\n]{0,500}(?:-rf|-fr|--recursive)`),
	},
	{
		name:    "destructive JavaScript filesystem operation",
		pattern: regexp.MustCompile(`(?i)\b(?:fs\.)?(?:rm|rmdir|unlink)(?:sync)?\s*\([^)\n]{0,500}(?:recursive\s*:\s*true|force\s*:\s*true|[^)]*)\)`),
	},
	{
		name:    "destructive Ruby filesystem operation",
		pattern: regexp.MustCompile(`(?i)\bfileutils\.(?:rm_rf|rm_r|remove_dir)\s*\(`),
	},
	{
		name:    "dynamic code execution",
		pattern: regexp.MustCompile(`(?i)\b(?:eval|exec)\s*\(`),
	},
	{
		name:    "encoded command execution",
		pattern: regexp.MustCompile(`(?i)\b(?:base64\s+(?:-d|--decode)|openssl\s+(?:enc\s+)?-d\b|xxd\s+-r\b)[^\n]{0,1000}(?:\||>\s*/tmp/)[^\n]{0,500}\b(?:ba|z|k|da)?sh\b`),
	},
}

// Match returns a short description when text contains a built-in blocked operation.
func Match(text string) (string, bool) {
	normalized := normalize(text)
	if normalized == "" {
		return "", false
	}
	for _, rule := range contentRules {
		if rule.pattern.MatchString(normalized) {
			return rule.name, true
		}
	}
	tokens := shellTokens(normalized)
	if dangerousRecursiveRemove(tokens) {
		return "recursive forced deletion", true
	}
	if dangerousGitOperation(tokens) {
		return "destructive Git operation", true
	}
	if dangerousExecutable(tokens) {
		return "destructive system command", true
	}
	if dangerousInlineInterpreter(tokens) {
		return "inline or piped script execution", true
	}
	if dangerousFindDelete(tokens) {
		return "recursive find deletion", true
	}
	return "", false
}

// Check returns ErrBlocked when text matches a built-in blocked operation.
func Check(text string) error {
	rule, blocked := Match(text)
	if !blocked {
		return nil
	}
	return fmt.Errorf("%w: %s", ErrBlocked, rule)
}

// HookInput extracts executable or generated-code content from supported agent hook payloads.
func HookInput(harness, event string, raw []byte) string {
	var payload struct {
		Command   string `json:"command"`
		Cwd       string `json:"cwd"`
		ToolName  string `json:"tool_name"`
		ToolInput struct {
			Command   string `json:"command"`
			Content   string `json:"content"`
			NewString string `json:"new_string"`
			Patch     string `json:"patch"`
		} `json:"tool_input"`
	}
	if json.Unmarshal(raw, &payload) != nil {
		return ""
	}
	switch strings.ToLower(strings.TrimSpace(harness)) {
	case "claude-code", "claude":
		if event != "pre-tool-use" {
			return ""
		}
		switch strings.ToLower(strings.TrimSpace(payload.ToolName)) {
		case "bash", "shell":
			return commandAndReferencedScript(payload.ToolInput.Command, payload.Cwd)
		case "write", "edit", "multiedit", "apply_patch":
			return strings.Join(
				[]string{payload.ToolInput.Content, payload.ToolInput.NewString, payload.ToolInput.Patch},
				"\n",
			)
		}
	case "cursor":
		if event == "permission-request" {
			if payload.Command != "" {
				return commandAndReferencedScript(payload.Command, payload.Cwd)
			}
			return commandAndReferencedScript(payload.ToolInput.Command, payload.Cwd)
		}
	case "codex":
		if event == "pre-tool-use" || event == "permission-request" {
			if strings.EqualFold(payload.ToolName, "apply_patch") {
				return payload.ToolInput.Patch
			}
			if payload.Command != "" {
				return commandAndReferencedScript(payload.Command, payload.Cwd)
			}
			return commandAndReferencedScript(payload.ToolInput.Command, payload.Cwd)
		}
	}
	return ""
}

func commandAndReferencedScript(command, cwd string) string {
	script := referencedScript(command, cwd)
	if script == "" {
		return command
	}
	return command + "\n" + script
}

func referencedScript(command, cwd string) string {
	fields := strings.Fields(strings.NewReplacer(`"`, "", "'", "").Replace(command))
	if len(fields) == 0 {
		return ""
	}
	index := 0
	for index < len(fields) {
		switch tokenCommand(strings.ToLower(fields[index])) {
		case "sudo", "command", "env", "nohup", "time":
			index++
		default:
			goto interpreter
		}
	}
interpreter:
	if index >= len(fields) {
		return ""
	}
	executable := tokenCommand(strings.ToLower(fields[index]))
	interpreted := false
	switch executable {
	case "python", "python2", "python3", "perl", "ruby", "node", "php",
		"sh", "bash", "zsh", "ksh", "dash":
		interpreted = true
		index++
	}
	var candidate string
	if interpreted {
		for index < len(fields) {
			if !strings.HasPrefix(fields[index], "-") {
				candidate = fields[index]
				break
			}
			index++
		}
	} else if strings.HasPrefix(fields[index], "./") {
		candidate = fields[index]
	}
	if candidate == "" || strings.ContainsAny(candidate, "$*?{}[]") {
		return ""
	}
	path := candidate
	if !filepath.IsAbs(path) {
		if strings.TrimSpace(cwd) == "" {
			return ""
		}
		path = filepath.Join(cwd, path)
	}
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() || info.Size() > 1<<20 {
		return ""
	}
	contents, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return string(contents)
}

// SetEnabled atomically updates the guard state consumed by agent hooks.
func SetEnabled(dataDir string, enabled bool) error {
	path, err := statePath(dataDir)
	if err != nil {
		return err
	}
	if !enabled {
		if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("disable command guard: %w", err)
		}
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return fmt.Errorf("create command guard directory: %w", err)
	}
	temporary, err := os.CreateTemp(filepath.Dir(path), ".command-guard-*")
	if err != nil {
		return fmt.Errorf("create command guard state: %w", err)
	}
	temporaryPath := temporary.Name()
	defer func() { _ = os.Remove(temporaryPath) }()
	if err := temporary.Chmod(0o600); err != nil {
		_ = temporary.Close()
		return fmt.Errorf("secure command guard state: %w", err)
	}
	if _, err := temporary.WriteString("enabled\n"); err != nil {
		_ = temporary.Close()
		return fmt.Errorf("write command guard state: %w", err)
	}
	if err := temporary.Close(); err != nil {
		return fmt.Errorf("close command guard state: %w", err)
	}
	if err := os.Rename(temporaryPath, path); err != nil {
		return fmt.Errorf("replace command guard state: %w", err)
	}
	return nil
}

// Enabled reports whether autonomous command execution is currently guarded.
func Enabled(dataDir string) bool {
	path, err := statePath(dataDir)
	if err != nil {
		return false
	}
	_, err = os.Stat(path)
	return err == nil
}

func statePath(dataDir string) (string, error) {
	dataDir = strings.TrimSpace(dataDir)
	if dataDir == "" {
		return "", errors.New("AO_DATA_DIR is required for command guard")
	}
	return filepath.Join(dataDir, stateFileName), nil
}

func normalize(text string) string {
	text = strings.ReplaceAll(text, "\\\r\n", "")
	text = strings.ReplaceAll(text, "\\\n", "")
	text = strings.NewReplacer("'", "", `"`, "", "`", "", "\\", "").Replace(text)
	return strings.ToLower(strings.TrimSpace(text))
}

func shellTokens(text string) []string {
	replacer := strings.NewReplacer(
		"&&", " | ", "||", " | ", ";", " | ", "|", " | ",
		"\n", " | ", "\r", " | ", "(", " | ", ")", " | ",
		"$", " ", "{", " ", "}", " ",
	)
	return strings.Fields(replacer.Replace(text))
}

func tokenCommand(token string) string {
	token = strings.Trim(token, " \t,.:[]<>")
	return filepath.Base(token)
}

func commandPosition(tokens []string, index int) bool {
	if index == 0 || tokens[index-1] == "|" {
		return true
	}
	for cursor := index - 1; cursor >= 0 && tokens[cursor] != "|"; cursor-- {
		token := tokenCommand(tokens[cursor])
		switch token {
		case "sudo", "command", "builtin", "env", "nohup", "time", "xargs", "-exec", "-execdir":
			return true
		}
	}
	return false
}

func commandWindow(tokens []string, index, limit int) []string {
	end := index + limit
	if end > len(tokens) {
		end = len(tokens)
	}
	for cursor := index; cursor < end; cursor++ {
		if tokens[cursor] == "|" {
			return tokens[index:cursor]
		}
	}
	return tokens[index:end]
}

func dangerousRecursiveRemove(tokens []string) bool {
	for index, token := range tokens {
		if tokenCommand(token) != "rm" || !commandPosition(tokens, index) {
			continue
		}
		recursive, force := false, false
		for _, argument := range commandWindow(tokens, index+1, 12) {
			if argument == "--recursive" {
				recursive = true
			}
			if argument == "--force" {
				force = true
			}
			if strings.HasPrefix(argument, "-") && !strings.HasPrefix(argument, "--") {
				flags := strings.TrimLeft(argument, "-")
				recursive = recursive || strings.Contains(flags, "r")
				force = force || strings.Contains(flags, "f")
			}
		}
		if recursive && force {
			return true
		}
	}
	return false
}

func dangerousGitOperation(tokens []string) bool {
	for index, token := range tokens {
		if tokenCommand(token) != "git" || !commandPosition(tokens, index) {
			continue
		}
		window := commandWindow(tokens, index+1, 24)
		for commandIndex, argument := range window {
			switch argument {
			case "reset":
				for _, option := range window[commandIndex+1:] {
					if option == "--hard" {
						return true
					}
				}
			case "push":
				for _, option := range window[commandIndex+1:] {
					if option == "-f" || strings.HasPrefix(option, "--force") {
						return true
					}
				}
			case "clean":
				for _, option := range window[commandIndex+1:] {
					if strings.HasPrefix(option, "-") &&
						strings.Contains(option, "f") &&
						(strings.Contains(option, "d") || strings.Contains(option, "x")) {
						return true
					}
				}
			}
		}
	}
	return false
}

func dangerousExecutable(tokens []string) bool {
	for index, token := range tokens {
		if !commandPosition(tokens, index) {
			continue
		}
		command := tokenCommand(token)
		switch command {
		case "dd", "wipefs", "fdisk", "sfdisk", "cfdisk", "parted", "shred",
			"chmod", "chown", "chgrp", "chattr", "reboot", "shutdown", "poweroff", "halt":
			return true
		}
		if command == "mkfs" || strings.HasPrefix(command, "mkfs.") {
			return true
		}
	}
	return false
}

func dangerousInlineInterpreter(tokens []string) bool {
	for index, token := range tokens {
		if !commandPosition(tokens, index) {
			continue
		}
		command := tokenCommand(token)
		window := commandWindow(tokens, index+1, 8)
		switch command {
		case "eval", "exec":
			return true
		case "sh", "bash", "zsh", "ksh", "dash":
			for _, option := range window {
				if strings.HasPrefix(option, "-") && strings.Contains(option, "c") {
					return true
				}
			}
			if index > 0 && tokens[index-1] == "|" {
				return true
			}
		case "python", "python2", "python3", "perl", "ruby", "node", "php":
			for _, option := range window {
				if option == "-c" || option == "-e" || option == "--eval" {
					return true
				}
			}
			if index > 0 && tokens[index-1] == "|" {
				return true
			}
		}
	}
	return false
}

func dangerousFindDelete(tokens []string) bool {
	for index, token := range tokens {
		if tokenCommand(token) != "find" || !commandPosition(tokens, index) {
			continue
		}
		for _, argument := range commandWindow(tokens, index+1, 32) {
			if argument == "-delete" {
				return true
			}
		}
	}
	return false
}
