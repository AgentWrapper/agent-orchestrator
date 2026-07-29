package daytona

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os/exec"
	"regexp"
	"strings"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// Workspace provisions a session's isolated checkout INSIDE its Daytona
// sandbox: Create makes the sandbox (from the configured snapshot, with the
// control plane's boot env injected) and clones the project repo into it;
// Destroy tears the sandbox down after the same dirty-worktree refusal the
// local gitworktree adapter enforces. Every git operation runs in the sandbox
// via the toolbox API, mirroring the local adapter's command sequences.
type Workspace struct {
	core
	opts          WorkspaceOptions
	createTimeout time.Duration
	logger        *slog.Logger
}

var _ ports.Workspace = (*Workspace)(nil)

// RepoRemote tells the workspace adapter where a project's repository lives
// from the sandbox's point of view, plus clone credentials for private repos.
type RepoRemote struct {
	// URL is the clone URL (https). Required.
	URL string
	// DefaultBranch is the branch session branches are created from when the
	// workspace config does not name one.
	DefaultBranch string
	// Username/Password authenticate the clone (e.g. "x-access-token" + a
	// GitHub token). They travel in the toolbox git API body, never on a
	// command line.
	Username string
	Password string
}

// WorkspaceOptions configures the Daytona Workspace adapter.
type WorkspaceOptions struct {
	// Client talks to Daytona. Required.
	Client Client
	// Snapshot is the Daytona snapshot sandboxes are created from. Production
	// snapshots must have tmux, git, and the agent harness (agent CLIs + `ao`
	// Linux binary) preinstalled; see docs/cloud/daytona-runtime.md. Empty
	// falls back to Daytona's default snapshot (useful only for smoke tests).
	Snapshot string
	// Target picks the Daytona region ("us"/"eu"); empty uses the org default.
	Target string
	// CPU/MemoryGiB/DiskGiB size the sandbox; zero uses Daytona defaults.
	CPU       int
	MemoryGiB int
	DiskGiB   int
	// AutoStopMinutes is Daytona's inactivity auto-stop (the park mechanism in
	// the cost model). 0 applies the adapter default (15); -1 disables
	// auto-stop entirely.
	AutoStopMinutes int
	// AutoArchiveMinutes is how long a stopped sandbox waits before archiving
	// to object storage; 0 keeps Daytona's default.
	AutoArchiveMinutes int
	// BootEnv is injected into the sandbox at creation — this is where the
	// control plane places agent inference credentials (e.g.
	// CLAUDE_CODE_OAUTH_TOKEN) and the hooks-path env (AO_API_BASE,
	// AO_API_TOKEN). See the design doc's control-plane contract.
	BootEnv map[string]string
	// SessionBootEnv is merged into BootEnv for a specific session at sandbox
	// creation time. The control plane uses this to mint per-session AO_API_TOKEN
	// values after the session id is assigned.
	SessionBootEnv func(ctx context.Context, cfg ports.WorkspaceConfig) (map[string]string, error)
	// WorkspaceRoot is the directory inside the sandbox that holds session
	// checkouts; default /home/daytona/ao.
	WorkspaceRoot string
	// ResolveRepo maps a workspace config onto a clone URL + credentials. The
	// default resolver reads the `origin` remote of cfg.RepoPath on the daemon
	// host (the hybrid local-daemon/cloud-runtime setup); the cloud control
	// plane substitutes its own resolver.
	ResolveRepo func(ctx context.Context, cfg ports.WorkspaceConfig) (RepoRemote, error)
	// GitUserName/GitUserEmail configure commit identity inside the sandbox so
	// agents can commit out of the box. Defaults: "AO Agent" /
	// "ao-agent@users.noreply.github.com"; set either to "-" to skip.
	GitUserName  string
	GitUserEmail string
	// ExecTimeout / StartTimeout mirror Options. CreateTimeout bounds sandbox
	// creation (snapshot pull) and the initial clone; default 5m.
	ExecTimeout   time.Duration
	StartTimeout  time.Duration
	CreateTimeout time.Duration
	// Logger receives provisioning diagnostics; nil defaults to slog.Default().
	Logger *slog.Logger
}

