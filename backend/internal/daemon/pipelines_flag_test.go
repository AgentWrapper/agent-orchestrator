package daemon

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/config"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/controllers"
)

type fakeSettingReader struct {
	value string
	err   error
}

func (f fakeSettingReader) GetAppSetting(_ context.Context, key string) (string, error) {
	if key != controllers.PipelinesEnabledSettingKey {
		return "", nil
	}
	return f.value, f.err
}

func boolPtr(b bool) *bool { return &b }

// TestResolvePipelinesEnabled is the precedence table: the explicit AO_PIPELINES
// env override wins over the persisted app-setting; with the env unset the
// setting decides; with neither, pipelines stay off. A store read error degrades
// to off.
func TestResolvePipelinesEnabled(t *testing.T) {
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	cases := []struct {
		name    string
		env     *bool  // config.PipelinesEnv
		setting string // persisted "pipelines.enabled" value ("" == absent)
		want    bool
	}{
		{"env on beats setting off", boolPtr(true), "false", true},
		{"env on beats setting absent", boolPtr(true), "", true},
		{"env off beats setting on", boolPtr(false), "true", false},
		{"env off beats setting absent", boolPtr(false), "", false},
		{"env unset, setting on", nil, "true", true},
		{"env unset, setting off", nil, "false", false},
		{"env unset, setting absent", nil, "", false},
		{"env unset, setting garbage", nil, "not-a-bool", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			cfg := config.Config{PipelinesEnv: tc.env}
			got := resolvePipelinesEnabled(context.Background(), cfg, fakeSettingReader{value: tc.setting}, log)
			if got != tc.want {
				t.Errorf("resolvePipelinesEnabled = %v, want %v", got, tc.want)
			}
		})
	}

	t.Run("store error degrades to off when env unset", func(t *testing.T) {
		cfg := config.Config{PipelinesEnv: nil}
		got := resolvePipelinesEnabled(context.Background(), cfg, fakeSettingReader{err: errors.New("boom")}, log)
		if got {
			t.Error("resolvePipelinesEnabled = true on store error, want false")
		}
	})

	t.Run("env override ignores store error", func(t *testing.T) {
		cfg := config.Config{PipelinesEnv: boolPtr(true)}
		got := resolvePipelinesEnabled(context.Background(), cfg, fakeSettingReader{err: errors.New("boom")}, log)
		if !got {
			t.Error("resolvePipelinesEnabled = false, want true (env override wins before store read)")
		}
	})
}
