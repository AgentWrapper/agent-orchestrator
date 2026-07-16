package scmconnection

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apierr"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

type fakeStore struct {
	rows           map[string]domain.SCMConnection
	createErr      error
	updateErr      error
	updateErrs     []error
	deleteErr      error
	validationErr  error
	updateOK       bool
	deleteOK       bool
	createCall     []domain.SCMConnection
	updateCall     []domain.SCMConnection
	deleteHook     func()
	respectContext bool
	createCtxErrs  []error
}

func newFakeStore() *fakeStore {
	return &fakeStore{rows: map[string]domain.SCMConnection{}, updateOK: true, deleteOK: true}
}

func (f *fakeStore) CreateSCMConnection(ctx context.Context, row domain.SCMConnection) error {
	f.createCtxErrs = append(f.createCtxErrs, ctx.Err())
	if f.respectContext && ctx.Err() != nil {
		return ctx.Err()
	}
	f.createCall = append(f.createCall, row)
	if f.createErr != nil {
		err := f.createErr
		f.createErr = nil
		return err
	}
	if _, exists := f.rows[row.ID]; exists {
		return errors.New("unique constraint")
	}
	f.rows[row.ID] = row
	return nil
}

func (f *fakeStore) GetSCMConnection(_ context.Context, id string) (domain.SCMConnection, bool, error) {
	row, ok := f.rows[id]
	return row, ok, nil
}

func (f *fakeStore) ListSCMConnections(context.Context) ([]domain.SCMConnection, error) {
	rows := make([]domain.SCMConnection, 0, len(f.rows))
	for _, row := range f.rows {
		rows = append(rows, row)
	}
	return rows, nil
}

func (f *fakeStore) UpdateSCMConnection(_ context.Context, row domain.SCMConnection) (bool, error) {
	f.updateCall = append(f.updateCall, row)
	if len(f.updateErrs) > 0 {
		err := f.updateErrs[0]
		f.updateErrs = f.updateErrs[1:]
		if err != nil {
			return false, err
		}
	}
	if f.updateErr != nil {
		err := f.updateErr
		f.updateErr = nil
		return false, err
	}
	if !f.updateOK {
		return false, nil
	}
	if _, ok := f.rows[row.ID]; !ok {
		return false, nil
	}
	f.rows[row.ID] = row
	return true, nil
}

func (f *fakeStore) UpdateSCMConnectionValidation(_ context.Context, id string, expectedUpdatedAt time.Time, status domain.SCMConnectionStatus, username string) (bool, error) {
	if f.validationErr != nil {
		return false, f.validationErr
	}
	row, ok := f.rows[id]
	if !ok || !row.UpdatedAt.Equal(expectedUpdatedAt) {
		return false, nil
	}
	row.Status = status
	row.Username = username
	f.rows[id] = row
	return true, nil
}

func (f *fakeStore) DeleteSCMConnection(_ context.Context, id string) (bool, error) {
	if f.deleteErr != nil {
		err := f.deleteErr
		f.deleteErr = nil
		return false, err
	}
	if !f.deleteOK {
		return false, nil
	}
	if _, ok := f.rows[id]; !ok {
		return false, nil
	}
	delete(f.rows, id)
	if f.deleteHook != nil {
		f.deleteHook()
	}
	return true, nil
}

type fakeCredentials struct {
	secrets              map[string][]byte
	putErr               error
	getErr               error
	deleteErr            error
	puts                 []string
	deletes              []string
	deleteCtxErrs        []error
	getCtxErrs           []error
	putCtxErrs           []error
	lastGet              []byte
	respectContext       bool
	deleteRemovesOnError bool
	putErrByRef          map[string]error
}

func newFakeCredentials() *fakeCredentials { return &fakeCredentials{secrets: map[string][]byte{}} }

func (f *fakeCredentials) Put(ctx context.Context, ref string, secret []byte) error {
	f.puts = append(f.puts, ref)
	f.putCtxErrs = append(f.putCtxErrs, ctx.Err())
	if f.respectContext && ctx.Err() != nil {
		return ctx.Err()
	}
	if err := f.putErrByRef[ref]; err != nil {
		delete(f.putErrByRef, ref)
		return err
	}
	if f.putErr != nil {
		err := f.putErr
		f.putErr = nil
		return err
	}
	f.secrets[ref] = append([]byte(nil), secret...)
	return nil
}

func (f *fakeCredentials) Get(ctx context.Context, ref string) ([]byte, bool, error) {
	f.getCtxErrs = append(f.getCtxErrs, ctx.Err())
	if f.respectContext && ctx.Err() != nil {
		return nil, false, ctx.Err()
	}
	if f.getErr != nil {
		return nil, false, f.getErr
	}
	secret, ok := f.secrets[ref]
	result := append([]byte(nil), secret...)
	f.lastGet = result
	return result, ok, nil
}

