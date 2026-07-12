package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestLoadDefaults(t *testing.T) {
	// Clear every recognised var so we observe pure defaults regardless of the
	// surrounding environment.
	for _, k := range []string{"AO_PORT", "AO_REQUEST_TIMEOUT", "AO_SHUTDOWN_TIMEOUT", "AO_RUN_FILE", "AO_DATA_DIR", "AO_AGENT", "AO_AGENT_HEALTH_INTERVAL", "AO_MODEL_REVALIDATION_INTERVAL", "AO_PRIME_PROJECT_ID", "AO_PRIME_DISPLAY_NAME", "AO_ALLOWED_ORIGINS", "AO_TELEMETRY_EVENTS", "AO_TELEMETRY_METRICS", "AO_TELEMETRY_REMOTE", "AO_TELEMETRY_POSTHOG_KEY", "AO_TELEMETRY_POSTHOG_HOST"} {
		t.Setenv(k, "")
	}
	for _, k := range []string{"AO_METRICS_INTERVAL", "AO_METRICS_DISK_FREE_PCT", "AO_METRICS_MEM_AVAIL_PCT", "AO_METRICS_LOAD_PER_CORE", "AO_METRICS_ZOMBIE_TICKS"} {
		t.Setenv(k, "")
	}

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.Host != LoopbackHost {
		t.Errorf("Host = %q, want %q", cfg.Host, LoopbackHost)
	}
	if cfg.Port != DefaultPort {
		t.Errorf("Port = %d, want %d", cfg.Port, DefaultPort)
	}
	if cfg.RequestTimeout != DefaultRequestTimeout {
		t.Errorf("RequestTimeout = %s, want %s", cfg.RequestTimeout, DefaultRequestTimeout)
	}
	if cfg.ShutdownTimeout != DefaultShutdownTimeout {
		t.Errorf("ShutdownTimeout = %s, want %s", cfg.ShutdownTimeout, DefaultShutdownTimeout)
	}
	if cfg.RunFilePath == "" {
		t.Error("RunFilePath is empty, want a resolved default path")
	}
	homeDir, err := os.UserHomeDir()
	if err != nil {
		t.Fatalf("UserHomeDir: %v", err)
	}
	wantRunFilePath := filepath.Join(homeDir, ".ao", "running.json")
	if cfg.RunFilePath != wantRunFilePath {
		t.Errorf("RunFilePath = %q, want %q", cfg.RunFilePath, wantRunFilePath)
	}
	if cfg.DataDir == "" {
		t.Error("DataDir is empty, want a resolved default path")
	}
	wantDataDir := filepath.Join(homeDir, ".ao", "data")
	if cfg.DataDir != wantDataDir {
		t.Errorf("DataDir = %q, want %q", cfg.DataDir, wantDataDir)
	}
	if cfg.Telemetry.Remote != TelemetryRemoteOff || cfg.Telemetry.PostHogHost != DefaultTelemetryPostHogHost {
		t.Fatalf("Telemetry defaults = %+v", cfg.Telemetry)
	}
	if cfg.AgentHealthInterval != DefaultAgentHealthInterval {
		t.Errorf("AgentHealthInterval = %s, want %s", cfg.AgentHealthInterval, DefaultAgentHealthInterval)
	}
	if cfg.ModelRevalidationInterval != DefaultModelRevalidationInterval {
		t.Errorf("ModelRevalidationInterval = %s, want %s", cfg.ModelRevalidationInterval, DefaultModelRevalidationInterval)
	}
	if cfg.PrimeProjectID != "" {
		t.Errorf("PrimeProjectID = %q, want disabled default", cfg.PrimeProjectID)
	}
	if cfg.PrimeDisplayName != "" {
		t.Errorf("PrimeDisplayName = %q, want computed-name fallback", cfg.PrimeDisplayName)
	}
	if cfg.Metrics.Interval != DefaultMetricsInterval {
		t.Errorf("Metrics.Interval = %s, want %s", cfg.Metrics.Interval, DefaultMetricsInterval)
	}
	if cfg.Metrics.DiskFreePercent != DefaultMetricsDiskFreePercent {
		t.Errorf("Metrics.DiskFreePercent = %v, want %v", cfg.Metrics.DiskFreePercent, float64(DefaultMetricsDiskFreePercent))
	}
	if cfg.Metrics.MemAvailablePercent != DefaultMetricsMemAvailablePercent {
		t.Errorf("Metrics.MemAvailablePercent = %v, want %v", cfg.Metrics.MemAvailablePercent, float64(DefaultMetricsMemAvailablePercent))
	}
	if cfg.Metrics.LoadPerCore != DefaultMetricsLoadPerCore {
		t.Errorf("Metrics.LoadPerCore = %v, want %v", cfg.Metrics.LoadPerCore, DefaultMetricsLoadPerCore)
	}
	if cfg.Metrics.ZombieSustainTicks != DefaultMetricsZombieSustainTicks {
		t.Errorf("Metrics.ZombieSustainTicks = %d, want %d", cfg.Metrics.ZombieSustainTicks, DefaultMetricsZombieSustainTicks)
	}
}

