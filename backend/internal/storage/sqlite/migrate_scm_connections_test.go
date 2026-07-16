package sqlite

import (
	"database/sql"
	"strings"
	"testing"

	"github.com/pressly/goose/v3"
)

func TestMigration0024PreservesCDCAndAddsGlobalSCMConnectionEvents(t *testing.T) {
	db, err := sql.Open("sqlite", "file:"+t.TempDir()+"/ao.db"+pragmas)
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })

	upTo(t, db, 23)
	if _, err := db.Exec(`
		INSERT INTO projects (id, path, registered_at) VALUES ('p1', '/tmp/p1', '2026-07-16T00:00:00Z');
		INSERT INTO sessions (id, project_id, num, activity_last_at, created_at, updated_at)
		VALUES ('p1-1', 'p1', 1, '2026-07-16T00:00:00Z', '2026-07-16T00:00:00Z', '2026-07-16T00:00:00Z');
	`); err != nil {
		t.Fatalf("seed pre-0024 CDC row: %v", err)
	}
	beforeTriggers := triggerNames(t, db)
	beforeTriggerSQL := triggerDefinitions(t, db)

	upTo(t, db, 24)
	afterTriggers := triggerNames(t, db)
	afterTriggerSQL := triggerDefinitions(t, db)
	for name := range beforeTriggers {
		if !afterTriggers[name] {
			t.Errorf("pre-0024 trigger %q was not restored", name)
			continue
		}
		if afterSQL := afterTriggerSQL[name]; afterSQL != beforeTriggerSQL[name] {
			t.Errorf("pre-0024 trigger %q definition changed\nbefore: %s\nafter:  %s", name, beforeTriggerSQL[name], afterSQL)
		}
	}
	if len(afterTriggers) != len(beforeTriggers)+5 {
		t.Errorf("trigger count after 0024 = %d, want %d existing + 3 connection + 2 project guard triggers", len(afterTriggers), len(beforeTriggers))
	}

	var priorCount int
	if err := db.QueryRow(`
		SELECT COUNT(*) FROM change_log
		WHERE project_id = 'p1' AND session_id = 'p1-1' AND event_type = 'session_created'
	`).Scan(&priorCount); err != nil {
		t.Fatalf("query preserved CDC row: %v", err)
	}
	if priorCount != 1 {
		t.Fatalf("preserved pre-0024 session events = %d, want 1", priorCount)
	}

	if _, err := db.Exec(`
		INSERT INTO sessions (id, project_id, num, activity_last_at, created_at, updated_at)
		VALUES ('p1-2', 'p1', 2, '2026-07-16T00:01:00Z', '2026-07-16T00:01:00Z', '2026-07-16T00:01:00Z');
	`); err != nil {
		t.Fatalf("insert session after 0024: %v", err)
	}
	var postMigrationCount int
	if err := db.QueryRow(`
		SELECT COUNT(*) FROM change_log
		WHERE project_id = 'p1' AND session_id = 'p1-2' AND event_type = 'session_created'
	`).Scan(&postMigrationCount); err != nil {
		t.Fatalf("query post-0024 session event: %v", err)
	}
	if postMigrationCount != 1 {
		t.Fatalf("post-0024 session events = %d, want 1", postMigrationCount)
	}
	if _, err := db.Exec(`
		INSERT INTO pr (url, session_id, updated_at)
		VALUES ('https://example.test/pr/1', 'p1-2', '2026-07-16T00:01:30Z');
	`); err != nil {
		t.Fatalf("insert PR after 0024: %v", err)
	}
	var prProjectID sql.NullString
	if err := db.QueryRow(`
		SELECT project_id FROM change_log
		WHERE session_id = 'p1-2' AND event_type = 'pr_created'
	`).Scan(&prProjectID); err != nil {
		t.Fatalf("query post-0024 PR event: %v", err)
	}
	if !prProjectID.Valid || prProjectID.String != "p1" {
		t.Fatalf("post-0024 PR event project = %v, want p1", prProjectID)
	}

	if _, err := db.Exec(`
		INSERT INTO scm_connections
			(id, provider, display_name, web_base_url, api_base_url, credential_ref, created_at, updated_at)
		VALUES
			('gitlab-work', 'gitlab', 'Work', 'https://gitlab.example.com', 'https://gitlab.example.com/api/v4', 'scm/gitlab-work', '2026-07-16T00:02:00Z', '2026-07-16T00:02:00Z');
		UPDATE scm_connections SET status = 'connected', username = 'alice'
		WHERE id = 'gitlab-work';
		UPDATE scm_connections SET display_name = 'Work GitLab', updated_at = '2026-07-16T00:03:00Z'
		WHERE id = 'gitlab-work';
		DELETE FROM scm_connections WHERE id = 'gitlab-work';
	`); err != nil {
		t.Fatalf("mutate SCM connection: %v", err)
	}

	rows, err := db.Query(`
		SELECT event_type, project_id, session_id, payload
		FROM change_log
		WHERE event_type LIKE 'scm_connection_%'
		ORDER BY seq
	`)
	if err != nil {
		t.Fatalf("query connection events: %v", err)
	}
	defer rows.Close()
	wantTypes := []string{"scm_connection_created", "scm_connection_updated", "scm_connection_updated", "scm_connection_deleted"}
	var gotTypes []string
	for rows.Next() {
		var eventType, payload string
		var projectID, sessionID sql.NullString
		if err := rows.Scan(&eventType, &projectID, &sessionID, &payload); err != nil {
			t.Fatalf("scan connection event: %v", err)
		}
		if projectID.Valid || sessionID.Valid {
			t.Fatalf("global event %q has project=%v session=%v", eventType, projectID, sessionID)
		}
		if payload == "" || payload == "{}" {
			t.Fatalf("global event %q has empty payload", eventType)
		}
		gotTypes = append(gotTypes, eventType)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("connection event rows: %v", err)
	}
	if len(gotTypes) != len(wantTypes) {
		t.Fatalf("connection events = %v, want %v", gotTypes, wantTypes)
	}
	for i := range wantTypes {
		if gotTypes[i] != wantTypes[i] {
			t.Fatalf("connection events = %v, want %v", gotTypes, wantTypes)
		}
	}

	if _, err := db.Exec(`
		INSERT INTO scm_connections
			(id, provider, display_name, web_base_url, api_base_url, credential_ref, created_at, updated_at)
		VALUES
			('defaults', 'gitlab', 'Defaults', 'https://gitlab.com', 'https://gitlab.com/api/v4', 'scm/defaults', '2026-07-16T00:04:00Z', '2026-07-16T00:04:00Z');
	`); err != nil {
		t.Fatalf("insert default validation metadata: %v", err)
	}
	var status, username string
	if err := db.QueryRow(`SELECT status, username FROM scm_connections WHERE id = 'defaults'`).Scan(&status, &username); err != nil {
		t.Fatalf("read validation defaults: %v", err)
	}
	if status != "unknown" || username != "" {
		t.Fatalf("validation defaults = (%q, %q), want (unknown, empty)", status, username)
	}
	if _, err := db.Exec(`UPDATE scm_connections SET status = 'invalid' WHERE id = 'defaults'`); err == nil {
		t.Fatal("invalid validation status committed")
	}
}