func (f *fakeCredentials) Delete(ctx context.Context, ref string) error {
	f.deletes = append(f.deletes, ref)
	f.deleteCtxErrs = append(f.deleteCtxErrs, ctx.Err())
	if f.deleteErr != nil {
		err := f.deleteErr
		f.deleteErr = nil
		if f.deleteRemovesOnError {
			delete(f.secrets, ref)
		}
		return err
	}
	delete(f.secrets, ref)
	return nil
}

type fakeTester struct {
	result  TestResult
	err     error
	config  ConnectionTestConfig
	token   []byte
	calls   int
	entered chan struct{}
	release chan struct{}
}

func (f *fakeTester) Test(_ context.Context, config ConnectionTestConfig, token []byte) (TestResult, error) {
	f.calls++
	f.config = config
	f.token = append([]byte(nil), token...)
	if f.entered != nil {
		close(f.entered)
		<-f.release
	}
	return f.result, f.err
}

func newTestService(st *fakeStore, creds *fakeCredentials, tester ConnectionTester) *Service {
	return newTestServiceWithLoopbackPolicy(st, creds, tester, false)
}

func newTestServiceWithLoopbackPolicy(st *fakeStore, creds *fakeCredentials, tester ConnectionTester, allow bool) *Service {
	return New(Deps{
		Store:                 st,
		Credentials:           creds,
		Tester:                tester,
		AllowInsecureLoopback: allow,
		Clock: func() time.Time {
			return time.Date(2026, 7, 16, 12, 0, 0, 0, time.UTC)
		},
		NewCredentialRef: func(id string) (string, error) { return "scm/" + id + "/new", nil },
	})
}

func createInput(token *string) CreateInput {
	in := CreateInput{
		ID: "gitlab-work", Provider: domain.SCMProviderGitLab,
		DisplayName: "Work GitLab",
	}
	if token != nil {
		in.Token = tokenInput(*token)
	}
	return in
}

func TestCreateListGetDefaultsAndKeepsTokenWriteOnly(t *testing.T) {
	st, creds := newFakeStore(), newFakeCredentials()
	token := "glpat-secret"
	svc := newTestService(st, creds, nil)

	created, err := svc.Create(context.Background(), createInput(&token))
	if err != nil {
		t.Fatal(err)
	}
	if created.ID != "gitlab-work" || created.WebBaseURL != "https://gitlab.com" || created.APIBaseURL != "https://gitlab.com/api/v4" {
		t.Fatalf("created = %#v", created)
	}
	if !created.CredentialConfigured || created.Status != StatusUnknown || created.Username != "" {
		t.Fatalf("credential view = %#v", created)
	}
	row := st.rows[created.ID]
	if row.CredentialRef == "" || strings.Contains(row.CredentialRef, token) {
		t.Fatalf("credential ref = %q", row.CredentialRef)
	}
	if got := string(creds.secrets[row.CredentialRef]); got != token {
		t.Fatalf("stored secret = %q", got)
	}

	got, err := svc.Get(context.Background(), created.ID)
	if err != nil || !reflect.DeepEqual(got, created) {
		t.Fatalf("get = (%#v, %v), want %#v", got, err, created)
	}
	list, err := svc.List(context.Background())
	if err != nil || !reflect.DeepEqual(list, []Connection{created}) {
		t.Fatalf("list = (%#v, %v)", list, err)
	}
}

func TestGetAndListReflectPersistedValidation(t *testing.T) {
	st, creds := seededConnection()
	row := st.rows["gitlab-work"]
	row.Status = domain.SCMConnectionStatusConnected
	row.Username = "alice"
	st.rows[row.ID] = row
	svc := newTestService(st, creds, nil)

	got, err := svc.Get(context.Background(), row.ID)
	if err != nil || got.Status != StatusConnected || got.Username != "alice" {
		t.Fatalf("get validation = (%#v, %v)", got, err)
	}
	list, err := svc.List(context.Background())
	if err != nil || len(list) != 1 || list[0].Status != StatusConnected || list[0].Username != "alice" {
		t.Fatalf("list validation = (%#v, %v)", list, err)
	}
}

