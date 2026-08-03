package config

import "testing"

func TestLoadRequiresCloudSecrets(t *testing.T) {
	t.Setenv("AO_DATABASE_URL", "postgres://example")
	t.Setenv("AO_DATABASE_DIRECT_URL", "")
	t.Setenv("AO_SANDBOX_PROVIDER", "daytona")
	t.Setenv("AO_DAYTONA_API_KEY", "daytona")
	t.Setenv("AO_DAYTONA_TARGET", "")
	t.Setenv("AO_DAYTONA_WORKER_SNAPSHOT", "worker-snapshot")
	t.Setenv("AO_ENCRYPTION_KEY", "0000000000000000000000000000000000000000000000000000000000000000")
	t.Setenv("AO_WORKER_SIGNING_KEY", "1111111111111111111111111111111111111111111111111111111111111111")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if cfg.ListenAddr != "127.0.0.1:3010" {
		t.Fatalf("ListenAddr = %q", cfg.ListenAddr)
	}
	if cfg.DaytonaTarget != "us" {
		t.Fatalf("DaytonaTarget = %q", cfg.DaytonaTarget)
	}
	if cfg.DaytonaWorkerSnapshot != "worker-snapshot" {
		t.Fatalf("DaytonaWorkerSnapshot = %q", cfg.DaytonaWorkerSnapshot)
	}
	if cfg.SandboxProvider != "daytona" {
		t.Fatalf("SandboxProvider = %q", cfg.SandboxProvider)
	}
	if cfg.AuthMode != "local" {
		t.Fatalf("AuthMode = %q", cfg.AuthMode)
	}
	if cfg.DatabaseDirectURL != cfg.DatabaseURL {
		t.Fatalf("DatabaseDirectURL = %q, want runtime fallback", cfg.DatabaseDirectURL)
	}
	if len(cfg.EncryptionKey) != 32 {
		t.Fatalf("EncryptionKey length = %d", len(cfg.EncryptionKey))
	}
}

func TestLoadDoesNotRequireExternalAuthConfiguration(t *testing.T) {
	t.Setenv("AO_DATABASE_URL", "postgres://example")
	t.Setenv("AO_SANDBOX_PROVIDER", "docker")
	t.Setenv("AO_ENCRYPTION_KEY", "0000000000000000000000000000000000000000000000000000000000000000")
	t.Setenv("AO_WORKER_SIGNING_KEY", "1111111111111111111111111111111111111111111111111111111111111111")

	if _, err := Load(); err != nil {
		t.Fatalf("Load() error = %v", err)
	}
}

func TestLoadRejectsInvalidTarget(t *testing.T) {
	t.Setenv("AO_DATABASE_URL", "postgres://example")
	t.Setenv("AO_DATABASE_DIRECT_URL", "")
	t.Setenv("AO_SANDBOX_PROVIDER", "daytona")
	t.Setenv("AO_DAYTONA_API_KEY", "daytona")
	t.Setenv("AO_DAYTONA_TARGET", "moon")
	t.Setenv("AO_DAYTONA_WORKER_SNAPSHOT", "worker-snapshot")
	t.Setenv("AO_ENCRYPTION_KEY", "0000000000000000000000000000000000000000000000000000000000000000")
	t.Setenv("AO_WORKER_SIGNING_KEY", "1111111111111111111111111111111111111111111111111111111111111111")

	if _, err := Load(); err == nil {
		t.Fatal("Load() error = nil, want invalid target")
	}
}

