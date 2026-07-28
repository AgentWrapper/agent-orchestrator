package cloud

// The cloud supervisor provisions one isolated Daytona sandbox PER worker session
// (not per harness), installs the harness, ports the user's local credential in,
// boots a scoped `ao daemon --agent-host` inside, and reaches it over a signed
// preview URL. One sandbox per session is deliberate: a session can then be shared
// with a teammate without exposing any other session.
//
// Ported from the Electron-main TypeScript supervisor. Here it lives in the Go
// backend (the daemon), exposed to clients via HTTP endpoints.
//
// Security invariants: the Daytona API key stays in this process (read from env),
// never logged, never uploaded into a sandbox; the ported harness credential goes
// straight into the sandbox and is never logged; the signed preview URL is a
// short-lived secret.

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

// agentHostPort is the loopback port the scoped daemon listens on inside a sandbox.
const agentHostPort = 3001

// CloudSession is a live per-session sandbox. Keyed by SandboxID (globally
// unique); SessionID is only unique within a daemon so it must not be the key.
type CloudSession struct { //nolint:revive // name intentionally disambiguates across packages; renaming ripples widely
	SessionID string `json:"sessionId"`
	// LocalProjectID is the LOCAL project this cloud session belongs to, so a
	// client merges its card into the right board. Distinct from ProjectID (the
	// sandbox daemon's own project id).
	LocalProjectID string `json:"localProjectId"`
	ProjectID      string `json:"projectId"`
	Harness        string `json:"harness"`
	// Kind is "worker" or "orchestrator" — the role of the in-sandbox session.
	Kind string `json:"kind,omitempty"`
	// OrchestratorID is the bus routing key of the orchestrator that requested
	// this worker (delegated spawn); empty for a non-delegated session. Used by
	// the control plane to authorize cross-location bus traffic.
	OrchestratorID string `json:"orchestratorId,omitempty"`
	// IdempotencyKey dedupes retried spawns (see SpawnInput.IdempotencyKey).
	IdempotencyKey string `json:"idempotencyKey,omitempty"`
	SandboxID      string `json:"sandboxId"`
	PreviewURL     string `json:"previewUrl"`
	// Status tracks async provisioning: "provisioning" (sandbox created, harness
	// booting), "ready" (session live), or "failed". SessionID/PreviewURL are
	// empty until ready. DisplayName lets the client label the provisioning card.
	Status      string `json:"status"`
	Error       string `json:"error,omitempty"`
	DisplayName string `json:"displayName,omitempty"`
	// TenantID scopes a session to an authenticated tenant in the multi-tenant
	// control plane. Empty for the single-user local daemon (one implicit tenant).
	TenantID string `json:"tenantId,omitempty"`
}

// Provisioning-status constants.
const (
	StatusProvisioning = "provisioning"
	StatusReady        = "ready"
	StatusFailed       = "failed"
	StatusTerminated   = "terminated" // killed: sandbox deleted, card kept as archived
)

// SupervisorConfig wires the supervisor to its environment. APIKey and
// LinuxBinaryPath are funcs so a missing value is a clear runtime error, not a
// boot crash, and so a rotated key is picked up.
type SupervisorConfig struct {
	APIKey          func() string
	LinuxBinaryPath func() string
	Snapshot        string
	StatePath       string // JSON registry path (local daemon). Ignored when Store is set.
	// Store persists the session registry. The local daemon uses a JSON file
	// (default, via StatePath); the control plane injects a tenant-scoped SQL
	// store. When nil, a JSONStore over StatePath is used (or a no-op if empty).
	Store Store
	Log   *slog.Logger
	// NewProvider builds the sandbox backend from the credential returned by
	// APIKey. nil → Daytona (DaytonaProviderFactory). Swap this to run on e2b,
	// Fly, Modal, etc. without touching the supervisor.
	NewProvider ProviderFactory
	// OnSessionReady, if set, is called whenever a cloud session reaches "ready"
	// (fresh provisioning or boot restore) with SessionID + PreviewURL populated.
	// The control plane uses it to file the session's location for the federated
	// bus. Plain callback over CloudSession keeps this package cloud- and
	// control-plane-agnostic. Invoked outside the supervisor lock.
	OnSessionReady func(CloudSession)
	// OnSessionEnded mirrors OnSessionReady for teardown, so the location can be
	// dropped when a session is terminated.
	OnSessionEnded func(CloudSession)
	// ControlPlaneURL, when set, is injected into the sandbox as
	// AO_CONTROL_PLANE_URL so the in-sandbox daemon can dial the federated bus.
	ControlPlaneURL string
	// MintBusToken, when set, mints a per-sandbox scoped bus token injected as
	// AO_BUS_TOKEN. A func (not a concrete signer) keeps this package free of the
	// control plane's auth internals. Empty result / nil ⇒ no token injected.
	MintBusToken func(tenantID, sandboxID string) (string, error)
}

// Supervisor owns the set of live cloud sessions.
type Supervisor struct {
	cfg      SupervisorConfig
	mu       sync.Mutex
	sessions map[string]*CloudSession // keyed by sandboxId
	restored bool
}

// NewSupervisor builds a supervisor. Snapshot defaults to daytona-small.
func NewSupervisor(cfg SupervisorConfig) *Supervisor {
	if cfg.Snapshot == "" {
		cfg.Snapshot = "daytona-small"
	}
	if cfg.Log == nil {
		cfg.Log = slog.Default()
	}
	// Default the registry to a JSON file over StatePath (local daemon behavior).
	if cfg.Store == nil {
		cfg.Store = &JSONStore{Path: cfg.StatePath}
	}
	return &Supervisor{cfg: cfg, sessions: map[string]*CloudSession{}}
}

// SetLocationHooks wires callbacks fired when a session becomes ready / ends.
// The control plane uses them to keep the federated-bus location registry in
// sync; construction order (supervisor before the registry) makes a setter
// cleaner than a config field here.
func (s *Supervisor) SetLocationHooks(onReady, onEnded func(CloudSession)) {
	s.cfg.OnSessionReady = onReady
	s.cfg.OnSessionEnded = onEnded
}

