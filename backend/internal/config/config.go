// Package config loads the daemon's runtime configuration. The HTTP daemon is
// a loopback-only sidecar: it binds 127.0.0.1, takes no public traffic, and
// reads everything it needs from the environment with sane defaults so it can
// boot with zero configuration in development.
package config

import (
	"fmt"
	"math"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

const (
	// LoopbackHost is the only host the daemon ever binds. There is deliberately
	// no AO_HOST env var: the daemon has no auth/CORS/TLS and a stray
	// AO_HOST=0.0.0.0 would turn it into a public no-auth service. If a
	// non-default loopback (e.g. ::1, 127.0.0.2) is ever needed, add it back with
	// an IsLoopback() validator — not a raw env read.
	LoopbackHost = "127.0.0.1"
	// DefaultPort is the single port for REST, terminal mux, health, and control.
	DefaultPort = 3001
	// DefaultRequestTimeout bounds a single REST request. Long-lived terminal mux
	// connections are mounted outside this timeout.
	DefaultRequestTimeout = 60 * time.Second
	// DefaultShutdownTimeout is the hard cap on graceful shutdown. After this
	// the process exits even if connections are still draining.
	DefaultShutdownTimeout = 10 * time.Second
	// DefaultAgentHealthInterval is how often the background agent-health monitor
	// re-probes each configured harness for install+auth readiness. It is a slow
	// loop by design: a login expiring is a human-timescale event, so a few
	// minutes of detection latency is fine and keeps agent-CLI probes cheap.
	DefaultAgentHealthInterval = 5 * time.Minute
	// DefaultModelRevalidationInterval is how often configured model pins are
	// re-probed for provider/account reachability. Model retirement and account
	// entitlement drift are human-timescale events, and probes can make real model
	// calls, so the default is daily rather than tied to agent auth health.
	DefaultModelRevalidationInterval = 24 * time.Hour
	// DefaultAgent is the compatibility value used when AO_AGENT is unset. The
	// daemon validates it at startup, but worker/orchestrator spawns resolve from
	// explicit requests or project role config instead of falling back to it.
	DefaultAgent = "claude-code"
	// DefaultTelemetryPostHogHost is the default PostHog ingestion host when
	// remote telemetry is enabled and AO_TELEMETRY_POSTHOG_HOST is unset.
	DefaultTelemetryPostHogHost = "https://us.i.posthog.com"
	// DefaultMetricsInterval is how often the resource metrics observer samples
	// host/session/cost facts. A coarse loop by design: resource pressure is a
	// human-timescale signal, so a ~30s tick keeps sampling cheap.
	DefaultMetricsInterval = 30 * time.Second
	// DefaultMetricsDiskFreePercent fires the disk_low alert when free space on
	// the data-dir volume drops below this percent.
	DefaultMetricsDiskFreePercent = 10
	// DefaultMetricsMemAvailablePercent fires the mem_low alert when available
	// memory drops below this percent.
	DefaultMetricsMemAvailablePercent = 10
	// DefaultMetricsLoadPerCore fires the load_high alert when 1-min loadavg per
	// core exceeds this ratio.
	DefaultMetricsLoadPerCore = 1.0
	// DefaultMetricsZombieSustainTicks is how many consecutive ticks the zombie
	// count must stay above zero before the zombies alert fires.
	DefaultMetricsZombieSustainTicks = 2
	// MaxPrimeDisplayNameLen mirrors the session display-name cap enforced by
	// the API and session manager.
	MaxPrimeDisplayNameLen = 20
)

// TelemetryRemote selects the remote telemetry exporter.
type TelemetryRemote string

const (
	// TelemetryRemoteOff disables remote telemetry export.
	TelemetryRemoteOff TelemetryRemote = "off"
	// TelemetryRemotePostHog exports allowlisted events to PostHog.
	TelemetryRemotePostHog TelemetryRemote = "posthog"
)

// TelemetryConfig controls local and remote telemetry behavior.
type TelemetryConfig struct {
	Events      bool
	Metrics     bool
	Remote      TelemetryRemote
	PostHogKey  string
	PostHogHost string
}

// MetricsConfig controls the resource metrics observer: its sampling interval
// (0 disables the observer entirely) and the alert thresholds. A zero threshold
// disables that specific alert while leaving the observer and /api/v1/metrics
// running.
type MetricsConfig struct {
	// Interval is the observer sampling period. Zero disables the observer.
	Interval time.Duration
	// DiskFreePercent is the disk_low threshold (percent free). Zero disables it.
	DiskFreePercent float64
	// MemAvailablePercent is the mem_low threshold (percent available). Zero
	// disables it.
	MemAvailablePercent float64
	// LoadPerCore is the load_high threshold (loadavg per core). Zero disables it.
	LoadPerCore float64
	// ZombieSustainTicks is how many consecutive ticks zombies>0 must persist
	// before the zombies alert fires. Zero disables it.
	ZombieSustainTicks int
}

// DefaultAllowedOrigins are the browser origins the daemon's CORS boundary
// trusts, beyond loopback-served content (which the middleware always trusts —
// local pages can reach the no-auth daemon directly anyway). The daemon has no
// auth, so every entry must be an origin web content cannot present:
// app://renderer is the packaged Electron renderer, served from a custom
// scheme only the desktop app registers — no website can bear it. The opaque
// "null" origin (file:// pages, sandboxed iframes on any website) must never
// be added.
var DefaultAllowedOrigins = []string{
	"app://renderer",
}

// Config is the fully-resolved daemon configuration. It is immutable once
// built by Load.
type Config struct {
	// Host is the bind address. Always loopback — see LoopbackHost.
	Host string
	// Port is the TCP port to bind. The daemon fails fast if it is taken.
	Port int
	// RequestTimeout bounds REST request handling.
	RequestTimeout time.Duration
	// ShutdownTimeout is the hard graceful-shutdown deadline.
	ShutdownTimeout time.Duration
	// RunFilePath is where the PID + port handshake file (running.json) is
	// written so the Electron supervisor can discover and reap the daemon.
	RunFilePath string
	// DataDir is the directory holding durable SQLite state: DB and WAL files.
	// It is created on first use by the storage layer.
	DataDir string
	// Agent is the compatibility agent adapter id selected by AO_AGENT;
	// startSession fails fast if no adapter with this id is registered.
	Agent string
	// AgentHealthInterval is the period of the background agent-health monitor.
	// Zero disables the monitor entirely (no periodic probing, no alerts).
	AgentHealthInterval time.Duration
	// ModelRevalidationInterval is the period of the configured model-pin
	// reachability monitor. Zero disables scheduled model probing.
	ModelRevalidationInterval time.Duration
	// PrimeProjectID is the project that hosts the optional global prime
	// orchestrator. Empty disables the prime supervisor.
	PrimeProjectID string
	// PrimeDisplayName is the optional fleet-scoped display name for the global
	// prime orchestrator. Empty keeps the computed "<project> Prime" fallback.
	PrimeDisplayName string
	// AllowedOrigins are the browser origins granted CORS read access (see
	// DefaultAllowedOrigins). Overridden by AO_ALLOWED_ORIGINS.
	AllowedOrigins []string
	// Telemetry controls local/remote telemetry sinks.
	Telemetry TelemetryConfig
	// Metrics controls the resource metrics observer.
	Metrics MetricsConfig
}

// Addr returns the host:port the HTTP server binds. It uses net.JoinHostPort so
// the result is correct for IPv6 literals as well as IPv4 / hostnames.
func (c Config) Addr() string {
	return net.JoinHostPort(c.Host, strconv.Itoa(c.Port))
}

// Load resolves configuration from the environment, applying defaults. It
// returns an error only for values that are present but malformed (e.g. a
// non-numeric AO_PORT); missing values fall back to defaults.
//
// Recognised variables:
//
//	AO_PORT              bind port           (default 3001)
//	AO_REQUEST_TIMEOUT   per-request timeout (Go duration > 0, default 60s)
//	AO_SHUTDOWN_TIMEOUT  shutdown deadline   (Go duration > 0, default 10s)
//	AO_RUN_FILE          running.json path   (default ~/.ao/running.json)
//	AO_DATA_DIR          durable state dir   (default ~/.ao/data)
//	AO_AGENT             compatibility agent id (default claude-code)
//	AO_AGENT_HEALTH_INTERVAL agent-health probe period (Go duration >= 0, 0 disables, default 5m)
//	AO_MODEL_REVALIDATION_INTERVAL model-pin probe period (Go duration >= 0, 0 disables, default 24h)
//	AO_PRIME_PROJECT_ID optional project id that hosts the global prime orchestrator (default disabled)
//	AO_PRIME_DISPLAY_NAME optional fleet-scoped prime display name (default computed from host project)
//	AO_ALLOWED_ORIGINS   CORS origins, comma-separated (default DefaultAllowedOrigins)
//	AO_TELEMETRY_EVENTS  local event capture off|on (default off)
//	AO_TELEMETRY_METRICS local metric capture off|on (default off)
//	AO_TELEMETRY_REMOTE  remote exporter off|posthog (default off)
//	AO_TELEMETRY_POSTHOG_KEY   PostHog project key
//	AO_TELEMETRY_POSTHOG_HOST  PostHog host (default DefaultTelemetryPostHogHost)
//	AO_METRICS_INTERVAL        resource observer tick (Go duration >= 0, 0 disables, default 30s)
//	AO_METRICS_DISK_FREE_PCT   disk_low threshold, percent free (0-100, 0 disables, default 10)
//	AO_METRICS_MEM_AVAIL_PCT   mem_low threshold, percent available (0-100, 0 disables, default 10)
//	AO_METRICS_LOAD_PER_CORE   load_high threshold, loadavg per core (>=0, 0 disables, default 1)
//	AO_METRICS_ZOMBIE_TICKS    zombies alert sustain ticks (int >=0, 0 disables, default 2)
//
// The bind host is not configurable: the daemon is loopback-only by design.
func Load() (Config, error) {
	cfg := Config{
		Host:                      LoopbackHost,
		Port:                      DefaultPort,
		RequestTimeout:            DefaultRequestTimeout,
		ShutdownTimeout:           DefaultShutdownTimeout,
		Agent:                     DefaultAgent,
		AgentHealthInterval:       DefaultAgentHealthInterval,
		ModelRevalidationInterval: DefaultModelRevalidationInterval,
		AllowedOrigins:            DefaultAllowedOrigins,
		Telemetry: TelemetryConfig{
			Remote:      TelemetryRemoteOff,
			PostHogHost: DefaultTelemetryPostHogHost,
		},
		Metrics: MetricsConfig{
			Interval:            DefaultMetricsInterval,
			DiskFreePercent:     DefaultMetricsDiskFreePercent,
			MemAvailablePercent: DefaultMetricsMemAvailablePercent,
			LoadPerCore:         DefaultMetricsLoadPerCore,
			ZombieSustainTicks:  DefaultMetricsZombieSustainTicks,
		},
	}

	if raw := os.Getenv("AO_PORT"); raw != "" {
		port, err := strconv.Atoi(raw)
		if err != nil {
			return Config{}, fmt.Errorf("invalid AO_PORT %q: %w", raw, err)
		}
		if port < 1 || port > 65535 {
			return Config{}, fmt.Errorf("invalid AO_PORT %d: out of range 1-65535", port)
		}
		cfg.Port = port
	}

	if raw := os.Getenv("AO_REQUEST_TIMEOUT"); raw != "" {
		d, err := parsePositiveDuration("AO_REQUEST_TIMEOUT", raw)
		if err != nil {
			return Config{}, err
		}
		cfg.RequestTimeout = d
	}

	if raw := os.Getenv("AO_SHUTDOWN_TIMEOUT"); raw != "" {
		d, err := parsePositiveDuration("AO_SHUTDOWN_TIMEOUT", raw)
		if err != nil {
			return Config{}, err
		}
		cfg.ShutdownTimeout = d
	}

	if raw := os.Getenv("AO_AGENT"); raw != "" {
		cfg.Agent = raw
	}

	if raw := os.Getenv("AO_AGENT_HEALTH_INTERVAL"); raw != "" {
		d, err := parseNonNegativeDuration("AO_AGENT_HEALTH_INTERVAL", raw)
		if err != nil {
			return Config{}, err
		}
		cfg.AgentHealthInterval = d
	}

	if raw := os.Getenv("AO_MODEL_REVALIDATION_INTERVAL"); raw != "" {
		d, err := parseNonNegativeDuration("AO_MODEL_REVALIDATION_INTERVAL", raw)
		if err != nil {
			return Config{}, err
		}
		cfg.ModelRevalidationInterval = d
	}

	if raw := strings.TrimSpace(os.Getenv("AO_PRIME_PROJECT_ID")); raw != "" {
		cfg.PrimeProjectID = raw
	}
	if raw := strings.TrimSpace(os.Getenv("AO_PRIME_DISPLAY_NAME")); raw != "" {
		if utf8.RuneCountInString(raw) > MaxPrimeDisplayNameLen {
			return Config{}, fmt.Errorf("AO_PRIME_DISPLAY_NAME must be %d characters or fewer", MaxPrimeDisplayNameLen)
		}
		cfg.PrimeDisplayName = raw
	}

	if raw, ok := os.LookupEnv("AO_ALLOWED_ORIGINS"); ok && raw != "" {
		// Explicit override replaces the defaults entirely so a deployment can
		// also narrow the list. The "null" origin is rejected, never silently
		// dropped: an operator allowing it would open the no-auth daemon to
		// every sandboxed iframe on the web.
		origins := make([]string, 0, 4)
		for _, origin := range strings.Split(raw, ",") {
			origin = strings.TrimSpace(origin)
			if origin == "" {
				continue
			}
			if origin == "null" || origin == "*" {
				return Config{}, fmt.Errorf("invalid AO_ALLOWED_ORIGINS entry %q: wildcard and null origins are not allowed", origin)
			}
			origins = append(origins, origin)
		}
		cfg.AllowedOrigins = origins
	}

	if raw := os.Getenv("AO_TELEMETRY_EVENTS"); raw != "" {
		v, err := parseToggleEnv("AO_TELEMETRY_EVENTS", raw)
		if err != nil {
			return Config{}, err
		}
		cfg.Telemetry.Events = v
	}
	if raw := os.Getenv("AO_TELEMETRY_METRICS"); raw != "" {
		v, err := parseToggleEnv("AO_TELEMETRY_METRICS", raw)
		if err != nil {
			return Config{}, err
		}
		cfg.Telemetry.Metrics = v
	}
	if raw := os.Getenv("AO_TELEMETRY_REMOTE"); raw != "" {
		remote, err := parseTelemetryRemote(raw)
		if err != nil {
			return Config{}, fmt.Errorf("invalid AO_TELEMETRY_REMOTE %q: %w", raw, err)
		}
		cfg.Telemetry.Remote = remote
	}
	if raw := os.Getenv("AO_TELEMETRY_POSTHOG_KEY"); raw != "" {
		cfg.Telemetry.PostHogKey = raw
	}
	if raw := os.Getenv("AO_TELEMETRY_POSTHOG_HOST"); raw != "" {
		cfg.Telemetry.PostHogHost = raw
	}

	if raw := os.Getenv("AO_METRICS_INTERVAL"); raw != "" {
		d, err := parseNonNegativeDuration("AO_METRICS_INTERVAL", raw)
		if err != nil {
			return Config{}, err
		}
		cfg.Metrics.Interval = d
	}
	if raw := os.Getenv("AO_METRICS_DISK_FREE_PCT"); raw != "" {
		v, err := parseNonNegativePercent("AO_METRICS_DISK_FREE_PCT", raw)
		if err != nil {
			return Config{}, err
		}
		cfg.Metrics.DiskFreePercent = v
	}
	if raw := os.Getenv("AO_METRICS_MEM_AVAIL_PCT"); raw != "" {
		v, err := parseNonNegativePercent("AO_METRICS_MEM_AVAIL_PCT", raw)
		if err != nil {
			return Config{}, err
		}
		cfg.Metrics.MemAvailablePercent = v
	}
	if raw := os.Getenv("AO_METRICS_LOAD_PER_CORE"); raw != "" {
		v, err := parseNonNegativeFloat("AO_METRICS_LOAD_PER_CORE", raw)
		if err != nil {
			return Config{}, err
		}
		cfg.Metrics.LoadPerCore = v
	}
	if raw := os.Getenv("AO_METRICS_ZOMBIE_TICKS"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n < 0 {
			return Config{}, fmt.Errorf("invalid AO_METRICS_ZOMBIE_TICKS %q: must be an integer >= 0", raw)
		}
		cfg.Metrics.ZombieSustainTicks = n
	}

	runFile, err := resolveRunFilePath()
	if err != nil {
		return Config{}, err
	}
	cfg.RunFilePath = runFile

	dataDir, err := resolveDataDir()
	if err != nil {
		return Config{}, err
	}
	cfg.DataDir = dataDir

	return cfg, nil
}

func parseToggleEnv(name, raw string) (bool, error) {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "on", "true", "1", "yes":
		return true, nil
	case "off", "false", "0", "no":
		return false, nil
	default:
		return false, fmt.Errorf("%s must be off|on", name)
	}
}

