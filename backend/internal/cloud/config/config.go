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

const defaultFlyWorkerImage = "registry.fly.io/ao-workers-nihal-2026:stable"

// Config contains the AO Cloud process configuration.
type Config struct {
	ListenAddr            string
	PublicURL             string
	WebPublicURL          string
	DatabaseURL           string
	DatabaseDirectURL     string
	AuthMode              string
	SupabaseURL           string
	SupabaseAnonKey       string
	SandboxProvider       string
	DaytonaAPIURL         string
	DaytonaAPIKey         string
	DaytonaTarget         string
	DaytonaWorkerSnapshot string
	DockerWorkerImage     string
	FlyAPIURL             string
	FlyAPIToken           string
	FlyApp                string
	FlyRegion             string
	FlyWorkerImage        string
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
		AuthMode:              strings.ToLower(envOr("AO_CLOUD_AUTH_MODE", "local")),
		SupabaseURL:           strings.TrimRight(os.Getenv("AO_SUPABASE_URL"), "/"),
		SupabaseAnonKey:       os.Getenv("AO_SUPABASE_ANON_KEY"),
		SandboxProvider:       envOr("AO_SANDBOX_PROVIDER", "docker"),
		DaytonaAPIURL:         strings.TrimRight(envOr("AO_DAYTONA_API_URL", "https://app.daytona.io/api"), "/"),
		DaytonaAPIKey:         os.Getenv("AO_DAYTONA_API_KEY"),
		DaytonaTarget:         envOr("AO_DAYTONA_TARGET", "us"),
		DaytonaWorkerSnapshot: strings.TrimSpace(os.Getenv("AO_DAYTONA_WORKER_SNAPSHOT")),
		DockerWorkerImage:     envOr("AO_DOCKER_WORKER_IMAGE", "ao-cloud-worker:local"),
		FlyAPIURL:             strings.TrimRight(envOr("AO_FLY_API_URL", "https://api.machines.dev/v1"), "/"),
		FlyAPIToken:           strings.TrimSpace(os.Getenv("AO_FLY_API_TOKEN")),
		FlyApp:                strings.TrimSpace(os.Getenv("AO_FLY_APP")),
		FlyRegion:             envOr("AO_FLY_REGION", "iad"),
		FlyWorkerImage:        envOr("AO_FLY_WORKER_IMAGE", defaultFlyWorkerImage),
		EncryptionKey:         encryptionKey,
		WorkerSigningKey:      workerSigningKey,
		ReconcileInterval:     2 * time.Second,
		ShutdownTimeout:       15 * time.Second,
		AllowLocalGitHub:      os.Getenv("AO_GITHUB_AUTH_MODE") == "local-gh",
		GitHubToken:           strings.TrimSpace(os.Getenv("AO_GITHUB_TOKEN")),
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
	switch c.AuthMode {
	case "local":
	case "supabase", "hosted":
		if strings.TrimSpace(c.SupabaseURL) == "" {
			missing = append(missing, "AO_SUPABASE_URL")
		}
		if strings.TrimSpace(c.SupabaseAnonKey) == "" {
			missing = append(missing, "AO_SUPABASE_ANON_KEY")
		}
	default:
		return fmt.Errorf("AO_CLOUD_AUTH_MODE must be local, supabase, or hosted, got %q", c.AuthMode)
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
	case "fly":
		missingFly := make([]string, 0, 2)
		for name, value := range map[string]string{
			"AO_FLY_API_TOKEN": c.FlyAPIToken,
			"AO_FLY_APP":       c.FlyApp,
		} {
			if strings.TrimSpace(value) == "" {
				missingFly = append(missingFly, name)
			}
		}
		if len(missingFly) > 0 {
			return fmt.Errorf("missing required Fly configuration: %s", strings.Join(missingFly, ", "))
		}
	default:
		return fmt.Errorf("AO_SANDBOX_PROVIDER must be docker, daytona, or fly, got %q", c.SandboxProvider)
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