// notifyReady fires OnSessionReady with a snapshot of the session, outside the
// lock. Safe no-op when the callback or session is absent.
func (s *Supervisor) notifyReady(sandboxID string) {
	if s.cfg.OnSessionReady == nil {
		return
	}
	s.mu.Lock()
	cur := s.sessions[sandboxID]
	var snap CloudSession
	if cur != nil {
		snap = *cur
	}
	s.mu.Unlock()
	if snap.SessionID != "" && snap.PreviewURL != "" {
		s.cfg.OnSessionReady(snap)
	}
}

func (s *Supervisor) logf(format string, args ...any) {
	s.cfg.Log.Info("cloud: " + fmt.Sprintf(format, args...))
}

func (s *Supervisor) client() (SandboxProvider, error) {
	factory := s.cfg.NewProvider
	if factory == nil {
		factory = DaytonaProviderFactory
	}
	return factory(s.cfg.APIKey())
}

// CloudCapable reports whether a harness has a verified cloud recipe.
func (s *Supervisor) CloudCapable(harness string) bool {
	r, ok := recipeFor(harness)
	return ok && r.Verified
}

// Configured reports whether a Daytona API key is available (cloud is usable).
func (s *Supervisor) Configured() bool { return s.cfg.APIKey() != "" }

// Capabilities reports whether cloud is configured and which harnesses can run.
func (s *Supervisor) Capabilities() (bool, []string) {
	return s.Configured(), CloudCapableHarnesses()
}

// ProxyFetch performs a REST call to a sandbox's preview URL from THIS process
// and returns the status + raw body. Clients use it instead of calling the
// sandbox directly, so a signed preview URL never leaves the backend and no
// cross-origin (CORS) rules apply. previewURL is supplied by the caller (e.g. a
// shared-session token), so it is validated to be an https Daytona preview host.
func (s *Supervisor) ProxyFetch(ctx context.Context, previewURL, method, apiPath string, body any) (int, json.RawMessage, error) {
	if !isSandboxPreviewURL(previewURL) {
		return 0, nil, fmt.Errorf("cloud: refusing to proxy non-sandbox URL")
	}
	var reqBody io.Reader
	if body != nil {
		buf, err := json.Marshal(body)
		if err != nil {
			return 0, nil, err
		}
		reqBody = bytes.NewReader(buf)
	}
	req, err := http.NewRequestWithContext(ctx, method, strings.TrimRight(previewURL, "/")+apiPath, reqBody)
	if err != nil {
		return 0, nil, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("Accept", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return resp.StatusCode, nil, err
	}
	return resp.StatusCode, raw, nil
}

// isSandboxPreviewURL guards ProxyFetch against SSRF: only https Daytona preview
// hosts are proxyable.
func isSandboxPreviewURL(raw string) bool {
	return strings.HasPrefix(raw, "https://") && strings.Contains(raw, "daytona")
}

// SpawnInput is the request to run one session in a fresh cloud sandbox.
type SpawnInput struct {
	Harness        string
	LocalProjectID string
	ProjectPath    string // LOCAL path; mapped into the sandbox
	// RemoteURL is the git remote to clone into the sandbox. Callers that spawn
	// via the hosted control plane MUST set it — the control plane runs on Azure
	// and cannot read the local ProjectPath to derive the remote. Empty → derive
	// from ProjectPath (local daemon, which can read it).
	RemoteURL   string
	Prompt      string
	DisplayName string
	Branch      string
	// Kind is "worker" (default) or "orchestrator". An orchestrator cloud session
	// runs the project's coordinator agent in the sandbox — same provisioning as a
	// worker, only the in-sandbox session it creates differs.
	Kind string
	// TenantID scopes the session to a tenant (control plane). Empty = local daemon.
	TenantID string
	// Credential is the harness credential the CALLER supplies at spawn time
	// (e.g. the desktop app reads the user's current Claude credential and passes
	// it here). When set it is injected into the sandbox verbatim as the harness's
	// credential file, taking precedence over any server-side source — so the
	// hosted control plane never needs a stored copy. NEVER logged or persisted.
	Credential string
	// OrchestratorID is the session id of the orchestrator that requested this
	// worker (delegated spawn). Injected into the sandbox as
	// AO_ORCHESTRATOR_SESSION_ID so the worker's daemon reports idle over the bus
	// to that remote orchestrator. Empty for a non-delegated spawn.
	OrchestratorID string
	// IdempotencyKey, when set, dedupes spawns: a retry carrying the same key
	// returns the already-created session instead of provisioning a second
	// sandbox. Lets a caller safely retry a delegated spawn whose response was
	// lost (e.g. the sandbox→control-plane egress reset the connection).
	IdempotencyKey string
}

// SpawnResult acknowledges a spawn. Provisioning is async, so only the sandbox
// id + status are known when SpawnCloud returns.
type SpawnResult struct {
	SandboxID string `json:"sandboxId"`
	Status    string `json:"status"`
}

// SpawnCloud provisions a fresh sandbox and starts one worker session in it.
// It returns as soon as the sandbox is CREATED (~3s with a baked snapshot),
// registering the session as "provisioning"; the slow steps (upload ao, boot the
// daemon, clone the repo, create the session) run in a background goroutine so
// the caller/UI never blocks on them. The card flips "provisioning"→"ready" (or
// "failed") as the registry updates. The goroutine is decoupled from the request
// context, so provisioning survives even if the client disconnects.
func (s *Supervisor) SpawnCloud(ctx context.Context, in SpawnInput) (*SpawnResult, error) {
	recipe, ok := recipeFor(in.Harness)
	if !ok {
		return nil, fmt.Errorf("cloud: no recipe for harness %q", in.Harness)
	}
	client, err := s.client()
	if err != nil {
		return nil, err
	}

	// Idempotency: a retried delegated spawn (same key) must not create a second
	// sandbox — return the session already provisioned for this key. Guards
	// against the sandbox→control-plane egress resetting a spawn's response.
	if in.IdempotencyKey != "" {
		s.mu.Lock()
		for _, v := range s.sessions {
			if v.TenantID == in.TenantID && v.IdempotencyKey == in.IdempotencyKey && v.Status != StatusTerminated && v.Status != StatusFailed {
				res := &SpawnResult{SandboxID: v.SandboxID, Status: v.Status}
				s.mu.Unlock()
				s.logf("cloud: idempotent spawn hit key=%s → sandbox=%s", in.IdempotencyKey, shortID(v.SandboxID))
				return res, nil
			}
		}
		s.mu.Unlock()
	}

	// Detach the create call from the caller's request context (with its own
	// timeout) so a client disconnect mid-request — e.g. a delegated spawn from
	// inside a sandbox, over the internet — can't abort provisioning. The slow
	// half already runs on a background context; this covers the sync half too.
	createCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 90*time.Second)
	defer cancel()
	box, err := s.createSandbox(createCtx, client, recipe)
	if err != nil {
		return nil, err
	}
	sandboxID := box.ID

	// Register immediately as provisioning so the board shows a card right away.
	s.mu.Lock()
	s.sessions[sandboxID] = &CloudSession{
		LocalProjectID: in.LocalProjectID,
		Harness:        in.Harness,
		Kind:           in.Kind,
		OrchestratorID: in.OrchestratorID,
		IdempotencyKey: in.IdempotencyKey,
		SandboxID:      sandboxID,
		Status:         StatusProvisioning,
		DisplayName:    in.DisplayName,
		TenantID:       in.TenantID,
	}
	s.mu.Unlock()
	s.save()

	// Finish provisioning off the request path.
	go s.finishProvisioning(client, box, recipe, in) // #nosec G118 -- provisioning must outlive the request; detached context is intentional

	return &SpawnResult{SandboxID: sandboxID, Status: StatusProvisioning}, nil
}

