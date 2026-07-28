// Package busclient is the daemon-side half of the federated bus (Phase B). It
// dials the control plane's bus endpoints so a laptop daemon (or an in-sandbox
// agent-host) can take part in cross-location orchestration:
//
//   - registers the sessions this daemon owns (POST /bus/register)
//   - holds an SSE channel open and executes commands the hub routes to it
//     (GET /bus/stream → send/spawn/kill against the local session manager)
//   - forwards commands that target a session this daemon does NOT own
//     (POST /bus/route) and delivers events a local session emits
//     (POST /bus/event — e.g. a worker reporting to a remote orchestrator)
//
// The client is decoupled from the daemon internals via the Executor interface,
// and speaks the shared busproto wire types. When no control-plane URL is
// configured it is simply never started, so the existing all-local flow is
// untouched.
package busclient

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/busproto"
)

// credPollInterval is how often the daemon-mode loop re-checks for credentials
// while it has none (e.g. before the user signs in to cloud). Cheap: a file read.
const credPollInterval = 3 * time.Second

// Executor is the local daemon capability the bus client drives when a routed
// command arrives, plus enumeration of owned sessions for registration. The
// daemon supplies a concrete adapter over its session Manager + Service; the
// client stays free of daemon/domain types.
type Executor interface {
	Send(ctx context.Context, sessionID, message string) error
	Kill(ctx context.Context, sessionID string) error
	Spawn(ctx context.Context, spec json.RawMessage) (sessionID string, err error)
	OwnedSessions(ctx context.Context) ([]busproto.SessionRef, error)
}

// Config parameterises the client. ControlPlaneURL empty ⇒ disabled.
type Config struct {
	ControlPlaneURL string // e.g. https://…azurecontainerapps.io
	Token           string // Bearer JWT whose org_id/sub is the tenant
	Tenant          string // dev fallback → X-AO-Tenant (used when Token is empty)
	DaemonID        string // this daemon's stable id
	AgentHost       bool   // in-sandbox mode: reachable inbound via preview URL, so no held-open stream
	// CredentialsPath, when set, is a JSON file {controlPlaneUrl, token, tenant}
	// that OVERRIDES the static fields above and is re-read on every connect. It
	// lets the desktop app hand the daemon a fresh bus token after boot (and after
	// sign-in) with no restart. The sandbox uses the env fields; the laptop uses
	// this file. (Task 1: laptop-in-loop.)
	CredentialsPath string

	HTTPClient   *http.Client
	ReconnectMin time.Duration
	ReconnectMax time.Duration
}

// Enabled reports whether a control plane could ever be reached — either a
// static URL or a credentials file to watch.
func (c Config) Enabled() bool {
	return strings.TrimSpace(c.ControlPlaneURL) != "" || strings.TrimSpace(c.CredentialsPath) != ""
}

// fileCreds is the on-disk credential the desktop app writes for the daemon.
type fileCreds struct {
	ControlPlaneURL string `json:"controlPlaneUrl"`
	Token           string `json:"token"`
	Tenant          string `json:"tenant"`
}

func (c *Config) withDefaults() {
	if c.HTTPClient == nil {
		// No client-wide timeout: the SSE GET is held open indefinitely. Per-POST
		// deadlines come from the request context instead.
		c.HTTPClient = &http.Client{}
	}
	if c.ReconnectMin <= 0 {
		c.ReconnectMin = time.Second
	}
	if c.ReconnectMax <= 0 {
		c.ReconnectMax = 30 * time.Second
	}
}

// Client is the daemon-side bus participant.
type Client struct {
	cfg  Config
	exec Executor
	http *http.Client
	log  *slog.Logger
}

// New builds a client. exec must be non-nil.
func New(cfg Config, exec Executor, log *slog.Logger) *Client {
	if log == nil {
		log = slog.Default()
	}
	cfg.withDefaults()
	return &Client{cfg: cfg, exec: exec, http: cfg.HTTPClient, log: log}
}