func TestLoadMetricsOverrides(t *testing.T) {
	t.Setenv("AO_METRICS_INTERVAL", "0") // disables the observer
	t.Setenv("AO_METRICS_DISK_FREE_PCT", "5")
	t.Setenv("AO_METRICS_MEM_AVAIL_PCT", "0") // disables mem_low alert
	t.Setenv("AO_METRICS_LOAD_PER_CORE", "2.5")
	t.Setenv("AO_METRICS_ZOMBIE_TICKS", "3")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.Metrics.Interval != 0 {
		t.Errorf("Interval = %s, want 0 (disabled)", cfg.Metrics.Interval)
	}
	if cfg.Metrics.DiskFreePercent != 5 {
		t.Errorf("DiskFreePercent = %v, want 5", cfg.Metrics.DiskFreePercent)
	}
	if cfg.Metrics.MemAvailablePercent != 0 {
		t.Errorf("MemAvailablePercent = %v, want 0", cfg.Metrics.MemAvailablePercent)
	}
	if cfg.Metrics.LoadPerCore != 2.5 {
		t.Errorf("LoadPerCore = %v, want 2.5", cfg.Metrics.LoadPerCore)
	}
	if cfg.Metrics.ZombieSustainTicks != 3 {
		t.Errorf("ZombieSustainTicks = %d, want 3", cfg.Metrics.ZombieSustainTicks)
	}
}

func TestLoadMetricsInvalid(t *testing.T) {
	cases := map[string]string{
		"AO_METRICS_INTERVAL":      "nope",
		"AO_METRICS_DISK_FREE_PCT": "150",
		"AO_METRICS_MEM_AVAIL_PCT": "-1",
		"AO_METRICS_LOAD_PER_CORE": "-2",
		"AO_METRICS_ZOMBIE_TICKS":  "-1",
		// Non-finite values must be rejected: NaN<0 and Inf>100 are both false,
		// so without an explicit guard they would silently disable/overflow a
		// threshold.
		"AO_METRICS_LOAD_PER_CORE_NAN": "NaN",
		"AO_METRICS_DISK_FREE_PCT_INF": "Inf",
	}
	for k, v := range cases {
		t.Run(k, func(t *testing.T) {
			// Allow two distinct cases for one env var via a "_SUFFIX" test key.
			envKey := k
			if i := strings.Index(k, "_NAN"); i >= 0 {
				envKey = k[:i]
			}
			if i := strings.Index(k, "_INF"); i >= 0 {
				envKey = k[:i]
			}
			t.Setenv(envKey, v)
			if _, err := Load(); err == nil {
				t.Fatalf("Load with %s=%q should fail", envKey, v)
			}
		})
	}
}