// finishProvisioning runs the slow half of a spawn (install/boot/clone/session)
// and updates the registry to ready/failed. Runs in its own goroutine with a
// fresh context so a client disconnect can't abort it.
func (s *Supervisor) finishProvisioning(client SandboxProvider, box *Sandbox, recipe Recipe, in SpawnInput) {
	defer func() {
		if r := recover(); r != nil {
			s.markFailed(box.ID, fmt.Sprintf("panic: %v", r), client)
		}
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()

	previewURL, err := s.installAndBoot(ctx, client, box, recipe, in)
	if err != nil {
		s.markFailed(box.ID, err.Error(), client)
		return
	}
	sandboxPath := "/home/daytona/work/" + baseNameOr(in.ProjectPath, "project")
	// Clone the project's real git remote so a cloud session has the same code a
	// local one does (empty init if there's no remote). Prefer a remote supplied
	// by the caller (control plane — it can't read the local ProjectPath); fall
	// back to deriving it locally (daemon).
	spec := gitCloneSpec(in.ProjectPath)
	if strings.TrimSpace(in.RemoteURL) != "" {
		spec = cloneSpec{RemoteURL: normalizeGitURL(in.RemoteURL), Branch: in.Branch}
	}
	if err := s.prepareProject(ctx, client, *box, sandboxPath, spec); err != nil {
		s.markFailed(box.ID, err.Error(), client)
		return
	}
	projectID, err := s.ensureProject(ctx, previewURL, sandboxPath)
	if err != nil {
		s.markFailed(box.ID, err.Error(), client)
		return
	}
	sessionID, err := s.createSession(ctx, previewURL, projectID, in)
	if err != nil {
		s.markFailed(box.ID, err.Error(), client)
		return
	}

	s.mu.Lock()
	if cur := s.sessions[box.ID]; cur != nil {
		cur.SessionID = sessionID
		cur.ProjectID = projectID
		cur.PreviewURL = previewURL
		cur.Status = StatusReady
		cur.Error = ""
	}
	s.mu.Unlock()
	s.save()
	s.notifyReady(box.ID)
	s.logf("cloud session ready: sandbox=%s session=%s", box.ID, sessionID)
}

// markFailed records a provisioning failure and tears the sandbox down. The
// failed entry is KEPT so the board can show the error; the user dismisses it
// via terminate (which removes it).
func (s *Supervisor) markFailed(sandboxID, msg string, client SandboxProvider) {
	s.logf("cloud provisioning failed: sandbox=%s: %s", shortID(sandboxID), msg)
	s.mu.Lock()
	if cur := s.sessions[sandboxID]; cur != nil {
		cur.Status = StatusFailed
		cur.Error = msg
	}
	s.mu.Unlock()
	s.save()
	_ = client.Delete(context.Background(), sandboxID)
}

// createSandbox provisions the Daytona sandbox only (fast, ~3s with a baked
// snapshot) and resolves its toolbox proxy URL. The slow install/boot happens in
// installAndBoot.
// egressAllowList builds the sandbox's egress domain allowlist (Option A): the
// control-plane host + the harness's domains + the base set (git/apt). It's
// applied ONLY in hosted mode (a control-plane URL is configured) — that's when
// the sandbox must reach a host Daytona's curated default blocks, and setting
// the list REPLACES that default. In local-daemon mode it returns "" so Daytona's
// default (which already permits git/npm/anthropic) stays in effect. The result
// is default-deny egress scoped to exactly what the harness needs.
func (s *Supervisor) egressAllowList(recipe Recipe) string {
	cpHost := hostOf(s.cfg.ControlPlaneURL)
	if cpHost == "" {
		return "" // local daemon: no control plane to reach → keep Daytona's default
	}
	seen := map[string]bool{}
	var out []string
	add := func(d string) {
		d = strings.TrimSpace(d)
		if d != "" && !seen[d] {
			seen[d] = true
			out = append(out, d)
		}
	}
	add(cpHost)
	for _, d := range recipe.EgressDomains {
		add(d)
	}
	for _, d := range baseEgressDomains {
		add(d)
	}
	return strings.Join(out, ",") // Daytona caps at 20; the wildcards keep us well under
}

// hostOf returns the bare hostname of a URL (no scheme/port/path), or "".
func hostOf(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ""
	}
	if u, err := url.Parse(raw); err == nil && u.Host != "" {
		return u.Hostname()
	}
	return ""
}