// currentCreds resolves the control-plane URL / token / tenant to use right now.
// A credentials file (if configured and present) overrides the static config, so
// a rotated token is picked up on the next connect without a restart.
func (c *Client) currentCreds() (url, token, tenant string) {
	url, token, tenant = c.cfg.ControlPlaneURL, c.cfg.Token, c.cfg.Tenant
	if c.cfg.CredentialsPath == "" {
		return
	}
	data, err := os.ReadFile(c.cfg.CredentialsPath)
	if err != nil {
		return // no file yet → fall back to static config
	}
	var fc fileCreds
	if json.Unmarshal(data, &fc) != nil {
		return
	}
	if strings.TrimSpace(fc.ControlPlaneURL) != "" {
		url = fc.ControlPlaneURL
	}
	if strings.TrimSpace(fc.Token) != "" {
		token = fc.Token
	}
	if strings.TrimSpace(fc.Tenant) != "" {
		tenant = fc.Tenant
	}
	return
}

// CanRoute reports whether the bus is configured enough to route right now. The
// session service checks this before routing a non-local send over the bus, so
// an unconfigured/signed-out daemon behaves exactly like a purely-local one.
func (c *Client) CanRoute() bool {
	url, token, _ := c.currentCreds()
	return strings.TrimSpace(url) != "" && strings.TrimSpace(token) != ""
}

// Run participates in the bus until ctx is cancelled. Laptop daemons hold an SSE
// channel open (reconnecting with backoff); an in-sandbox agent-host only keeps
// its registration warm, since the hub reaches it inbound via preview URL.
func (c *Client) Run(ctx context.Context) error {
	if !c.cfg.Enabled() {
		return nil
	}
	c.log.Info("bus client starting", "controlPlane", c.cfg.ControlPlaneURL, "daemonId", c.cfg.DaemonID, "agentHost", c.cfg.AgentHost)
	if c.cfg.AgentHost {
		return c.runAgentHost(ctx)
	}
	return c.runDaemon(ctx)
}

// runDaemon holds the SSE stream open, reconnecting with capped backoff. The
// register POST is fired from inside stream() once the channel is live, so the
// hub never has this daemon's sessions pointing at a not-yet-connected channel.
func (c *Client) runDaemon(ctx context.Context) error {
	backoff := c.cfg.ReconnectMin
	for ctx.Err() == nil {
		// Wait for credentials (e.g. until the user signs in and the desktop app
		// writes the token file). Cheap poll; no connection attempted until ready.
		if !c.CanRoute() {
			if !sleepCtx(ctx, credPollInterval) {
				break
			}
			continue
		}
		err := c.stream(ctx)
		if ctx.Err() != nil {
			break
		}
		if err != nil {
			c.log.Warn("bus stream dropped; reconnecting", "err", err, "in", backoff)
			if !sleepCtx(ctx, backoff) {
				break
			}
			backoff = capDur(backoff*2, c.cfg.ReconnectMax)
			continue
		}
		backoff = c.cfg.ReconnectMin // clean close → reconnect promptly
	}
	return ctx.Err()
}

// runAgentHost keeps an in-sandbox client alive without registering or holding a
// stream. The control plane already filed this sandbox's location (LocationSandbox
// via OnSessionReady) and reaches its sessions inbound over the signed preview
// URL. Registering here would OVERWRITE that with a LocationDaemon entry pointing
// at a channel we don't hold — breaking inbound routing. The outbound path
// (RouteSend/Emit) is driven on demand by the session service, so nothing
// periodic is needed; just stay alive until shutdown.
func (c *Client) runAgentHost(ctx context.Context) error {
	<-ctx.Done()
	return ctx.Err()
}