func TestLoadAgentHealthInterval(t *testing.T) {
	t.Setenv("AO_AGENT_HEALTH_INTERVAL", "90s")
	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.AgentHealthInterval != 90*time.Second {
		t.Errorf("AgentHealthInterval = %s, want 90s", cfg.AgentHealthInterval)
	}

	// Zero is a valid "disable" sentinel, not an error.
	t.Setenv("AO_AGENT_HEALTH_INTERVAL", "0")
	cfg, err = Load()
	if err != nil {
		t.Fatalf("Load zero: %v", err)
	}
	if cfg.AgentHealthInterval != 0 {
		t.Errorf("AgentHealthInterval = %s, want 0 (disabled)", cfg.AgentHealthInterval)
	}
}

func TestLoadModelRevalidationInterval(t *testing.T) {
	t.Setenv("AO_MODEL_REVALIDATION_INTERVAL", "12h")
	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.ModelRevalidationInterval != 12*time.Hour {
		t.Errorf("ModelRevalidationInterval = %s, want 12h", cfg.ModelRevalidationInterval)
	}

	t.Setenv("AO_MODEL_REVALIDATION_INTERVAL", "0")
	cfg, err = Load()
	if err != nil {
		t.Fatalf("Load zero: %v", err)
	}
	if cfg.ModelRevalidationInterval != 0 {
		t.Errorf("ModelRevalidationInterval = %s, want 0 (disabled)", cfg.ModelRevalidationInterval)
	}
}

func TestLoadOverrides(t *testing.T) {
	t.Setenv("AO_PORT", "4002")
	t.Setenv("AO_REQUEST_TIMEOUT", "5s")
	t.Setenv("AO_SHUTDOWN_TIMEOUT", "3s")
	t.Setenv("AO_RUN_FILE", "/tmp/ao-test-running.json")
	t.Setenv("AO_DATA_DIR", "/tmp/ao-test-data")
	t.Setenv("AO_TELEMETRY_EVENTS", "on")
	t.Setenv("AO_TELEMETRY_METRICS", "off")
	t.Setenv("AO_TELEMETRY_REMOTE", "posthog")
	t.Setenv("AO_TELEMETRY_POSTHOG_KEY", "phc_test")
	t.Setenv("AO_TELEMETRY_POSTHOG_HOST", "https://eu.i.posthog.com")
	t.Setenv("AO_PRIME_PROJECT_ID", " ao ")
	t.Setenv("AO_PRIME_DISPLAY_NAME", " AO Prime ")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.Addr() != "127.0.0.1:4002" {
		t.Errorf("Addr() = %q, want 127.0.0.1:4002", cfg.Addr())
	}
	if cfg.RequestTimeout != 5*time.Second {
		t.Errorf("RequestTimeout = %s, want 5s", cfg.RequestTimeout)
	}
	if cfg.ShutdownTimeout != 3*time.Second {
		t.Errorf("ShutdownTimeout = %s, want 3s", cfg.ShutdownTimeout)
	}
	if cfg.RunFilePath != "/tmp/ao-test-running.json" {
		t.Errorf("RunFilePath = %q, want /tmp/ao-test-running.json", cfg.RunFilePath)
	}
	if cfg.DataDir != "/tmp/ao-test-data" {
		t.Errorf("DataDir = %q, want /tmp/ao-test-data", cfg.DataDir)
	}
	if !cfg.Telemetry.Events || cfg.Telemetry.Metrics {
		t.Fatalf("Telemetry toggles = %+v", cfg.Telemetry)
	}
	if cfg.Telemetry.Remote != TelemetryRemotePostHog || cfg.Telemetry.PostHogKey != "phc_test" || cfg.Telemetry.PostHogHost != "https://eu.i.posthog.com" {
		t.Fatalf("Telemetry remote = %+v", cfg.Telemetry)
	}
	if cfg.PrimeProjectID != "ao" {
		t.Errorf("PrimeProjectID = %q, want trimmed ao", cfg.PrimeProjectID)
	}
	if cfg.PrimeDisplayName != "AO Prime" {
		t.Errorf("PrimeDisplayName = %q, want trimmed AO Prime", cfg.PrimeDisplayName)
	}
}