const (
	defaultWorkspaceRoot   = "/home/daytona/ao"
	defaultAutoStopMinutes = 15
	defaultGitUserName     = "AO Agent"
	defaultGitUserEmail    = "ao-agent@users.noreply.github.com"
)

// NewWorkspace builds the Daytona Workspace adapter.
func NewWorkspace(opts WorkspaceOptions) (*Workspace, error) {
	if opts.Client == nil {
		return nil, errors.New("daytona workspace: client is required")
	}
	if err := validateEnvKeys(opts.BootEnv); err != nil {
		return nil, fmt.Errorf("daytona workspace: boot env: %w", err)
	}
	if opts.WorkspaceRoot == "" {
		opts.WorkspaceRoot = defaultWorkspaceRoot
	}
	if opts.AutoStopMinutes == 0 {
		opts.AutoStopMinutes = defaultAutoStopMinutes
	}
	if opts.ResolveRepo == nil {
		opts.ResolveRepo = resolveRepoFromLocalOrigin
	}
	if opts.GitUserName == "" {
		opts.GitUserName = defaultGitUserName
	}
	if opts.GitUserEmail == "" {
		opts.GitUserEmail = defaultGitUserEmail
	}
	execTimeout := opts.ExecTimeout
	if execTimeout <= 0 {
		execTimeout = defaultExecTimeout
	}
	startTimeout := opts.StartTimeout
	if startTimeout <= 0 {
		startTimeout = defaultStartTimeout
	}
	createTimeout := opts.CreateTimeout
	if createTimeout <= 0 {
		createTimeout = defaultCreateTimeout
	}
	logger := opts.Logger
	if logger == nil {
		logger = slog.Default()
	}
	return &Workspace{
		core: core{
			client:       opts.Client,
			execTimeout:  execTimeout,
			startTimeout: startTimeout,
		},
		opts:          opts,
		createTimeout: createTimeout,
		logger:        logger,
	}, nil
}

// resolveRepoFromLocalOrigin is the default resolver for the hybrid setup
// where the daemon runs next to the canonical repo: it reads the repo's
// `origin` URL on the daemon host. Credentials are left empty (public repos,
// or a snapshot with ambient git credentials).
func resolveRepoFromLocalOrigin(ctx context.Context, cfg ports.WorkspaceConfig) (RepoRemote, error) {
	if cfg.RepoPath == "" {
		return RepoRemote{}, errors.New("daytona workspace: no repo path to resolve a clone URL from; configure WorkspaceOptions.ResolveRepo")
	}
	out, err := exec.CommandContext(ctx, "git", "-C", cfg.RepoPath, "remote", "get-url", "origin").Output()
	if err != nil {
		return RepoRemote{}, fmt.Errorf("daytona workspace: resolve origin of %s: %w", cfg.RepoPath, err)
	}
	return RepoRemote{URL: strings.TrimSpace(string(out))}, nil
}

// workspacePath is the checkout directory for a session inside its sandbox.
func (w *Workspace) workspacePath(name string) string {
	return strings.TrimRight(w.opts.WorkspaceRoot, "/") + "/" + name
}

// Create provisions the session's sandbox and clones the repo/branch into it.
func (w *Workspace) Create(ctx context.Context, cfg ports.WorkspaceConfig) (ports.WorkspaceInfo, error) {
	name, err := sessionName(cfg.SessionID)
	if err != nil {
		return ports.WorkspaceInfo{}, err
	}
	remote, err := w.opts.ResolveRepo(ctx, cfg)
	if err != nil {
		return ports.WorkspaceInfo{}, err
	}
	if remote.URL == "" {
		return ports.WorkspaceInfo{}, errors.New("daytona workspace: repo resolver returned an empty clone URL")
	}

	sb, found, err := w.sandboxForHandle(ctx, name)
	if err != nil {
		return ports.WorkspaceInfo{}, err
	}
	if !found {
		sb, err = w.createSandbox(ctx, name, cfg)
		if err != nil {
			return ports.WorkspaceInfo{}, err
		}
	} else {
		if sb, err = w.ensureStarted(ctx, sb); err != nil {
			return ports.WorkspaceInfo{}, err
		}
	}

	path := w.workspacePath(name)
	branch, err := w.provisionCheckout(ctx, sb, path, cfg, remote)
	if err != nil {
		// The sandbox without a checkout is useless; tear it down so a retried
		// spawn does not find a half-provisioned sandbox.
		if delErr := w.client.DeleteSandbox(context.WithoutCancel(ctx), sb.ID); delErr != nil {
			w.logger.Warn("daytona workspace: cleanup after failed provision", "sandbox", sb.ID, "error", delErr)
		}
		return ports.WorkspaceInfo{}, err
	}
	return ports.WorkspaceInfo{
		Path:      path,
		Branch:    branch,
		SessionID: cfg.SessionID,
		ProjectID: cfg.ProjectID,
	}, nil
}

