// Package candidaterun connects Agent Orchestrator to the external
// digest-bound fixture candidate-run kernel in observer mode. AO remains the
// dispatcher; the sidecar can only configure the run journal and observe
// AO-native lifecycle facts.
package candidaterun

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

//go:embed observer.mjs
var observerProgram string

var (
	sha256Pattern = regexp.MustCompile(`^[0-9a-f]{64}$`)
	issuePattern  = regexp.MustCompile(`^github:([^/\s]+/[^#\s]+)#([1-9]\d*)$`)
)

type binding struct {
	SchemaVersion    int             `json:"schemaVersion"`
	NodeBinary       string          `json:"nodeBinary"`
	JournalDirectory string          `json:"journalDirectory"`
	Kernel           kernelBinding   `json:"kernel"`
	ControllerClaim  controllerClaim `json:"controllerClaim"`
	Codex            codexBinding    `json:"codex"`
	ActivationRaw    json.RawMessage `json:"activationProfile"`
	PreparedRaw      json.RawMessage `json:"prepared"`
	activation       activationProfile
	prepared         preparedRun
}

type kernelBinding struct {
	ModulePath string `json:"modulePath"`
	SHA256     string `json:"sha256"`
}

type controllerClaim struct {
	EventID   string `json:"eventId"`
	ClaimID   string `json:"claimId"`
	ClaimedAt string `json:"claimedAt"`
}

type codexBinding struct {
	Harness        string `json:"harness"`
	ApprovalPolicy string `json:"approvalPolicy"`
}

type activationProfile struct {
	SchemaVersion int    `json:"schemaVersion"`
	CandidateSlug string `json:"candidateSlug"`
	Model         string `json:"model"`
	Effort        string `json:"effort"`
	Sandbox       string `json:"sandbox"`
}

type preparedRun struct {
	CandidateSlug           string         `json:"candidateSlug"`
	RunID                   string         `json:"runId"`
	Scenario                string         `json:"scenario"`
	Repository              string         `json:"repository"`
	ControllerOwner         string         `json:"controllerOwner"`
	Dispatcher              string         `json:"dispatcher"`
	ActivationProfileDigest string         `json:"activationProfileDigest"`
	Tasks                   []preparedTask `json:"tasks"`
}

type preparedTask struct {
	Slot             string `json:"slot"`
	IssueNumber      int    `json:"issueNumber"`
	SchedulingOrder  *int   `json:"schedulingOrder"`
	IdempotencyKey   string `json:"idempotencyKey"`
	AllocationKey    string `json:"allocationKey"`
	SourceWriterMode string `json:"sourceWriterMode"`
	Branch           string `json:"branch"`
}

type readyFrame struct {
	Type                 string `json:"type"`
	ControllerInstanceID string `json:"controllerInstanceId"`
}

type responseFrame struct {
	ID     int64           `json:"id"`
	OK     bool            `json:"ok"`
	Result json.RawMessage `json:"result,omitempty"`
	Error  string          `json:"error,omitempty"`
}

type observedTask struct {
	claim          ports.CandidateRunClaim
	receipt        ports.CandidateRunAllocationReceipt
	startRequested bool
	started        bool
	stopped        bool
	pullRequests   map[string]bool
}

// Client owns one long-lived observer sidecar and serializes all frames over
// its stdio pipes. It is safe for concurrent callers.
type Client struct {
	binding              binding
	controllerInstanceID string
	command              *exec.Cmd
	stdin                io.WriteCloser
	scanner              *bufio.Scanner
	stderr               *bytes.Buffer
	logger               *slog.Logger
	clock                func() time.Time

	mu       sync.Mutex
	nextID   int64
	closed   bool
	stateMu  sync.Mutex
	claimed  map[string]ports.CandidateRunClaim
	sessions map[domain.SessionID]*observedTask
}

var _ ports.CandidateRunStarter = (*Client)(nil)

