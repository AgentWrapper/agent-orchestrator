package domain

import (
	"strings"
	"testing"
)

func TestSanitizeControlChars(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want string
	}{
		{name: "plain text unchanged", in: "hello world", want: "hello world"},
		{name: "keeps newline tab carriage return", in: "a\nb\tc\rd", want: "a\nb\tc\rd"},
		{name: "strips ansi escape byte leaving harmless residue", in: "before\x1b[2Jafter", want: "before[2Jafter"},
		{name: "strips nul and bell", in: "x\x00y\az", want: "xyz"},
		{name: "strips osc sequence bytes", in: "\x1b]0;title\a", want: "]0;title"},
		{name: "empty stays empty", in: "", want: ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := SanitizeControlChars(tt.in); got != tt.want {
				t.Fatalf("SanitizeControlChars(%q) = %q, want %q", tt.in, got, tt.want)
			}
		})
	}
}

func TestValidateReviewBody(t *testing.T) {
	tests := []struct {
		name    string
		body    string
		wantErr bool
	}{
		{name: "empty allowed", body: "", wantErr: false},
		{name: "markdown with code and url allowed", body: "Please fix `foo_bar`.\n\n```go\nreturn err\n```\nhttps://github.com/o/r/pull/1", wantErr: false},
		{name: "single non latin language allowed", body: strings.Repeat("请修复这个测试失败的问题。", 8), wantErr: false},
		{name: "japanese script mix allowed", body: strings.Repeat("この漢字とカタカナのレビューを確認してください。", 6), wantErr: false},
		{name: "unsafe control byte rejected", body: "looks ok\x1b[2J", wantErr: true},
		{name: "oversized body rejected", body: strings.Repeat("a", ReviewBodyMaxRunes+1), wantErr: true},
		{name: "oversized token rejected", body: strings.Repeat("a", ReviewBodyMaxTokenRunes+1), wantErr: true},
		{name: "multiscript token salad rejected", body: strings.Repeat("ગુજરાતી русский 中文 հայերեն عربي ", 6), wantErr: true},
		{name: "short multilingual names allowed", body: "Names in docs mention العربية, русский, 中文, հայերեն, and ગુજરાતી once.", wantErr: false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if err := ValidateReviewBody(tt.body); (err != nil) != tt.wantErr {
				t.Fatalf("ValidateReviewBody() err = %v, wantErr = %v", err, tt.wantErr)
			}
		})
	}
}