func triggerDefinitions(t *testing.T, db *sql.DB) map[string]string {
	t.Helper()
	rows, err := db.Query(`SELECT name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name`)
	if err != nil {
		t.Fatalf("query trigger definitions: %v", err)
	}
	defer rows.Close()
	definitions := make(map[string]string)
	for rows.Next() {
		var name, definition string
		if err := rows.Scan(&name, &definition); err != nil {
			t.Fatalf("scan trigger definition: %v", err)
		}
		definitions[name] = strings.Join(strings.Fields(definition), " ")
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("trigger definition rows: %v", err)
	}
	return definitions
}

func triggerNames(t *testing.T, db *sql.DB) map[string]bool {
	t.Helper()
	rows, err := db.Query(`SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name`)
	if err != nil {
		t.Fatalf("query triggers: %v", err)
	}
	defer rows.Close()
	names := make(map[string]bool)
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			t.Fatalf("scan trigger: %v", err)
		}
		names[name] = true
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("trigger rows: %v", err)
	}
	return names
}

func TestMigration0024DownRestoresLegacyCDCTriggers(t *testing.T) {
	db, err := sql.Open("sqlite", "file:"+t.TempDir()+"/ao.db"+pragmas)
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })

	upTo(t, db, 23)
	legacyTriggers := triggerNames(t, db)
	legacyTriggerSQL := triggerDefinitions(t, db)
	upTo(t, db, 24)
	downTo(t, db, 23)

	got := triggerNames(t, db)
	if !mapsEqual(got, legacyTriggers) {
		t.Fatalf("triggers after down = %v, want legacy set %v", got, legacyTriggers)
	}
	gotSQL := triggerDefinitions(t, db)
	for name, wantSQL := range legacyTriggerSQL {
		if gotSQL[name] != wantSQL {
			t.Errorf("legacy trigger %q definition changed after down\nbefore: %s\nafter:  %s", name, wantSQL, gotSQL[name])
		}
	}
}