// Open validates the non-secret binding, starts the embedded observer bridge,
// and waits for the kernel's durable run-configuration acknowledgement.
func Open(ctx context.Context, configPath string, logger *slog.Logger) (*Client, error) {
	cfg, err := loadBinding(configPath)
	if err != nil {
		return nil, err
	}
	if logger == nil {
		logger = slog.Default()
	}
	cmd := exec.CommandContext(
		ctx,
		cfg.NodeBinary,
		"--input-type=module",
		"--eval",
		observerProgram,
		"--",
		configPath,
	)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, fmt.Errorf("candidate run observer stdin: %w", err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, fmt.Errorf("candidate run observer stdout: %w", err)
	}
	stderr := &bytes.Buffer{}
	cmd.Stderr = stderr
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("candidate run observer start: %w", err)
	}
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 4096), 1024*1024)
	if !scanner.Scan() {
		waitErr := cmd.Wait()
		return nil, sidecarExitError("candidate run observer configure", scanner.Err(), waitErr, stderr.String())
	}
	var ready readyFrame
	if err := json.Unmarshal(scanner.Bytes(), &ready); err != nil {
		_ = stdin.Close()
		_ = cmd.Wait()
		return nil, fmt.Errorf("candidate run observer ready frame: %w", err)
	}
	if ready.Type != "ready" || strings.TrimSpace(ready.ControllerInstanceID) == "" {
		_ = stdin.Close()
		_ = cmd.Wait()
		return nil, errors.New("candidate run observer returned an invalid ready frame")
	}
	return &Client{
		binding:              cfg,
		controllerInstanceID: ready.ControllerInstanceID,
		command:              cmd,
		stdin:                stdin,
		scanner:              scanner,
		stderr:               stderr,
		logger:               logger,
		clock:                func() time.Time { return time.Now().UTC() },
		claimed:              map[string]ports.CandidateRunClaim{},
		sessions:             map[domain.SessionID]*observedTask{},
	}, nil
}

// ExecutionProfile returns the exact non-secret Codex runtime binding.
func (c *Client) ExecutionProfile() ports.CandidateRunExecutionProfile {
	return ports.CandidateRunExecutionProfile{
		Harness:        domain.AgentHarness(c.binding.Codex.Harness),
		Model:          c.binding.activation.Model,
		Effort:         c.binding.activation.Effort,
		Sandbox:        c.binding.activation.Sandbox,
		ApprovalPolicy: c.binding.Codex.ApprovalPolicy,
	}
}

// Claim durably acknowledges AO's task claim before any session row or native
// workspace can be created.
func (c *Client) Claim(ctx context.Context, request ports.CandidateRunClaimRequest) (ports.CandidateRunClaim, error) {
	c.stateMu.Lock()
	defer c.stateMu.Unlock()
	repository, issueNumber, err := parseCanonicalIssueID(request.IssueID)
	if err != nil {
		return ports.CandidateRunClaim{}, err
	}
	if repository != c.binding.prepared.Repository {
		return ports.CandidateRunClaim{}, fmt.Errorf("candidate run issue repository %q does not match prepared repository", repository)
	}
	var task *preparedTask
	for i := range c.binding.prepared.Tasks {
		if c.binding.prepared.Tasks[i].IssueNumber == issueNumber {
			task = &c.binding.prepared.Tasks[i]
			break
		}
	}
	if task == nil {
		return ports.CandidateRunClaim{}, fmt.Errorf("candidate run issue %d is not a prepared task", issueNumber)
	}
	if branch := strings.TrimSpace(request.RequestedBranch); branch != "" && branch != task.Branch {
		return ports.CandidateRunClaim{}, fmt.Errorf("candidate run requested branch %q does not match prepared branch %q", branch, task.Branch)
	}
	if _, exists := c.claimed[task.Slot]; exists {
		return ports.CandidateRunClaim{}, fmt.Errorf("candidate run task %s is already claimed by this AO process", task.Slot)
	}
	instanceDigest := sha256.Sum256([]byte(c.controllerInstanceID))
	claim := ports.CandidateRunClaim{
		Slot:                 task.Slot,
		ClaimID:              fmt.Sprintf("agent-orchestrator:%s:%s:%s", c.binding.prepared.RunID, task.Slot, hex.EncodeToString(instanceDigest[:6])),
		ControllerInstanceID: c.controllerInstanceID,
		Repository:           c.binding.prepared.Repository,
		IssueNumber:          task.IssueNumber,
		Branch:               task.Branch,
		AllocationKey:        task.AllocationKey,
		IdempotencyKey:       task.IdempotencyKey,
		SourceWriterMode:     task.SourceWriterMode,
	}
	at := c.clock().UTC().Format(time.RFC3339Nano)
	event := map[string]any{
		"eventId": "claim:" + task.Slot + ":" + hex.EncodeToString(instanceDigest[:6]),
		"type":    "task-claimed",
		"slot":    task.Slot,
		"at":      at,
		"payload": map[string]any{
			"claimId":                    claim.ClaimID,
			"dispatcher":                 c.binding.prepared.Dispatcher,
			"controllerInstanceId":       c.controllerInstanceID,
			"continuationTriggerEventId": nil,
			"allocationKey":              task.AllocationKey,
			"idempotencyKey":             task.IdempotencyKey,
		},
	}
	if err := c.observe(ctx, event); err != nil {
		return ports.CandidateRunClaim{}, fmt.Errorf("candidate run claim %s: %w", task.Slot, err)
	}
	c.claimed[task.Slot] = claim
	return claim, nil
}

