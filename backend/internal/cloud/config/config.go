// Package config loads the separately deployable AO Cloud service
// configuration. It deliberately does not reuse the local daemon config,
// because loopback daemon state and cloud secrets have different trust models.
package config

import (
	"crypto/rsa"
	"crypto/x509"
	"encoding/hex"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const (
	maxGitHubPrivateKeyBytes int64 = 64 << 10
)

// Config contains the AO Cloud process configuration.
type Config struct {
	ListenAddr             string
	PublicURL              string
	WebPublicURL           string
	AuthMode               string
	AuthProvider           string
	AuthIssuer             string
	AuthAudience           string
	AuthJWKSURL            string
	WorkOSAPIKey           string
	AllowExternalSignup    bool
	DatabaseURL            string
	DatabaseDirectURL      string
	SandboxProvider        string
	DaytonaAPIURL          string
	DaytonaAPIKey          string
	DaytonaTarget          string
	DaytonaWorkerSnapshot  string
	DockerWorkerImage      string
	EncryptionKey          []byte
	WorkerSigningKey       []byte
	ReconcileInterval      time.Duration
	ShutdownTimeout        time.Duration
	AllowLocalGitHub       bool
	GitHubToken            string
	GitHubAuthMode         string
	GitHubAppID            int64
	GitHubAppClientID      string
	GitHubAppSlug          string
	GitHubAppPrivateKeyPEM []byte
	GitHubAppWebhookSecret string
	GitHubAppStateSecret   string
	WorkerBinaryPath       string
}

// Load reads, defaults, and validates AO Cloud configuration from the environment.
func Load() (Config, error) {
	encryptionKey, err := decodeKey("AO_ENCRYPTION_KEY")
	if err != nil {
		return Config{}, err
	}
	workerSigningKey, err := decodeKey("AO_WORKER_SIGNING_KEY")
	if err != nil {
		return Config{}, err
	}
	gitHubAuthMode := strings.TrimSpace(os.Getenv("AO_GITHUB_AUTH_MODE"))
	gitHubAppID, err := parseOptionalInt64("AO_GITHUB_APP_ID")
	if err != nil {
		return Config{}, err
	}
	var gitHubAppPrivateKey []byte
	if gitHubAuthMode == "github-app" {
		gitHubAppPrivateKey, err = readPrivateKeyFile(
			strings.TrimSpace(os.Getenv("AO_GITHUB_APP_PRIVATE_KEY_PATH")),
		)
		if err != nil {
			return Config{}, err
		}
	}

	cfg := Config{
		ListenAddr:             envOr("AO_CLOUD_LISTEN_ADDR", "127.0.0.1:3010"),
		PublicURL:              strings.TrimRight(envOr("AO_CLOUD_PUBLIC_URL", "http://127.0.0.1:3010"), "/"),
		WebPublicURL:           strings.TrimRight(envOr("AO_WEB_PUBLIC_URL", "http://127.0.0.1:5174"), "/"),
		AuthMode:               envOr("AO_CLOUD_AUTH_MODE", "local"),
		AuthProvider:           strings.TrimSpace(os.Getenv("AO_CLOUD_AUTH_PROVIDER")),
		AuthIssuer:             strings.TrimRight(strings.TrimSpace(os.Getenv("AO_CLOUD_AUTH_ISSUER")), "/"),
		AuthAudience:           strings.TrimSpace(os.Getenv("AO_CLOUD_AUTH_AUDIENCE")),
		AuthJWKSURL:            strings.TrimSpace(os.Getenv("AO_CLOUD_AUTH_JWKS_URL")),
		WorkOSAPIKey:           strings.TrimSpace(os.Getenv("WORKOS_API_KEY")),
		AllowExternalSignup:    envBool("AO_CLOUD_ALLOW_PUBLIC_SIGNUP", false),
		DatabaseURL:            os.Getenv("AO_DATABASE_URL"),
		DatabaseDirectURL:      strings.TrimSpace(os.Getenv("AO_DATABASE_DIRECT_URL")),
		SandboxProvider:        envOr("AO_SANDBOX_PROVIDER", "docker"),
		DaytonaAPIURL:          strings.TrimRight(envOr("AO_DAYTONA_API_URL", "https://app.daytona.io/api"), "/"),
		DaytonaAPIKey:          os.Getenv("AO_DAYTONA_API_KEY"),
		DaytonaTarget:          envOr("AO_DAYTONA_TARGET", "us"),
		DaytonaWorkerSnapshot:  strings.TrimSpace(os.Getenv("AO_DAYTONA_WORKER_SNAPSHOT")),
		DockerWorkerImage:      envOr("AO_DOCKER_WORKER_IMAGE", "ao-cloud-worker:local"),
		EncryptionKey:          encryptionKey,
		WorkerSigningKey:       workerSigningKey,
		ReconcileInterval:      2 * time.Second,
		ShutdownTimeout:        15 * time.Second,
		AllowLocalGitHub:       gitHubAuthMode == "local-gh",
		GitHubToken:            strings.TrimSpace(os.Getenv("AO_LOCAL_GITHUB_TOKEN")),
		GitHubAuthMode:         gitHubAuthMode,
		GitHubAppID:            gitHubAppID,
		GitHubAppClientID:      strings.TrimSpace(os.Getenv("AO_GITHUB_APP_CLIENT_ID")),
		GitHubAppSlug:          strings.TrimSpace(os.Getenv("AO_GITHUB_APP_SLUG")),
		GitHubAppPrivateKeyPEM: gitHubAppPrivateKey,
		GitHubAppWebhookSecret: strings.TrimSpace(os.Getenv("AO_GITHUB_APP_WEBHOOK_SECRET")),
		GitHubAppStateSecret:   strings.TrimSpace(os.Getenv("AO_GITHUB_APP_STATE_SECRET")),
		WorkerBinaryPath:       strings.TrimSpace(os.Getenv("AO_WORKER_BINARY_PATH")),
	}
	if cfg.AuthMode == "workos" {
		workOSClientID := strings.TrimSpace(os.Getenv("WORKOS_CLIENT_ID"))
		if cfg.AuthProvider == "" {
			cfg.AuthProvider = "workos"
		}
		if cfg.AuthIssuer == "" && workOSClientID != "" {
			cfg.AuthIssuer = "https://api.workos.com/user_management/" + workOSClientID
		}
		if cfg.AuthAudience == "" {
			cfg.AuthAudience = workOSClientID
		}
		if cfg.AuthJWKSURL == "" && workOSClientID != "" {
			cfg.AuthJWKSURL = "https://api.workos.com/sso/jwks/" + workOSClientID
		}
	}
	if cfg.AuthProvider == "" {
		cfg.AuthProvider = "external"
	}
	if cfg.AuthIssuer == "" {
		cfg.AuthIssuer = cfg.WebPublicURL
	}
	if cfg.AuthAudience == "" {
		cfg.AuthAudience = cfg.AuthIssuer
	}
	if cfg.AuthJWKSURL == "" {
		cfg.AuthJWKSURL = cfg.AuthIssuer + "/api/auth/jwks"
	}
	if err := cfg.Validate(); err != nil {
		return Config{}, err
	}
	if cfg.DatabaseDirectURL == "" {
		cfg.DatabaseDirectURL = cfg.DatabaseURL
	}
	return cfg, nil
}

// Validate checks that Config can safely start the cloud service.
func (c Config) Validate() error {
	missing := make([]string, 0, 3)
	if strings.TrimSpace(c.DatabaseURL) == "" {
		missing = append(missing, "AO_DATABASE_URL")
	}
	if len(missing) > 0 {
		return fmt.Errorf("missing required cloud configuration: %s", strings.Join(missing, ", "))
	}
	if len(c.EncryptionKey) != 32 {
		return errors.New("AO_ENCRYPTION_KEY must decode to exactly 32 bytes")
	}
	if len(c.WorkerSigningKey) < 32 {
		return errors.New("AO_WORKER_SIGNING_KEY must decode to at least 32 bytes")
	}
	switch c.AuthMode {
	case "local":
	case "workos":
		if strings.TrimSpace(c.WorkOSAPIKey) == "" {
			return errors.New("WORKOS_API_KEY is required when AO_CLOUD_AUTH_MODE is workos")
		}
		fallthrough
	case "external":
		if strings.TrimSpace(c.AuthProvider) == "" ||
			strings.TrimSpace(c.AuthIssuer) == "" ||
			strings.TrimSpace(c.AuthAudience) == "" ||
			strings.TrimSpace(c.AuthJWKSURL) == "" {
			return errors.New("AO_CLOUD_AUTH_PROVIDER, AO_CLOUD_AUTH_ISSUER, AO_CLOUD_AUTH_AUDIENCE, and AO_CLOUD_AUTH_JWKS_URL are required when AO_CLOUD_AUTH_MODE is workos or external")
		}
	default:
		return fmt.Errorf("AO_CLOUD_AUTH_MODE must be local, workos, or external, got %q", c.AuthMode)
	}
	switch c.GitHubAuthMode {
	case "":
		if c.AuthMode == "workos" {
			return errors.New("AO_GITHUB_AUTH_MODE must be github-app when AO_CLOUD_AUTH_MODE is workos")
		}
	case "local-gh":
		if c.AuthMode != "local" {
			return errors.New("AO_GITHUB_AUTH_MODE=local-gh is allowed only when AO_CLOUD_AUTH_MODE=local")
		}
	case "github-app":
		if c.GitHubAppID <= 0 {
			return errors.New("AO_GITHUB_APP_ID must be a positive integer")
		}
		if strings.TrimSpace(c.GitHubAppClientID) == "" {
			return errors.New("AO_GITHUB_APP_CLIENT_ID is required")
		}
		if strings.TrimSpace(c.GitHubAppSlug) == "" {
			return errors.New("AO_GITHUB_APP_SLUG is required")
		}
		if err := validateGitHubPrivateKeyPEM(c.GitHubAppPrivateKeyPEM); err != nil {
			return err
		}
		if len(c.GitHubAppWebhookSecret) < 32 {
			return errors.New("AO_GITHUB_APP_WEBHOOK_SECRET must be at least 32 characters")
		}
		if len(c.GitHubAppStateSecret) < 32 {
			return errors.New("AO_GITHUB_APP_STATE_SECRET must be at least 32 characters")
		}
		if c.GitHubAppWebhookSecret == c.GitHubAppStateSecret {
			return errors.New("AO_GITHUB_APP_WEBHOOK_SECRET and AO_GITHUB_APP_STATE_SECRET must be independent")
		}
		if c.GitHubToken != "" {
			return errors.New("AO_LOCAL_GITHUB_TOKEN must not be set when AO_GITHUB_AUTH_MODE=github-app")
		}
	default:
		return fmt.Errorf("AO_GITHUB_AUTH_MODE must be empty, local-gh, or github-app, got %q", c.GitHubAuthMode)
	}
	switch c.SandboxProvider {
	case "docker":
		if strings.TrimSpace(c.DockerWorkerImage) == "" {
			return errors.New("AO_DOCKER_WORKER_IMAGE is required when AO_SANDBOX_PROVIDER=docker")
		}
	case "daytona":
		if strings.TrimSpace(c.DaytonaAPIKey) == "" {
			return errors.New("AO_DAYTONA_API_KEY is required when AO_SANDBOX_PROVIDER=daytona")
		}
		if strings.TrimSpace(c.DaytonaWorkerSnapshot) == "" {
			return errors.New("AO_DAYTONA_WORKER_SNAPSHOT is required when AO_SANDBOX_PROVIDER=daytona")
		}
		switch c.DaytonaTarget {
		case "us", "eu":
		default:
			return fmt.Errorf("AO_DAYTONA_TARGET must be us or eu, got %q", c.DaytonaTarget)
		}
	default:
		return fmt.Errorf("AO_SANDBOX_PROVIDER must be docker or daytona, got %q", c.SandboxProvider)
	}
	return nil
}

func envOr(name, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(name)); value != "" {
		return value
	}
	return fallback
}