func (s *Supervisor) createSandbox(ctx context.Context, client SandboxProvider, recipe Recipe) (*Sandbox, error) {
	// Prefer the harness's pre-baked snapshot (claude/tmux already installed) over
	// the generic default (which needs a multi-minute install).
	snapshot := recipe.Snapshot
	if snapshot == "" {
		snapshot = s.cfg.Snapshot
	}
	s.logf("provisioning %s sandbox (snapshot=%s, baked=%v)…", recipe.ID, snapshot, recipe.Snapshot != "")
	// Never idle-stop: agent sessions run as long-lived processes INSIDE the
	// sandbox, so Daytona's default idle auto-stop (~15m) would kill them out
	// from under us. 0 disables auto-stop; the sandbox lives until AO explicitly
	// tears it down (or the delete backstop fires if it somehow gets stopped).
	noAutoStop := 0
	autoDelete := 240 // minutes; leak backstop, only counts once stopped
	box, err := client.Create(ctx, CreateSandboxRequest{
		Snapshot:           snapshot,
		Labels:             map[string]string{"app": "ao-agent-host", "harness": recipe.ID},
		DomainAllowList:    s.egressAllowList(recipe),
		AutoStopInterval:   &noAutoStop,
		AutoDeleteInterval: &autoDelete,
	})
	if err != nil {
		return nil, err
	}
	// The toolbox proxy URL is needed for exec/file calls but isn't always on the
	// create response; fetch the full sandbox to be sure.
	if box.ToolboxProxyURL == "" {
		full, gerr := client.Get(ctx, box.ID)
		if gerr != nil {
			_ = client.Delete(context.Background(), box.ID)
			return nil, gerr
		}
		box = full
	}
	return box, nil
}

// installAndBoot uploads the ao binary, installs the harness (unless baked),
// ports credentials, boots the scoped agent-host, and returns a signed preview
// URL. On any error the sandbox is torn down.
func (s *Supervisor) installAndBoot(ctx context.Context, client SandboxProvider, box *Sandbox, recipe Recipe, in SpawnInput) (previewURL string, err error) {
	linux := s.cfg.LinuxBinaryPath()
	if linux == "" {
		return "", fmt.Errorf("cloud: linux ao binary not configured (set AO_LINUX_BINARY)")
	}
	binary, err := os.ReadFile(linux)
	if err != nil {
		return "", fmt.Errorf("cloud: read linux ao binary: %w", err)
	}
	baked := recipe.Snapshot != ""

	sh := func(cmd string, timeoutSec int) (string, error) {
		r, e := client.Exec(ctx, *box, ExecuteRequest{Command: "bash -lc " + shQuote(cmd), Timeout: timeoutSec})
		if e != nil {
			return "", e
		}
		if r.ExitCode != 0 {
			return "", fmt.Errorf("sandbox cmd failed (rc=%d): %s", r.ExitCode, tail(r.Result, 600))
		}
		return r.Result, nil
	}

	// 1. ao binary + base prereqs
	if _, err = sh("mkdir -p /home/daytona/.ao", 60); err != nil {
		return "", err
	}
	if err := client.UploadFile(ctx, *box, "/home/daytona/ao", binary); err != nil {
		return "", err
	}
	if _, err = sh("sudo mv /home/daytona/ao /usr/local/bin/ao && sudo chmod +x /usr/local/bin/ao", 60); err != nil {
		return "", err
	}
	if _, err = sh("git config --global user.email pod@ao; git config --global user.name ao-pod; git config --global init.defaultBranch main", 60); err != nil {
		return "", err
	}

	// tmux + harness are baked into the snapshot when `baked`; otherwise install
	// them now (the slow path). This is the ~4-minute difference.
	if !baked {
		if _, err = sh("command -v tmux >/dev/null || (sudo apt-get update -qq && sudo apt-get install -y -qq tmux) >/dev/null 2>&1; command -v tmux", 300); err != nil {
			return "", err
		}
		for _, cmd := range recipe.Install {
			if _, err = sh(cmd, 600); err != nil {
				return "", err
			}
		}
	}

	// 3. port credential + headless seed
	if err := s.portCredentials(ctx, client, *box, recipe, sh, in.Credential); err != nil {
		return "", err
	}

	// 4. boot the scoped agent-host
	env := map[string]string{
		"AO_AGENT_HOST_HARNESSES": recipe.ID,
		"AO_DATA_DIR":             "/home/daytona/.ao",
		"DISABLE_AUTOUPDATER":     "1",
	}
	// Federated bus: let the in-sandbox daemon dial back to the control plane
	// with a per-sandbox scoped token (never the user's credential). Both are
	// optional — absent them the sandbox just runs without an outbound channel.
	if s.cfg.ControlPlaneURL != "" {
		env["AO_CONTROL_PLANE_URL"] = s.cfg.ControlPlaneURL
		env["AO_DAEMON_ID"] = box.ID
		if s.cfg.MintBusToken != nil {
			if tok, mErr := s.cfg.MintBusToken(in.TenantID, box.ID); mErr == nil && tok != "" {
				env["AO_BUS_TOKEN"] = tok
			} else if mErr != nil {
				s.logf("cloud: bus token mint failed for sandbox %s: %v", shortID(box.ID), mErr)
			}
		}
		// A delegated worker sandbox learns its remote orchestrator so its daemon
		// can report worker_idle back over the bus (Task 4).
		if in.OrchestratorID != "" {
			env["AO_ORCHESTRATOR_SESSION_ID"] = in.OrchestratorID
		}
	}
	if len(recipe.PathAdd) > 0 {
		parts := make([]string, 0, len(recipe.PathAdd))
		for _, p := range recipe.PathAdd {
			parts = append(parts, strings.ReplaceAll(p, "~", "/home/daytona"))
		}
		env["PATH"] = strings.Join(parts, ":") + ":/usr/local/bin:/usr/bin:/bin"
	}
	for k, v := range recipe.Env {
		env[k] = v
	}
	envStr := envAssignments(env)
	if _, err = sh(fmt.Sprintf("nohup env %s ao daemon > /home/daytona/agent-host.log 2>&1 & sleep 1", envStr), 60); err != nil {
		return "", err
	}

	// 5. wait for readiness on loopback
	ready := false
	for i := 0; i < 40; i++ {
		out, _ := sh(fmt.Sprintf("curl -sf http://127.0.0.1:%d/readyz && echo OK || true", agentHostPort), 30)
		if strings.Contains(out, "OK") {
			ready = true
			break
		}
		time.Sleep(time.Second)
	}
	if !ready {
		logTail, _ := sh("tail -30 /home/daytona/agent-host.log", 30)
		return "", fmt.Errorf("cloud: agent-host never became ready:\n%s", logTail)
	}

	// 6. signed preview URL (token embedded → browser-usable)
	previewURL, err = s.signedPreview(ctx, client, box.ID, 30*60)
	if err != nil {
		return "", err
	}
	s.logf("%s host ready: sandbox=%s", recipe.ID, box.ID)
	return previewURL, nil
}

