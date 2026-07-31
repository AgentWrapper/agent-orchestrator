package config

import "testing"

func TestLoadRequiresCloudSecrets(t *testing.T) {
	t.Setenv("AO_DATABASE_URL", "postgres://example")
	t.Setenv("AO_DATABASE_DIRECT_URL", "")
	t.Setenv("AO_SUPABASE_URL", "https://project.supabase.co")
	t.Setenv("AO_SUPABASE_ANON_KEY", "anon")
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
		t.Fatalf("AuthMode = %q, want local default", cfg.AuthMode)
	}
	if cfg.DatabaseDirectURL != cfg.DatabaseURL {
		t.Fatalf("DatabaseDirectURL = %q, want runtime fallback", cfg.DatabaseDirectURL)
	}
	if len(cfg.EncryptionKey) != 32 {
		t.Fatalf("EncryptionKey length = %d", len(cfg.EncryptionKey))
	}
}

func TestLoadLocalAuthDoesNotRequireSupabase(t *testing.T) {
	t.Setenv("AO_DATABASE_URL", "postgres://example")
	t.Setenv("AO_CLOUD_AUTH_MODE", "local")
	t.Setenv("AO_SUPABASE_URL", "")
	t.Setenv("AO_SUPABASE_ANON_KEY", "")
	t.Setenv("AO_SANDBOX_PROVIDER", "docker")
	t.Setenv("AO_ENCRYPTION_KEY", "0000000000000000000000000000000000000000000000000000000000000000")
	t.Setenv("AO_WORKER_SIGNING_KEY", "1111111111111111111111111111111111111111111111111111111111111111")

	if _, err := Load(); err != nil {
		t.Fatalf("Load() error = %v", err)
	}
}

func TestLoadSupabaseAuthRequiresSupabaseCredentials(t *testing.T) {
	t.Setenv("AO_DATABASE_URL", "postgres://example")
	t.Setenv("AO_CLOUD_AUTH_MODE", "supabase")
	t.Setenv("AO_SUPABASE_URL", "")
	t.Setenv("AO_SUPABASE_ANON_KEY", "")
	t.Setenv("AO_SANDBOX_PROVIDER", "docker")
	t.Setenv("AO_ENCRYPTION_KEY", "0000000000000000000000000000000000000000000000000000000000000000")
	t.Setenv("AO_WORKER_SIGNING_KEY", "1111111111111111111111111111111111111111111111111111111111111111")

	if _, err := Load(); err == nil {
		t.Fatal("Load() error = nil, want missing Supabase credentials")
	}
}

func TestLoadRejectsInvalidTarget(t *testing.T) {
	t.Setenv("AO_DATABASE_URL", "postgres://example")
	t.Setenv("AO_DATABASE_DIRECT_URL", "")
	t.Setenv("AO_SUPABASE_URL", "https://project.supabase.co")
	t.Setenv("AO_SUPABASE_ANON_KEY", "anon")
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

func TestLoadRequiresDaytonaWorkerSnapshot(t *testing.T) {
	t.Setenv("AO_DATABASE_URL", "postgres://example")
	t.Setenv("AO_CLOUD_AUTH_MODE", "local")
	t.Setenv("AO_SANDBOX_PROVIDER", "daytona")
	t.Setenv("AO_DAYTONA_API_KEY", "daytona")
	t.Setenv("AO_DAYTONA_WORKER_SNAPSHOT", "")
	t.Setenv("AO_ENCRYPTION_KEY", "0000000000000000000000000000000000000000000000000000000000000000")
	t.Setenv("AO_WORKER_SIGNING_KEY", "1111111111111111111111111111111111111111111111111111111111111111")

	if _, err := Load(); err == nil {
		t.Fatal("Load() error = nil, want missing Daytona worker snapshot")
	}
}

func TestLoadAcceptsFlyWithoutDaytonaKey(t *testing.T) {
	t.Setenv("AO_DATABASE_URL", "postgres://example")
	t.Setenv("AO_SUPABASE_URL", "https://project.supabase.co")
	t.Setenv("AO_SUPABASE_ANON_KEY", "anon")
	t.Setenv("AO_SANDBOX_PROVIDER", "fly")
	t.Setenv("AO_DAYTONA_API_KEY", "")
	t.Setenv("AO_FLY_API_TOKEN", "fly-token")
	t.Setenv("AO_FLY_APP", "ao-workers")
	t.Setenv("AO_FLY_REGION", "bom")
	t.Setenv("AO_FLY_WORKER_IMAGE", "")
	t.Setenv("AO_ENCRYPTION_KEY", "0000000000000000000000000000000000000000000000000000000000000000")
	t.Setenv("AO_WORKER_SIGNING_KEY", "1111111111111111111111111111111111111111111111111111111111111111")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if cfg.SandboxProvider != "fly" || cfg.FlyRegion != "bom" {
		t.Fatalf("Fly config = %#v", cfg)
	}
	if cfg.FlyWorkerImage != defaultFlyWorkerImage {
		t.Fatalf("FlyWorkerImage = %q", cfg.FlyWorkerImage)
	}
}
