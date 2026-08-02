package claudecode

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// handshakeTimeout bounds the initialize round trip. It is a local IPC call that
// settles in well under a second on a healthy install; the generous bound is for
// a cold start where the CLI is still loading plugins and MCP servers.
const handshakeTimeout = 60 * time.Second

// claudePlugin is the subset of AO's existing Claude Code agent plugin that the
// Chat driver reuses. Binary resolution and local auth probing already live there
// and must not be reimplemented: a second copy would drift from what TUI sessions
// do, and AO would end up with two different answers to "is Claude logged in".
//
// Nothing here hands AO a credential. Auth is the user's own `claude` login, and
// the driver only ever asks whether it exists.
type claudePlugin interface {
	ResolveBinary(ctx context.Context) (string, error)
	AuthStatus(ctx context.Context) (ports.AgentAuthStatus, error)
}

// process is a running claude, abstracted so tests can substitute pipes for a
// child process.
type process struct {
	stdin  io.WriteCloser
	stdout io.Reader
	// stderrTail returns the last thing the CLI printed to stderr. The CLI reports
	// its startup refusals there and then exits — "No conversation found with
	// session ID: …" is stderr-only — so without this a failed launch reaches the
	// user as a controller that stopped for no stated reason.
	stderrTail func() string
	// stop releases the process. It must be safe to call more than once.
	stop func() error
}

// spawnFunc launches a claude process. Injected so tests never exec anything.
type spawnFunc func(ctx context.Context, bin, workdir string, args, env []string) (*process, error)

// Driver opens Claude Code conversations over the stream-json CLI.
type Driver struct {
	plugin claudePlugin
	log    *slog.Logger
	spawn  spawnFunc
	// newSessionID mints the CLI session id. Injected so a test can assert on a
	// known id rather than on whatever a UUID generator produced.
	newSessionID func() string
}

// New builds a Chat driver over the existing Claude Code agent plugin.
func New(plugin claudePlugin, log *slog.Logger) *Driver {
	if log == nil {
		log = slog.New(slog.DiscardHandler)
	}
	return &Driver{
		plugin:       plugin,
		log:          log,
		spawn:        spawnClaude,
		newSessionID: uuid.NewString,
	}
}

var _ ports.ChatDriver = (*Driver)(nil)

// Harness reports which agent this driver serves.
func (d *Driver) Harness() domain.AgentHarness { return domain.HarnessClaudeCode }

// capabilities is what a Claude Code CLI of a supported version provides. Every
// entry was exercised against claude 2.1.220 rather than read off a doc.
func capabilities() ports.ChatCapabilities {
	return ports.ChatCapabilities{
		// The production floor, all four measured: text streams as
		// content_block_delta with --include-partial-messages; approvals arrive as
		// can_use_tool control requests and were answered end to end; interrupt
		// cancels a running turn and leaves the process serving the next one; and
		// --resume recovers context on a fresh process with the same session id.
		ports.ChatCapabilityStreaming: true,
		ports.ChatCapabilityApprovals: true,
		ports.ChatCapabilityInterrupt: true,
		ports.ChatCapabilityResume:    true,

		ports.ChatCapabilityTools: true,
		// Token accounting rides every assistant message and the turn result, and
		// the result's modelUsage is where the context window comes from.
		ports.ChatCapabilityUsage: true,
		// TodoWrite and ExitPlanMode are the agent stating what it intends to do.
		ports.ChatCapabilityPlans: true,
		// list_models answers with the account's own catalog, including which
		// effort levels each model takes.
		ports.ChatCapabilityModels: true,
		// get_usage reports utilization and a reset instant for both the five-hour
		// and seven-day windows.
		ports.ChatCapabilityRateLimits: true,
		// rename_session accepts a title.
		ports.ChatCapabilityRename: true,
		// /compact runs as a turn and the CLI reports both sides of the reclaim on
		// a compact_boundary frame.
		ports.ChatCapabilityCompaction: true,

		// Deliberately absent, each for a measured reason:
		//
		//   history  — the CLI exposes no way to read a session's turn list back,
		//              so AO cannot enumerate what it did not itself record.
		//   diffs    — get_workspace_diff reports the WORKING TREE against git, not
		//              what one turn changed. Filing a whole-tree diff under the
		//              latest turn would credit it with every edit an earlier turn
		//              made, so no turn diff is emitted at all.
		//   rollback — nothing discards history back to a point. rewind_files
		//              restores files without touching what the agent remembers,
		//              which is a different operation wearing a similar name.
		//   fork     — --fork-session branches only at launch, and ChatForker has to
		//              branch a conversation that is already open.
		//   steer    — no mid-turn steering exists on this wire.
		//   user_input — request_user_dialog exists, but the CLI fails closed for a
		//              host that does not declare the dialog kinds it can render,
		//              and AO declares none. Advertising it would offer a control
		//              nothing can answer.
		//   skills   — the initialize handshake does return the install's command
		//              catalog, but it is a TERMINAL palette (/clear, /config,
		//              /model, /heapdump) with no chat meaning, and AO has no
		//              consumer for ChatSkillLister at all. Listing it would put
		//              names on screen that nothing can invoke.
	}
}

