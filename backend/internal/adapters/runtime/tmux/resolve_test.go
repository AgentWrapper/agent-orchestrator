package tmux

import (
	"errors"
	"io/fs"
	"strings"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// -- fakes --

type fakeFileInfo struct {
	mode fs.FileMode
}

func (f fakeFileInfo) Name() string       { return "tmux" }
func (f fakeFileInfo) Size() int64        { return 1 }
func (f fakeFileInfo) Mode() fs.FileMode  { return f.mode }
func (f fakeFileInfo) ModTime() time.Time { return time.Time{} }
func (f fakeFileInfo) IsDir() bool        { return f.mode.IsDir() }
func (f fakeFileInfo) Sys() any           { return nil }

// fakeStat maps paths to file modes; missing paths error like os.Stat.
func fakeStat(files map[string]fs.FileMode) func(string) (fs.FileInfo, error) {
	return func(path string) (fs.FileInfo, error) {
		mode, ok := files[path]
		if !ok {
			return nil, fs.ErrNotExist
		}
		return fakeFileInfo{mode: mode}, nil
	}
}

// fakeLookPath maps names to paths; missing names error like exec.LookPath.
func fakeLookPath(paths map[string]string) func(string) (string, error) {
	return func(name string) (string, error) {
		if path, ok := paths[name]; ok {
			return path, nil
		}
		return "", errors.New("executable file not found in $PATH")
	}
}

// -- ResolveBinary tests --

func TestResolveBinary(t *testing.T) {
	systemTmux := map[string]string{"tmux": "/usr/bin/tmux"}
	noTmux := map[string]string{}

	tests := []struct {
		name       string
		override   string
		bundled    string
		lookPath   map[string]string
		files      map[string]fs.FileMode
		wantPath   string
		wantSource Source
		wantErr    string // substring; empty means success expected
	}{
		{
			name:       "override wins even when system tmux exists",
			override:   "/opt/custom/tmux",
			lookPath:   systemTmux,
			files:      map[string]fs.FileMode{"/opt/custom/tmux": 0o755},
			wantPath:   "/opt/custom/tmux",
			wantSource: SourceOverride,
		},
		{
			name:     "broken override fails loudly instead of falling through",
			override:  "/opt/custom/tmux",
			lookPath: systemTmux,
			files:    map[string]fs.FileMode{},
			wantErr:  "AO_TMUX_BIN",
		},
		{
			name:     "non-executable override rejected",
			override:  "/opt/custom/tmux",
			lookPath: systemTmux,
			files:    map[string]fs.FileMode{"/opt/custom/tmux": 0o644},
			wantErr:  "AO_TMUX_BIN",
		},
		{
			name:       "system tmux wins over bundled",
			bundled:    "/app/resources/tmux-dist/tmux",
			lookPath:   systemTmux,
			files:      map[string]fs.FileMode{"/app/resources/tmux-dist/tmux": 0o755},
			wantPath:   "/usr/bin/tmux",
			wantSource: SourceSystem,
		},
		{
			name:       "bundled accepted when system tmux absent",
			bundled:    "/app/resources/tmux-dist/tmux",
			lookPath:   noTmux,
			files:      map[string]fs.FileMode{"/app/resources/tmux-dist/tmux": 0o755},
			wantPath:   "/app/resources/tmux-dist/tmux",
			wantSource: SourceBundled,
		},
		{
			name:     "non-executable bundled rejected",
			bundled:  "/app/resources/tmux-dist/tmux",
			lookPath: noTmux,
			files:    map[string]fs.FileMode{"/app/resources/tmux-dist/tmux": 0o644},
			wantErr:  "not executable",
		},
		{
			name:     "missing bundled file rejected",
			bundled:  "/app/resources/tmux-dist/tmux",
			lookPath: noTmux,
			files:    map[string]fs.FileMode{},
			wantErr:  "not executable",
		},
		{
			name:     "directory bundled path rejected",
			bundled:  "/app/resources/tmux-dist/tmux",
			lookPath: noTmux,
			files:    map[string]fs.FileMode{"/app/resources/tmux-dist/tmux": fs.ModeDir | 0o755},
			wantErr:  "not executable",
		},
		{
			name:     "neither system nor bundled",
			lookPath: noTmux,
			wantErr:  "no bundled tmux available",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			path, source, err := ResolveBinary(tt.override, tt.bundled, fakeLookPath(tt.lookPath), fakeStat(tt.files))
			if tt.wantErr != "" {
				if err == nil {
					t.Fatalf("ResolveBinary = (%q, %q, nil), want error containing %q", path, source, tt.wantErr)
				}
				if !errors.Is(err, ports.ErrRuntimePrerequisite) {
					t.Fatalf("err = %v, want ports.ErrRuntimePrerequisite sentinel", err)
				}
				if !strings.Contains(err.Error(), tt.wantErr) {
					t.Fatalf("err = %v, want substring %q", err, tt.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("ResolveBinary error = %v, want success", err)
			}
			if path != tt.wantPath || source != tt.wantSource {
				t.Fatalf("ResolveBinary = (%q, %q), want (%q, %q)", path, source, tt.wantPath, tt.wantSource)
			}
		})
	}
}