// RecordAllocation records the native worktree result before AO provisions the
// workspace or asks an agent adapter for a launch command.
func (c *Client) RecordAllocation(
	ctx context.Context,
	claim ports.CandidateRunClaim,
	sessionID domain.SessionID,
	workspace string,
) error {
	c.stateMu.Lock()
	defer c.stateMu.Unlock()
	preparedClaim, ok := c.claimed[claim.Slot]
	if !ok || preparedClaim.ClaimID != claim.ClaimID {
		return fmt.Errorf("candidate run allocation has no acknowledged claim for slot %s", claim.Slot)
	}
	if strings.TrimSpace(string(sessionID)) == "" {
		return errors.New("candidate run allocation runtime task ID is required")
	}
	if !filepath.IsAbs(workspace) {
		return errors.New("candidate run allocation workspace must be absolute")
	}
	if _, exists := c.sessions[sessionID]; exists {
		return fmt.Errorf("candidate run session %s already has an allocation", sessionID)
	}
	receipt := ports.CandidateRunAllocationReceipt{
		SchemaVersion:   1,
		Slot:            claim.Slot,
		AllocationKey:   claim.AllocationKey,
		ClaimID:         claim.ClaimID,
		RuntimeTaskID:   string(sessionID),
		RuntimeHostID:   nil,
		Workspace:       workspace,
		RequestedBranch: claim.Branch,
		SourceWriter:    "agent-orchestrator:" + string(sessionID),
		AllocatedAt:     c.clock().UTC().Format(time.RFC3339Nano),
	}
	event := map[string]any{
		"eventId": "allocation:" + claim.Slot + ":" + claim.ClaimID,
		"type":    "task-allocated",
		"slot":    claim.Slot,
		"at":      receipt.AllocatedAt,
		"payload": map[string]any{"allocationReceipt": receipt},
	}
	if err := c.observe(ctx, event); err != nil {
		return fmt.Errorf("candidate run allocation %s: %w", claim.Slot, err)
	}
	c.sessions[sessionID] = &observedTask{
		claim:        claim,
		receipt:      receipt,
		pullRequests: map[string]bool{},
	}
	return nil
}

// RecordSessionStartRequested records runtime launch intent synchronously
// before AO invokes the native runtime adapter.
func (c *Client) RecordSessionStartRequested(ctx context.Context, sessionID domain.SessionID) error {
	c.stateMu.Lock()
	defer c.stateMu.Unlock()
	task, ok := c.sessions[sessionID]
	if !ok {
		return fmt.Errorf("candidate run session %s has no allocation", sessionID)
	}
	if task.startRequested {
		return fmt.Errorf("candidate run session %s already recorded start intent", sessionID)
	}
	at := c.clock().UTC().Format(time.RFC3339Nano)
	event := map[string]any{
		"eventId": "session-start-request:" + task.claim.Slot + ":" + task.claim.ClaimID,
		"type":    "session-start-requested",
		"slot":    task.claim.Slot,
		"at":      at,
		"payload": map[string]any{
			"allocationReceiptDigest": canonicalDigest(task.receipt),
			"claimId":                 task.claim.ClaimID,
			"dispatcher":              c.binding.prepared.Dispatcher,
			"mode":                    "observer",
		},
	}
	if err := c.observe(ctx, event); err != nil {
		return fmt.Errorf("candidate run start intent %s: %w", sessionID, err)
	}
	task.startRequested = true
	return nil
}