func TestCreateValidationAndDuplicateMapping(t *testing.T) {
	cases := []struct {
		name string
		in   CreateInput
		code string
	}{
		{name: "id", in: CreateInput{ID: "../bad", Provider: domain.SCMProviderGitLab, DisplayName: "x"}, code: "INVALID_SCM_CONNECTION_ID"},
		{name: "provider", in: CreateInput{ID: "x", Provider: "bitbucket", DisplayName: "x"}, code: "INVALID_SCM_PROVIDER"},
		{name: "display name", in: CreateInput{ID: "x", Provider: domain.SCMProviderGitLab}, code: "SCM_CONNECTION_DISPLAY_NAME_REQUIRED"},
		{name: "non-loopback http", in: CreateInput{ID: "x", Provider: domain.SCMProviderGitLab, DisplayName: "x", WebBaseURL: "http://gitlab.example.com"}, code: "INVALID_SCM_CONNECTION_URL"},
		{name: "relative", in: CreateInput{ID: "x", Provider: domain.SCMProviderGitLab, DisplayName: "x", WebBaseURL: "/gitlab"}, code: "INVALID_SCM_CONNECTION_URL"},
		{name: "credentials", in: CreateInput{ID: "x", Provider: domain.SCMProviderGitLab, DisplayName: "x", WebBaseURL: "https://user:pass@gitlab.example.com"}, code: "INVALID_SCM_CONNECTION_URL"},
		{name: "query", in: CreateInput{ID: "x", Provider: domain.SCMProviderGitLab, DisplayName: "x", APIBaseURL: "https://gitlab.example.com/api/v4?token=x"}, code: "INVALID_SCM_CONNECTION_URL"},
		{name: "empty query", in: CreateInput{ID: "x", Provider: domain.SCMProviderGitLab, DisplayName: "x", APIBaseURL: "https://gitlab.example.com/api/v4?"}, code: "INVALID_SCM_CONNECTION_URL"},
		{name: "fragment", in: CreateInput{ID: "x", Provider: domain.SCMProviderGitLab, DisplayName: "x", APIBaseURL: "https://gitlab.example.com/api/v4#x"}, code: "INVALID_SCM_CONNECTION_URL"},
		{name: "empty fragment", in: CreateInput{ID: "x", Provider: domain.SCMProviderGitLab, DisplayName: "x", APIBaseURL: "https://gitlab.example.com/api/v4#"}, code: "INVALID_SCM_CONNECTION_URL"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := newTestService(newFakeStore(), newFakeCredentials(), nil).Create(context.Background(), tc.in)
			assertAPIError(t, err, tc.code)
		})
	}

	t.Run("production rejects loopback HTTP", func(t *testing.T) {
		in := createInput(nil)
		in.WebBaseURL = "http://127.0.0.1:8080/gitlab/"
		_, err := newTestService(newFakeStore(), newFakeCredentials(), nil).Create(context.Background(), in)
		assertAPIError(t, err, "INVALID_SCM_CONNECTION_URL")
	})

	t.Run("development policy allows loopback HTTP and derived API", func(t *testing.T) {
		in := createInput(nil)
		in.WebBaseURL = "http://127.0.0.1:8080/gitlab/"
		got, err := newTestServiceWithLoopbackPolicy(newFakeStore(), newFakeCredentials(), nil, true).Create(context.Background(), in)
		if err != nil || got.APIBaseURL != "http://127.0.0.1:8080/gitlab/api/v4" {
			t.Fatalf("create = (%#v, %v)", got, err)
		}
	})

	t.Run("encoded path is preserved", func(t *testing.T) {
		in := createInput(nil)
		in.WebBaseURL = "https://gitlab.example.com/gitlab%20root/"
		got, err := newTestService(newFakeStore(), newFakeCredentials(), nil).Create(context.Background(), in)
		if err != nil || got.WebBaseURL != "https://gitlab.example.com/gitlab%20root" || got.APIBaseURL != "https://gitlab.example.com/gitlab%20root/api/v4" {
			t.Fatalf("create = (%#v, %v)", got, err)
		}
	})

	t.Run("duplicate", func(t *testing.T) {
		st, creds := newFakeStore(), newFakeCredentials()
		svc := newTestService(st, creds, nil)
		if _, err := svc.Create(context.Background(), createInput(nil)); err != nil {
			t.Fatal(err)
		}
		token := "replacement-must-not-win"
		_, err := svc.Create(context.Background(), createInput(&token))
		assertAPIError(t, err, "SCM_CONNECTION_ALREADY_EXISTS")
	})
}

func TestUpdateCredentialPresenceSemantics(t *testing.T) {
	for _, tc := range []struct {
		name      string
		token     *string
		wantToken string
		wantSame  bool
	}{
		{name: "omitted retains", token: nil, wantToken: "old", wantSame: true},
		{name: "present replaces", token: ptr("new"), wantToken: "new"},
		{name: "empty removes", token: ptr(""), wantToken: ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			st, creds := seededConnection()
			oldRef := st.rows["gitlab-work"].CredentialRef
			svc := newTestService(st, creds, nil)
			got, err := svc.Update(context.Background(), "gitlab-work", UpdateInput{
				Provider: domain.SCMProviderGitLab, DisplayName: "Renamed",
				WebBaseURL: "https://gitlab.example.com", Token: tokenInputPtr(tc.token),
			})
			if err != nil {
				t.Fatal(err)
			}
			row := st.rows["gitlab-work"]
			if tc.wantSame != (row.CredentialRef == oldRef) {
				t.Fatalf("credential ref same = %v, want %v", row.CredentialRef == oldRef, tc.wantSame)
			}
			secret := string(creds.secrets[row.CredentialRef])
			if secret != tc.wantToken || got.CredentialConfigured != (tc.wantToken != "") {
				t.Fatalf("secret/view = (%q, %#v)", secret, got)
			}
			if row.APIBaseURL != "https://gitlab.example.com/api/v4" || row.DisplayName != "Renamed" {
				t.Fatalf("updated row = %#v", row)
			}
		})
	}
}

