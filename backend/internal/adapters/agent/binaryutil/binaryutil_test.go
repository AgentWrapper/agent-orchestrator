package binaryutil

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func TestResolveBinaryPrefersPath(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("PATH lookup shape differs on windows")
	}
	dir := t.TempDir()
	bin := filepath.Join(dir, "widget")
	if err := os.WriteFile(bin, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir)

	got, err := ResolveBinary(context.Background(), BinarySpec{Label: "widget", Names: []string{"widget"}})
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if got != bin {
		t.Fatalf("got %q, want %q", got, bin)
	}
}

func TestResolveBinaryFallsBackToHomeCandidate(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("unix home candidate shape")
	}
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("PATH", t.TempDir()) // empty of the binary
	bin := filepath.Join(home, ".local", "bin", "widget")
	if err := os.MkdirAll(filepath.Dir(bin), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(bin, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}

	got, err := ResolveBinary(context.Background(), BinarySpec{
		Label:         "widget",
		Names:         []string{"widget"},
		UnixHomePaths: [][]string{{".local", "bin", "widget"}},
	})
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if got != bin {
		t.Fatalf("got %q, want %q", got, bin)
	}
}

func TestResolveBinaryNotFound(t *testing.T) {
	t.Setenv("PATH", t.TempDir())
	_, err := ResolveBinary(context.Background(), BinarySpec{
		Label:    "widget",
		Names:    []string{"widget-does-not-exist"},
		WinNames: []string{"widget-does-not-exist.exe"},
	})
	if !errors.Is(err, ports.ErrAgentBinaryNotFound) {
		t.Fatalf("want ErrAgentBinaryNotFound, got %v", err)
	}
}

func TestResolveBinaryHonorsCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := ResolveBinary(ctx, BinarySpec{Label: "widget", Names: []string{"widget"}})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("want context.Canceled, got %v", err)
	}
}