func parseTelemetryRemote(raw string) (TelemetryRemote, error) {
	switch TelemetryRemote(strings.ToLower(strings.TrimSpace(raw))) {
	case TelemetryRemoteOff:
		return TelemetryRemoteOff, nil
	case TelemetryRemotePostHog:
		return TelemetryRemotePostHog, nil
	default:
		return "", fmt.Errorf("must be off|posthog")
	}
}

// parsePositiveDuration rejects zero and negative durations: a zero
// RequestTimeout would expire every request instantly, and a non-positive
// ShutdownTimeout would defeat graceful shutdown.
func parsePositiveDuration(name, raw string) (time.Duration, error) {
	d, err := time.ParseDuration(raw)
	if err != nil {
		return 0, fmt.Errorf("invalid %s %q: %w", name, raw, err)
	}
	if d <= 0 {
		return 0, fmt.Errorf("invalid %s %q: must be > 0", name, raw)
	}
	return d, nil
}

// parseNonNegativeDuration accepts zero (a documented "disable" sentinel, e.g.
// AO_AGENT_HEALTH_INTERVAL=0 turns the monitor off) but rejects negatives and
// malformed values.
func parseNonNegativeDuration(name, raw string) (time.Duration, error) {
	d, err := time.ParseDuration(raw)
	if err != nil {
		return 0, fmt.Errorf("invalid %s %q: %w", name, raw, err)
	}
	if d < 0 {
		return 0, fmt.Errorf("invalid %s %q: must be >= 0", name, raw)
	}
	return d, nil
}