func TestUpdateInvalidatesValidationOnlyForConnectionChanges(t *testing.T) {
	for _, tc := range []struct {
		name       string
		update     UpdateInput
		wantStatus string
		wantUser   string
	}{
		{
			name:       "display name retains",
			update:     UpdateInput{Provider: domain.SCMProviderGitLab, DisplayName: "Renamed", WebBaseURL: "https://gitlab.com"},
			wantStatus: StatusConnected, wantUser: "alice",
		},
		{
			name:       "URL invalidates",
			update:     UpdateInput{Provider: domain.SCMProviderGitLab, DisplayName: "Work", WebBaseURL: "https://gitlab.example.com"},
			wantStatus: StatusUnknown,
		},
		{
			name:       "token invalidates",
			update:     UpdateInput{Provider: domain.SCMProviderGitLab, DisplayName: "Work", WebBaseURL: "https://gitlab.com", Token: tokenInput("new")},
			wantStatus: StatusUnknown,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			st, creds := seededConnection()
			row := st.rows["gitlab-work"]
			row.Status = domain.SCMConnectionStatusConnected
			row.Username = "alice"
			st.rows[row.ID] = row
			got, err := newTestService(st, creds, nil).Update(context.Background(), row.ID, tc.update)
			if err != nil {
				t.Fatal(err)
			}
			stored := st.rows[row.ID]
			if got.Status != tc.wantStatus || got.Username != tc.wantUser || string(stored.Status) != tc.wantStatus || stored.Username != tc.wantUser {
				t.Fatalf("validation = response(%q,%q) stored(%q,%q)", got.Status, got.Username, stored.Status, stored.Username)
			}
		})
	}
}