// stream opens the held-open SSE GET, registers once the channel is live, then
// executes each command/event frame the hub pushes down it.
func (c *Client) stream(ctx context.Context) error {
	url, token, tenant := c.currentCreds()
	if url == "" || token == "" {
		return errors.New("bus: not configured")
	}
	u := url + "/api/v1/cloud/bus/stream?daemonId=" + c.cfg.DaemonID
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return err
	}
	c.authHeaders(req, token, tenant)
	req.Header.Set("Accept", "text/event-stream")

	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("bus stream: HTTP %d", resp.StatusCode)
	}

	// Channel is live on the server now → announce our sessions. Retry with capped
	// backoff until it succeeds (or the stream/ctx ends): a single failed register
	// would otherwise leave this daemon's sessions unroutable for the whole
	// connection. Bounded by streamCtx, which the caller cancels when the stream
	// drops so the next reconnect re-registers cleanly. (Audit #9.)
	streamCtx, cancelStream := context.WithCancel(ctx)
	defer cancelStream()
	go func() {
		backoff := c.cfg.ReconnectMin
		for streamCtx.Err() == nil {
			if err := c.register(streamCtx); err == nil {
				return
			} else if streamCtx.Err() == nil {
				c.log.Warn("bus register failed; retrying", "err", err, "in", backoff)
			}
			if !sleepCtx(streamCtx, backoff) {
				return
			}
			backoff = capDur(backoff*2, c.cfg.ReconnectMax)
		}
	}()

	sc := bufio.NewScanner(resp.Body)
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for sc.Scan() {
		line := sc.Text()
		if !strings.HasPrefix(line, "data:") {
			continue // ": ping" / ": connected" comments
		}
		payload := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if payload == "" {
			continue
		}
		var f busproto.Frame
		if err := json.Unmarshal([]byte(payload), &f); err != nil {
			c.log.Warn("bus frame decode", "err", err)
			continue
		}
		c.dispatch(ctx, f)
	}
	return sc.Err()
}

// dispatch executes an inbound frame against the local session manager.
func (c *Client) dispatch(ctx context.Context, f busproto.Frame) {
	switch f.Type {
	case busproto.FrameCommand:
		if f.Command == nil {
			return
		}
		c.execCommand(ctx, *f.Command)
	case busproto.FrameEvent:
		if f.Event == nil {
			return
		}
		// An event routed to a session this daemon owns (e.g. a remote worker
		// reporting to a local orchestrator) → inject it as a message.
		if err := c.exec.Send(ctx, f.Event.ToSessionID, eventMessage(*f.Event)); err != nil {
			c.log.Warn("bus event deliver", "err", err, "to", f.Event.ToSessionID)
		}
	}
}

func (c *Client) execCommand(ctx context.Context, cmd busproto.Command) {
	var err error
	switch cmd.Op {
	case "send":
		err = c.exec.Send(ctx, cmd.SessionID, cmd.Message)
	case "kill":
		err = c.exec.Kill(ctx, cmd.SessionID)
	case "spawn":
		_, err = c.exec.Spawn(ctx, cmd.Spec)
	default:
		err = fmt.Errorf("unknown op %q", cmd.Op)
	}
	if err != nil {
		c.log.Warn("bus command failed", "op", cmd.Op, "session", cmd.SessionID, "err", err)
	}
}

// register announces the sessions this daemon owns to the hub.
func (c *Client) register(ctx context.Context) error {
	refs, err := c.exec.OwnedSessions(ctx)
	if err != nil {
		return err
	}
	if refs == nil {
		refs = []busproto.SessionRef{}
	}
	return c.postJSON(ctx, "/api/v1/cloud/bus/register", map[string]any{
		"daemonId": c.cfg.DaemonID,
		"sessions": refs,
	}, nil)
}

// Route forwards a command targeting a session this daemon does NOT own; the hub
// routes it to whichever host does.
func (c *Client) Route(ctx context.Context, cmd busproto.Command) error {
	return c.postJSON(ctx, "/api/v1/cloud/bus/route", cmd, nil)
}

