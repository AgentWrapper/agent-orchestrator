package cloud

import (
	"fmt"
	"net"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/auth"
)

const (
	defaultHost = "127.0.0.1"
	defaultPort = 3011
)

// Config is the ao-cloud control-plane configuration.
type Config struct {
	Host           string
	Port           int
	DatabaseURL    string
	JWTSecret      string
	SecretKey      string
	Google         auth.GoogleConfig
	RequestTimeout time.Duration
	DataDir        string
	Runtime        string
	PublicAPIBase  string
	DevAuth        bool
	Daytona        DaytonaConfig
}

// DaytonaConfig configures cloud sandbox sessions.
type DaytonaConfig struct {
	APIKey             string
	APIURL             string
	Snapshot           string
	Target             string
	CPU                int
	MemoryGiB          int
	DiskGiB            int
	AutoStopMinutes    int
	AutoArchiveMinutes int
	WorkspaceRoot      string
	GitUsername        string
	GitPassword        string
}

// LoadConfig resolves ao-cloud configuration from the environment.
func LoadConfig() (Config, error) {
	dataDir, err := defaultDataDir()
	if err != nil {
		return Config{}, err
	}
	cfg := Config{
		Host:           envDefault("AO_CLOUD_HOST", defaultHost),
		Port:           defaultPort,
		DatabaseURL:    os.Getenv("AO_CLOUD_DATABASE_URL"),
		JWTSecret:      os.Getenv("AO_CLOUD_JWT_SECRET"),
		SecretKey:      os.Getenv("AO_CLOUD_SECRET_KEY"),
		RequestTimeout: 60 * time.Second,
		DataDir:        envDefault("AO_DATA_DIR", dataDir),
		Runtime:        strings.TrimSpace(envDefault("AO_CLOUD_RUNTIME", os.Getenv("AO_RUNTIME"))),
		PublicAPIBase:  strings.TrimRight(strings.TrimSpace(os.Getenv("AO_CLOUD_API_BASE")), "/"),
		DevAuth:        os.Getenv("AO_CLOUD_DEV_AUTH") == "1",
		Google: auth.GoogleConfig{
			ClientID:     os.Getenv("AO_CLOUD_GOOGLE_CLIENT_ID"),
			ClientSecret: os.Getenv("AO_CLOUD_GOOGLE_CLIENT_SECRET"),
			RedirectURL:  os.Getenv("AO_CLOUD_GOOGLE_REDIRECT_URL"),
		},
		Daytona: DaytonaConfig{
			APIKey:          os.Getenv("DAYTONA_API_KEY"),
			APIURL:          os.Getenv("DAYTONA_API_URL"),
			Snapshot:        os.Getenv("AO_DAYTONA_SNAPSHOT"),
			Target:          os.Getenv("DAYTONA_TARGET"),
			AutoStopMinutes: 15,
			WorkspaceRoot:   os.Getenv("AO_DAYTONA_WORKSPACE_ROOT"),
			GitUsername:     os.Getenv("AO_CLOUD_GIT_USERNAME"),
			GitPassword:     os.Getenv("AO_CLOUD_GIT_PASSWORD"),
		},
	}
	if raw := os.Getenv("AO_CLOUD_PORT"); raw != "" {
		port, err := strconv.Atoi(raw)
		if err != nil || port < 1 || port > 65535 {
			return Config{}, fmt.Errorf("invalid AO_CLOUD_PORT %q", raw)
		}
		cfg.Port = port
	}
	if raw := os.Getenv("AO_CLOUD_REQUEST_TIMEOUT"); raw != "" {
		d, err := time.ParseDuration(raw)
		if err != nil || d <= 0 {
			return Config{}, fmt.Errorf("invalid AO_CLOUD_REQUEST_TIMEOUT %q", raw)
		}
		cfg.RequestTimeout = d
	}
	if err := parseIntEnv("AO_DAYTONA_CPU", &cfg.Daytona.CPU); err != nil {
		return Config{}, err
	}
	if err := parseIntEnv("AO_DAYTONA_MEMORY_GIB", &cfg.Daytona.MemoryGiB); err != nil {
		return Config{}, err
	}
	if err := parseIntEnv("AO_DAYTONA_DISK_GIB", &cfg.Daytona.DiskGiB); err != nil {
		return Config{}, err
	}
	if err := parseIntEnv("AO_DAYTONA_AUTO_STOP_MINUTES", &cfg.Daytona.AutoStopMinutes); err != nil {
		return Config{}, err
	}
	if err := parseIntEnv("AO_DAYTONA_AUTO_ARCHIVE_MINUTES", &cfg.Daytona.AutoArchiveMinutes); err != nil {
		return Config{}, err
	}
	return cfg, nil
}

// Addr returns the host:port listen address for ao-cloud.
func (c Config) Addr() string {
	return net.JoinHostPort(c.Host, strconv.Itoa(c.Port))
}

func envDefault(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func parseIntEnv(key string, dst *int) error {
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return nil
	}
	v, err := strconv.Atoi(raw)
	if err != nil {
		return fmt.Errorf("invalid %s %q", key, raw)
	}
	*dst = v
	return nil
}

func defaultDataDir() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return home + "/.ao/cloud", nil
}