// RecordSessionStarted records the returned native runtime handle after
// RecordSessionStartRequested has been durably acknowledged.
func (c *Client) RecordSessionStarted(ctx context.Context, sessionID domain.SessionID) error {
	c.stateMu.Lock()
	defer c.stateMu.Unlock()
	task, ok := c.sessions[sessionID]
	if !ok || !task.startRequested {
		return fmt.Errorf("candidate run session %s has no acknowledged start intent", sessionID)
	}
	if task.started {
		return fmt.Errorf("candidate run session %s is already started", sessionID)
	}
	at := c.clock().UTC().Format(time.RFC3339Nano)
	event := map[string]any{
		"eventId": "session:" + task.claim.Slot + ":" + task.claim.ClaimID,
		"type":    "session-started",
		"slot":    task.claim.Slot,
		"at":      at,
		"payload": map[string]any{"sessionId": string(sessionID)},
	}
	if err := c.observe(ctx, event); err != nil {
		return fmt.Errorf("candidate run session started %s: %w", sessionID, err)
	}
	task.started = true
	return nil
}

// RecordPullRequest records a provider observation only after AO's own session
// has started. Repository, issue, and branch binding are revalidated by the
// external kernel before the event is acknowledged.
func (c *Client) RecordPullRequest(
	ctx context.Context,
	sessionID domain.SessionID,
	observation ports.SCMObservation,
) error {
	c.stateMu.Lock()
	defer c.stateMu.Unlock()
	task, ok := c.sessions[sessionID]
	if !ok || !task.started {
		return fmt.Errorf("candidate run session %s is not started", sessionID)
	}
	url := strings.TrimSpace(observation.PR.URL)
	if url == "" {
		url = strings.TrimSpace(observation.PR.HTMLURL)
	}
	if observation.PR.Number < 1 || url == "" {
		return errors.New("candidate run pull request number and URL are required")
	}
	if task.pullRequests[url] {
		return nil
	}
	at := observation.ObservedAt.UTC()
	if at.IsZero() {
		at = c.clock().UTC()
	}
	event := map[string]any{
		"eventId": fmt.Sprintf("pr:%s:%d", task.claim.Slot, observation.PR.Number),
		"type":    "pull-request-opened",
		"slot":    task.claim.Slot,
		"at":      at.Format(time.RFC3339Nano),
		"payload": map[string]any{
			"repository":  observation.Repo,
			"issueNumber": task.claim.IssueNumber,
			"branch":      observation.PR.SourceBranch,
			"url":         url,
		},
	}
	if err := c.observe(ctx, event); err != nil {
		return fmt.Errorf("candidate run pull request %s: %w", url, err)
	}
	task.pullRequests[url] = true
	return nil
}

// RecordStopped appends worker and zero-running-descendant evidence only after
// the native runtime adapter has returned a complete teardown proof.
func (c *Client) RecordStopped(
	ctx context.Context,
	sessionID domain.SessionID,
	reason string,
	proof ports.RuntimeStopProof,
) error {
	c.stateMu.Lock()
	defer c.stateMu.Unlock()
	task, ok := c.sessions[sessionID]
	if !ok || !task.started {
		return fmt.Errorf("candidate run session %s is not started", sessionID)
	}
	if task.stopped {
		return nil
	}
	if strings.TrimSpace(reason) == "" || strings.TrimSpace(proof.ProcessID) == "" {
		return errors.New("candidate run stop reason and process ID are required")
	}
	if proof.DescendantsRunning != 0 {
		return fmt.Errorf("candidate run stop has %d running descendants", proof.DescendantsRunning)
	}
	for _, id := range proof.DescendantIDs {
		if strings.TrimSpace(id) == "" {
			return errors.New("candidate run stop descendant IDs must be nonblank")
		}
	}
	at := c.clock().UTC().Format(time.RFC3339Nano)
	workerEvent := map[string]any{
		"eventId": "stop:" + task.claim.Slot + ":" + string(sessionID),
		"type":    "worker-stopped",
		"slot":    task.claim.Slot,
		"at":      at,
		"payload": map[string]any{
			"processId": proof.ProcessID,
			"reason":    reason,
			"sessionId": string(sessionID),
		},
	}
	if err := c.observe(ctx, workerEvent); err != nil {
		return fmt.Errorf("candidate run worker stop %s: %w", sessionID, err)
	}
	descendantEvent := map[string]any{
		"eventId": "descendants:" + task.claim.Slot + ":" + string(sessionID),
		"type":    "descendants-stopped",
		"slot":    task.claim.Slot,
		"at":      at,
		"payload": map[string]any{
			"descendantIds":      proof.DescendantIDs,
			"descendantsRunning": proof.DescendantsRunning,
			"processId":          proof.ProcessID,
		},
	}
	if err := c.observe(ctx, descendantEvent); err != nil {
		return fmt.Errorf("candidate run descendant stop %s: %w", sessionID, err)
	}
	task.stopped = true
	return nil
}