func TestMigration0024ProjectConnectionGuardsAllowLegacyConfigs(t *testing.T) {
	db, err := sql.Open("sqlite", "file:"+t.TempDir()+"/ao.db"+pragmas)
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	upTo(t, db, 24)

	legacyConfigs := []struct {
		id     string
		config any
	}{
		{id: "null-config", config: nil},
		{id: "missing-scm", config: `{"defaultBranch":"main"}`},
		{id: "empty-connection", config: `{"scm":{"connectionId":""}}`},
	}
	for _, legacy := range legacyConfigs {
		if _, err := db.Exec(
			`INSERT INTO projects (id, path, registered_at, config) VALUES (?, ?, '2026-07-16T00:00:00Z', ?)`,
			legacy.id, "/tmp/"+legacy.id, legacy.config,
		); err != nil {
			t.Errorf("insert legacy project %q: %v", legacy.id, err)
		}
	}
	virtualDefaults := []struct {
		id     string
		config string
	}{
		{id: "github-default", config: `{"scm":{"provider":"github","connectionId":"github-default"}}`},
		{id: "legacy-default", config: `{"scm":{"connectionId":"github-default"}}`},
	}
	for _, project := range virtualDefaults {
		if _, err := db.Exec(
			`INSERT INTO projects (id, path, registered_at, config) VALUES (?, ?, '2026-07-16T00:00:00Z', ?)`,
			project.id, "/tmp/"+project.id, project.config,
		); err != nil {
			t.Errorf("insert virtual GitHub default project %q: %v", project.id, err)
		}
	}

	if _, err := db.Exec(
		`INSERT INTO projects (id, path, registered_at, config)
		 VALUES ('missing-connection', '/tmp/missing-connection', '2026-07-16T00:00:00Z',
		         '{"scm":{"connectionId":"does-not-exist"}}')`,
	); err == nil {
		t.Fatal("explicit reference to missing SCM connection committed")
	}
	if _, err := db.Exec(
		`INSERT INTO projects (id, path, registered_at, config)
		 VALUES ('gitlab-default', '/tmp/gitlab-default', '2026-07-16T00:00:00Z',
		         '{"scm":{"provider":"gitlab","connectionId":"github-default"}}')`,
	); err == nil {
		t.Fatal("GitLab project reference to virtual github-default committed")
	}

	if _, err := db.Exec(
		`UPDATE projects
		 SET config = '{"scm":{"provider":"github","connectionId":"github-default"}}'
		 WHERE id = 'null-config'`,
	); err != nil {
		t.Fatalf("update project to virtual GitHub default: %v", err)
	}
	if _, err := db.Exec(
		`UPDATE projects
		 SET config = '{"scm":{"connectionId":"does-not-exist"}}'
		 WHERE id = 'missing-scm'`,
	); err == nil {
		t.Fatal("project update to missing SCM connection committed")
	}
	if _, err := db.Exec(
		`UPDATE projects
		 SET config = '{"scm":{"provider":"gitlab","connectionId":"github-default"}}'
		 WHERE id = 'empty-connection'`,
	); err == nil {
		t.Fatal("project update to GitLab github-default committed")
	}
}

func downTo(t *testing.T, db *sql.DB, version int64) {
	t.Helper()
	gooseMu.Lock()
	defer gooseMu.Unlock()
	goose.SetBaseFS(migrationsFS)
	goose.SetLogger(goose.NopLogger())
	if err := goose.SetDialect("sqlite3"); err != nil {
		t.Fatalf("set dialect: %v", err)
	}
	if err := goose.DownTo(db, "migrations", version); err != nil {
		t.Fatalf("migrate down to %d: %v", version, err)
	}
}

func mapsEqual(a, b map[string]bool) bool {
	if len(a) != len(b) {
		return false
	}
	for key := range a {
		if !b[key] {
			return false
		}
	}
	return true
}