// Probe reports what this install can do without creating a conversation, so an
// unsupported request can be refused before AO commits a session or worktree.
func (d *Driver) Probe(ctx context.Context) (ports.ChatCapabilities, error) {
	if _, err := d.plugin.ResolveBinary(ctx); err != nil {
		return nil, fmt.Errorf("%w: %w", ports.ErrChatDriverUnavailable, err)
	}

	// An unknown auth result is not proof of failure — the same rule AO already
	// applies to runtime probes. Only an explicit unauthorized blocks creation.
	status, err := d.plugin.AuthStatus(ctx)
	if err == nil && status == ports.AgentAuthStatusUnauthorized {
		return nil, ports.ErrChatAuthRequired
	}
	if err != nil {
		d.log.Debug("claude auth probe inconclusive; continuing", "error", err)
	}

	return capabilities(), nil
}

// Start opens a new Claude Code session in the session worktree.
//
// The session id is minted here and handed to the CLI with --session-id rather
// than read back from the first system/init. That frame only arrives once a turn
// runs, so reading the id from it would leave a freshly created conversation with
// nothing to persist and no way to resume until somebody had already talked to it.
func (d *Driver) Start(ctx context.Context, cfg ports.ChatStartConfig) (ports.ChatConversation, error) {
	if !filepath.IsAbs(cfg.WorkspacePath) {
		// The CLI resolves a relative cwd against its own process directory, which
		// would silently put the agent in the wrong tree.
		return nil, fmt.Errorf("workspace path must be absolute, got %q", cfg.WorkspacePath)
	}

	sessionID := d.newSessionID()
	args := baseArgs(cfg.Permissions)
	args = append(args, "--session-id", sessionID)
	if cfg.Model != "" {
		args = append(args, "--model", cfg.Model)
	}
	if cfg.SystemPrompt != "" {
		// Appended, not replaced: AO's standing instructions are additional to the
		// agent's own system prompt, and replacing it would strip the tool
		// discipline the CLI depends on.
		args = append(args, "--append-system-prompt", cfg.SystemPrompt)
	}

	conv, err := d.connect(ctx, cfg.WorkspacePath, args, cfg.Env)
	if err != nil {
		return nil, err
	}
	conv.start(sessionID)
	return conv, nil
}

// Resume reattaches to a stored Claude Code session after a daemon restart.
//
// A session id the CLI does not have is detected here rather than on the first
// turn: the CLI prints "No conversation found with session ID: …" to stderr and
// exits 1 before answering anything, so the handshake below fails and this
// reports ErrChatResumeFailed. Deliberately not falling back to a fresh session —
// silently opening a new conversation would present unrelated history as
// continuous.
func (d *Driver) Resume(ctx context.Context, cfg ports.ChatResumeConfig) (ports.ChatConversation, error) {
	if cfg.ProviderConversationID == "" {
		return nil, fmt.Errorf("%w: no stored session id", ports.ErrChatResumeFailed)
	}
	if !filepath.IsAbs(cfg.WorkspacePath) {
		return nil, fmt.Errorf("workspace path must be absolute, got %q", cfg.WorkspacePath)
	}

	args := baseArgs(cfg.Permissions)
	// --resume keeps the same session id. --fork-session would mint a new one,
	// which is the wrong thing for a restart: AO has the old id persisted and a
	// session that quietly changed identity could never be resumed twice.
	args = append(args, "--resume="+cfg.ProviderConversationID)

	conv, err := d.connect(ctx, cfg.WorkspacePath, args, cfg.Env)
	if err != nil {
		return nil, fmt.Errorf("%w: %w", ports.ErrChatResumeFailed, err)
	}
	conv.start(cfg.ProviderConversationID)
	return conv, nil
}

