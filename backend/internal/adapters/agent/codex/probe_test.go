package codex

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// codexExecFlagSurface is the set of flags `codex exec` actually accepts, taken
// verbatim from `codex exec --help` on the pinned CLI (codex-cli 0.144.1), plus
// `--no-update`, which is a top-level flag the codex-fugu wrapper passes before
// the subcommand.
//
// `--ask-for-approval` is deliberately absent: it belongs to the interactive TUI,
// not to `exec`. Passing it makes clap exit 2 before the provider is ever
// contacted (#182). `exec` is non-interactive and already runs approval=never.
var codexExecFlagSurface = []string{
	"--no-update",
	"--add-dir",
	"--color",
	"--config",
	"--dangerously-bypass-approvals-and-sandbox",
	"--dangerously-bypass-hook-trust",
	"--disable",
	"--enable",
	"--ephemeral",
	"--help",
	"--ignore-rules",
	"--ignore-user-config",
	"--image",
	"--json",
	"--local-provider",
	"--model",
	"--output-last-message",
	"--output-schema",
	"--oss",
	"--profile",
	"--sandbox",
	"--skip-git-repo-check",
	"--strict-config",
	"--version",
	"--cd",
}

// writeClapLikeFake installs a fake `codex` that validates its long flags against
// codexExecFlagSurface and exits 2 on an unknown one, the way clap does. The old
// fake ignored $@ and exited 0, which is precisely why CI never noticed that AO
// was passing a flag `codex exec` rejects.
func writeClapLikeFake(t *testing.T, argsFile string) string {
	t.Helper()
	bin := filepath.Join(t.TempDir(), "codex")
	// Also validates the enumerated values clap constrains, so a valid flag with
	// an invalid value (--sandbox bogus) fails here as it would in production.
	script := `#!/bin/sh
expect=""
for arg in "$@"; do
  if [ -n "$expect" ]; then
    case " $expect " in
      *" $arg "*) expect=""; continue ;;
      *) echo "error: invalid value '$arg'" >&2; exit 2 ;;
    esac
  fi
  case "$arg" in
    --sandbox) expect="read-only workspace-write danger-full-access" ;;
    --color) expect="always never auto" ;;
    --*)
      case " $AO_CODEX_SUPPORTED_FLAGS " in
        *" $arg "*) ;;
        *)
          echo "error: unexpected argument '$arg' found" >&2
          exit 2
          ;;
      esac
      ;;
  esac
done
if [ -n "$AO_CODEX_ARGS_FILE" ]; then
  printf '%s\n' "$@" > "$AO_CODEX_ARGS_FILE"
fi
exit 0
`
	if err := os.WriteFile(bin, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("AO_CODEX_SUPPORTED_FLAGS", strings.Join(codexExecFlagSurface, " "))
	t.Setenv("AO_CODEX_ARGS_FILE", argsFile)
	return bin
}

func writeFakeScript(t *testing.T, body string) string {
	t.Helper()
	bin := filepath.Join(t.TempDir(), "codex")
	if err := os.WriteFile(bin, []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
	return bin
}

// TestValidateModelProbeArgsUseOnlySupportedCodexExecFlags is the regression that
// #182 needed: the probe must only pass flags the pinned `codex exec` accepts.
func TestValidateModelProbeArgsUseOnlySupportedCodexExecFlags(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell-script fake is Unix-specific")
	}
	argsFile := filepath.Join(t.TempDir(), "args.txt")
	bin := writeClapLikeFake(t, argsFile)

	plugin := &Plugin{resolvedBinary: bin}
	if err := plugin.ValidateModel(context.Background(), "gpt-5.5"); err != nil {
		t.Fatalf("ValidateModel against a flag-checking fake: %v", err)
	}

	data, err := os.ReadFile(argsFile)
	if err != nil {
		t.Fatal(err)
	}
	args := strings.Fields(string(data))

	for _, arg := range args {
		if !strings.HasPrefix(arg, "--") {
			continue
		}
		if !containsString(codexExecFlagSurface, arg) {
			t.Errorf("probe passes %q, which `codex exec` does not accept", arg)
		}
	}
	if containsString(args, "--ask-for-approval") {
		t.Error("probe still passes --ask-for-approval; `codex exec` exits 2 on it (#182)")
	}
	// The probe must still be a meaningful reachability check.
	for _, want := range [][]string{
		{"exec"},
		{"--model", "gpt-5.5"},
		{"--sandbox", "read-only"},
	} {
		if !containsSubsequence(args, want) {
			t.Errorf("probe args %#v missing %#v", args, want)
		}
	}
}

// TestValidateModelClassifiesUsageErrorAsProbeUnavailable pins the contract half:
// a clap usage error (exit 2) is an AO-side defect, not a provider verdict.
func TestValidateModelClassifiesUsageErrorAsProbeUnavailable(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell-script fake is Unix-specific")
	}
	bin := writeFakeScript(t, `#!/bin/sh
echo "error: unexpected argument '--bogus' found" >&2
exit 2
`)
	plugin := &Plugin{resolvedBinary: bin}
	err := plugin.ValidateModel(context.Background(), "gpt-5.5")
	if err == nil {
		t.Fatal("ValidateModel err = nil, want a usage error")
	}
	if !ports.ProbeUnavailable(err) {
		t.Fatalf("exit-2 usage error must classify as ProbeUnavailable, got %v", err)
	}
}