func (w *Workspace) createSandbox(ctx context.Context, name string, cfg ports.WorkspaceConfig) (Sandbox, error) {
	autoStop := w.opts.AutoStopMinutes
	if autoStop < 0 {
		autoStop = 0 // Daytona: 0 disables auto-stop
	}
	env, err := w.bootEnv(ctx, cfg)
	if err != nil {
		return Sandbox{}, err
	}
	req := CreateSandboxRequest{
		Name:     "ao-" + name,
		Snapshot: w.opts.Snapshot,
		Env:      env,
		Labels: map[string]string{
			LabelSession: name,
			LabelProject: string(cfg.ProjectID),
		},
		Target:           w.opts.Target,
		CPU:              w.opts.CPU,
		Memory:           w.opts.MemoryGiB,
		Disk:             w.opts.DiskGiB,
		AutoStopInterval: &autoStop,
	}
	if w.opts.AutoArchiveMinutes > 0 {
		v := w.opts.AutoArchiveMinutes
		req.AutoArchiveInterval = &v
	}
	sb, err := w.client.CreateSandbox(ctx, req)
	if err != nil {
		return Sandbox{}, fmt.Errorf("daytona workspace: create sandbox for %s: %w", name, err)
	}
	if sb.State == StateStarted {
		return sb, nil
	}
	sb, err = w.waitForState(ctx, sb.ID, StateStarted, w.createTimeout)
	if err != nil {
		if delErr := w.client.DeleteSandbox(context.WithoutCancel(ctx), sb.ID); delErr != nil {
			w.logger.Warn("daytona workspace: cleanup after failed create", "sandbox", sb.ID, "error", delErr)
		}
		return Sandbox{}, err
	}
	return sb, nil
}

func (w *Workspace) bootEnv(ctx context.Context, cfg ports.WorkspaceConfig) (map[string]string, error) {
	env := make(map[string]string, len(w.opts.BootEnv)+4)
	for k, v := range w.opts.BootEnv {
		env[k] = v
	}
	if w.opts.SessionBootEnv != nil {
		extra, err := w.opts.SessionBootEnv(ctx, cfg)
		if err != nil {
			return nil, fmt.Errorf("daytona workspace: session boot env: %w", err)
		}
		if err := validateEnvKeys(extra); err != nil {
			return nil, fmt.Errorf("daytona workspace: session boot env: %w", err)
		}
		for k, v := range extra {
			env[k] = v
		}
	}
	return env, nil
}