// connect spawns the CLI and completes the initialize handshake.
func (d *Driver) connect(
	ctx context.Context, workdir string, args []string, env map[string]string,
) (*conversation, error) {
	bin, err := d.plugin.ResolveBinary(ctx)
	if err != nil {
		return nil, fmt.Errorf("%w: %w", ports.ErrChatDriverUnavailable, err)
	}

	proc, err := d.spawn(ctx, bin, workdir, args, processEnv(env))
	if err != nil {
		return nil, fmt.Errorf("%w: launch claude: %w", ports.ErrChatDriverUnavailable, err)
	}

	conv := newConversation(proc, d.log)

	initCtx, cancel := context.WithTimeout(ctx, handshakeTimeout)
	defer cancel()

	// The handshake is optional to the CLI — a turn works without one — but AO
	// sends it for two reasons. It is the only round trip that proves the process
	// is alive and speaking this protocol before AO reports a conversation open;
	// and it is how a bad --resume is caught, since the CLI prints its complaint
	// to stderr and exits before answering, which fails this request.
	//
	// supportedDialogKinds is deliberately not sent. The CLI treats its absence as
	// "this host cannot display dialogs" and degrades the affected flows instead of
	// parking a request_user_dialog nothing in AO could render.
	if err := conv.conn.request(initCtx, "initialize", nil, nil); err != nil {
		_ = conv.Close()
		if tail := conv.stderrTail(); tail != "" {
			// The CLI's own words. They say things AO cannot infer, like which
			// session id it could not find.
			return nil, fmt.Errorf("%w: initialize: %w: %s",
				ports.ErrChatDriverIncompatible, err, tail)
		}
		return nil, fmt.Errorf("%w: initialize: %w", ports.ErrChatDriverIncompatible, err)
	}
	return conv, nil
}

// baseArgs is the launch every conversation shares.
func baseArgs(permissions ports.PermissionMode) []string {
	args := []string{
		"--print",
		"--output-format", "stream-json",
		"--input-format", "stream-json",
		// --verbose is required for stream-json output to carry anything beyond the
		// final result. Without it there are no assistant frames to normalize.
		"--verbose",
		// The load-bearing, undocumented flag. It is what routes permission asks to
		// this process over the control channel; without it the CLI has no client
		// to ask, so a mode that would prompt instead denies the tool call and
		// reports it in the result's permission_denials. The agent then quietly
		// fails to act with nothing on screen to explain why. The TypeScript SDK
		// passes the same sentinel whenever a canUseTool callback exists.
		"--permission-prompt-tool", "stdio",
		// Assistant text otherwise arrives only as a settled message, which is not
		// streaming in any sense a reader would recognize.
		"--include-partial-messages",
	}
	if mode := permissionMode(permissions); mode != "" {
		args = append(args, "--permission-mode", mode)
	}
	return args
}

// permissionMode maps AO's permission mode onto the CLI's --permission-mode.
// An empty result means "emit no flag".
//
// The mapping is deliberately identical to what AO already passes a Claude Code
// TUI session (see the agent plugin's appendPermissionFlags), including default
// meaning no flag at all. Chat must not quietly become stricter or laxer than the
// terminal for the same setting, and for this agent the terminal's answer to
// "default" is the user's own settings.json defaultMode — not a policy AO invents.
//
// acceptEdits and manual are the modes where approvals actually reach a person:
// bypassPermissions skips every check, and auto lets a classifier decide, so a
// session in either of those will mostly never raise a card. That is the
// difference between a session that asks and one that cannot, and it is chosen
// per session by the user, not here.
func permissionMode(mode ports.PermissionMode) string {
	switch ports.NormalizePermissionMode(mode) {
	case ports.PermissionModeAcceptEdits:
		return "acceptEdits"
	case ports.PermissionModeAuto:
		return "auto"
	case ports.PermissionModeBypassPermissions:
		return "bypassPermissions"
	default:
		return ""
	}
}