func (c *Client) observe(ctx context.Context, event map[string]any) error {
	var result json.RawMessage
	return c.request(ctx, "observe", map[string]any{"event": event}, &result)
}

func canonicalDigest(value any) string {
	raw, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	var canonical any
	if err := json.Unmarshal(raw, &canonical); err != nil {
		panic(err)
	}
	raw, err = json.Marshal(canonical)
	if err != nil {
		panic(err)
	}
	digest := sha256.Sum256(raw)
	return hex.EncodeToString(digest[:])
}

func (c *Client) request(ctx context.Context, method string, params, result any) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return err
	}
	if c.closed {
		return errors.New("candidate run observer is closed")
	}
	c.nextID++
	request := map[string]any{"id": c.nextID, "method": method, "params": params}
	frame, err := json.Marshal(request)
	if err != nil {
		return err
	}
	if _, err := c.stdin.Write(append(frame, '\n')); err != nil {
		return fmt.Errorf("candidate run observer write: %w", err)
	}
	if !c.scanner.Scan() {
		return sidecarExitError("candidate run observer response", c.scanner.Err(), nil, c.stderr.String())
	}
	var response responseFrame
	if err := json.Unmarshal(c.scanner.Bytes(), &response); err != nil {
		return fmt.Errorf("candidate run observer response frame: %w", err)
	}
	if response.ID != c.nextID {
		return fmt.Errorf("candidate run observer response id %d does not match request %d", response.ID, c.nextID)
	}
	if !response.OK {
		if strings.TrimSpace(response.Error) == "" {
			return errors.New("candidate run observer rejected request")
		}
		return errors.New(response.Error)
	}
	if result != nil && len(response.Result) > 0 {
		if err := json.Unmarshal(response.Result, result); err != nil {
			return fmt.Errorf("candidate run observer result: %w", err)
		}
	}
	return nil
}

// Close ends the sidecar without issuing a kernel stop operation. Observer mode
// owns no run stop authority.
func (c *Client) Close() error {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return nil
	}
	c.closed = true
	stdin := c.stdin
	cmd := c.command
	c.mu.Unlock()
	if err := stdin.Close(); err != nil {
		return fmt.Errorf("candidate run observer close stdin: %w", err)
	}
	if err := cmd.Wait(); err != nil {
		return sidecarExitError("candidate run observer exit", nil, err, c.stderr.String())
	}
	return nil
}