func TestLoadInvalid(t *testing.T) {
	tests := []struct {
		name string
		env  map[string]string
	}{
		{"non-numeric port", map[string]string{"AO_PORT": "abc"}},
		{"port out of range", map[string]string{"AO_PORT": "70000"}},
		{"bad request timeout", map[string]string{"AO_REQUEST_TIMEOUT": "soon"}},
		{"bad shutdown timeout", map[string]string{"AO_SHUTDOWN_TIMEOUT": "later"}},
		{"zero request timeout", map[string]string{"AO_REQUEST_TIMEOUT": "0s"}},
		{"negative request timeout", map[string]string{"AO_REQUEST_TIMEOUT": "-1s"}},
		{"zero shutdown timeout", map[string]string{"AO_SHUTDOWN_TIMEOUT": "0s"}},
		{"negative shutdown timeout", map[string]string{"AO_SHUTDOWN_TIMEOUT": "-5s"}},
		{"bad agent-health interval", map[string]string{"AO_AGENT_HEALTH_INTERVAL": "soon"}},
		{"negative agent-health interval", map[string]string{"AO_AGENT_HEALTH_INTERVAL": "-1m"}},
		{"bad model revalidation interval", map[string]string{"AO_MODEL_REVALIDATION_INTERVAL": "daily"}},
		{"negative model revalidation interval", map[string]string{"AO_MODEL_REVALIDATION_INTERVAL": "-1m"}},
		{"null origin", map[string]string{"AO_ALLOWED_ORIGINS": "app://renderer,null"}},
		{"wildcard origin", map[string]string{"AO_ALLOWED_ORIGINS": "*"}},
		{"bad telemetry events", map[string]string{"AO_TELEMETRY_EVENTS": "maybe"}},
		{"bad telemetry metrics", map[string]string{"AO_TELEMETRY_METRICS": "maybe"}},
		{"bad telemetry remote", map[string]string{"AO_TELEMETRY_REMOTE": "otlp"}},
		{"overlong prime display name", map[string]string{"AO_PRIME_DISPLAY_NAME": "this prime display name is too long"}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			for k, v := range tc.env {
				t.Setenv(k, v)
			}
			if _, err := Load(); err == nil {
				t.Fatal("Load() = nil error, want error")
			}
		})
	}
}

func TestLoadAllowedOrigins(t *testing.T) {
	t.Run("default includes the packaged renderer origin", func(t *testing.T) {
		t.Setenv("AO_ALLOWED_ORIGINS", "")
		cfg, err := Load()
		if err != nil {
			t.Fatalf("Load: %v", err)
		}
		found := false
		for _, origin := range cfg.AllowedOrigins {
			if origin == "app://renderer" {
				found = true
			}
		}
		if !found {
			t.Errorf("AllowedOrigins = %v, want app://renderer included", cfg.AllowedOrigins)
		}
	})

	t.Run("override replaces defaults and trims entries", func(t *testing.T) {
		t.Setenv("AO_ALLOWED_ORIGINS", " app://renderer , http://localhost:9999 ,")
		cfg, err := Load()
		if err != nil {
			t.Fatalf("Load: %v", err)
		}
		want := []string{"app://renderer", "http://localhost:9999"}
		if len(cfg.AllowedOrigins) != len(want) {
			t.Fatalf("AllowedOrigins = %v, want %v", cfg.AllowedOrigins, want)
		}
		for i, origin := range want {
			if cfg.AllowedOrigins[i] != origin {
				t.Errorf("AllowedOrigins[%d] = %q, want %q", i, cfg.AllowedOrigins[i], origin)
			}
		}
	})
}