func TestMutationCompensation(t *testing.T) {
	t.Run("create metadata failure removes new secret", func(t *testing.T) {
		st, creds := newFakeStore(), newFakeCredentials()
		st.createErr = errors.New("db unavailable")
		token := "secret"
		_, err := newTestService(st, creds, nil).Create(context.Background(), createInput(&token))
		assertAPIError(t, err, "SCM_CONNECTION_CREATE_FAILED")
		if len(creds.secrets) != 0 || len(creds.deletes) != 1 {
			t.Fatalf("credentials after compensation = %#v deletes=%v", creds.secrets, creds.deletes)
		}
	})

	t.Run("replace metadata failure removes new secret and retains old", func(t *testing.T) {
		st, creds := seededConnection()
		st.updateErr = errors.New("db unavailable")
		_, err := newTestService(st, creds, nil).Update(context.Background(), "gitlab-work", UpdateInput{
			Provider: domain.SCMProviderGitLab, DisplayName: "x", Token: tokenInput("new"),
		})
		assertAPIError(t, err, "SCM_CONNECTION_UPDATE_FAILED")
		row := st.rows["gitlab-work"]
		if string(creds.secrets[row.CredentialRef]) != "old" || len(creds.secrets) != 1 {
			t.Fatalf("credentials after compensation = %#v", creds.secrets)
		}
	})

	t.Run("remove metadata failure retains old", func(t *testing.T) {
		st, creds := seededConnection()
		st.updateErr = errors.New("db unavailable")
		_, err := newTestService(st, creds, nil).Update(context.Background(), "gitlab-work", UpdateInput{
			Provider: domain.SCMProviderGitLab, DisplayName: "x", Token: tokenInput(""),
		})
		assertAPIError(t, err, "SCM_CONNECTION_UPDATE_FAILED")
		row := st.rows["gitlab-work"]
		if string(creds.secrets[row.CredentialRef]) != "old" {
			t.Fatalf("old credential was removed: %#v", creds.secrets)
		}
	})

	t.Run("replace cleanup failure rolls metadata back", func(t *testing.T) {
		st, creds := seededConnection()
		creds.deleteErr = errors.New("vault unavailable")
		_, err := newTestService(st, creds, nil).Update(context.Background(), "gitlab-work", UpdateInput{
			Provider: domain.SCMProviderGitLab, DisplayName: "Renamed", Token: tokenInput("new"),
		})
		assertAPIError(t, err, "SCM_CREDENTIAL_STORE_FAILED")
		row := st.rows["gitlab-work"]
		if row.DisplayName != "Work" || row.CredentialRef != "scm/gitlab-work/old" || len(creds.secrets) != 1 {
			t.Fatalf("state after rollback = %#v credentials=%#v", row, creds.secrets)
		}
	})

	t.Run("rollback failure keeps replacement credential consistent with metadata", func(t *testing.T) {
		st, creds := seededConnection()
		st.updateErrs = []error{nil, errors.New("rollback unavailable")}
		creds.deleteErr = errors.New("vault unavailable")
		_, err := newTestService(st, creds, nil).Update(context.Background(), "gitlab-work", UpdateInput{
			Provider: domain.SCMProviderGitLab, DisplayName: "Renamed", Token: tokenInput("new"),
		})
		assertAPIError(t, err, "SCM_CONNECTION_UPDATE_FAILED")
		row := st.rows["gitlab-work"]
		if row.CredentialRef != "scm/gitlab-work/new" || string(creds.secrets[row.CredentialRef]) != "new" {
			t.Fatalf("metadata/credential diverged after rollback failure: row=%#v credentials=%#v", row, creds.secrets)
		}
	})

	t.Run("destructive old delete is restored before rollback", func(t *testing.T) {
		st, creds := seededConnection()
		creds.deleteErr = errors.New("vault unavailable")
		creds.deleteRemovesOnError = true
		_, err := newTestService(st, creds, nil).Update(context.Background(), "gitlab-work", UpdateInput{
			Provider: domain.SCMProviderGitLab, DisplayName: "Renamed", Token: tokenInput("new"),
		})
		assertAPIError(t, err, "SCM_CREDENTIAL_STORE_FAILED")
		row := st.rows["gitlab-work"]
		if row.CredentialRef != "scm/gitlab-work/old" || string(creds.secrets[row.CredentialRef]) != "old" {
			t.Fatalf("destructive delete rollback diverged: row=%#v credentials=%#v", row, creds.secrets)
		}
		if _, exists := creds.secrets["scm/gitlab-work/new"]; exists {
			t.Fatalf("replacement credential survived successful rollback: %#v", creds.secrets)
		}
	})

	t.Run("old secret restore failure keeps replacement state", func(t *testing.T) {
		st, creds := seededConnection()
		creds.deleteErr = errors.New("vault unavailable")
		creds.deleteRemovesOnError = true
		creds.putErrByRef = map[string]error{"scm/gitlab-work/old": errors.New("restore unavailable")}
		_, err := newTestService(st, creds, nil).Update(context.Background(), "gitlab-work", UpdateInput{
			Provider: domain.SCMProviderGitLab, DisplayName: "Renamed", Token: tokenInput("new"),
		})
		assertAPIError(t, err, "SCM_CREDENTIAL_STORE_FAILED")
		row := st.rows["gitlab-work"]
		if row.CredentialRef != "scm/gitlab-work/new" || string(creds.secrets[row.CredentialRef]) != "new" {
			t.Fatalf("restore failure diverged replacement state: row=%#v credentials=%#v", row, creds.secrets)
		}
	})

	t.Run("rollback failure after old restore keeps replacement state", func(t *testing.T) {
		st, creds := seededConnection()
		st.updateErrs = []error{nil, errors.New("rollback unavailable")}
		creds.deleteErr = errors.New("vault unavailable")
		creds.deleteRemovesOnError = true
		_, err := newTestService(st, creds, nil).Update(context.Background(), "gitlab-work", UpdateInput{
			Provider: domain.SCMProviderGitLab, DisplayName: "Renamed", Token: tokenInput("new"),
		})
		assertAPIError(t, err, "SCM_CONNECTION_UPDATE_FAILED")
		row := st.rows["gitlab-work"]
		if row.CredentialRef != "scm/gitlab-work/new" || string(creds.secrets[row.CredentialRef]) != "new" || string(creds.secrets["scm/gitlab-work/old"]) != "old" {
			t.Fatalf("rollback failure state = row=%#v credentials=%#v", row, creds.secrets)
		}
	})

	t.Run("create cleanup survives cancellation and surfaces cleanup failure", func(t *testing.T) {
		st, creds := newFakeStore(), newFakeCredentials()
		st.createErr = errors.New("db unavailable")
		creds.deleteErr = errors.New("vault cleanup unavailable")
		token := "secret"
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		_, err := newTestService(st, creds, nil).Create(ctx, createInput(&token))
		assertJoinedAPIErrorCodes(t, err, "SCM_CONNECTION_CREATE_FAILED", "SCM_CREDENTIAL_CLEANUP_FAILED")
		if len(creds.deleteCtxErrs) != 1 || creds.deleteCtxErrs[0] != nil {
			t.Fatalf("create cleanup context errors = %v, want [nil]", creds.deleteCtxErrs)
		}
	})

	t.Run("update cleanup survives cancellation and surfaces cleanup failure", func(t *testing.T) {
		st, creds := seededConnection()
		st.updateErr = errors.New("db unavailable")
		creds.deleteErr = errors.New("vault cleanup unavailable")
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		_, err := newTestService(st, creds, nil).Update(ctx, "gitlab-work", UpdateInput{
			Provider: domain.SCMProviderGitLab, DisplayName: "Renamed", Token: tokenInput("new"),
		})
		assertJoinedAPIErrorCodes(t, err, "SCM_CONNECTION_UPDATE_FAILED", "SCM_CREDENTIAL_CLEANUP_FAILED")
		if len(creds.deleteCtxErrs) != 1 || creds.deleteCtxErrs[0] != nil {
			t.Fatalf("update cleanup context errors = %v, want [nil]", creds.deleteCtxErrs)
		}
	})

	t.Run("delete credential failure restores metadata", func(t *testing.T) {
		st, creds := seededConnection()
		creds.deleteErr = errors.New("vault unavailable")
		err := newTestService(st, creds, nil).Delete(context.Background(), "gitlab-work")
		assertAPIError(t, err, "SCM_CONNECTION_DELETE_FAILED")
		if _, ok := st.rows["gitlab-work"]; !ok {
			t.Fatal("metadata was not restored")
		}
	})

	t.Run("delete credential read failure restores metadata", func(t *testing.T) {
		st, creds := seededConnection()
		creds.getErr = errors.New("vault unavailable")
		err := newTestService(st, creds, nil).Delete(context.Background(), "gitlab-work")
		assertAPIError(t, err, "SCM_CREDENTIAL_STORE_FAILED")
		if _, ok := st.rows["gitlab-work"]; !ok {
			t.Fatal("metadata was not restored")
		}
	})

	t.Run("delete cleanup survives cancellation after metadata commit", func(t *testing.T) {
		st, creds := seededConnection()
		st.respectContext = true
		creds.respectContext = true
		ctx, cancel := context.WithCancel(context.Background())
		st.deleteHook = cancel
		if err := newTestService(st, creds, nil).Delete(ctx, "gitlab-work"); err != nil {
			t.Fatal(err)
		}
		if _, exists := st.rows["gitlab-work"]; exists || len(creds.secrets) != 0 {
			t.Fatalf("successful canceled delete left state: rows=%#v credentials=%#v", st.rows, creds.secrets)
		}
		assertContextErrorsNil(t, creds.getCtxErrs, creds.deleteCtxErrs)
	})

	t.Run("delete vault failure after cancellation restores metadata and secret", func(t *testing.T) {
		st, creds := seededConnection()
		st.respectContext = true
		creds.respectContext = true
		creds.deleteErr = errors.New("vault unavailable")
		creds.deleteRemovesOnError = true
		ctx, cancel := context.WithCancel(context.Background())
		st.deleteHook = cancel
		err := newTestService(st, creds, nil).Delete(ctx, "gitlab-work")
		assertAPIError(t, err, "SCM_CONNECTION_DELETE_FAILED")
		row, exists := st.rows["gitlab-work"]
		if !exists || string(creds.secrets[row.CredentialRef]) != "old" {
			t.Fatalf("failed canceled delete was not restored: rows=%#v credentials=%#v", st.rows, creds.secrets)
		}
		if len(creds.deletes) != 1 {
			t.Fatalf("vault delete calls = %v, want one", creds.deletes)
		}
		assertContextErrorsNil(t, creds.getCtxErrs, creds.deleteCtxErrs, creds.putCtxErrs)
		assertContextErrorsNil(t, st.createCtxErrs)
	})

	t.Run("delete zeros loaded credential bytes", func(t *testing.T) {
		st, creds := seededConnection()
		if err := newTestService(st, creds, nil).Delete(context.Background(), "gitlab-work"); err != nil {
			t.Fatal(err)
		}
		if len(creds.lastGet) == 0 {
			t.Fatal("delete did not load credential bytes")
		}
		for i, b := range creds.lastGet {
			if b != 0 {
				t.Fatalf("loaded credential byte %d = %d, want zero", i, b)
			}
		}
	})
}

