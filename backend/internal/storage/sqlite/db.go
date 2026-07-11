// Package sqlite owns SQLite connection setup and goose-managed schema
// migrations. Typed CRUD lives in the store subpackage; this package keeps the
// public Open entrypoint and compatibility aliases for callers.
package sqlite

import (
	"database/sql"
	"embed"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
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
	compat, err := prepareDivergentVersion32Compatibility(db)
	if err != nil {
		return err
	}
	if compat.runThroughVersion33 {
		if err := goose.UpTo(db, "migrations", 33); err != nil {
			return fmt.Errorf("run divergent version 32 compatibility migrations through 33: %w", err)
		}
	}
	for _, version := range compat.markApplied {
		if err := markGooseVersionApplied(db, version); err != nil {
			return err
		}
	}
	if err := goose.Up(db, "migrations"); err != nil {
		return fmt.Errorf("run migrations: %w", err)
	}
	return nil
}

type divergentVersion32Compatibility struct {
	runThroughVersion33 bool
	markApplied         []int64
}

func prepareDivergentVersion32Compatibility(db *sql.DB) (divergentVersion32Compatibility, error) {
	version32, err := gooseVersionApplied(db, 32)
	if err != nil {
		return divergentVersion32Compatibility{}, err
	}
	if !version32 {
		return divergentVersion32Compatibility{}, nil
	}
	hasPendingDecision, err := sqliteColumnExists(db, "sessions", "pending_decision")
	if err != nil {
		return divergentVersion32Compatibility{}, err
	}
	if !hasPendingDecision {
		if _, err := db.Exec(`ALTER TABLE sessions ADD COLUMN pending_decision TEXT NOT NULL DEFAULT ''`); err != nil {
			return divergentVersion32Compatibility{}, fmt.Errorf("apply divergent version 32 pending_decision compatibility: %w", err)
		}
	}
	hasHeadSHA, err := sqliteColumnExists(db, "notifications", "head_sha")
	if err != nil {
		return divergentVersion32Compatibility{}, err
	}
	hasOrchestratorNotifications, err := sqliteTableSQLContains(db, "notifications", "'orchestrator_replaced'")
	if err != nil {
		return divergentVersion32Compatibility{}, err
	}
	var compat divergentVersion32Compatibility
	if hasOrchestratorNotifications {
		compat.markApplied = append(compat.markApplied, 33)
	} else if hasHeadSHA {
		compat.runThroughVersion33 = true
	}
	if hasHeadSHA && hasOrchestratorNotifications {
		compat.markApplied = append(compat.markApplied, 34)
	}
	return compat, nil
}

func markGooseVersionApplied(db *sql.DB, version int64) error {
	applied, err := gooseVersionApplied(db, version)
	if err != nil {
		return err
	}
	if applied {
		return nil
	}
	if _, err := db.Exec(`INSERT INTO goose_db_version (version_id, is_applied) VALUES (?, 1)`, version); err != nil {
		return fmt.Errorf("mark divergent version 32 migration %d applied: %w", version, err)
	}
	return nil
}

func gooseVersionApplied(db *sql.DB, version int64) (bool, error) {
	var hasTable bool
	if err := db.QueryRow(`SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'goose_db_version')`).Scan(&hasTable); err != nil {
		return false, fmt.Errorf("check goose version table: %w", err)
	}
	if !hasTable {
		return false, nil
	}
	var applied bool
	if err := db.QueryRow(`SELECT EXISTS(SELECT 1 FROM goose_db_version WHERE version_id = ? AND is_applied = 1)`, version).Scan(&applied); err != nil {
		return false, fmt.Errorf("check goose version %d: %w", version, err)
	}
	return applied, nil
}

func sqliteColumnExists(db *sql.DB, table, column string) (bool, error) {
	if table != "notifications" && table != "sessions" {
		return false, fmt.Errorf("unsupported sqlite column check table %q", table)
	}
	rows, err := db.Query(fmt.Sprintf(`PRAGMA table_info(%s)`, table))
	if err != nil {
		return false, fmt.Errorf("inspect %s schema: %w", table, err)
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var cid int
		var name, typ string
		var notNull, pk int
		var defaultValue any
		if err := rows.Scan(&cid, &name, &typ, &notNull, &defaultValue, &pk); err != nil {
			return false, fmt.Errorf("scan %s schema: %w", table, err)
		}
		if name == column {
			return true, nil
		}
	}
	if err := rows.Err(); err != nil {
		return false, fmt.Errorf("iterate %s schema: %w", table, err)
	}
	return false, nil
}

func sqliteTableSQLContains(db *sql.DB, table, needle string) (bool, error) {
	if table != "notifications" {
		return false, fmt.Errorf("unsupported sqlite table SQL check %q", table)
	}
	var schemaSQL string
	err := db.QueryRow(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`, table).Scan(&schemaSQL)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("read %s schema SQL: %w", table, err)
	}
	return strings.Contains(schemaSQL, needle), nil
}