func (s *Supervisor) signedPreview(ctx context.Context, client SandboxProvider, sandboxID string, ttlSec int) (string, error) {
	signed, err := client.SignedPreview(ctx, sandboxID, agentHostPort, ttlSec)
	if err != nil {
		return "", err
	}
	return signed.URL, nil
}

// ViewURL mints a fresh signed preview URL for a sandbox (refresh before expiry).
func (s *Supervisor) ViewURL(ctx context.Context, sandboxID string) (string, error) {
	sess := s.get(sandboxID)
	if sess == nil {
		return "", nil
	}
	client, err := s.client()
	if err != nil {
		return "", err
	}
	signedURL, err := s.signedPreview(ctx, client, sandboxID, 30*60)
	if err != nil {
		return "", err
	}
	s.mu.Lock()
	if cur := s.sessions[sandboxID]; cur != nil {
		cur.PreviewURL = signedURL
	}
	s.mu.Unlock()
	return signedURL, nil
}

// SharePayload is the token a teammate imports to view a session read-only
// (model A). The signed URL is a bearer secret until it expires; model B swaps in
// a revocable, daemon-enforced scope.
type SharePayload struct {
	V           int    `json:"v"`
	PreviewURL  string `json:"previewUrl"`
	SandboxID   string `json:"sandboxId"`
	SessionID   string `json:"sessionId"`
	Harness     string `json:"harness"`
	ProjectName string `json:"projectName,omitempty"`
	Mode        string `json:"mode"`
}

// ShareResult is the encoded token plus its lifetime.
type ShareResult struct {
	Token        string `json:"token"`
	ExpiresInSec int    `json:"expiresInSec"`
}

// Share mints a longer-lived signed URL for a session and encodes a readonly
// share token. Default TTL 24h so a teammate can view while the owner is offline.
func (s *Supervisor) Share(ctx context.Context, sandboxID string, ttlSec int, projectName string) (*ShareResult, error) {
	sess := s.get(sandboxID)
	if sess == nil {
		return nil, nil
	}
	if ttlSec <= 0 {
		ttlSec = 24 * 60 * 60
	}
	client, err := s.client()
	if err != nil {
		return nil, err
	}
	signedURL, err := s.signedPreview(ctx, client, sandboxID, ttlSec)
	if err != nil {
		return nil, err
	}
	payload := SharePayload{
		V:           1,
		PreviewURL:  signedURL,
		SandboxID:   sandboxID,
		SessionID:   sess.SessionID,
		Harness:     sess.Harness,
		ProjectName: projectName,
		Mode:        "readonly",
	}
	buf, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	token := base64.RawURLEncoding.EncodeToString(buf)
	s.logf("minted readonly share for sandbox %s (ttl %ds)", shortID(sandboxID), ttlSec)
	return &ShareResult{Token: token, ExpiresInSec: ttlSec}, nil
}

// SessionStatus fetches a session's live view from its sandbox daemon. A 404
// prunes the ghost so callers stop trying.
func (s *Supervisor) SessionStatus(ctx context.Context, sandboxID string) (json.RawMessage, error) {
	sess := s.get(sandboxID)
	if sess == nil {
		return nil, nil
	}
	// Still provisioning (or failed) → no sandbox session view yet.
	if sess.Status != StatusReady || sess.SessionID == "" || sess.PreviewURL == "" {
		return nil, nil
	}
	raw, err := s.api(ctx, sess.PreviewURL, "GET", "/api/v1/sessions/"+sess.SessionID, nil)
	if err != nil {
		if isNotFound(err) {
			s.mu.Lock()
			delete(s.sessions, sandboxID)
			s.mu.Unlock()
			s.save()
			return nil, nil
		}
		return nil, err
	}
	return raw, nil
}

// ListSessions returns the live registry for clients to merge into their board.
func (s *Supervisor) ListSessions() []CloudSession {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]CloudSession, 0, len(s.sessions))
	for _, v := range s.sessions {
		out = append(out, *v)
	}
	return out
}

// ListSessionsForTenant returns only the sessions owned by tenantID — the
// control plane's per-tenant view. An empty tenantID matches sessions with no
// tenant (the local-daemon case).
func (s *Supervisor) ListSessionsForTenant(tenantID string) []CloudSession {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]CloudSession, 0)
	for _, v := range s.sessions {
		if v.TenantID == tenantID {
			out = append(out, *v)
		}
	}
	return out
}

// OwnsSandbox reports whether tenantID owns the given sandbox — the guard the
// control plane uses before status/view/share/terminate so a tenant can't touch
// another tenant's sandbox.
func (s *Supervisor) OwnsSandbox(tenantID, sandboxID string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	v := s.sessions[sandboxID]
	return v != nil && v.TenantID == tenantID
}

