package cloud

import (
	"fmt"
	"net"
	"os"
	"strconv"
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
}

// LoadConfig resolves ao-cloud configuration from the environment.
func LoadConfig() (Config, error) {
	cfg := Config{
		Host:           envDefault("AO_CLOUD_HOST", defaultHost),
		Port:           defaultPort,
		DatabaseURL:    os.Getenv("AO_CLOUD_DATABASE_URL"),
		JWTSecret:      os.Getenv("AO_CLOUD_JWT_SECRET"),
		SecretKey:      os.Getenv("AO_CLOUD_SECRET_KEY"),
		RequestTimeout: 60 * time.Second,
		Google: auth.GoogleConfig{
			ClientID:     os.Getenv("AO_CLOUD_GOOGLE_CLIENT_ID"),
			ClientSecret: os.Getenv("AO_CLOUD_GOOGLE_CLIENT_SECRET"),
			RedirectURL:  os.Getenv("AO_CLOUD_GOOGLE_REDIRECT_URL"),
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
