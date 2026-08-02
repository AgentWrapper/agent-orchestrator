package sqlite

import (
	"testing"

	"github.com/pressly/goose/v3"
)

// TestMigrationVersionsAreUnique scans the embedded migration filenames and
// parses each version with goose.NumericComponent — the same function goose
// itself uses — so prefixes that parse to the same int64 (e.g. "014" vs
// "0014") are caught as a collision, not just identical strings. Catches the
// conflict with a clear message instead of a goose panic at runtime.
func TestMigrationVersionsAreUnique(t *testing.T) {
	entries, err := migrationsFS.ReadDir("migrations")
	if err != nil {
		t.Fatalf("read migrations dir: %v", err)
	}

	seen := map[int64]string{} // parsed version -> filename
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() {
			continue
		}

		version, err := goose.NumericComponent(name)
		if err != nil {
			t.Errorf("migration %q has no version goose can parse: %v", name, err)
			continue
		}

		if other, dup := seen[version]; dup {
			t.Errorf("duplicate migration version %d: %s vs %s", version, other, name)
			continue
		}
		seen[version] = name
	}
}

// forkMigrationFloor is where this fork's migrations live. Upstream numbers its
// own migrations sequentially from 1, so anything the fork adds in that range
// eventually collides: goose keys on the version NUMBER, so an upstream
// migration sharing a number with an already-applied fork migration is silently
// SKIPPED, its columns never appear, and queries fail at runtime with "no such
// column" rather than at migration time.
const forkMigrationFloor = 9000

// upstreamMigrationCeiling is the first version upstream had not reached when
// the fork started numbering. Anything from here up to forkMigrationFloor is
// the collision window.
const upstreamMigrationCeiling = 40

// TestForkMigrationsStayOutOfUpstreamRange fails if a migration sits in the
// window upstream may still number into. Fork migrations must be >= 9000.
func TestForkMigrationsStayOutOfUpstreamRange(t *testing.T) {
	entries, err := migrationsFS.ReadDir("migrations")
	if err != nil {
		t.Fatalf("read migrations dir: %v", err)
	}

	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		name := e.Name()

		version, err := goose.NumericComponent(name)
		if err != nil {
			continue // TestMigrationVersionsAreUnique reports unparseable names.
		}

		if version >= upstreamMigrationCeiling && version < forkMigrationFloor {
			t.Errorf("migration %q has version %d, inside upstream's range [%d, %d): "+
				"upstream can ship its own migration with that number, which goose would "+
				"then silently skip. Renumber it to %d+.",
				name, version, upstreamMigrationCeiling, forkMigrationFloor, forkMigrationFloor)
		}
	}
}