func envBool(name string, fallback bool) bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv(name))) {
	case "1", "true", "yes", "on":
		return true
	case "0", "false", "no", "off":
		return false
	default:
		return fallback
	}
}

func decodeKey(name string) ([]byte, error) {
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		return nil, fmt.Errorf("%s is required", name)
	}
	key, err := hex.DecodeString(raw)
	if err != nil {
		return nil, fmt.Errorf("%s must be hexadecimal: %w", name, err)
	}
	return key, nil
}

func parseOptionalInt64(name string) (int64, error) {
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		return 0, nil
	}
	value, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || value <= 0 {
		return 0, fmt.Errorf("%s must be a positive base-10 integer", name)
	}
	return value, nil
}

func readPrivateKeyFile(path string) ([]byte, error) {
	if path == "" {
		return nil, errors.New("AO_GITHUB_APP_PRIVATE_KEY_PATH is required when AO_GITHUB_AUTH_MODE=github-app")
	}
	if !filepath.IsAbs(path) {
		return nil, errors.New("AO_GITHUB_APP_PRIVATE_KEY_PATH must be an absolute path")
	}
	info, err := os.Lstat(path)
	if err != nil {
		return nil, fmt.Errorf("read AO_GITHUB_APP_PRIVATE_KEY_PATH: %w", err)
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return nil, errors.New("AO_GITHUB_APP_PRIVATE_KEY_PATH must not be a symbolic link")
	}
	if !info.Mode().IsRegular() {
		return nil, errors.New("AO_GITHUB_APP_PRIVATE_KEY_PATH must be a regular file")
	}
	if info.Mode().Perm()&0o077 != 0 {
		return nil, errors.New("AO_GITHUB_APP_PRIVATE_KEY_PATH must not be readable or writable by group or others")
	}
	if info.Size() == 0 || info.Size() > maxGitHubPrivateKeyBytes {
		return nil, fmt.Errorf("AO_GITHUB_APP_PRIVATE_KEY_PATH must be between 1 and %d bytes", maxGitHubPrivateKeyBytes)
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("open AO_GITHUB_APP_PRIVATE_KEY_PATH: %w", err)
	}
	defer file.Close()
	privateKey, err := io.ReadAll(io.LimitReader(file, maxGitHubPrivateKeyBytes+1))
	if err != nil {
		return nil, fmt.Errorf("read AO_GITHUB_APP_PRIVATE_KEY_PATH: %w", err)
	}
	if int64(len(privateKey)) > maxGitHubPrivateKeyBytes {
		return nil, fmt.Errorf("AO_GITHUB_APP_PRIVATE_KEY_PATH must be at most %d bytes", maxGitHubPrivateKeyBytes)
	}
	return privateKey, nil
}