// TestValidateModelClassifiesProviderRejectionAsUnreachable is the other half: a
// real 400 from the provider IS a verdict and must keep hard-blocking the write.
func TestValidateModelClassifiesProviderRejectionAsUnreachable(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell-script fake is Unix-specific")
	}
	bin := writeFakeScript(t, `#!/bin/sh
echo 'ERROR: {"status":400,"error":{"message":"The '"'"'gpt-5.5-codex'"'"' model is not supported when using Codex with a ChatGPT account."}}' >&2
exit 1
`)
	plugin := &Plugin{resolvedBinary: bin}
	err := plugin.ValidateModel(context.Background(), "gpt-5.5-codex")
	if err == nil {
		t.Fatal("ValidateModel err = nil, want provider rejection")
	}
	if ports.ProbeUnavailable(err) {
		t.Fatalf("provider rejection must NOT be ProbeUnavailable, got %v", err)
	}
	if !strings.Contains(err.Error(), "not supported when using Codex") {
		t.Fatalf("err = %v, want the provider output preserved", err)
	}
}

// TestValidateModelExitOneClassification: exit 1 is not automatically a verdict.
// `codex exec` exits 1 for a model rejection AND for a network drop, a TLS
// failure, a provider 5xx, or a rate limit. Only a provider response that is a
// definitive statement about the requested model may block a config write —
// everything else is infrastructure and must fail open (#182, AC#2 "transient
// exec error").
func TestValidateModelExitOneClassification(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell-script fake is Unix-specific")
	}
	tests := []struct {
		name        string
		stderr      string
		unavailable bool // true => infrastructure, fail open
	}{
		{
			name:        "model rejected 400",
			stderr:      `ERROR: {"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The 'gpt-5.5-codex' model is not supported when using Codex with a ChatGPT account."}}`,
			unavailable: false,
		},
		{
			name:        "model not found 404",
			stderr:      `ERROR: {"type":"error","status":404,"error":{"message":"model_not_found"}}`,
			unavailable: false,
		},
		{
			name:        "plain text rejection",
			stderr:      `400 model not available`,
			unavailable: false,
		},
		{
			name:        "provider 500",
			stderr:      `ERROR: {"type":"error","status":500,"error":{"message":"internal server error"}}`,
			unavailable: true,
		},
		{
			name:        "provider 503",
			stderr:      `ERROR: {"type":"error","status":503,"error":{"message":"service unavailable"}}`,
			unavailable: true,
		},
		{
			name:        "rate limited 429",
			stderr:      `ERROR: {"type":"error","status":429,"error":{"message":"rate limit exceeded"}}`,
			unavailable: true,
		},
		{
			name:        "network drop, no status at all",
			stderr:      `error sending request: connection reset by peer`,
			unavailable: true,
		},
		{
			name:        "tls failure",
			stderr:      `error: tls handshake eof`,
			unavailable: true,
		},
		{
			name:        "auth failure says nothing about the model",
			stderr:      `ERROR: {"type":"error","status":401,"error":{"message":"unauthorized"}}`,
			unavailable: true,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			bin := writeFakeScript(t, "#!/bin/sh\ncat <<'STDERR' >&2\n"+tc.stderr+"\nSTDERR\nexit 1\n")
			plugin := &Plugin{resolvedBinary: bin}

			err := plugin.ValidateModel(context.Background(), "gpt-5.5")
			if err == nil {
				t.Fatal("ValidateModel err = nil, want failure")
			}
			if got := ports.ProbeUnavailable(err); got != tc.unavailable {
				t.Fatalf("ProbeUnavailable = %v, want %v (err: %v)", got, tc.unavailable, err)
			}
		})
	}
}