// Terminate tears a sandbox down and drops it from the registry.
// Terminate kills a cloud session: it deletes the Daytona sandbox (stopping
// billing and destroying the worker) and marks the registry entry "terminated"
// — KEEPING it so the board renders a terminated card, exactly like a local
// killed session lingers as an archived card. Use Remove to drop it entirely.
func (s *Supervisor) Terminate(ctx context.Context, sandboxID string) error {
	sess := s.get(sandboxID)
	if sess == nil {
		return nil
	}
	s.mu.Lock()
	if cur := s.sessions[sandboxID]; cur != nil {
		cur.Status = StatusTerminated
		cur.PreviewURL = "" // sandbox is gone; no live view
	}
	s.mu.Unlock()
	s.save()
	if s.cfg.OnSessionEnded != nil {
		s.cfg.OnSessionEnded(*sess) // pre-teardown snapshot (still has SessionID)
	}
	client, err := s.client()
	if err != nil {
		return err
	}
	return client.Delete(ctx, sandboxID)
}

// Remove drops a session from the registry entirely (board cleanup). Deletes the
// sandbox too if it somehow still exists.
func (s *Supervisor) Remove(ctx context.Context, sandboxID string) error {
	if s.get(sandboxID) == nil {
		return nil
	}
	s.mu.Lock()
	delete(s.sessions, sandboxID)
	s.mu.Unlock()
	s.save()
	if client, err := s.client(); err == nil {
		_ = client.Delete(ctx, sandboxID)
	}
	return nil
}

// ── sandbox daemon HTTP + project/session helpers ───────────────────────────

// cloneSpec describes how to reproduce a local project's repo inside a sandbox:
// the origin remote (normalized to https) and the branch to check out.
type cloneSpec struct {
	RemoteURL string
	Branch    string
}

// gitCloneSpec inspects a LOCAL git repo and returns how to clone it into a
// sandbox. Empty RemoteURL → the caller falls back to an empty init.
func gitCloneSpec(localPath string) cloneSpec {
	return cloneSpec{
		RemoteURL: normalizeGitURL(runGit(localPath, "remote", "get-url", "origin")),
		Branch:    runGit(localPath, "rev-parse", "--abbrev-ref", "HEAD"),
	}
}