func validateGitHubPrivateKeyPEM(privateKeyPEM []byte) error {
	block, rest := pem.Decode(privateKeyPEM)
	if block == nil || len(strings.TrimSpace(string(rest))) != 0 {
		return errors.New("AO_GITHUB_APP_PRIVATE_KEY_PATH must contain exactly one PEM private key")
	}
	if x509.IsEncryptedPEMBlock(block) {
		return errors.New("AO_GITHUB_APP_PRIVATE_KEY_PATH must contain an unencrypted RSA private key")
	}
	var key any
	var err error
	switch block.Type {
	case "RSA PRIVATE KEY":
		key, err = x509.ParsePKCS1PrivateKey(block.Bytes)
	case "PRIVATE KEY":
		key, err = x509.ParsePKCS8PrivateKey(block.Bytes)
	default:
		return errors.New("AO_GITHUB_APP_PRIVATE_KEY_PATH must contain an RSA private key")
	}
	if err != nil {
		return fmt.Errorf("AO_GITHUB_APP_PRIVATE_KEY_PATH contains an invalid private key: %w", err)
	}
	if _, ok := key.(*rsa.PrivateKey); !ok {
		return errors.New("AO_GITHUB_APP_PRIVATE_KEY_PATH must contain an RSA private key")
	}
	return nil
}