func TestDeleteMapsNotFoundAndReferenceConflict(t *testing.T) {
	st, creds := seededConnection()
	svc := newTestService(st, creds, nil)
	st.deleteErr = ports.ErrSCMConnectionReferenced
	creds.getErr = errors.New("vault unavailable")
	assertAPIError(t, svc.Delete(context.Background(), "gitlab-work"), "SCM_CONNECTION_REFERENCED")
	if len(creds.deletes) != 0 {
		t.Fatal("referenced delete touched credentials")
	}
	assertAPIError(t, svc.Delete(context.Background(), "missing"), "SCM_CONNECTION_NOT_FOUND")
}

func TestConnectionTestReturnsStructuredResultAndNeverRawErrors(t *testing.T) {
	st, creds := seededConnection()
	tester := &fakeTester{result: TestResult{
		Status:       StatusConnected,
		Identity:     Identity{Username: "alice", DisplayName: "Alice"},
		Capabilities: Capabilities{Read: true, Write: false},
	}}
	svc := newTestService(st, creds, tester)
	got, err := svc.Test(context.Background(), "gitlab-work")
	if err != nil || !reflect.DeepEqual(got, tester.result) {
		t.Fatalf("test = (%#v, %v)", got, err)
	}
	if tester.calls != 1 || string(tester.token) != "old" || tester.config != (ConnectionTestConfig{
		ID: "gitlab-work", Provider: domain.SCMProviderGitLab,
		WebBaseURL: "https://gitlab.com", APIBaseURL: "https://gitlab.com/api/v4",
	}) {
		t.Fatalf("tester call = %#v token=%q", tester.config, tester.token)
	}
	configType := reflect.TypeOf(tester.config)
	for i := 0; i < configType.NumField(); i++ {
		name := strings.ToLower(configType.Field(i).Name)
		if strings.Contains(name, "credential") || strings.Contains(name, "ref") {
			t.Fatalf("tester config exposes persistence detail %q", configType.Field(i).Name)
		}
	}
	if row := st.rows["gitlab-work"]; row.Status != domain.SCMConnectionStatusConnected || row.Username != "alice" {
		t.Fatalf("persisted successful validation = (%q, %q)", row.Status, row.Username)
	}

	delete(creds.secrets, st.rows["gitlab-work"].CredentialRef)
	got, err = svc.Test(context.Background(), "gitlab-work")
	if err != nil || got.Status != StatusMissingCredential || tester.calls != 1 {
		t.Fatalf("missing credential test = (%#v, %v), calls=%d", got, err, tester.calls)
	}
	if row := st.rows["gitlab-work"]; row.Status != domain.SCMConnectionStatusMissingCredential || row.Username != "" {
		t.Fatalf("persisted missing credential = (%q, %q)", row.Status, row.Username)
	}

	creds.secrets[st.rows["gitlab-work"].CredentialRef] = []byte("old")
	tester.err = errors.New("provider body contains glpat-secret")
	_, err = svc.Test(context.Background(), "gitlab-work")
	e := assertAPIError(t, err, "SCM_CONNECTION_TEST_FAILED")
	if strings.Contains(e.Message, "provider") || strings.Contains(e.Message, "glpat") {
		t.Fatalf("raw provider error leaked: %q", e.Message)
	}
}

