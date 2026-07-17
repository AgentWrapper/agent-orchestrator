package store_test

import (
	"bytes"
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	modernsqlite "modernc.org/sqlite"

	"github.com/aoagents/agent-orchestrator/backend/internal/cdc"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite"
)

var deleteLockBarrier struct {
	register sync.Once
	mu       sync.Mutex
	entered  chan struct{}
	release  chan struct{}
}

func testSCMConnection() domain.SCMConnection {
	now := time.Date(2026, 7, 16, 8, 0, 0, 0, time.UTC)
	return domain.SCMConnection{
		ID:            "gitlab-work",
		Provider:      domain.SCMProviderGitLab,
		DisplayName:   "Work GitLab",
		WebBaseURL:    "https://gitlab.example.com",
		APIBaseURL:    "https://gitlab.example.com/api/v4",
		CredentialRef: "scm/gitlab-work",
		Status:        domain.SCMConnectionStatusUnknown,
		CreatedAt:     now,
		UpdatedAt:     now,
	}
}

func TestSCMConnectionValidationPersistsAcrossRestartAndEmitsCDC(t *testing.T) {
	dir := t.TempDir()
	ctx := context.Background()
	s, err := sqlite.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	conn := testSCMConnection()
	if err := s.CreateSCMConnection(ctx, conn); err != nil {
		t.Fatal(err)
	}
	before, err := s.LatestSeq(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if updated, err := s.UpdateSCMConnectionValidation(ctx, conn.ID, conn.UpdatedAt, domain.SCMConnectionStatusConnected, "alice"); err != nil || !updated {
		t.Fatalf("update validation: updated=%v err=%v", updated, err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}

	reopened, err := sqlite.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = reopened.Close() })
	got, ok, err := reopened.GetSCMConnection(ctx, conn.ID)
	if err != nil || !ok {
		t.Fatalf("get after restart: ok=%v err=%v", ok, err)
	}
	if got.Status != domain.SCMConnectionStatusConnected || got.Username != "alice" {
		t.Fatalf("validation after restart = (%q, %q)", got.Status, got.Username)
	}
	if got.UpdatedAt != conn.UpdatedAt {
		t.Fatalf("validation advanced configuration revision from %v to %v", conn.UpdatedAt, got.UpdatedAt)
	}
	events, err := reopened.EventsAfter(ctx, before, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 1 || events[0].Type != cdc.EventSCMConnectionUpdated {
		t.Fatalf("validation events = %#v, want one connection update", events)
	}
}

func TestSCMConnectionValidationUsesConfigurationRevisionCAS(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	conn := testSCMConnection()
	if err := s.CreateSCMConnection(ctx, conn); err != nil {
		t.Fatal(err)
	}

	newer := conn
	newer.DisplayName = "Renamed"
	newer.UpdatedAt = conn.UpdatedAt.Add(time.Minute)
	if updated, err := s.UpdateSCMConnection(ctx, newer); err != nil || !updated {
		t.Fatalf("update configuration: updated=%v err=%v", updated, err)
	}
	if updated, err := s.UpdateSCMConnectionValidation(ctx, conn.ID, conn.UpdatedAt, domain.SCMConnectionStatusConnected, "stale"); err != nil || updated {
		t.Fatalf("stale validation CAS: updated=%v err=%v", updated, err)
	}
	got, ok, err := s.GetSCMConnection(ctx, conn.ID)
	if err != nil || !ok {
		t.Fatalf("get after stale CAS: ok=%v err=%v", ok, err)
	}
	if got.Status != domain.SCMConnectionStatusUnknown || got.Username != "" || !got.UpdatedAt.Equal(newer.UpdatedAt) {
		t.Fatalf("stale validation changed row: %#v", got)
	}
	if updated, err := s.UpdateSCMConnectionValidation(ctx, conn.ID, newer.UpdatedAt, domain.SCMConnectionStatusConnected, "alice"); err != nil || !updated {
		t.Fatalf("current validation CAS: updated=%v err=%v", updated, err)
	}
	got, _, err = s.GetSCMConnection(ctx, conn.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Status != domain.SCMConnectionStatusConnected || got.Username != "alice" || !got.UpdatedAt.Equal(newer.UpdatedAt) {
		t.Fatalf("current validation result = %#v", got)
	}
}

func TestSCMConnectionStoreCRUD(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	want := testSCMConnection()

	if err := s.CreateSCMConnection(ctx, want); err != nil {
		t.Fatalf("create: %v", err)
	}
	if err := s.CreateSCMConnection(ctx, want); err == nil {
		t.Fatal("duplicate create succeeded")
	}
	got, ok, err := s.GetSCMConnection(ctx, want.ID)
	if err != nil || !ok {
		t.Fatalf("get: ok=%v err=%v", ok, err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("get = %#v, want %#v", got, want)
	}
	list, err := s.ListSCMConnections(ctx)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if !reflect.DeepEqual(list, []domain.SCMConnection{want}) {
		t.Fatalf("list = %#v, want %#v", list, []domain.SCMConnection{want})
	}

	updated := want
	updated.DisplayName = "Engineering GitLab"
	updated.UpdatedAt = updated.UpdatedAt.Add(time.Minute)
	if ok, err := s.UpdateSCMConnection(ctx, updated); err != nil || !ok {
		t.Fatalf("update: ok=%v err=%v", ok, err)
	}
	if ok, err := s.UpdateSCMConnection(ctx, domain.SCMConnection{ID: "missing"}); err != nil || ok {
		t.Fatalf("update missing: ok=%v err=%v", ok, err)
	}
	if got, _, _ := s.GetSCMConnection(ctx, want.ID); got.DisplayName != updated.DisplayName || got.CreatedAt != want.CreatedAt {
		t.Fatalf("updated row = %#v", got)
	}

	if ok, err := s.DeleteSCMConnection(ctx, want.ID); err != nil || !ok {
		t.Fatalf("delete: ok=%v err=%v", ok, err)
	}
	if ok, err := s.DeleteSCMConnection(ctx, want.ID); err != nil || ok {
		t.Fatalf("delete missing: ok=%v err=%v", ok, err)
	}
	if _, ok, err := s.GetSCMConnection(ctx, want.ID); err != nil || ok {
		t.Fatalf("get deleted: ok=%v err=%v", ok, err)
	}
}

func TestSCMConnectionStoreRejectsReferencedDelete(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	conn := testSCMConnection()
	if err := s.CreateSCMConnection(ctx, conn); err != nil {
		t.Fatal(err)
	}
	if err := s.UpsertProject(ctx, domain.ProjectRecord{
		ID: "ao", Path: "/tmp/ao", RegisteredAt: conn.CreatedAt,
		Config: domain.ProjectConfig{SCM: domain.SCMProjectConfig{
			Provider: domain.SCMProviderGitLab, ConnectionID: conn.ID,
		}},
	}); err != nil {
		t.Fatal(err)
	}

	ok, err := s.DeleteSCMConnection(ctx, conn.ID)
	if ok || !errors.Is(err, ports.ErrSCMConnectionReferenced) {
		t.Fatalf("delete referenced: ok=%v err=%v", ok, err)
	}
	if _, exists, getErr := s.GetSCMConnection(ctx, conn.ID); getErr != nil || !exists {
		t.Fatalf("referenced connection removed: exists=%v err=%v", exists, getErr)
	}
}

func TestSCMConnectionStoreRejectsReferencedProviderChange(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	conn := testSCMConnection()
	if err := s.CreateSCMConnection(ctx, conn); err != nil {
		t.Fatal(err)
	}
	if err := s.UpsertProject(ctx, referencedProject(conn)); err != nil {
		t.Fatal(err)
	}

	conn.Provider = domain.SCMProviderGitHub
	conn.UpdatedAt = conn.UpdatedAt.Add(time.Second)
	updated, err := s.UpdateSCMConnection(ctx, conn)
	if updated || !errors.Is(err, ports.ErrSCMConnectionReferenced) {
		t.Fatalf("provider update: updated=%v err=%v", updated, err)
	}
	stored, ok, getErr := s.GetSCMConnection(ctx, conn.ID)
	if getErr != nil || !ok || stored.Provider != domain.SCMProviderGitLab {
		t.Fatalf("stored connection = %#v, exists=%v err=%v", stored, ok, getErr)
	}
}

func TestProjectStoreRejectsSCMProviderConnectionMismatch(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	conn := testSCMConnection()
	if err := s.CreateSCMConnection(ctx, conn); err != nil {
		t.Fatal(err)
	}
	project := referencedProject(conn)
	project.Config.SCM.Provider = domain.SCMProviderGitHub
	if err := s.UpsertProject(ctx, project); err == nil {
		t.Fatal("project with mismatched SCM provider was persisted")
	}
	if _, exists, err := s.GetProject(ctx, project.ID); err != nil || exists {
		t.Fatalf("mismatched project exists=%v err=%v", exists, err)
	}
}

func TestSCMConnectionDeleteAcrossStoresPreservesReferenceIntegrity(t *testing.T) {
	ctx := context.Background()

	t.Run("reference commits first", func(t *testing.T) {
		first, second := newSharedTestStores(t)
		conn := testSCMConnection()
		if err := first.CreateSCMConnection(ctx, conn); err != nil {
			t.Fatal(err)
		}
		if err := second.UpsertProject(ctx, referencedProject(conn)); err != nil {
			t.Fatalf("commit project reference: %v", err)
		}

		deleted, err := first.DeleteSCMConnection(ctx, conn.ID)
		if deleted || !errors.Is(err, ports.ErrSCMConnectionReferenced) {
			t.Fatalf("delete after reference commit: deleted=%v err=%v", deleted, err)
		}
		assertNoDanglingProjectConnection(t, first, conn.ID, "ao")
	})

	t.Run("delete commits first", func(t *testing.T) {
		first, second := newSharedTestStores(t)
		conn := testSCMConnection()
		if err := first.CreateSCMConnection(ctx, conn); err != nil {
			t.Fatal(err)
		}
		if deleted, err := first.DeleteSCMConnection(ctx, conn.ID); err != nil || !deleted {
			t.Fatalf("delete before reference: deleted=%v err=%v", deleted, err)
		}

		if err := second.UpsertProject(ctx, referencedProject(conn)); err == nil {
			t.Fatal("project reference to deleted connection committed")
		}
		if _, exists, err := first.GetProject(ctx, "ao"); err != nil || exists {
			t.Fatalf("dangling project exists=%v err=%v", exists, err)
		}
	})
}

func TestSCMConnectionProjectGuardsHonorVirtualGitHubDefault(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	now := testSCMConnection().CreatedAt
	project := func(id string, scm domain.SCMProjectConfig) domain.ProjectRecord {
		return domain.ProjectRecord{
			ID: id, Path: "/tmp/" + id, RegisteredAt: now,
			Config: domain.ProjectConfig{SCM: scm},
		}
	}
	githubDefault := domain.SCMProjectConfig{
		Provider: domain.SCMProviderGitHub, ConnectionID: "github-default",
	}
	gitlabDefault := domain.SCMProjectConfig{
		Provider: domain.SCMProviderGitLab, ConnectionID: "github-default",
	}

	if err := s.UpsertProject(ctx, project("github-insert", githubDefault)); err != nil {
		t.Fatalf("insert virtual GitHub default: %v", err)
	}
	if err := s.UpsertProject(ctx, project("github-update", domain.SCMProjectConfig{})); err != nil {
		t.Fatal(err)
	}
	if err := s.UpsertProject(ctx, project("github-update", githubDefault)); err != nil {
		t.Fatalf("update to virtual GitHub default: %v", err)
	}

	if err := s.UpsertProject(ctx, project("gitlab-insert", gitlabDefault)); err == nil {
		t.Fatal("GitLab insert using virtual github-default committed")
	}
	if err := s.UpsertProject(ctx, project("gitlab-update", domain.SCMProjectConfig{})); err != nil {
		t.Fatal(err)
	}
	if err := s.UpsertProject(ctx, project("gitlab-update", gitlabDefault)); err == nil {
		t.Fatal("GitLab update using virtual github-default committed")
	}
	if err := s.UpsertProject(ctx, project("missing", domain.SCMProjectConfig{
		Provider: domain.SCMProviderGitHub, ConnectionID: "missing",
	})); err == nil {
		t.Fatal("ordinary missing connection committed")
	}
}

func TestSCMConnectionDeleteClassificationHoldsWriteLock(t *testing.T) {
	installDeleteLockBarrier()
	entered := make(chan struct{})
	release := make(chan struct{})
	deleteLockBarrier.mu.Lock()
	deleteLockBarrier.entered = entered
	deleteLockBarrier.release = release
	deleteLockBarrier.mu.Unlock()

	dir := t.TempDir()
	first, second := openSharedTestStores(t, dir)
	t.Cleanup(func() {
		select {
		case <-release:
		default:
			close(release)
		}
		deleteLockBarrier.mu.Lock()
		deleteLockBarrier.entered = nil
		deleteLockBarrier.release = nil
		deleteLockBarrier.mu.Unlock()
	})
	ctx := context.Background()
	lockRow := testSCMConnection()
	lockRow.ID = "lock-holder"
	lockRow.CredentialRef = "scm/lock-holder"
	if err := first.CreateSCMConnection(ctx, lockRow); err != nil {
		t.Fatal(err)
	}
	before, err := first.LatestSeq(ctx)
	if err != nil {
		t.Fatal(err)
	}

	db, err := sql.Open("sqlite", "file:"+filepath.Join(dir, "ao.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	if _, err := db.Exec(`
		CREATE TRIGGER test_scm_delete_lock_barrier
		BEFORE UPDATE ON scm_connections
		WHEN OLD.id = 'lock-holder'
		BEGIN
			SELECT ao_test_scm_delete_lock_barrier();
		END;
	`); err != nil {
		t.Fatalf("create barrier trigger: %v", err)
	}

	type deleteResult struct {
		deleted bool
		err     error
	}
	deleteDone := make(chan deleteResult, 1)
	go func() {
		deleted, err := first.DeleteSCMConnection(ctx, "recreated")
		deleteDone <- deleteResult{deleted: deleted, err: err}
	}()
	select {
	case <-entered:
	case <-time.After(2 * time.Second):
		t.Fatal("delete did not acquire the SQLite write-lock barrier")
	}

	recreated := testSCMConnection()
	recreated.ID = "recreated"
	recreated.CredentialRef = "scm/recreated"
	createDone := make(chan error, 1)
	go func() { createDone <- second.CreateSCMConnection(ctx, recreated) }()
	select {
	case err := <-createDone:
		t.Fatalf("recreate completed before delete classification committed: %v", err)
	case <-time.After(100 * time.Millisecond):
	}
	close(release)

	result := <-deleteDone
	if result.deleted || result.err != nil {
		t.Fatalf("missing delete result = (%v, %v), want (false, nil)", result.deleted, result.err)
	}
	if err := <-createDone; err != nil {
		t.Fatalf("recreate after classification: %v", err)
	}
	events, err := first.EventsAfter(ctx, before, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 1 || events[0].Type != cdc.EventSCMConnectionCreated {
		t.Fatalf("events after lock + recreate = %#v, want one create event", events)
	}
}

func installDeleteLockBarrier() {
	deleteLockBarrier.register.Do(func() {
		modernsqlite.MustRegisterScalarFunction(
			"ao_test_scm_delete_lock_barrier",
			0,
			func(_ *modernsqlite.FunctionContext, _ []driver.Value) (driver.Value, error) {
				deleteLockBarrier.mu.Lock()
				entered := deleteLockBarrier.entered
				release := deleteLockBarrier.release
				deleteLockBarrier.entered = nil
				deleteLockBarrier.mu.Unlock()
				if entered != nil {
					close(entered)
				}
				if release != nil {
					<-release
				}
				return int64(0), nil
			},
		)
	})
}

func newSharedTestStores(t *testing.T) (*sqlite.Store, *sqlite.Store) {
	t.Helper()
	dir := t.TempDir()
	return openSharedTestStores(t, dir)
}

func openSharedTestStores(t *testing.T, dir string) (*sqlite.Store, *sqlite.Store) {
	t.Helper()
	first, err := sqlite.Open(dir)
	if err != nil {
		t.Fatalf("open first store: %v", err)
	}
	t.Cleanup(func() { _ = first.Close() })
	second, err := sqlite.Open(dir)
	if err != nil {
		t.Fatalf("open second store: %v", err)
	}
	t.Cleanup(func() { _ = second.Close() })
	return first, second
}

func referencedProject(conn domain.SCMConnection) domain.ProjectRecord {
	return domain.ProjectRecord{
		ID: "ao", Path: "/tmp/ao", RegisteredAt: conn.CreatedAt,
		Config: domain.ProjectConfig{SCM: domain.SCMProjectConfig{
			Provider: domain.SCMProviderGitLab, ConnectionID: conn.ID,
		}},
	}
}

func assertNoDanglingProjectConnection(t *testing.T, s *sqlite.Store, connectionID, projectID string) {
	t.Helper()
	project, exists, err := s.GetProject(context.Background(), projectID)
	if err != nil || !exists {
		t.Fatalf("get referenced project: exists=%v err=%v", exists, err)
	}
	if project.Config.SCM.ConnectionID != connectionID {
		t.Fatalf("project connection = %q, want %q", project.Config.SCM.ConnectionID, connectionID)
	}
	if _, exists, err := s.GetSCMConnection(context.Background(), connectionID); err != nil || !exists {
		t.Fatalf("referenced connection exists=%v err=%v", exists, err)
	}
}

func TestSCMConnectionStoreEmitsGlobalCDC(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	conn := testSCMConnection()
	if err := s.CreateSCMConnection(ctx, conn); err != nil {
		t.Fatal(err)
	}
	conn.DisplayName = "Updated"
	conn.UpdatedAt = conn.UpdatedAt.Add(time.Minute)
	if _, err := s.UpdateSCMConnection(ctx, conn); err != nil {
		t.Fatal(err)
	}
	if _, err := s.DeleteSCMConnection(ctx, conn.ID); err != nil {
		t.Fatal(err)
	}

	events, err := s.EventsAfter(ctx, 0, 100)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 3 {
		t.Fatalf("events = %d, want 3", len(events))
	}
	wantTypes := []cdc.EventType{
		cdc.EventSCMConnectionCreated,
		cdc.EventSCMConnectionUpdated,
		cdc.EventSCMConnectionDeleted,
	}
	for i, event := range events {
		if event.Type != wantTypes[i] || event.ProjectID != "" || event.SessionID != "" {
			t.Fatalf("event[%d] = %#v, want type=%q and global scope", i, event, wantTypes[i])
		}
		if bytes.Contains(event.Payload, []byte(conn.CredentialRef)) {
			t.Fatalf("event[%d] leaked credential ref: %s", i, event.Payload)
		}
	}
}

func TestSCMConnectionStoreUpdatedAtOnlyEmitsCDC(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	conn := testSCMConnection()
	if err := s.CreateSCMConnection(ctx, conn); err != nil {
		t.Fatal(err)
	}
	before, err := s.LatestSeq(ctx)
	if err != nil {
		t.Fatal(err)
	}

	conn.UpdatedAt = conn.UpdatedAt.Add(time.Minute)
	if updated, err := s.UpdateSCMConnection(ctx, conn); err != nil || !updated {
		t.Fatalf("updated-at-only update: updated=%v err=%v", updated, err)
	}
	events, err := s.EventsAfter(ctx, before, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 1 || events[0].Type != cdc.EventSCMConnectionUpdated {
		t.Fatalf("updated-at-only events = %#v, want one scm_connection_updated", events)
	}
}

func TestSCMConnectionSQLiteContainsMetadataOnly(t *testing.T) {
	recordType := reflect.TypeFor[domain.SCMConnection]()
	for i := 0; i < recordType.NumField(); i++ {
		name := strings.ToLower(recordType.Field(i).Name)
		if strings.Contains(name, "token") || strings.Contains(name, "secret") {
			t.Fatalf("domain.SCMConnection exposes secret-bearing field %q", recordType.Field(i).Name)
		}
	}

	dir := t.TempDir()
	s, err := sqlite.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	conn := testSCMConnection()
	if err := s.CreateSCMConnection(context.Background(), conn); err != nil {
		t.Fatal(err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}

	db, err := sql.Open("sqlite", "file:"+filepath.Join(dir, "ao.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	rows, err := db.Query(`PRAGMA table_info(scm_connections)`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var columns []string
	for rows.Next() {
		var cid, notNull, pk int
		var name, typ string
		var defaultValue any
		if err := rows.Scan(&cid, &name, &typ, &notNull, &defaultValue, &pk); err != nil {
			t.Fatal(err)
		}
		columns = append(columns, name)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("schema columns: %v", err)
	}
	for _, column := range columns {
		if strings.Contains(column, "token") || strings.Contains(column, "secret") {
			t.Fatalf("scm_connections has secret-bearing column %q", column)
		}
	}
}
