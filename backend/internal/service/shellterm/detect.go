package shellterm

import (
	"path/filepath"
	"strings"
)

// agentFromProcessName maps a pane's foreground process name to an AO harness
// id. This is the primary signal for "which agent is running in this shell":
// unlike scrollback it is exact, and it goes away the moment the CLI exits.
// A plain shell (zsh/bash/…) or anything unrecognized returns "".
func agentFromProcessName(name string) string {
	proc := strings.ToLower(strings.TrimSpace(name))
	// tmux reports a bare command name, but be tolerant of a full path.
	proc = strings.TrimSuffix(filepath.Base(proc), ".exe")
	if proc == "" {
		return ""
	}
	if agent, ok := agentProcessNames[proc]; ok {
		return agent
	}
	return ""
}

// isShellProcessName reports whether the pane is sitting at a plain interactive
// shell. That is the one answer we can act on negatively: it proves no agent is
// running, so the tab must drop any label rather than fall back to a banner
// still sitting in scrollback. Anything else (an interpreter hosting an agent
// CLI, an unknown tool) is inconclusive and leaves the fallback in play.
func isShellProcessName(name string) bool {
	proc := strings.ToLower(strings.TrimSpace(name))
	proc = strings.TrimSuffix(filepath.Base(proc), ".exe")
	proc = strings.TrimPrefix(proc, "-") // login shells appear as "-zsh"
	switch proc {
	case "sh", "bash", "zsh", "fish", "dash", "ksh", "tcsh", "csh", "nu", "xonsh", "pwsh", "powershell", "cmd":
		return true
	}
	return false
}

// Only real agent CLI binaries belong here. Interpreters (node, python, bun)
// are deliberately absent: they host many programs and would mislabel tabs.
var agentProcessNames = map[string]string{
	"kimi":         "kimi",
	"kimi-code":    "kimi",
	"claude":       "claude-code",
	"claude-code":  "claude-code",
	"codex":        "codex",
	"cursor-agent": "cursor",
	"cursor":       "cursor",
	"opencode":     "opencode",
	"kilocode":     "kilocode",
	"aider":        "aider",
	"copilot":      "copilot",
	"goose":        "goose",
	"crush":        "crush",
	"qwen":         "qwen",
	"grok":         "grok",
	"droid":        "droid",
	"amp":          "amp",
	"devin":        "devin",
	"cline":        "cline",
	"auggie":       "auggie",
	"autohand":     "autohand",
	"kiro":         "kiro",
	"vibe":         "vibe",
	"continue":     "continue",
	"agy":          "agy",
	"pi":           "pi",
}

// detectAgentFromOutput is the fallback for runtimes that cannot report a
// foreground process: it looks for an agent's startup banner in recent pane
// output. Only distinctive banner phrases count — a bare binary name would
// match the command the user merely typed, or an old line still in scrollback.
func detectAgentFromOutput(out string) string {
	lower := strings.ToLower(out)
	if lower == "" {
		return ""
	}
	for _, rule := range agentBannerRules {
		if strings.Contains(lower, rule.needle) {
			return rule.agent
		}
	}
	return ""
}

var agentBannerRules = []struct {
	needle string
	agent  string
}{
	{"welcome to kimi", "kimi"},
	{"kimi code", "kimi"},
	{"claude code", "claude-code"},
	{"openai codex", "codex"},
	{"cursor agent", "cursor"},
	{"github copilot", "copilot"},
	{"aider v", "aider"},
	{"opencode ", "opencode"},
}