func TestConnectionTestMapsAndPersistsStructuredFailures(t *testing.T) {
	for _, tc := range []struct {
		name       string
		failure    TestFailureKind
		result     TestResult
		wantKind   apierr.Kind
		wantCode   string
		wantStatus domain.SCMConnectionStatus
		wantUser   string
	}{
		{name: "auth", failure: TestFailureAuth, wantKind: apierr.KindUnauthorized, wantCode: "SCM_AUTH_FAILED", wantStatus: domain.SCMConnectionStatusUnauthorized},
		{name: "forbidden", failure: TestFailureForbidden, wantKind: apierr.KindForbidden, wantCode: "SCM_FORBIDDEN", wantStatus: domain.SCMConnectionStatusForbidden},
		{name: "unreachable", failure: TestFailureUnreachable, wantKind: apierr.KindUnavailable, wantCode: "SCM_INSTANCE_UNREACHABLE", wantStatus: domain.SCMConnectionStatusUnreachable},
		{name: "TLS", failure: TestFailureTLS, wantKind: apierr.KindUnavailable, wantCode: "SCM_TLS_FAILED", wantStatus: domain.SCMConnectionStatusTLSError},
		{name: "rate limited", failure: TestFailureRateLimited, wantKind: apierr.KindRateLimited, wantCode: "SCM_RATE_LIMITED", wantStatus: domain.SCMConnectionStatusRateLimited},
		{name: "repo missing", failure: TestFailureRepoNotFound, result: connectedTestResult("alice"), wantKind: apierr.KindNotFound, wantCode: "SCM_REPO_NOT_FOUND", wantStatus: domain.SCMConnectionStatusConnected, wantUser: "alice"},
		{name: "write scope", failure: TestFailureWriteScopeMissing, result: connectedTestResult("alice"), wantKind: apierr.KindForbidden, wantCode: "SCM_WRITE_SCOPE_MISSING", wantStatus: domain.SCMConnectionStatusConnected, wantUser: "alice"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			st, creds := seededConnection()
			tester := &fakeTester{result: tc.result, err: NewTestFailure(tc.failure, errors.New("provider body contains glpat-secret"))}
			_, err := newTestService(st, creds, tester).Test(context.Background(), "gitlab-work")
			var got *apierr.Error
			if !errors.As(err, &got) || got.Kind != tc.wantKind || got.Code != tc.wantCode {
				t.Fatalf("error = %#v, want kind=%v code=%s", got, tc.wantKind, tc.wantCode)
			}
			if strings.Contains(err.Error(), "provider body") || strings.Contains(err.Error(), "glpat") {
				t.Fatalf("raw provider failure leaked: %v", err)
			}
			row := st.rows["gitlab-work"]
			if row.Status != tc.wantStatus || row.Username != tc.wantUser {
				t.Fatalf("persisted failure = (%q,%q), want (%q,%q)", row.Status, row.Username, tc.wantStatus, tc.wantUser)
			}
		})
	}
}