func TestLoadAcceptsWorkOSMode(t *testing.T) {
	t.Setenv("AO_DATABASE_URL", "postgres://example")
	t.Setenv("AO_SANDBOX_PROVIDER", "docker")
	t.Setenv("AO_ENCRYPTION_KEY", "0000000000000000000000000000000000000000000000000000000000000000")
	t.Setenv("AO_WORKER_SIGNING_KEY", "1111111111111111111111111111111111111111111111111111111111111111")
	t.Setenv("AO_CLOUD_AUTH_MODE", "workos")
	t.Setenv("WORKOS_CLIENT_ID", "client_123")
	t.Setenv("WORKOS_API_KEY", "sk_test")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if cfg.AuthProvider != "workos" {
		t.Fatalf("AuthProvider = %q", cfg.AuthProvider)
	}
	if cfg.AuthIssuer != "https://api.workos.com/user_management/client_123" {
		t.Fatalf("AuthIssuer = %q", cfg.AuthIssuer)
	}
	if cfg.AuthAudience != "client_123" {
		t.Fatalf("AuthAudience = %q", cfg.AuthAudience)
	}
	if cfg.AuthJWKSURL != "https://api.workos.com/sso/jwks/client_123" {
		t.Fatalf("AuthJWKSURL = %q", cfg.AuthJWKSURL)
	}
	if cfg.AllowExternalSignup {
		t.Fatal("AllowExternalSignup = true, want hosted default false")
	}
}

func TestLoadAllowsExplicitExternalSignup(t *testing.T) {
	t.Setenv("AO_DATABASE_URL", "postgres://example")
	t.Setenv("AO_SANDBOX_PROVIDER", "docker")
	t.Setenv("AO_ENCRYPTION_KEY", "0000000000000000000000000000000000000000000000000000000000000000")
	t.Setenv("AO_WORKER_SIGNING_KEY", "1111111111111111111111111111111111111111111111111111111111111111")
	t.Setenv("AO_CLOUD_AUTH_MODE", "workos")
	t.Setenv("WORKOS_CLIENT_ID", "client_123")
	t.Setenv("WORKOS_API_KEY", "sk_test")
	t.Setenv("AO_CLOUD_ALLOW_PUBLIC_SIGNUP", "true")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if !cfg.AllowExternalSignup {
		t.Fatal("AllowExternalSignup = false, want true")
	}
}

func TestLoadRequiresWorkOSAPIKey(t *testing.T) {
	t.Setenv("AO_DATABASE_URL", "postgres://example")
	t.Setenv("AO_SANDBOX_PROVIDER", "docker")
	t.Setenv("AO_ENCRYPTION_KEY", "0000000000000000000000000000000000000000000000000000000000000000")
	t.Setenv("AO_WORKER_SIGNING_KEY", "1111111111111111111111111111111111111111111111111111111111111111")
	t.Setenv("AO_CLOUD_AUTH_MODE", "workos")
	t.Setenv("WORKOS_CLIENT_ID", "client_123")
	t.Setenv("WORKOS_API_KEY", "")

	if _, err := Load(); err == nil {
		t.Fatal("Load() error = nil, want missing WorkOS API key")
	}
}

func TestLoadRejectsInvalidAuthMode(t *testing.T) {
	t.Setenv("AO_DATABASE_URL", "postgres://example")
	t.Setenv("AO_SANDBOX_PROVIDER", "docker")
	t.Setenv("AO_CLOUD_AUTH_MODE", "magic")
	t.Setenv("AO_ENCRYPTION_KEY", "0000000000000000000000000000000000000000000000000000000000000000")
	t.Setenv("AO_WORKER_SIGNING_KEY", "1111111111111111111111111111111111111111111111111111111111111111")

	if _, err := Load(); err == nil {
		t.Fatal("Load() error = nil, want invalid auth mode")
	}
}

func TestLoadRequiresDaytonaWorkerSnapshot(t *testing.T) {
	t.Setenv("AO_DATABASE_URL", "postgres://example")
	t.Setenv("AO_SANDBOX_PROVIDER", "daytona")
	t.Setenv("AO_DAYTONA_API_KEY", "daytona")
	t.Setenv("AO_DAYTONA_WORKER_SNAPSHOT", "")
	t.Setenv("AO_ENCRYPTION_KEY", "0000000000000000000000000000000000000000000000000000000000000000")
	t.Setenv("AO_WORKER_SIGNING_KEY", "1111111111111111111111111111111111111111111111111111111111111111")

	if _, err := Load(); err == nil {
		t.Fatal("Load() error = nil, want missing Daytona worker snapshot")
	}
}
