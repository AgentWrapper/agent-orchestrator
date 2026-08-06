package commandguard

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestMatchBlocksBuiltInDestructiveOperations(t *testing.T) {
	t.Parallel()
	tests := []string{
		"rm -rf /tmp/project",
		"sudo rm -r -f ./cache",
		"command rm --force --recursive build",
		"git reset --hard HEAD~1",
		"git -C /workspace push origin main --force",
		"git push -f origin main",
		"git push --force-with-lease",
		"git clean -fdx",
		"dd if=/dev/zero of=/dev/sda",
		"mkfs.ext4 /dev/sdb",
		"chmod -R 777 /workspace",
		"chown root:root secret",
		"wipefs -a /dev/sda",
		"find . -name '*.tmp' -delete",
		`python -c "import shutil; shutil.rmtree('/tmp/x')"`,
		`python deploy.py && shutil.rmtree(path)`,
		`node -e "require('fs').rmSync('/tmp/x', {recursive:true})"`,
		`fs.rmSync(target, { recursive: true, force: true })`,
		`FileUtils.rm_rf(target)`,
		`eval(decodedPayload)`,
		`bash -c "echo cm0gLXJmIC8= | base64 -d | sh"`,
		"printf cm0gLXJmIC8= | base64 --decode | bash",
		"safe-command && r'm' -r\\f /tmp/x",
		"$(git reset --hard)",
		"eval \"$DYNAMIC_COMMAND\"",
	}
	for _, command := range tests {
		t.Run(command, func(t *testing.T) {
			t.Parallel()
			if rule, blocked := Match(command); !blocked {
				t.Fatalf("Match(%q) blocked=false, want true", command)
			} else if rule == "" {
				t.Fatalf("Match(%q) returned an empty rule", command)
			}
			if err := Check(command); !errors.Is(err, ErrBlocked) {
				t.Fatalf("Check(%q) error = %v, want ErrBlocked", command, err)
			}
		})
	}
}

func TestMatchAllowsOrdinaryDevelopmentCommands(t *testing.T) {
	t.Parallel()
	tests := []string{
		"go test ./...",
		"git status --short",
		"git push origin feature",
		"git reset README.md",
		"rm -r ./generated",
		"rm -f ./output.log",
		"python scripts/check.py",
		"bash scripts/test.sh",
		"base64 README.md",
		"find . -name '*.go' -print",
	}
	for _, command := range tests {
		if rule, blocked := Match(command); blocked {
			t.Errorf("Match(%q) = %q, true; want allowed", command, rule)
		}
	}
}

func TestHookInputExtractsSupportedAgentCommandsAndWrites(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name    string
		harness string
		event   string
		payload string
		want    string
	}{
		{
			name:    "claude bash",
			harness: "claude-code",
			event:   "pre-tool-use",
			payload: `{"tool_name":"Bash","tool_input":{"command":"git reset --hard"}}`,
			want:    "git reset --hard",
		},
		{
			name:    "claude generated script",
			harness: "claude-code",
			event:   "pre-tool-use",
			payload: `{"tool_name":"Write","tool_input":{"content":"import shutil\nshutil.rmtree(path)"}}`,
			want:    "import shutil\nshutil.rmtree(path)\n\n",
		},
		{
			name:    "cursor shell",
			harness: "cursor",
			event:   "permission-request",
			payload: `{"command":"chmod 777 file"}`,
			want:    "chmod 777 file",
		},
		{
			name:    "codex shell",
			harness: "codex",
			event:   "permission-request",
			payload: `{"tool_input":{"command":"dd if=x of=y"}}`,
			want:    "dd if=x of=y",
		},
		{
			name:    "non blocking hook",
			harness: "claude-code",
			event:   "post-tool-use",
			payload: `{"tool_name":"Bash","tool_input":{"command":"rm -rf /"}}`,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			if got := HookInput(test.harness, test.event, []byte(test.payload)); got != test.want {
				t.Fatalf("HookInput() = %q, want %q", got, test.want)
			}
		})
	}
}

func TestHookInputInspectsReferencedScriptContents(t *testing.T) {
	t.Parallel()
	workspace := t.TempDir()
	script := filepath.Join(workspace, "cleanup.py")
	if err := os.WriteFile(
		script,
		[]byte("import shutil\nshutil.rmtree('/tmp/build')\n"),
		0o600,
	); err != nil {
		t.Fatal(err)
	}
	payload := []byte(
		`{"cwd":` + quoteJSON(workspace) +
			`,"tool_name":"Bash","tool_input":{"command":"python cleanup.py"}}`,
	)
	input := HookInput("claude-code", "pre-tool-use", payload)
	if _, blocked := Match(input); !blocked {
		t.Fatalf("referenced script was not inspected: %q", input)
	}
}

func TestStateIsDurableAndRemovable(t *testing.T) {
	t.Parallel()
	dataDir := t.TempDir()
	if Enabled(dataDir) {
		t.Fatal("Enabled() = true before state exists")
	}
	if err := SetEnabled(dataDir, true); err != nil {
		t.Fatalf("SetEnabled(true) error = %v", err)
	}
	if !Enabled(dataDir) {
		t.Fatal("Enabled() = false after enabling")
	}
	info, err := os.Stat(filepath.Join(dataDir, stateFileName))
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("state mode = %o, want 600", info.Mode().Perm())
	}
	if err := SetEnabled(dataDir, false); err != nil {
		t.Fatalf("SetEnabled(false) error = %v", err)
	}
	if Enabled(dataDir) {
		t.Fatal("Enabled() = true after disabling")
	}
}

func quoteJSON(value string) string {
	encoded, _ := json.Marshal(value)
	return string(encoded)
}
