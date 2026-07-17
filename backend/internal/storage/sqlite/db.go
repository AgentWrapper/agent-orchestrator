// Package sqlite owns SQLite connection setup and goose-managed schema
// migrations. Typed CRUD lives in the store subpackage; this package keeps the
// public Open entrypoint and compatibility aliases for callers.
package sqlite

import (
	"context"
	"database/sql"
	"embed"
	"fmt"
	"os"
	"path/filepath"
	"sync"

	"github.com/pressly/goose/v3"

	sqlitestore "github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite/store"

	// modernc.org/sqlite is the pure-Go (CGO-free) SQLite driver — chosen so the
	// daemon cross-compiles and ships as a static binary with no libsqlite/CGO
	// toolchain dependency, at the cost of some raw throughput vs a C-backed driver.
	_ "modernc.org/sqlite"
)

// Store is the SQLite-backed persistence layer.
type Store = sqlitestore.Store

//go:embed migrations/*.sql
var migrationsFS embed.FS

// pragmas are applied on every connection open. WAL + NORMAL lets readers run
// concurrently with the writer; busy_timeout absorbs brief writer contention;
// foreign_keys enforces the cascades and the CDC triggers' lookups.
const pragmas = "?_pragma=journal_mode(WAL)" +
	"&_pragma=busy_timeout(5000)" +
	"&_pragma=foreign_keys(ON)" +
	"&_pragma=synchronous(NORMAL)"

const readOnlyPragmas = "?mode=ro" +
	"&_pragma=busy_timeout(5000)" +
	"&_pragma=foreign_keys(ON)"

// maxReaders caps the reader pool. WAL allows many concurrent readers.
const maxReaders = 8

// Open opens (creating if absent) the SQLite database under dataDir and returns
// a Store. It uses TWO pools against the same file:
//
//   - a single WRITER connection (writeDB, MaxOpenConns=1): every write goes
//     here, so a write and the CDC triggers' subqueries it fires always see the
//     prior writes on the same connection (read-your-writes). This is required
//     because the pr/pr_checks triggers SELECT from sessions/pr to fill in the
//     event's project_id; a pooled writer could land that read on a connection
//     that hasn't caught up to the commit and read NULL.
//   - a READER pool (readDB, MaxOpenConns=maxReaders): all reads scale across
//     it; WAL readers see the latest committed snapshot.
func Open(dataDir string) (*Store, error) {
	if err := os.MkdirAll(dataDir, 0o750); err != nil {
		return nil, fmt.Errorf("create data dir: %w", err)
	}
	dsn := "file:" + filepath.Join(dataDir, "ao.db") + pragmas

	writeDB, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("open sqlite writer: %w", err)
	}
	writeDB.SetMaxOpenConns(1)
	writeDB.SetMaxIdleConns(1)
	if err := migrate(writeDB); err != nil {
		_ = writeDB.Close()
		return nil, err
	}

	readDB, err := sql.Open("sqlite", dsn)
	if err != nil {
		_ = writeDB.Close()
		return nil, fmt.Errorf("open sqlite reader: %w", err)
	}
	readDB.SetMaxOpenConns(maxReaders)
	readDB.SetMaxIdleConns(maxReaders)

	return sqlitestore.NewStore(writeDB, readDB), nil
}

// OpenReadOnly opens an existing SQLite database under dataDir without creating
// the directory, opening a writable connection, or running migrations.
func OpenReadOnly(ctx context.Context, dataDir string) (*Store, error) {
	dsn := "file:" + filepath.Join(dataDir, "ao.db") + readOnlyPragmas

	writeDB, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("open sqlite read-only writer: %w", err)
	}
	writeDB.SetMaxOpenConns(1)
	writeDB.SetMaxIdleConns(1)
	if err := writeDB.PingContext(ctx); err != nil {
		_ = writeDB.Close()
		return nil, fmt.Errorf("open sqlite read-only writer: %w", err)
	}

	readDB, err := sql.Open("sqlite", dsn)
	if err != nil {
		_ = writeDB.Close()
		return nil, fmt.Errorf("open sqlite read-only reader: %w", err)
	}
	readDB.SetMaxOpenConns(maxReaders)
	readDB.SetMaxIdleConns(maxReaders)
	if err := readDB.PingContext(ctx); err != nil {
		_ = readDB.Close()
		_ = writeDB.Close()
		return nil, fmt.Errorf("open sqlite read-only reader: %w", err)
	}

	return sqlitestore.NewStore(writeDB, readDB), nil
}

// gooseMu serialises calls into goose. goose v3 keeps its baseFS / logger /
// dialect as package-level globals (goose.SetBaseFS, goose.SetLogger,
// goose.SetDialect), so two concurrent Open() calls — uncommon in production
// but normal in -race test runs — race on those writes. The cost of holding the
// mutex is one process-startup migration; readers and writers afterwards never
// touch goose.
var gooseMu sync.Mutex

func migrate(db *sql.DB) error {
	gooseMu.Lock()
	defer gooseMu.Unlock()
	goose.SetBaseFS(migrationsFS)
	goose.SetLogger(goose.NopLogger())
	if err := goose.SetDialect("sqlite3"); err != nil {
		return fmt.Errorf("set goose dialect: %w", err)
	}
	if err := goose.Up(db, "migrations"); err != nil {
		return fmt.Errorf("run migrations: %w", err)
	}
	return nil
}