func TestValidateModelClassifiesTimeoutAsProbeUnavailable(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell-script fake is Unix-specific")
	}
	bin := writeFakeScript(t, `#!/bin/sh
sleep 10
`)
	plugin := &Plugin{resolvedBinary: bin}
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()

	err := plugin.ValidateModel(ctx, "gpt-5.5")
	if err == nil {
		t.Fatal("ValidateModel err = nil, want timeout")
	}
	if !ports.ProbeUnavailable(err) {
		t.Fatalf("probe timeout must classify as ProbeUnavailable, got %v", err)
	}
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("err = %v, want it to wrap context.DeadlineExceeded", err)
	}
}

// TestValidateModelClassifiesSignalDeathAsProbeUnavailable: a probe killed by a
// signal (OOM killer, operator kill) exits with code -1 and never reached the
// provider. It says nothing about the model, so it must not block a config write.
func TestValidateModelClassifiesSignalDeathAsProbeUnavailable(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell-script fake is Unix-specific")
	}
	bin := writeFakeScript(t, `#!/bin/sh
kill -9 $$
`)
	plugin := &Plugin{resolvedBinary: bin}
	err := plugin.ValidateModel(context.Background(), "gpt-5.5")
	if err == nil {
		t.Fatal("ValidateModel err = nil, want signal death")
	}
	if !ports.ProbeUnavailable(err) {
		t.Fatalf("signal-killed probe must classify as ProbeUnavailable, got %v", err)
	}
}

// TestValidateModelProbeTimeoutIsBounded guards the WaitDelay: `codex exec`
// children inherit the output pipe, so without it CombinedOutput keeps reading
// long after the context expires and the probe's timeout bounds nothing.
func TestValidateModelProbeTimeoutIsBounded(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell-script fake is Unix-specific")
	}
	// `sleep` is a child that holds the inherited stdout pipe open.
	bin := writeFakeScript(t, `#!/bin/sh
sleep 30 &
wait
`)
	plugin := &Plugin{resolvedBinary: bin}
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()

	start := time.Now()
	err := plugin.ValidateModel(ctx, "gpt-5.5")
	elapsed := time.Since(start)

	if err == nil || !ports.ProbeUnavailable(err) {
		t.Fatalf("want ProbeUnavailable timeout, got %v", err)
	}
	if budget := probeWaitDelay + 5*time.Second; elapsed > budget {
		t.Fatalf("probe took %s, want under %s — the timeout is not bounding wall-clock", elapsed, budget)
	}
}

func TestValidateModelClassifiesMissingBinaryAsProbeUnavailable(t *testing.T) {
	plugin := &Plugin{resolvedBinary: filepath.Join(t.TempDir(), "definitely-not-here")}
	err := plugin.ValidateModel(context.Background(), "gpt-5.5")
	if err == nil {
		t.Fatal("ValidateModel err = nil, want exec failure")
	}
	if !ports.ProbeUnavailable(err) {
		t.Fatalf("missing binary must classify as ProbeUnavailable, got %v", err)
	}
}

func containsString(haystack []string, needle string) bool {
	for _, s := range haystack {
		if s == needle {
			return true
		}
	}
	return false
}