func loadBinding(configPath string) (binding, error) {
	if !filepath.IsAbs(configPath) {
		return binding{}, errors.New("candidate run config path must be absolute")
	}
	info, err := os.Lstat(configPath)
	if err != nil {
		return binding{}, fmt.Errorf("candidate run config: %w", err)
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
		return binding{}, errors.New("candidate run config must be a regular non-link file")
	}
	file, err := os.Open(configPath)
	if err != nil {
		return binding{}, fmt.Errorf("candidate run config: %w", err)
	}
	defer func() { _ = file.Close() }()
	decoder := json.NewDecoder(io.LimitReader(file, 2*1024*1024))
	decoder.DisallowUnknownFields()
	var cfg binding
	if err := decoder.Decode(&cfg); err != nil {
		return binding{}, fmt.Errorf("candidate run config: %w", err)
	}
	if err := ensureJSONEOF(decoder); err != nil {
		return binding{}, err
	}
	if cfg.SchemaVersion != 1 {
		return binding{}, errors.New("candidate run config schemaVersion must be 1")
	}
	if err := json.Unmarshal(cfg.ActivationRaw, &cfg.activation); err != nil {
		return binding{}, fmt.Errorf("candidate run activation profile: %w", err)
	}
	if err := json.Unmarshal(cfg.PreparedRaw, &cfg.prepared); err != nil {
		return binding{}, fmt.Errorf("candidate run prepared binding: %w", err)
	}
	for label, value := range map[string]string{
		"node binary":       cfg.NodeBinary,
		"journal directory": cfg.JournalDirectory,
		"kernel module":     cfg.Kernel.ModulePath,
	} {
		if !filepath.IsAbs(value) {
			return binding{}, fmt.Errorf("candidate run %s path must be absolute", label)
		}
	}
	if !sha256Pattern.MatchString(cfg.Kernel.SHA256) {
		return binding{}, errors.New("candidate run kernel sha256 is invalid")
	}
	if cfg.activation.SchemaVersion != 2 {
		return binding{}, errors.New("candidate run activation profile must use schemaVersion 2")
	}
	if cfg.activation.CandidateSlug == "" || cfg.activation.CandidateSlug != cfg.prepared.CandidateSlug {
		return binding{}, errors.New("candidate run activation and prepared candidate slugs do not match")
	}
	if cfg.Codex.Harness != "codex" || cfg.Codex.ApprovalPolicy != "on-request" {
		return binding{}, errors.New("candidate run Codex binding must use codex with on-request approval")
	}
	if cfg.activation.Model == "" || cfg.activation.Effort == "" || cfg.activation.Sandbox != "workspace-write" {
		return binding{}, errors.New("candidate run activation profile must bind model, effort, and workspace-write sandbox")
	}
	if cfg.prepared.RunID == "" || cfg.prepared.Repository == "" || cfg.prepared.ControllerOwner == "" || cfg.prepared.Dispatcher == "" || len(cfg.prepared.Tasks) == 0 {
		return binding{}, errors.New("candidate run prepared binding is incomplete")
	}
	if !sha256Pattern.MatchString(cfg.prepared.ActivationProfileDigest) {
		return binding{}, errors.New("candidate run prepared activation profile digest is invalid")
	}
	for i := range cfg.prepared.Tasks {
		order := cfg.prepared.Tasks[i].SchedulingOrder
		if order == nil || *order != i {
			return binding{}, fmt.Errorf("candidate run prepared task %d scheduling order must be %d", i+1, i)
		}
	}
	if cfg.ControllerClaim.EventID == "" || cfg.ControllerClaim.ClaimID == "" {
		return binding{}, errors.New("candidate run controller claim is incomplete")
	}
	if _, err := time.Parse(time.RFC3339Nano, cfg.ControllerClaim.ClaimedAt); err != nil {
		return binding{}, errors.New("candidate run controller claimedAt must be ISO")
	}
	return cfg, nil
}

func ensureJSONEOF(decoder *json.Decoder) error {
	var extra any
	if err := decoder.Decode(&extra); err == io.EOF {
		return nil
	} else if err != nil {
		return fmt.Errorf("candidate run config: %w", err)
	}
	return errors.New("candidate run config contains trailing JSON")
}

func parseCanonicalIssueID(issueID domain.IssueID) (string, int, error) {
	match := issuePattern.FindStringSubmatch(string(issueID))
	if match == nil {
		return "", 0, fmt.Errorf("candidate run issue ID %q is not canonical GitHub owner/repo#number", issueID)
	}
	number, err := strconv.Atoi(match[2])
	if err != nil {
		return "", 0, fmt.Errorf("candidate run issue ID %q has an invalid number", issueID)
	}
	return match[1], number, nil
}

func sidecarExitError(prefix string, scanErr, waitErr error, stderr string) error {
	detail := strings.TrimSpace(stderr)
	switch {
	case scanErr != nil:
		return fmt.Errorf("%s: %w", prefix, scanErr)
	case detail != "" && waitErr != nil:
		return fmt.Errorf("%s: %w: %s", prefix, waitErr, detail)
	case detail != "":
		return fmt.Errorf("%s: %s", prefix, detail)
	case waitErr != nil:
		return fmt.Errorf("%s: %w", prefix, waitErr)
	default:
		return fmt.Errorf("%s: sidecar closed without a frame", prefix)
	}
}
