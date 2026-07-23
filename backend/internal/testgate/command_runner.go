package testgate

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"
)

const defaultCommandTimeout = 20 * time.Minute

// CommandRunner runs an external test-gate command. The command may create an
// ephemeral pod, run tests, and must print a final AO_VERDICT line.
type CommandRunner struct {
	command string
	args    []string
	workDir string
	env     map[string]string
	timeout time.Duration
}

// CommandRunnerOptions configures an external test-gate command runner.
type CommandRunnerOptions struct {
	Command string
	Args    []string
	WorkDir string
	Env     map[string]string
	Timeout time.Duration
}

// NewCommandRunner constructs a CommandRunner from opts, applying defaults.
func NewCommandRunner(opts CommandRunnerOptions) *CommandRunner {
	timeout := opts.Timeout
	if timeout <= 0 {
		timeout = defaultCommandTimeout
	}
	env := map[string]string{}
	for k, v := range opts.Env {
		env[k] = v
	}
	return &CommandRunner{
		command: strings.TrimSpace(opts.Command),
		args:    append([]string(nil), opts.Args...),
		workDir: opts.WorkDir,
		env:     env,
		timeout: timeout,
	}
}

// Run executes the configured command for req and parses the final AO_VERDICT line.
func (r *CommandRunner) Run(ctx context.Context, req RunRequest) (RunResult, error) {
	if r == nil || r.command == "" {
		return NotConfiguredRunner{}.Run(ctx, req)
	}
	runCtx := ctx
	cancel := func() {}
	if r.timeout > 0 {
		runCtx, cancel = context.WithTimeout(ctx, r.timeout)
	}
	defer cancel()

	payload, err := json.Marshal(req)
	if err != nil {
		return RunResult{}, fmt.Errorf("encode test gate request: %w", err)
	}
	cmd := exec.CommandContext(runCtx, r.command, r.args...)
	cmd.Stdin = strings.NewReader(string(payload))
	cmd.Env = commandEnv(os.Environ(), r.env, req)
	if req.WorkspacePath != "" {
		cmd.Dir = req.WorkspacePath
	} else if r.workDir != "" {
		cmd.Dir = r.workDir
	}

	out, err := cmd.CombinedOutput()
	output := string(out)
	if runCtx.Err() != nil {
		return RunResult{}, runCtx.Err()
	}
	if result, ok, parseErr := ParseRunResultOutput(output); parseErr != nil {
		return RunResult{}, parseErr
	} else if ok {
		return result, nil
	}
	if err != nil {
		return RunResult{}, fmt.Errorf("test gate command failed: %w%s", err, commandOutputSuffix(output))
	}
	return RunResult{Run: TestRun{
		Classification: ClassificationInfra,
		Summary:        "test gate command completed without AO_VERDICT",
	}}, nil
}

func commandEnv(base []string, extra map[string]string, req RunRequest) []string {
	env := append([]string(nil), base...)
	for k, v := range extra {
		env = append(env, k+"="+v)
	}
	env = append(env,
		"AO_TEST_GATE_KIND="+string(req.Kind),
		"AO_TEST_GATE_REVIEW_RUN_ID="+req.ReviewRun.ID,
		"AO_TEST_GATE_SESSION_ID="+string(req.ReviewRun.SessionID),
		"AO_TEST_GATE_PR_URL="+req.ReviewRun.PRURL,
		"AO_TEST_GATE_TARGET_SHA="+req.ReviewRun.TargetSHA,
		"AO_TEST_GATE_WORKSPACE_PATH="+req.WorkspacePath,
	)
	return env
}

func commandOutputSuffix(output string) string {
	output = strings.TrimSpace(output)
	if output == "" {
		return ""
	}
	if len(output) > 2000 {
		output = output[len(output)-2000:]
	}
	return ": " + output
}