// provisionCheckout clones the repo (base branch when set) and creates or
// checks out the session branch, returning the effective branch name. An
// existing valid checkout is reused (idempotent retry after a partial spawn).
func (w *Workspace) provisionCheckout(ctx context.Context, sb Sandbox, path string, cfg ports.WorkspaceConfig, remote RepoRemote) (string, error) {
	// Already provisioned? (`git -C path rev-parse` succeeds only for a repo.)
	if _, err := w.exec(ctx, sb.ID, "git -C "+shellQuote(path)+" rev-parse --is-inside-work-tree"); err == nil {
		return w.currentBranch(ctx, sb.ID, path)
	}

	baseBranch := cfg.BaseBranch
	if baseBranch == "" {
		baseBranch = remote.DefaultBranch
	}
	cloneCtx, cancel := context.WithTimeout(ctx, w.createTimeout)
	defer cancel()
	if err := w.client.GitClone(cloneCtx, sb.ID, GitCloneRequest{
		URL:      remote.URL,
		Path:     path,
		Branch:   baseBranch,
		Username: remote.Username,
		Password: remote.Password,
	}); err != nil {
		return "", fmt.Errorf("daytona workspace: clone %s: %w", remote.URL, err)
	}
	if err := w.configureGitIdentity(ctx, sb.ID, path); err != nil {
		return "", err
	}
	if err := w.configureClaudeCode(ctx, sb.ID, path); err != nil {
		return "", err
	}

	branch := cfg.Branch
	if branch == "" {
		// Scratch-style session: stay on the cloned branch.
		return w.currentBranch(ctx, sb.ID, path)
	}
	if err := validateBranchName(branch); err != nil {
		return "", err
	}
	// Prefer resuming an existing remote branch (restore of a prior session);
	// otherwise create the session branch from the cloned base.
	script := "cd " + shellQuote(path) + " && " +
		"if git fetch origin " + shellQuote(branch) + " >/dev/null 2>&1; then " +
		"git checkout -B " + shellQuote(branch) + " FETCH_HEAD; else " +
		"git checkout -B " + shellQuote(branch) + "; fi"
	if _, err := w.execWithTimeout(ctx, sb.ID, script, w.createTimeout); err != nil {
		return "", fmt.Errorf("daytona workspace: checkout branch %s: %w", branch, err)
	}
	return branch, nil
}

func (w *Workspace) configureGitIdentity(ctx context.Context, sandboxID, path string) error {
	if w.opts.GitUserName == "-" || w.opts.GitUserEmail == "-" {
		return nil
	}
	script := "cd " + shellQuote(path) +
		" && git config user.name " + shellQuote(w.opts.GitUserName) +
		" && git config user.email " + shellQuote(w.opts.GitUserEmail)
	if _, err := w.exec(ctx, sandboxID, script); err != nil {
		return fmt.Errorf("daytona workspace: configure git identity: %w", err)
	}
	return nil
}

func (w *Workspace) configureClaudeCode(ctx context.Context, sandboxID, path string) error {
	settings := path + "/.claude/settings.local.json"
	script := "mkdir -p " + shellQuote(path+"/.claude") + " && cat > " + shellQuote(settings) + " <<'JSON'\n" +
		claudeCodeHooksJSON + "\nJSON\n" +
		"node -e " + shellQuote(claudeTrustScript) + " " + shellQuote(path)
	if _, err := w.exec(ctx, sandboxID, script); err != nil {
		return fmt.Errorf("daytona workspace: configure claude-code hooks: %w", err)
	}
	return nil
}

const claudeCodeHooksJSON = `{"hooks":{"SessionStart":[{"matcher":"startup","hooks":[{"type":"command","command":"ao hooks claude-code session-start","timeout":30}]}],"UserPromptSubmit":[{"hooks":[{"type":"command","command":"ao hooks claude-code user-prompt-submit","timeout":30}]}],"PreToolUse":[{"hooks":[{"type":"command","command":"ao hooks claude-code pre-tool-use","timeout":30}]}],"PostToolUse":[{"hooks":[{"type":"command","command":"ao hooks claude-code post-tool-use","timeout":30}]}],"PostToolUseFailure":[{"hooks":[{"type":"command","command":"ao hooks claude-code post-tool-use-failure","timeout":30}]}],"PermissionRequest":[{"hooks":[{"type":"command","command":"ao hooks claude-code permission-request","timeout":30}]}],"Stop":[{"hooks":[{"type":"command","command":"ao hooks claude-code stop","timeout":30}]}],"Notification":[{"hooks":[{"type":"command","command":"ao hooks claude-code notification","timeout":30}]}],"SessionEnd":[{"hooks":[{"type":"command","command":"ao hooks claude-code session-end","timeout":30}]}]}}`

const claudeTrustScript = `const fs=require("fs"); const path=process.argv[1]; const cfg=process.env.HOME+"/.claude.json"; let root={}; try { root=JSON.parse(fs.readFileSync(cfg,"utf8")||"{}"); } catch (_) {} root.projects=root.projects||{}; root.projects[path]=Object.assign({}, root.projects[path]||{}, {hasTrustDialogAccepted:true}); fs.writeFileSync(cfg, JSON.stringify(root,null,2));`

