// Package config loads the separately deployable AO Cloud service
// configuration. It deliberately does not reuse the local daemon config,
// because loopback daemon state and cloud secrets have different trust models.
package config

import (
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"
)

// Config contains the AO Cloud process configuration.
type Config struct {
	ListenAddr            string
	PublicURL             string
	WebPublicURL          string
	DatabaseURL           string
	DatabaseDirectURL     string
	SandboxProvider       string
	DaytonaAPIURL         string
	DaytonaAPIKey         string
	DaytonaTarget         string
	DaytonaWorkerSnapshot string
	DockerWorkerImage     string
	EncryptionKey         []byte
	WorkerSigningKey      []byte
	ReconcileInterval     time.Duration
	ShutdownTimeout       time.Duration
	AllowLocalGitHub      bool
	GitHubToken           string
	WorkerBinaryPath      string
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

	cfg := Config{
		ListenAddr:            envOr("AO_CLOUD_LISTEN_ADDR", "127.0.0.1:3010"),
		PublicURL:             strings.TrimRight(envOr("AO_CLOUD_PUBLIC_URL", "http://127.0.0.1:3010"), "/"),
		WebPublicURL:          strings.TrimRight(envOr("AO_WEB_PUBLIC_URL", "http://127.0.0.1:5174"), "/"),
		DatabaseURL:           os.Getenv("AO_DATABASE_URL"),
		DatabaseDirectURL:     strings.TrimSpace(os.Getenv("AO_DATABASE_DIRECT_URL")),
		SandboxProvider:       envOr("AO_SANDBOX_PROVIDER", "docker"),
		DaytonaAPIURL:         strings.TrimRight(envOr("AO_DAYTONA_API_URL", "https://app.daytona.io/api"), "/"),
		DaytonaAPIKey:         os.Getenv("AO_DAYTONA_API_KEY"),
		DaytonaTarget:         envOr("AO_DAYTONA_TARGET", "us"),
		DaytonaWorkerSnapshot: strings.TrimSpace(os.Getenv("AO_DAYTONA_WORKER_SNAPSHOT")),
		DockerWorkerImage:     envOr("AO_DOCKER_WORKER_IMAGE", "ao-cloud-worker:local"),
		EncryptionKey:         encryptionKey,
		WorkerSigningKey:      workerSigningKey,
		ReconcileInterval:     2 * time.Second,
		ShutdownTimeout:       15 * time.Second,
		AllowLocalGitHub:      os.Getenv("AO_GITHUB_AUTH_MODE") == "local-gh",
		GitHubToken:           strings.TrimSpace(os.Getenv("AO_LOCAL_GITHUB_TOKEN")),
		WorkerBinaryPath:      strings.TrimSpace(os.Getenv("AO_WORKER_BINARY_PATH")),
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
