// Package postgres implements the AO Cloud managed-Postgres store.
package postgres

import (
	"database/sql"
	"embed"
	"fmt"
	"sync"

	"github.com/pressly/goose/v3"

	// pgx stdlib registers the database/sql "pgx" driver used by Open.
	_ "github.com/jackc/pgx/v5/stdlib"
)

//go:embed migrations/*.sql
var migrationsFS embed.FS

// Store is the tenant-scoped Postgres persistence layer.
type Store struct {
	db *sql.DB
	mu sync.Mutex
}

// Open connects to Postgres, runs cloud migrations, and returns a Store.
func Open(databaseURL string) (*Store, error) {
	if databaseURL == "" {
		return nil, fmt.Errorf("AO_CLOUD_DATABASE_URL is required")
	}
	db, err := sql.Open("pgx", databaseURL)
	if err != nil {
		return nil, fmt.Errorf("open postgres: %w", err)
	}
	db.SetMaxOpenConns(16)
	db.SetMaxIdleConns(8)
	if err := migrate(db); err != nil {
		_ = db.Close()
		return nil, err
	}
	return &Store{db: db}, nil
}

// DB exposes the underlying pool for focused integration tests.
func (s *Store) DB() *sql.DB { return s.db }

// Close closes the Postgres pool.
func (s *Store) Close() error { return s.db.Close() }

var gooseMu sync.Mutex

func migrate(db *sql.DB) error {
	gooseMu.Lock()
	defer gooseMu.Unlock()
	goose.SetBaseFS(migrationsFS)
	goose.SetLogger(goose.NopLogger())
	if err := goose.SetDialect("postgres"); err != nil {
		return fmt.Errorf("set goose dialect: %w", err)
	}
	if err := goose.Up(db, "migrations"); err != nil {
		return fmt.Errorf("run postgres migrations: %w", err)
	}
	return nil
}