func TestConnectionTestRejectsNilErrorNonSuccessResults(t *testing.T) {
	for _, status := range []string{
		"", StatusMissingCredential, StatusUnauthorized, StatusForbidden,
		StatusUnreachable, StatusTLSError, StatusRateLimited,
	} {
		t.Run(status, func(t *testing.T) {
			st, creds := seededConnection()
			st.rows["gitlab-work"] = func() domain.SCMConnection {
				row := st.rows["gitlab-work"]
				row.Status = domain.SCMConnectionStatusConnected
				row.Username = "previous"
				return row
			}()
			tester := &fakeTester{result: TestResult{Status: status}}
			_, err := newTestService(st, creds, tester).Test(context.Background(), "gitlab-work")
			assertAPIError(t, err, "SCM_CONNECTION_TEST_FAILED")
			row := st.rows["gitlab-work"]
			if row.Status != domain.SCMConnectionStatusUnknown || row.Username != "" {
				t.Fatalf("contract violation persisted (%q,%q), want unknown", row.Status, row.Username)
			}
		})
	}
}

func TestConnectionTestCannotOverwriteNewerConfigurationValidation(t *testing.T) {
	st, creds := seededConnection()
	tester := &fakeTester{
		result:  connectedTestResult("alice"),
		entered: make(chan struct{}),
		release: make(chan struct{}),
	}
	svc := newTestService(st, creds, tester)

	testErr := make(chan error, 1)
	go func() {
		_, err := svc.Test(context.Background(), "gitlab-work")
		testErr <- err
	}()
	<-tester.entered

	updated, err := svc.Update(context.Background(), "gitlab-work", UpdateInput{
		Provider: domain.SCMProviderGitLab, DisplayName: "Renamed",
	})
	if err != nil {
		t.Fatal(err)
	}
	close(tester.release)
	assertAPIError(t, <-testErr, "SCM_CONNECTION_TEST_STALE")

	row := st.rows["gitlab-work"]
	if row.UpdatedAt.Equal(time.Date(2026, 7, 15, 0, 0, 0, 0, time.UTC)) ||
		row.Status != domain.SCMConnectionStatusUnknown || row.Username != "" ||
		updated.Status != StatusUnknown {
		t.Fatalf("stale validation overwrote newer configuration: response=%#v row=%#v", updated, row)
	}
}

func connectedTestResult(username string) TestResult {
	return TestResult{
		Status:       StatusConnected,
		Identity:     Identity{Username: username},
		Capabilities: Capabilities{Read: true},
	}
}

func seededConnection() (*fakeStore, *fakeCredentials) {
	st, creds := newFakeStore(), newFakeCredentials()
	row := domain.SCMConnection{
		ID: "gitlab-work", Provider: domain.SCMProviderGitLab, DisplayName: "Work",
		WebBaseURL: "https://gitlab.com", APIBaseURL: "https://gitlab.com/api/v4",
		CredentialRef: "scm/gitlab-work/old", CreatedAt: time.Date(2026, 7, 15, 0, 0, 0, 0, time.UTC),
		Status:    domain.SCMConnectionStatusUnknown,
		UpdatedAt: time.Date(2026, 7, 15, 0, 0, 0, 0, time.UTC),
	}
	st.rows[row.ID] = row
	creds.secrets[row.CredentialRef] = []byte("old")
	return st, creds
}

func ptr(v string) *string { return &v }

func tokenInput(value string) TokenInput {
	return TokenInput{Value: value, Present: true}
}

func tokenInputPtr(value *string) TokenInput {
	if value == nil {
		return TokenInput{}
	}
	return tokenInput(*value)
}

func assertAPIError(t *testing.T, err error, code string) *apierr.Error {
	t.Helper()
	var got *apierr.Error
	if !errors.As(err, &got) {
		t.Fatalf("error = %v, want apierr %s", err, code)
	}
	if got.Code != code {
		t.Fatalf("error code = %q, want %q", got.Code, code)
	}
	return got
}

func assertJoinedAPIErrorCodes(t *testing.T, err error, codes ...string) {
	t.Helper()
	got := map[string]bool{}
	var visit func(error)
	visit = func(current error) {
		if current == nil {
			return
		}
		var apiError *apierr.Error
		if errors.As(current, &apiError) {
			got[apiError.Code] = true
		}
		if joined, ok := current.(interface{ Unwrap() []error }); ok {
			for _, child := range joined.Unwrap() {
				visit(child)
			}
			return
		}
		if wrapped := errors.Unwrap(current); wrapped != nil {
			visit(wrapped)
		}
	}
	visit(err)
	for _, code := range codes {
		if !got[code] {
			t.Fatalf("error codes = %v, want %q in %v", got, code, err)
		}
	}
}

func assertContextErrorsNil(t *testing.T, groups ...[]error) {
	t.Helper()
	for _, group := range groups {
		for _, err := range group {
			if err != nil {
				t.Fatalf("cleanup context error = %v, want nil", err)
			}
		}
	}
}
