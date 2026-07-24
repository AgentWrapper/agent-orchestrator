package preview

import (
	"strings"
	"testing"
)

func TestRenderMarkdownProducesHTMLDocument(t *testing.T) {
	out, err := RenderMarkdown([]byte("# Title\n\nHello **world**\n"), "notes.md")
	if err != nil {
		t.Fatalf("RenderMarkdown: %v", err)
	}
	got := string(out)
	for _, want := range []string{"<!doctype html>", "<title>notes.md</title>", "<h1", "Title", "<strong>world</strong>"} {
		if !strings.Contains(got, want) {
			t.Errorf("rendered output missing %q\n%s", want, got)
		}
	}
}

func TestRenderMarkdownGFMTable(t *testing.T) {
	src := "| a | b |\n| - | - |\n| 1 | 2 |\n"
	out, err := RenderMarkdown([]byte(src), "table.md")
	if err != nil {
		t.Fatalf("RenderMarkdown: %v", err)
	}
	if !strings.Contains(string(out), "<table>") {
		t.Errorf("GFM table not rendered:\n%s", out)
	}
}

func TestRenderMarkdownEscapesTitle(t *testing.T) {
	out, err := RenderMarkdown([]byte("hi"), "<x>.md")
	if err != nil {
		t.Fatalf("RenderMarkdown: %v", err)
	}
	if strings.Contains(string(out), "<title><x>.md</title>") {
		t.Errorf("title not escaped:\n%s", out)
	}
	if !strings.Contains(string(out), "&lt;x&gt;.md") {
		t.Errorf("expected escaped title, got:\n%s", out)
	}
}

func TestRenderMarkdownScrollbarStylesUseWebKitOutsideFirefox(t *testing.T) {
	out, err := RenderMarkdown([]byte("hi"), "notes.md")
	if err != nil {
		t.Fatalf("RenderMarkdown: %v", err)
	}
	got := string(out)
	for _, want := range []string{
		"::-webkit-scrollbar { width: 4px; height: 4px; }",
		"::-webkit-scrollbar-button { display: none; width: 0; height: 0; }",
		"@supports (-moz-appearance: none)",
		"* { scrollbar-width: thin; scrollbar-color: rgba(128,128,128,0.45) transparent; }",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("rendered output missing %q\n%s", want, got)
		}
	}

	supportsStart := strings.Index(got, "@supports (-moz-appearance: none)")
	standardProps := strings.Index(got, "* { scrollbar-width: thin;")
	if supportsStart < 0 || standardProps < 0 || standardProps < supportsStart {
		t.Errorf("standard scrollbar properties must stay inside the Firefox-only support block:\n%s", got)
	}
}
