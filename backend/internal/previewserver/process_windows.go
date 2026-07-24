//go:build windows

package previewserver

import (
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"

	"golang.org/x/sys/windows"

	aoprocess "github.com/aoagents/agent-orchestrator/backend/internal/process"
)

func previewCommand(name string, args ...string) *exec.Cmd {
	if resolved, err := exec.LookPath(name); err == nil && isWindowsBatchFile(resolved) {
		shell := strings.TrimSpace(os.Getenv("COMSPEC"))
		if shell == "" {
			shell = "cmd.exe"
		}
		cmd := exec.Command(shell) //nolint:gosec // COMSPEC is the OS-selected command interpreter for .cmd/.bat shims
		cmd.Args = nil
		cmd.SysProcAttr = &syscall.SysProcAttr{
			CmdLine:       `/d /s /c "` + windowsBatchCommandLine(resolved, args) + `"`,
			CreationFlags: windows.CREATE_NO_WINDOW | windows.CREATE_NEW_PROCESS_GROUP,
			HideWindow:    true,
		}
		return cmd
	}
	cmd := exec.Command(name, args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{
		CreationFlags: windows.CREATE_NO_WINDOW | windows.CREATE_NEW_PROCESS_GROUP,
		HideWindow:    true,
	}
	return cmd
}

func isWindowsBatchFile(path string) bool {
	extension := filepath.Ext(path)
	return strings.EqualFold(extension, ".cmd") || strings.EqualFold(extension, ".bat")
}

// cmd.exe uses different quoting rules from native Windows executables. The
// outer quotes are consumed by /s /c; each token remains quoted for paths and
// arguments containing spaces. Doubling embedded quotes preserves them for the
// batch shim instead of allowing them to terminate the command early.
func windowsBatchCommandLine(executable string, args []string) string {
	parts := make([]string, 0, len(args)+1)
	parts = append(parts, quoteWindowsBatchArg(executable))
	for _, arg := range args {
		parts = append(parts, quoteWindowsBatchArg(arg))
	}
	return strings.Join(parts, " ")
}

func quoteWindowsBatchArg(value string) string {
	return `"` + strings.ReplaceAll(value, `"`, `""`) + `"`
}

func terminatePreviewProcess(cmd *exec.Cmd) error {
	if cmd == nil || cmd.Process == nil {
		return nil
	}
	err := aoprocess.Command("taskkill", "/PID", strconv.Itoa(cmd.Process.Pid), "/T", "/F").Run()
	if err != nil {
		return cmd.Process.Kill()
	}
	return nil
}