func (w *Workspace) currentBranch(ctx context.Context, sandboxID, path string) (string, error) {
	out, err := w.exec(ctx, sandboxID, "git -C "+shellQuote(path)+" rev-parse --abbrev-ref HEAD")
	if err != nil {
		return "", fmt.Errorf("daytona workspace: read current branch: %w", err)
	}
	return strings.TrimSpace(out.Result), nil
}

// branchNamePattern conservatively bounds branch names before they are placed
// in a shell command (they are also shell-quoted; this is defense in depth and
// mirrors ports.ErrWorkspaceBranchInvalid semantics).
var branchNamePattern = regexp.MustCompile(`^[A-Za-z0-9._/-]+$`)

func validateBranchName(branch string) error {
	if !branchNamePattern.MatchString(branch) || strings.HasPrefix(branch, "-") || strings.Contains(branch, "..") {
		return fmt.Errorf("%w: %q", ports.ErrWorkspaceBranchInvalid, branch)
	}
	return nil
}

// Restore brings a torn-down session's workspace back: it wakes the existing
// sandbox when one survives, or re-provisions from the remote when the sandbox
// was deleted (the session branch is fetched if it exists on the remote).
func (w *Workspace) Restore(ctx context.Context, cfg ports.WorkspaceConfig) (ports.WorkspaceInfo, error) {
	name, err := sessionName(cfg.SessionID)
	if err != nil {
		return ports.WorkspaceInfo{}, err
	}
	sb, found, err := w.sandboxForHandle(ctx, name)
	if err != nil {
		return ports.WorkspaceInfo{}, err
	}
	if !found {
		return w.Create(ctx, cfg)
	}
	if sb, err = w.ensureStarted(ctx, sb); err != nil {
		return ports.WorkspaceInfo{}, err
	}
	path := w.workspacePath(name)
	if _, err := w.exec(ctx, sb.ID, "git -C "+shellQuote(path)+" rev-parse --is-inside-work-tree"); err != nil {
		return ports.WorkspaceInfo{}, fmt.Errorf("daytona workspace: restore %s: checkout missing: %w: %w", name, ports.ErrWorkspaceStale, err)
	}
	branch, err := w.currentBranch(ctx, sb.ID, path)
	if err != nil {
		return ports.WorkspaceInfo{}, err
	}
	return ports.WorkspaceInfo{
		Path:      path,
		Branch:    branch,
		SessionID: cfg.SessionID,
		ProjectID: cfg.ProjectID,
	}, nil
}

// Destroy tears the sandbox down unless the checkout holds uncommitted work —
// the same refusal the local adapter enforces (never force-delete dirty
// worktrees). A parked sandbox is woken for the dirty check and re-parked if
// the check refuses.
func (w *Workspace) Destroy(ctx context.Context, info ports.WorkspaceInfo) error {
	name, err := sessionName(info.SessionID)
	if err != nil {
		return err
	}
	sb, found, err := w.sandboxForHandle(ctx, name)
	if err != nil {
		return err
	}
	if !found {
		return nil // already gone: idempotent
	}
	wasParked := sb.State == StateStopped || sb.State == StateArchived
	if sb, err = w.ensureStarted(ctx, sb); err != nil {
		return fmt.Errorf("daytona workspace: wake sandbox for dirty check: %w", err)
	}
	dirty, err := w.isDirty(ctx, sb.ID, info.Path)
	if err != nil {
		return err
	}
	if dirty {
		if wasParked {
			if stopErr := w.client.StopSandbox(ctx, sb.ID); stopErr != nil {
				w.logger.Warn("daytona workspace: re-park after dirty refusal", "sandbox", sb.ID, "error", stopErr)
			}
		}
		return fmt.Errorf("daytona workspace: %s: %w", name, ports.ErrWorkspaceDirty)
	}
	if err := w.deleteAndWait(ctx, sb.ID); err != nil {
		return fmt.Errorf("daytona workspace: delete sandbox %s: %w", sb.ID, err)
	}
	return nil
}

