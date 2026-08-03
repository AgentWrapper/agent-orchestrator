package config

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/pem"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

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
	configureGitHubApp(t)

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
	configureGitHubApp(t)

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
	configureGitHubApp(t)

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

func TestLoadWorkOSRequiresGitHubAppMode(t *testing.T) {
	setBaseCloudEnv(t)
	t.Setenv("AO_CLOUD_AUTH_MODE", "workos")
	t.Setenv("WORKOS_CLIENT_ID", "client_123")
	t.Setenv("WORKOS_API_KEY", "sk_test")
	t.Setenv("AO_GITHUB_AUTH_MODE", "")

	_, err := Load()
	if err == nil || !strings.Contains(err.Error(), "must be github-app") {
		t.Fatalf("Load() error = %v, want GitHub App mode requirement", err)
	}
}

func TestLoadAcceptsArbitraryGitHubAppConfiguration(t *testing.T) {
	setBaseCloudEnv(t)
	t.Setenv("AO_CLOUD_AUTH_MODE", "workos")
	t.Setenv("WORKOS_CLIENT_ID", "client_123")
	t.Setenv("WORKOS_API_KEY", "sk_test")
	privateKey := configureGitHubApp(t)
	t.Setenv("AO_GITHUB_APP_ID", "987654")
	t.Setenv("AO_GITHUB_APP_CLIENT_ID", "Iv_production_client")
	t.Setenv("AO_GITHUB_APP_SLUG", "ao-cloud-production")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if cfg.GitHubAuthMode != "github-app" {
		t.Fatalf("GitHubAuthMode = %q", cfg.GitHubAuthMode)
	}
	if cfg.GitHubAppID != 987654 {
		t.Fatalf("GitHubAppID = %d", cfg.GitHubAppID)
	}
	if cfg.GitHubAppClientID != "Iv_production_client" {
		t.Fatalf("GitHubAppClientID = %q", cfg.GitHubAppClientID)
	}
	if cfg.GitHubAppSlug != "ao-cloud-production" {
		t.Fatalf("GitHubAppSlug = %q", cfg.GitHubAppSlug)
	}
	wantPrivateKey, err := os.ReadFile(privateKey)
	if err != nil {
		t.Fatal(err)
	}
	if string(cfg.GitHubAppPrivateKeyPEM) != string(wantPrivateKey) {
		t.Fatal("GitHubAppPrivateKeyPEM did not match the mounted PEM")
	}
}

func TestLoadRejectsMissingGitHubAppIdentity(t *testing.T) {
	tests := []struct {
		name  string
		env   string
		value string
		want  string
	}{
		{name: "app ID", env: "AO_GITHUB_APP_ID", value: "0", want: "AO_GITHUB_APP_ID"},
		{name: "client ID", env: "AO_GITHUB_APP_CLIENT_ID", value: "", want: "AO_GITHUB_APP_CLIENT_ID"},
		{name: "slug", env: "AO_GITHUB_APP_SLUG", value: "", want: "AO_GITHUB_APP_SLUG"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			setBaseCloudEnv(t)
			configureGitHubApp(t)
			t.Setenv(test.env, test.value)

			_, err := Load()
			if err == nil || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("Load() error = %v, want %q", err, test.want)
			}
		})
	}
}

func TestLoadRejectsSharedGitHubAppSecrets(t *testing.T) {
	setBaseCloudEnv(t)
	configureGitHubApp(t)
	t.Setenv("AO_GITHUB_APP_STATE_SECRET", strings.Repeat("a", 64))
	t.Setenv("AO_GITHUB_APP_WEBHOOK_SECRET", strings.Repeat("a", 64))

	_, err := Load()
	if err == nil || !strings.Contains(err.Error(), "must be independent") {
		t.Fatalf("Load() error = %v, want independent-secret error", err)
	}
}

func TestLoadRejectsLocalGitHubTokenInAppMode(t *testing.T) {
	setBaseCloudEnv(t)
	configureGitHubApp(t)
	t.Setenv("AO_LOCAL_GITHUB_TOKEN", "must-not-cross-profile-boundary")

	_, err := Load()
	if err == nil || !strings.Contains(err.Error(), "AO_LOCAL_GITHUB_TOKEN must not be set") {
		t.Fatalf("Load() error = %v, want local-token rejection", err)
	}
}

func TestLoadRejectsRelativeGitHubAppPrivateKeyPath(t *testing.T) {
	setBaseCloudEnv(t)
	configureGitHubApp(t)
	t.Setenv("AO_GITHUB_APP_PRIVATE_KEY_PATH", "github-app.private-key.pem")

	_, err := Load()
	if err == nil || !strings.Contains(err.Error(), "must be an absolute path") {
		t.Fatalf("Load() error = %v, want absolute-path error", err)
	}
}

func TestLoadRejectsPermissiveGitHubAppPrivateKey(t *testing.T) {
	setBaseCloudEnv(t)
	privateKeyPath := configureGitHubApp(t)
	if err := os.Chmod(privateKeyPath, 0o644); err != nil {
		t.Fatal(err)
	}

	_, err := Load()
	if err == nil || !strings.Contains(err.Error(), "group or others") {
		t.Fatalf("Load() error = %v, want private-key permission error", err)
	}
}

func TestLoadRejectsInvalidGitHubAppPrivateKeyPEM(t *testing.T) {
	setBaseCloudEnv(t)
	privateKeyPath := configureGitHubApp(t)
	if err := os.WriteFile(privateKeyPath, []byte("not a private key"), 0o600); err != nil {
		t.Fatal(err)
	}

	_, err := Load()
	if err == nil || !strings.Contains(err.Error(), "PEM private key") {
		t.Fatalf("Load() error = %v, want invalid PEM error", err)
	}
}

func setBaseCloudEnv(t *testing.T) {
	t.Helper()
	t.Setenv("AO_DATABASE_URL", "postgres://example")
	t.Setenv("AO_SANDBOX_PROVIDER", "docker")
	t.Setenv("AO_ENCRYPTION_KEY", strings.Repeat("0", 64))
	t.Setenv("AO_WORKER_SIGNING_KEY", strings.Repeat("1", 64))
}

func configureGitHubApp(t *testing.T) string {
	t.Helper()
	privateKey, err := rsa.GenerateKey(rand.Reader, 1024)
	if err != nil {
		t.Fatal(err)
	}
	privateKeyPEM := pem.EncodeToMemory(&pem.Block{
		Type:  "RSA PRIVATE KEY",
		Bytes: x509.MarshalPKCS1PrivateKey(privateKey),
	})
	privateKeyPath := filepath.Join(t.TempDir(), "github-app.private-key.pem")
	if err := os.WriteFile(privateKeyPath, privateKeyPEM, 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("AO_GITHUB_AUTH_MODE", "github-app")
	t.Setenv("AO_GITHUB_APP_ID", "4475070")
	t.Setenv("AO_GITHUB_APP_CLIENT_ID", "Iv23liLaAnXMSyGGzVl4")
	t.Setenv("AO_GITHUB_APP_SLUG", "ao-cloud-test")
	t.Setenv("AO_GITHUB_APP_PRIVATE_KEY_PATH", privateKeyPath)
	t.Setenv("AO_GITHUB_APP_WEBHOOK_SECRET", strings.Repeat("a", 64))
	t.Setenv("AO_GITHUB_APP_STATE_SECRET", strings.Repeat("b", 64))
	return privateKeyPath
}
