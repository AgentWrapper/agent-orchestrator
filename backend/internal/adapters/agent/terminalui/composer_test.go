package terminalui

import "testing"

func TestLastPromptIsEmptyOrDimPlaceholder(t *testing.T) {
	tests := []struct {
		name   string
		output string
		marker string
		want   bool
	}{
		{name: "blank claude", output: "status\n\x1b[39m❯\u00a0", marker: "❯", want: true},
		{name: "dim claude placeholder", output: "\x1b[39m❯\u00a0\x1b[2mclean up this code\x1b[0m", marker: "❯", want: true},
		{name: "typed claude draft", output: "\x1b[39m❯\u00a0do not submit this", marker: "❯", want: false},
		{name: "claude permission option", output: "permission\n❯ 1. Yes\n  2. No", marker: "❯", want: false},
		{name: "dim codex placeholder", output: "› \x1b[2mExplain this codebase\x1b[0m\n\n\x1b[2mmodel · workspace\x1b[0m", marker: "›", want: true},
		{name: "plain codex placeholder fails closed", output: "› Explain this codebase\nmodel · workspace", marker: "›", want: false},
		{name: "wrapped human draft fails closed", output: "❯\nhuman draft\nfooter", marker: "❯", want: false},
		{name: "leading blank rows in human draft fail closed", output: "❯\n\nhuman draft", marker: "❯", want: false},
		{name: "historical prompt is outside lookback", output: "❯\n1\n2\n3\n4\n5\n6\n7\n8\n9", marker: "❯", want: false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := LastPromptIsEmptyOrDimPlaceholder(tt.output, tt.marker); got != tt.want {
				t.Fatalf("LastPromptIsEmptyOrDimPlaceholder() = %v, want %v", got, tt.want)
			}
		})
	}
}