// ForceDestroy deletes the sandbox unconditionally. Only safe after
// StashUncommitted captured the session's work (and, for cloud sessions, only
// truly durable once preserve refs are pushed to the remote — see the design
// doc's limitations).
func (w *Workspace) ForceDestroy(ctx context.Context, info ports.WorkspaceInfo) error {
	name, err := sessionName(info.SessionID)
	if err != nil {
		return err
	}
	sb, found, err := w.sandboxForHandle(ctx, name)
	if err != nil {
		return err
	}
	if !found {
		return nil
	}
	if err := w.deleteAndWait(ctx, sb.ID); err != nil {
		return fmt.Errorf("daytona workspace: delete sandbox %s: %w", sb.ID, err)
	}
	return nil
}

func (w *Workspace) isDirty(ctx context.Context, sandboxID, path string) (bool, error) {
	out, err := w.exec(ctx, sandboxID, "git -C "+shellQuote(path)+" status --porcelain")
	if err != nil {
		var execErr *execError
		if errors.As(err, &execErr) {
			// Not a git repo any more: stale, nothing to protect.
			return false, fmt.Errorf("daytona workspace: dirty check %s: %w: %w", path, ports.ErrWorkspaceStale, err)
		}
		return false, fmt.Errorf("daytona workspace: dirty check %s: %w", path, err)
	}
	return strings.TrimSpace(out.Result) != "", nil
}

// preserveRefPattern bounds ref names accepted by ApplyPreserved before they
// enter a shell command (also shell-quoted; defense in depth).
var preserveRefPattern = regexp.MustCompile(`^refs/ao/preserved/[A-Za-z0-9._-]+$`)

// StashUncommitted captures all uncommitted work as a commit object at
// refs/ao/preserved/<session-id> without mutating the working tree, mirroring
// the local gitworktree sequence (temp index → add -A → write-tree →
// commit-tree → update-ref). Returns "" when the worktree is clean.
func (w *Workspace) StashUncommitted(ctx context.Context, info ports.WorkspaceInfo) (string, error) {
	name, err := sessionName(info.SessionID)
	if err != nil {
		return "", err
	}
	if info.Path == "" {
		return "", errors.New("daytona workspace: path is required for StashUncommitted")
	}
	sb, found, err := w.sandboxForHandle(ctx, name)
	if err != nil {
		return "", err
	}
	if !found {
		return "", fmt.Errorf("daytona workspace: stash %s: sandbox missing: %w", name, ports.ErrWorkspaceStale)
	}
	if sb, err = w.ensureStarted(ctx, sb); err != nil {
		return "", err
	}
	ref := "refs/ao/preserved/" + name
	// Exit 3 = stale (not a repo), exit 4 = clean (nothing to preserve).
	script := "cd " + shellQuote(info.Path) + " || exit 3; " +
		"git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 3; " +
		`[ -z "$(git status --porcelain)" ] && exit 4; ` +
		`IDX="$(mktemp -u)"; ` +
		"GIT_INDEX_FILE=\"$IDX\" git add -A && " +
		"TREE=$(GIT_INDEX_FILE=\"$IDX\" git write-tree) && " +
		"COMMIT=$(git commit-tree \"$TREE\" -p HEAD -m " + shellQuote("ao: preserved uncommitted work for "+name) + ") && " +
		"git update-ref " + shellQuote(ref) + " \"$COMMIT\"; " +
		`STATUS=$?; rm -f "$IDX"; exit $STATUS`
	if _, err := w.exec(ctx, sb.ID, script); err != nil {
		var execErr *execError
		if errors.As(err, &execErr) {
			switch execErr.exitCode {
			case 3:
				return "", fmt.Errorf("daytona workspace: stash %s: %w", name, ports.ErrWorkspaceStale)
			case 4:
				return "", nil
			}
		}
		return "", fmt.Errorf("daytona workspace: stash %s: %w", name, err)
	}
	return ref, nil
}