// Emit posts an event (e.g. worker → orchestrator) for the hub to route.
func (c *Client) Emit(ctx context.Context, ev busproto.Event) error {
	return c.postJSON(ctx, "/api/v1/cloud/bus/event", ev, nil)
}

// EmitMessage delivers a human-readable message from one session to another over
// the bus (e.g. a worker's idle nudge to a remote orchestrator). The message is
// JSON-encoded as the event payload and unwrapped on delivery.
func (c *Client) EmitMessage(ctx context.Context, fromSessionID, toSessionID, message string) error {
	data, err := json.Marshal(message)
	if err != nil {
		return err
	}
	return c.Emit(ctx, busproto.Event{
		FromSessionID: fromSessionID,
		ToSessionID:   toSessionID,
		Kind:          "message",
		Data:          data,
	})
}

// RouteSend routes a message to a session this daemon doesn't own. It satisfies
// the session service's RemoteRouter, so a cross-location `ao send` flows over
// the bus instead of failing not-found.
func (c *Client) RouteSend(ctx context.Context, sessionID, message string) error {
	return c.Route(ctx, busproto.Command{Op: "send", SessionID: sessionID, Message: message})
}

// RemoteSession is one session in the tenant's cross-location fleet.
type RemoteSession struct {
	SessionID string `json:"sessionId"`
	Kind      string `json:"kind"`
	ProjectID string `json:"projectId"`
	Type      string `json:"type"` // "sandbox" | "daemon"
	SandboxID string `json:"sandboxId"`
}

// Locations returns every session the tenant owns across locations (Task 3:
// fleet visibility) — an orchestrator uses it to discover workers elsewhere.
func (c *Client) Locations(ctx context.Context) ([]RemoteSession, error) {
	var out struct {
		Sessions []RemoteSession `json:"sessions"`
	}
	if err := c.getJSON(ctx, "/api/v1/cloud/bus/locations", &out); err != nil {
		return nil, err
	}
	return out.Sessions, nil
}

func (c *Client) postJSON(ctx context.Context, path string, body, out any) error {
	url, token, tenant := c.currentCreds()
	if url == "" {
		return errors.New("bus: not configured")
	}
	buf, err := json.Marshal(body)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url+path, bytes.NewReader(buf))
	if err != nil {
		return err
	}
	c.authHeaders(req, token, tenant)
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		snippet, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return fmt.Errorf("bus %s: HTTP %d: %s", path, resp.StatusCode, strings.TrimSpace(string(snippet)))
	}
	if out != nil {
		return json.NewDecoder(resp.Body).Decode(out)
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	return nil
}

func (c *Client) getJSON(ctx context.Context, path string, out any) error {
	url, token, tenant := c.currentCreds()
	if url == "" {
		return errors.New("bus: not configured")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url+path, nil)
	if err != nil {
		return err
	}
	c.authHeaders(req, token, tenant)
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		snippet, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return fmt.Errorf("bus %s: HTTP %d: %s", path, resp.StatusCode, strings.TrimSpace(string(snippet)))
	}
	return json.NewDecoder(resp.Body).Decode(out)
}

func (c *Client) authHeaders(req *http.Request, token, tenant string) {
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	if tenant != "" {
		req.Header.Set("X-AO-Tenant", tenant)
	}
}

func eventMessage(ev busproto.Event) string {
	if len(ev.Data) > 0 {
		// Data is usually a JSON-encoded string (a human-readable message);
		// unwrap it so the delivered text has no surrounding quotes. Fall back to
		// the raw bytes for non-string payloads.
		var s string
		if json.Unmarshal(ev.Data, &s) == nil {
			return s
		}
		return string(ev.Data)
	}
	return ev.Kind
}

func sleepCtx(ctx context.Context, d time.Duration) bool {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-t.C:
		return true
	}
}

func capDur(d, max time.Duration) time.Duration {
	if d > max {
		return max
	}
	return d
}
