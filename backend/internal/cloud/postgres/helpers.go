package postgres

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

func nullTime(t time.Time) sql.NullTime {
	if t.IsZero() {
		return sql.NullTime{}
	}
	return sql.NullTime{Time: t.UTC(), Valid: true}
}

func marshalProjectConfig(config domain.ProjectConfig) (any, error) {
	if config.IsZero() {
		return nil, nil
	}
	b, err := json.Marshal(config)
	if err != nil {
		return nil, fmt.Errorf("marshal project config: %w", err)
	}
	return string(b), nil
}

func unmarshalProjectConfig(raw sql.NullString) domain.ProjectConfig {
	if !raw.Valid || raw.String == "" {
		return domain.ProjectConfig{}
	}
	var cfg domain.ProjectConfig
	if err := json.Unmarshal([]byte(raw.String), &cfg); err != nil {
		return domain.ProjectConfig{}
	}
	return cfg
}

func noRows(err error) bool {
	return errors.Is(err, sql.ErrNoRows)
}