// ApplyPreserved replays a StashUncommitted capture via cherry-pick
// --no-commit; on conflict the ref is kept, markers stay in the tree, and
// ports.ErrPreservedConflict is returned (wrapped).
func (w *Workspace) ApplyPreserved(ctx context.Context, info ports.WorkspaceInfo, ref string) error {
	name, err := sessionName(info.SessionID)
	if err != nil {
		return err
	}
	if ref == "" {
		return errors.New("daytona workspace: ApplyPreserved: ref must not be empty")
	}
	if !preserveRefPattern.MatchString(ref) {
		return fmt.Errorf("daytona workspace: ApplyPreserved: invalid ref %q", ref)
	}
	sb, found, err := w.sandboxForHandle(ctx, name)
	if err != nil {
		return err
	}
	if !found {
		return fmt.Errorf("daytona workspace: apply preserved %s: sandbox missing: %w", name, ports.ErrWorkspaceStale)
	}
	if sb, err = w.ensureStarted(ctx, sb); err != nil {
		return err
	}
	// Exit 5 = conflict (cherry-pick left markers; ref must survive).
	script := "cd " + shellQuote(info.Path) + " && " +
		"SHA=$(git rev-parse --verify --quiet " + shellQuote(ref) + ") && " +
		"{ git cherry-pick --no-commit \"$SHA\" || exit 5; } && " +
		"git update-ref -d " + shellQuote(ref)
	if _, err := w.exec(ctx, sb.ID, script); err != nil {
		var execErr *execError
		if errors.As(err, &execErr) && execErr.exitCode == 5 {
			return fmt.Errorf("daytona workspace: apply preserved %s: %w: %w", name, ports.ErrPreservedConflict, err)
		}
		return fmt.Errorf("daytona workspace: apply preserved %s: %w", name, err)
	}
	return nil
}

// AddExclude appends ignore patterns to the checkout's .git/info/exclude
// (idempotent), so daemon-generated files never surface as untracked changes.
func (w *Workspace) AddExclude(ctx context.Context, info ports.WorkspaceInfo, patterns ...string) error {
	if len(patterns) == 0 {
		return nil
	}
	name, err := sessionName(info.SessionID)
	if err != nil {
		return err
	}
	sb, found, err := w.sandboxForHandle(ctx, name)
	if err != nil {
		return err
	}
	if !found {
		return fmt.Errorf("daytona workspace: add exclude %s: sandbox missing: %w", name, ports.ErrWorkspaceStale)
	}
	if sb, err = w.ensureStarted(ctx, sb); err != nil {
		return err
	}
	var b strings.Builder
	b.WriteString("cd " + shellQuote(info.Path) + " && ")
	b.WriteString(`D="$(git rev-parse --git-common-dir)" && mkdir -p "$D/info"`)
	for _, p := range patterns {
		q := shellQuote(p)
		b.WriteString(" && { grep -qxF " + q + ` "$D/info/exclude" 2>/dev/null || echo ` + q + ` >> "$D/info/exclude"; }`)
	}
	if _, err := w.exec(ctx, sb.ID, b.String()); err != nil {
		return fmt.Errorf("daytona workspace: add exclude: %w", err)
	}
	return nil
}

// Park stops the session's sandbox so an idle agent stops burning
// compute-hours (fs preserved, processes killed; see the cost model in
// docs/cloud/daytona-runtime.md). The lifecycle owner calls this from its
// idle policy; waking happens implicitly through Runtime.Restart.
func (w *Workspace) Park(ctx context.Context, info ports.WorkspaceInfo) error {
	name, err := sessionName(info.SessionID)
	if err != nil {
		return err
	}
	sb, found, err := w.sandboxForHandle(ctx, name)
	if err != nil {
		return err
	}
	if !found || sb.State != StateStarted {
		return nil
	}
	if err := w.client.StopSandbox(ctx, sb.ID); err != nil {
		return fmt.Errorf("daytona workspace: park %s: %w", name, err)
	}
	// Daytona's stop is async (the sandbox reports `started`, then `stopping`,
	// while the toolbox proxy 502s — observed live). Wait for the steady state
	// so "parked" means parked to callers and their next probe; tolerate the
	// lingering `started` reads from before the stop is applied.
	if _, err := w.waitForState(ctx, sb.ID, StateStopped, w.startTimeout, StateStarted); err != nil {
		return fmt.Errorf("daytona workspace: park %s: %w", name, err)
	}
	return nil
}
