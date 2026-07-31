package daemon

import (
	"context"
	"log/slog"
	"strconv"

	"github.com/aoagents/agent-orchestrator/backend/internal/config"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/controllers"
)

// pipelinesSettingReader reads the persisted pipelines flag. It is the subset of
// the store resolvePipelinesEnabled needs, kept small so the precedence logic is
// testable with a fake.
type pipelinesSettingReader interface {
	GetAppSetting(ctx context.Context, key string) (string, error)
}

// resolvePipelinesEnabled applies the pipelines flag precedence (spec §4b T12):
//
//  1. An explicit AO_PIPELINES env override (on or off) always wins. It is the
//     dev/CI escape hatch.
//  2. Otherwise the persisted "pipelines.enabled" app-setting decides. It lives
//     in the daemon's own store so it applies no matter who launched the daemon
//     (the Electron supervisor or a headless `ao start`).
//  3. With neither set, pipelines stay off.
//
// A store read error is logged and treated as "off": a persistence hiccup must
// not silently light up an experimental subsystem.
func resolvePipelinesEnabled(ctx context.Context, cfg config.Config, store pipelinesSettingReader, log *slog.Logger) bool {
	if cfg.PipelinesEnv != nil {
		return *cfg.PipelinesEnv
	}
	raw, err := store.GetAppSetting(ctx, controllers.PipelinesEnabledSettingKey)
	if err != nil {
		log.Warn("read persisted pipelines setting; defaulting off", "err", err)
		return false
	}
	// Missing/blank/garbage parses to false — the safe default.
	enabled, _ := strconv.ParseBool(raw)
	return enabled
}