// stderrRing keeps the last few lines the CLI printed to stderr.
//
// Bounded on purpose: this exists to explain a launch failure, and an agent that
// runs for an hour must not accumulate its whole diagnostic output in memory to
// do it.
type stderrRing struct {
	mu    sync.Mutex
	lines []string
}

const stderrRingLines = 8

func (r *stderrRing) add(line string) {
	line = strings.TrimSpace(line)
	if line == "" {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.lines = append(r.lines, line)
	if len(r.lines) > stderrRingLines {
		r.lines = r.lines[len(r.lines)-stderrRingLines:]
	}
}

func (r *stderrRing) tail() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return strings.Join(r.lines, "; ")
}

// spawnClaude is the real launcher.
func spawnClaude(_ context.Context, bin, workdir string, args, env []string) (*process, error) {
	cmd := exec.Command(bin, args...)
	cmd.Dir = workdir
	if len(env) > 0 {
		cmd.Env = env
	}

	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, fmt.Errorf("stdin pipe: %w", err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, fmt.Errorf("stdout pipe: %w", err)
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return nil, fmt.Errorf("stderr pipe: %w", err)
	}
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("start %s: %w", bin, err)
	}

	// Drained rather than discarded: the last lines are the only account of a
	// startup refusal, and an undrained pipe would eventually wedge the CLI.
	ring := &stderrRing{}
	go func() {
		scanner := bufio.NewScanner(stderr)
		scanner.Buffer(make([]byte, 0, 64*1024), 1<<20)
		for scanner.Scan() {
			ring.add(scanner.Text())
		}
	}()

	var stopOnce sync.Once
	return &process{
		stdin:      stdin,
		stdout:     stdout,
		stderrTail: ring.tail,
		stop: func() error {
			stopOnce.Do(func() {
				// Closing stdin is the graceful shutdown; kill only if it lingers.
				_ = stdin.Close()
				done := make(chan struct{})
				go func() { _, _ = cmd.Process.Wait(); close(done) }()
				select {
				case <-done:
				case <-time.After(3 * time.Second):
					_ = cmd.Process.Kill()
				}
			})
			return nil
		},
	}, nil
}

// processEnv builds the child's environment: the daemon's own, OVERLAID with AO's
// session variables.
//
// An overlay, not a replacement, and that distinction is load-bearing. AO's map is
// sparse — the session id, the project id, the data dir, the HookPATH pin, and
// whatever the project overrides — because the terminal path applies it on top of
// an inherited environment: tmux inherits the daemon's, and the runtime exports
// AO's additions over it. A chat driver that handed exec.Cmd that map alone would
// start the agent with no HOME, and Claude reads its login from ~/.claude.json.
// Measured: every turn came back "Not logged in · Please run /login" with a
// terminal_reason of api_error, on a machine where the CLI was logged in and
// working. AO holds no credential and must not: the fix is to let the user's own
// environment through, not to find their token.
//
// Sorted so a relaunch is byte-identical, which makes process diffs readable.
func processEnv(overlay map[string]string) []string {
	merged := make(map[string]string, len(os.Environ())+len(overlay))
	for _, kv := range os.Environ() {
		if idx := strings.IndexByte(kv, '='); idx > 0 {
			merged[kv[:idx]] = kv[idx+1:]
		}
	}
	// AO's values win: the HookPATH pin exists precisely to displace whatever `ao`
	// the inherited PATH would have resolved.
	for k, v := range overlay {
		merged[k] = v
	}

	keys := make([]string, 0, len(merged))
	for k := range merged {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	out := make([]string, 0, len(keys))
	for _, k := range keys {
		out = append(out, k+"="+merged[k])
	}
	return out
}
