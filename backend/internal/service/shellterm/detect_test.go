package shellterm

import "testing"

func TestAgentFromProcessName(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name string
		proc string
		want string
	}{
		{name: "empty", proc: "", want: ""},
		{name: "plain shell", proc: "zsh", want: ""},
		{name: "kimi", proc: "kimi", want: "kimi"},
		{name: "codex uppercase", proc: "Codex", want: "codex"},
		{name: "claude maps to claude-code", proc: "claude", want: "claude-code"},
		{name: "full path", proc: "/opt/homebrew/bin/kimi", want: "kimi"},
		// Interpreters host arbitrary programs; labelling them would be wrong.
		{name: "node is not an agent", proc: "node", want: ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			if got := agentFromProcessName(tc.proc); got != tc.want {
				t.Fatalf("agentFromProcessName(%q) = %q, want %q", tc.proc, got, tc.want)
			}
		})
	}
}

func TestIsShellProcessName(t *testing.T) {
	t.Parallel()
	for _, proc := range []string{"zsh", "-zsh", "bash", "Fish", "/bin/sh"} {
		if !isShellProcessName(proc) {
			t.Fatalf("isShellProcessName(%q) = false, want true", proc)
		}
	}
	// node may be hosting an agent CLI, so it must stay inconclusive.
	for _, proc := range []string{"", "node", "kimi", "vim"} {
		if isShellProcessName(proc) {
			t.Fatalf("isShellProcessName(%q) = true, want false", proc)
		}
	}
}

func TestDetectAgentFromOutput(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name string
		out  string
		want string
	}{
		{name: "empty", out: "", want: ""},
		{name: "plain shell", out: "➜ agent-orchestrator git:(main)", want: ""},
		{name: "kimi banner", out: "Welcome to Kimi Code!\nDirectory: /tmp", want: "kimi"},
		{name: "codex banner", out: ">_ OpenAI Codex (v0.142.5)", want: "codex"},
		// A typed-but-not-run command must not label the tab.
		{name: "typed command only", out: "➜ agent-orchestrator git:(main) ✗ codex", want: ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			if got := detectAgentFromOutput(tc.out); got != tc.want {
				t.Fatalf("detectAgentFromOutput(%q) = %q, want %q", tc.out, got, tc.want)
			}
		})
	}
}