func runGit(dir string, args ...string) string {
	out, err := exec.Command("git", append([]string{"-C", dir}, args...)...).Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

// normalizeGitURL converts an SSH git remote to its https form so the sandbox
// clones over https (with a token if one is available). Already-https URLs and
// unknown schemes pass through unchanged.
// redactURLUserinfo strips any user:password@ from an https URL so an inline
// token can't leak into an error string. Non-URL input is returned unchanged.
func redactURLUserinfo(raw string) string {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.User == nil {
		return raw
	}
	u.User = nil
	return u.String()
}

func normalizeGitURL(raw string) string {
	raw = strings.TrimSpace(raw)
	switch {
	case raw == "":
		return ""
	case strings.HasPrefix(raw, "git@"): // git@github.com:owner/repo.git
		return "https://" + strings.Replace(strings.TrimPrefix(raw, "git@"), ":", "/", 1)
	case strings.HasPrefix(raw, "ssh://git@"): // ssh://git@github.com/owner/repo.git
		return "https://" + strings.TrimPrefix(raw, "ssh://git@")
	default:
		return raw
	}
}

// githubToken resolves a GitHub token from the daemon's environment (never
// logged) so the sandbox can clone private repos and push PRs. Best-effort.
func githubToken() string {
	for _, k := range []string{"GITHUB_TOKEN", "GH_TOKEN"} {
		if t := strings.TrimSpace(os.Getenv(k)); t != "" {
			return t
		}
	}
	if out, err := exec.Command("gh", "auth", "token").Output(); err == nil {
		return strings.TrimSpace(string(out))
	}
	return ""
}

// prepareProject makes the project available inside the sandbox at projectPath.
// It ensures git is installed, then clones the project's real remote (so a cloud
// session sees the same code a local one does) and checks out its branch. With
// no usable remote it falls back to an empty repo. A host GitHub token, if
// present, is stored in the sandbox so clone (private) and push (PRs) both work.
func (s *Supervisor) prepareProject(ctx context.Context, client SandboxProvider, box Sandbox, projectPath string, spec cloneSpec) error {
	sh := func(cmd string, timeoutSec int) error {
		r, e := client.Exec(ctx, box, ExecuteRequest{Command: "bash -lc " + shQuote(cmd), Timeout: timeoutSec})
		if e != nil {
			return e
		}
		if r.ExitCode != 0 {
			return fmt.Errorf("rc=%d: %s", r.ExitCode, tail(r.Result, 400))
		}
		return nil
	}

	// git is on the daytona-small snapshot, but ensure it (cheap no-op if present).
	if err := sh("command -v git >/dev/null || (sudo apt-get update -qq && sudo apt-get install -y -qq git) >/dev/null 2>&1; git --version", 300); err != nil {
		return fmt.Errorf("cloud: ensure git: %w", err)
	}

	// Ensure the GitHub CLI (gh) — agents use it for PRs/issues. Best-effort: a
	// transient apt failure must not sink the whole sandbox (the agent falls back
	// to plain git / local work). Runs for every harness, incl. the pre-baked
	// snapshot which skips recipe Install steps.
	ensureGH := "command -v gh >/dev/null 2>&1 || { " +
		"(type -p curl >/dev/null 2>&1 || (sudo apt-get update -qq && sudo apt-get install -y -qq curl)) && " +
		"sudo mkdir -p -m 755 /etc/apt/keyrings && " +
		"curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo dd of=/etc/apt/keyrings/githubcli-archive-keyring.gpg 2>/dev/null && " +
		"sudo chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg && " +
		"echo \"deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main\" | sudo tee /etc/apt/sources.list.d/github-cli.list >/dev/null && " +
		"sudo apt-get update -qq && sudo apt-get install -y -qq gh; }"
	_ = sh(ensureGH+" ; gh --version >/dev/null 2>&1 || true", 300)

	q := shQuote(projectPath)

	// Authenticate git + gh with the host token so clone (private), push (PRs), and
	// gh commands all work — for BOTH the remote and remote-less paths (a scratch
	// project may still create a repo/remote). Errors are redacted so the token
	// never reaches a log line.
	if tok := githubToken(); tok != "" {
		seed := fmt.Sprintf(
			"git config --global credential.helper store && printf 'https://x-access-token:%%s@github.com\\n' %s > ~/.git-credentials && chmod 600 ~/.git-credentials",
			shQuote(tok),
		)
		if err := sh(seed, 60); err != nil {
			return fmt.Errorf("cloud: seed git credentials: %w", err)
		}
		// Persist gh auth (writes ~/.config/gh/hosts.yml) so `gh` works headless.
		_ = sh(fmt.Sprintf("printf '%%s' %s | gh auth login --with-token >/dev/null 2>&1 && gh auth setup-git >/dev/null 2>&1 || true", shQuote(tok)), 60)
	}

	if spec.RemoteURL == "" {
		// No remote to clone — empty init (a scratch/local-only project).
		if err := sh(fmt.Sprintf("mkdir -p %s && cd %s && (git rev-parse --git-dir >/dev/null 2>&1 || (git init -q && git commit -q --allow-empty -m 'ao cloud init'))", q, q), 60); err != nil {
			return fmt.Errorf("cloud: init project: %w", err)
		}
		return nil
	}

	// Clone if the dir isn't already a repo. Errors are redacted to the exit code
	// so a token in a credential prompt can never reach a log line.
	clone := fmt.Sprintf("if [ ! -d %s/.git ]; then git clone %s %s; fi", q, shQuote(spec.RemoteURL), q)
	if err := sh(clone, 600); err != nil {
		// Redact any userinfo (an inline token) before the URL reaches a persisted
		// / client-returned error. (Audit #12.)
		return fmt.Errorf("cloud: clone %s failed (see sandbox)", redactURLUserinfo(spec.RemoteURL))
	}
	// Check out the local branch if it exists on the remote; otherwise stay on the
	// default branch. Best-effort — a cloud session sees PUSHED state, not local
	// uncommitted work.
	if spec.Branch != "" && spec.Branch != "HEAD" {
		_ = sh(fmt.Sprintf("cd %s && git checkout %s 2>/dev/null || true", q, shQuote(spec.Branch)), 60)
	}
	return nil
}

func (s *Supervisor) ensureProject(ctx context.Context, previewURL, sandboxPath string) (string, error) {
	raw, err := s.api(ctx, previewURL, "POST", "/api/v1/projects", map[string]any{"path": sandboxPath})
	if err != nil {
		// PATH_ALREADY_REGISTERED carries the existing id in details.
		if id := existingProjectID(err.Error()); id != "" {
			return id, nil
		}
		return "", err
	}
	var resp struct {
		Project struct {
			ID        string `json:"id"`
			ProjectID string `json:"projectId"`
		} `json:"project"`
		ID string `json:"id"`
	}
	_ = json.Unmarshal(raw, &resp)
	switch {
	case resp.Project.ID != "":
		return resp.Project.ID, nil
	case resp.Project.ProjectID != "":
		return resp.Project.ProjectID, nil
	case resp.ID != "":
		return resp.ID, nil
	}
	return "", fmt.Errorf("cloud: project create returned no id")
}

func (s *Supervisor) createSession(ctx context.Context, previewURL, projectID string, in SpawnInput) (string, error) {
	// POST /sessions accepts kind=orchestrator with an EXPLICIT harness (exactly
	// what `ao spawn --kind orchestrator --harness …` does). We pass the harness
	// directly rather than using the dedicated /orchestrators route, because that
	// route resolves the agent from the project's orchestrator.agent config — which
	// a freshly-cloned sandbox project doesn't have (→ AGENT_REQUIRED).
	kind := in.Kind
	if kind == "" {
		kind = "worker"
	}
	body := map[string]any{
		"projectId":   projectID,
		"kind":        kind,
		"harness":     in.Harness,
		"prompt":      in.Prompt,
		"displayName": in.DisplayName,
		"branch":      in.Branch,
	}
	raw, err := s.api(ctx, previewURL, "POST", "/api/v1/sessions", body)
	if err != nil {
		return "", err
	}
	var resp struct {
		Session struct {
			ID string `json:"id"`
		} `json:"session"`
	}
	if err := json.Unmarshal(raw, &resp); err != nil || resp.Session.ID == "" {
		return "", fmt.Errorf("cloud: session create returned no id: %s", tail(string(raw), 300))
	}
	return resp.Session.ID, nil
}

// api calls the sandbox daemon over its signed preview URL (token embedded in the
// URL, so no auth header is needed).
func (s *Supervisor) api(ctx context.Context, previewURL, method, apiPath string, body any) (json.RawMessage, error) {
	var reqBody io.Reader
	if body != nil {
		buf, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		reqBody = bytes.NewReader(buf)
	}
	req, err := http.NewRequestWithContext(ctx, method, strings.TrimRight(previewURL, "/")+apiPath, reqBody)
	if err != nil {
		return nil, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("Accept", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("cloud daemon %s %s: %w", method, apiPath, err)
	}
	defer func() { _ = resp.Body.Close() }()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("cloud daemon %s %s -> %d: %s", method, apiPath, resp.StatusCode, tail(string(raw), 300))
	}
	return raw, nil
}

// ── credential porting ──────────────────────────────────────────────────────

func (s *Supervisor) portCredentials(ctx context.Context, client SandboxProvider, box Sandbox, recipe Recipe, sh func(string, int) (string, error), injectedCred string) error {
	for _, pf := range recipe.Auth.PortedFiles {
		// A caller-supplied credential (spawn-time injection) wins over any
		// server-side source, so the hosted control plane needs no stored copy.
		// It applies to the harness's credential file — the ported file that has
		// local credential sources.
		var bytesData []byte
		if injectedCred != "" && len(pf.Local) > 0 {
			bytesData = []byte(injectedCred)
		} else {
			resolved, ok := resolveLocalCredential(pf)
			if !ok {
				return fmt.Errorf("cloud: no credential for %s (%s); pass one at spawn or authenticate locally first", recipe.ID, pf.Remote)
			}
			bytesData = resolved
		}
		if dir := path.Dir(pf.Remote); dir != "." && dir != "" {
			if _, err := sh(fmt.Sprintf("mkdir -p /home/daytona/%s && chmod 700 /home/daytona/%s", dir, dir), 60); err != nil {
				return err
			}
		}
		if err := client.UploadFile(ctx, box, "/home/daytona/"+pf.Remote, bytesData); err != nil {
			return err
		}
		if pf.Mode != "" {
			if _, err := sh(fmt.Sprintf("chmod %s /home/daytona/%s", pf.Mode, pf.Remote), 60); err != nil {
				return err
			}
		}
	}
	for _, seed := range recipe.HeadlessSeed {
		if dir := path.Dir(seed.Remote); dir != "." && dir != "" {
			if _, err := sh("mkdir -p /home/daytona/"+dir, 60); err != nil {
				return err
			}
		}
		buf, err := json.Marshal(seed.JSON)
		if err != nil {
			return err
		}
		if err := client.UploadFile(ctx, box, "/home/daytona/"+seed.Remote, buf); err != nil {
			return err
		}
	}
	return nil
}

// resolveLocalCredential reads a credential from the first source that resolves:
// a file under $HOME, then (macOS) a Keychain generic-password.
func resolveLocalCredential(pf PortedFile) ([]byte, bool) {
	home, _ := os.UserHomeDir()
	for _, src := range pf.Local {
		if src.EnvVar != "" {
			if v := strings.TrimSpace(os.Getenv(src.EnvVar)); v != "" {
				return []byte(v), true
			}
		}
		if src.HomePath != "" {
			p := filepath.Join(home, src.HomePath)
			if data, err := os.ReadFile(p); err == nil && len(data) > 0 {
				return data, true
			}
		}
		if src.MacKeychainService != "" && runtime.GOOS == "darwin" {
			out, err := exec.Command("security", "find-generic-password", "-s", src.MacKeychainService, "-w").Output()
			if err == nil {
				trimmed := bytes.TrimSpace(out)
				if len(trimmed) > 0 {
					return trimmed, true
				}
			}
		}
	}
	return nil, false
}

// ── registry persistence (restore-after-restart) ────────────────────────────

func (s *Supervisor) get(sandboxID string) *CloudSession {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.sessions[sandboxID]
}

// save persists the durable identity of each session. Preview URLs are
// deliberately NOT persisted: a signed preview URL is a full-control bearer
// secret for the sandbox, and it expires — Restore re-mints a fresh one. (Audit
// #8: previously the whole struct, including PreviewURL, was written.) Best-effort.
func (s *Supervisor) save() {
	s.mu.Lock()
	rows := make([]CloudSession, 0, len(s.sessions))
	for _, v := range s.sessions {
		row := *v
		row.PreviewURL = "" // never persist the signed preview bearer
		rows = append(rows, row)
	}
	s.mu.Unlock()
	_ = s.cfg.Store.Save(rows)
}

// Restore re-attaches sandboxes that survived an app restart: for each persisted
// session still running, re-acquire a fresh preview URL. Idempotent.
func (s *Supervisor) Restore(ctx context.Context) {
	s.mu.Lock()
	if s.restored {
		s.mu.Unlock()
		return
	}
	s.restored = true
	s.mu.Unlock()

	if s.cfg.APIKey() == "" {
		return
	}
	rows, err := s.cfg.Store.Load()
	if err != nil || len(rows) == 0 {
		return
	}
	client, err := s.client()
	if err != nil {
		return
	}
	for _, row := range rows {
		// Terminated sessions have no sandbox — keep them as archived cards
		// (matching local terminated sessions that persist across restart).
		if row.Status == StatusTerminated {
			r := row
			r.PreviewURL = ""
			s.mu.Lock()
			s.sessions[row.SandboxID] = &r
			s.mu.Unlock()
			continue
		}
		// Only re-attach sessions that had fully provisioned (have a session id).
		// A row persisted mid-provisioning has no live goroutine after a restart.
		if row.SessionID == "" {
			continue
		}
		box, err := client.Get(ctx, row.SandboxID)
		if err != nil {
			continue // sandbox gone → drop it
		}
		if box.Stopped() {
			_ = client.Start(ctx, row.SandboxID)
		}
		signedURL, err := s.signedPreview(ctx, client, row.SandboxID, 30*60)
		if err != nil {
			continue
		}
		r := row
		r.PreviewURL = signedURL
		r.Status = StatusReady
		s.mu.Lock()
		s.sessions[row.SandboxID] = &r
		s.mu.Unlock()
		s.notifyReady(row.SandboxID)
		s.logf("restored cloud session %s (sandbox %s)", row.SessionID, shortID(row.SandboxID))
	}
	s.save()
}

// ── small helpers ───────────────────────────────────────────────────────────

func baseNameOr(p, fallback string) string {
	b := filepath.Base(p)
	if b == "." || b == "/" || b == "" {
		return fallback
	}
	return b
}

func shQuote(s string) string { return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'" }

func envAssignments(env map[string]string) string {
	parts := make([]string, 0, len(env))
	for k, v := range env {
		parts = append(parts, k+"="+shQuote(v))
	}
	return strings.Join(parts, " ")
}

func tail(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[len(s)-n:]
}

func shortID(id string) string {
	if len(id) > 8 {
		return id[:8]
	}
	return id
}

func isNotFound(err error) bool {
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "not found") || strings.Contains(msg, "404")
}

func existingProjectID(errMsg string) string {
	const key = `"existingProjectId":"`
	i := strings.Index(errMsg, key)
	if i < 0 {
		return ""
	}
	rest := errMsg[i+len(key):]
	if j := strings.IndexByte(rest, '"'); j >= 0 {
		return rest[:j]
	}
	return ""
}
