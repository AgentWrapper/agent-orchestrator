package cli

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestVersionCommandTextOutput(t *testing.T) {
	cmd := newVersionCommand()
	var out strings.Builder
	cmd.SetOut(&out)
	cmd.SetArgs(nil)
	if err := cmd.Execute(); err != nil {
		t.Fatalf("execute: %v", err)
	}
	got := strings.TrimSpace(out.String())
	if got == "" {
		t.Fatal("version output is empty")
	}
}

func TestVersionCommandJSONOutput(t *testing.T) {
	cmd := newVersionCommand()
	var out strings.Builder
	cmd.SetOut(&out)
	cmd.SetArgs([]string{"--json"})
	if err := cmd.Execute(); err != nil {
		t.Fatalf("execute: %v", err)
	}
	var parsed struct {
		Version  string `json:"version"`
		Revision string `json:"revision"`
		Modified bool   `json:"modified"`
	}
	if err := json.Unmarshal([]byte(out.String()), &parsed); err != nil {
		t.Fatalf("output is not valid JSON: %v\n%s", err, out.String())
	}
	if parsed.Version == "" {
		t.Error("JSON version field is empty")
	}
}

func TestVersionStringNonEmpty(t *testing.T) {
	if strings.TrimSpace(VersionString()) == "" {
		t.Fatal("VersionString() returned empty")
	}
}