// parseNonNegativeFloat accepts zero (the "disable this alert" sentinel) but
// rejects negatives and malformed values.
func parseNonNegativeFloat(name, raw string) (float64, error) {
	f, err := strconv.ParseFloat(raw, 64)
	if err != nil {
		return 0, fmt.Errorf("invalid %s %q: %w", name, raw, err)
	}
	// Reject NaN/Inf: "NaN < 0" and "Inf > 100" are both false, so without this
	// a threshold of NaN would silently disable the alert and Inf would slip past
	// the percent upper bound.
	if math.IsNaN(f) || math.IsInf(f, 0) {
		return 0, fmt.Errorf("invalid %s %q: must be a finite number", name, raw)
	}
	if f < 0 {
		return 0, fmt.Errorf("invalid %s %q: must be >= 0", name, raw)
	}
	return f, nil
}

// parseNonNegativePercent parses a percent threshold: a non-negative float that
// must not exceed 100. Zero disables the alert.
func parseNonNegativePercent(name, raw string) (float64, error) {
	f, err := parseNonNegativeFloat(name, raw)
	if err != nil {
		return 0, err
	}
	if f > 100 {
		return 0, fmt.Errorf("invalid %s %q: must be within 0-100", name, raw)
	}
	return f, nil
}

// resolveRunFilePath picks where running.json lives. An explicit AO_RUN_FILE
// wins; otherwise it sits under the canonical AO home directory so the CLI and
// Electron supervisor share one handshake location.
func resolveRunFilePath() (string, error) {
	if p, ok := os.LookupEnv("AO_RUN_FILE"); ok && p != "" {
		return p, nil
	}
	stateDir, err := defaultStateDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(stateDir, "running.json"), nil
}

// resolveDataDir picks where durable state (the SQLite DB) lives. An explicit
// AO_DATA_DIR wins; otherwise it defaults under the same canonical AO home
// directory as the run-file.
func resolveDataDir() (string, error) {
	if p, ok := os.LookupEnv("AO_DATA_DIR"); ok && p != "" {
		return p, nil
	}
	stateDir, err := defaultStateDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(stateDir, "data"), nil
}

func defaultStateDir() (string, error) {
	homeDir, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("resolve state dir: %w", err)
	}
	return filepath.Join(homeDir, ".ao"), nil
}
