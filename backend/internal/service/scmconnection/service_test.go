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
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite/store"
)

type fakeStore struct {
	rows       map[string]domain.SCMConnection
	createErr  error
	updateErr  error
	deleteErr  error
	updateOK   bool
	deleteOK   bool
	createCall []domain.SCMConnection
	updateCall []domain.SCMConnection
}

func newFakeStore() *fakeStore {
	return &fakeStore{rows: map[string]domain.SCMConnection{}, updateOK: true, deleteOK: true}
}

func (f *fakeStore) CreateSCMConnection(_ context.Context, row domain.SCMConnection) error {
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
	return true, nil
}

type fakeCredentials struct {
	secrets   map[string][]byte
	putErr    error
	getErr    error
	deleteErr error
	puts      []string
	deletes   []string
}

func newFakeCredentials() *fakeCredentials { return &fakeCredentials{secrets: map[string][]byte{}} }

func (f *fakeCredentials) Put(_ context.Context, ref string, secret []byte) error {
	f.puts = append(f.puts, ref)
	if f.putErr != nil {
		err := f.putErr
		f.putErr = nil
		return err
	}
	f.secrets[ref] = append([]byte(nil), secret...)
	return nil
}

func (f *fakeCredentials) Get(_ context.Context, ref string) ([]byte, bool, error) {
	if f.getErr != nil {
		return nil, false, f.getErr
	}
	secret, ok := f.secrets[ref]
	return append([]byte(nil), secret...), ok, nil
}

func (f *fakeCredentials) Delete(_ context.Context, ref string) error {
	f.deletes = append(f.deletes, ref)
	if f.deleteErr != nil {
		err := f.deleteErr
		f.deleteErr = nil
		return err
	}
	delete(f.secrets, ref)
	return nil
}

type fakeTester struct {
	result TestResult
	err    error
	row    domain.SCMConnection
	token  []byte
	calls  int
}

func (f *fakeTester) Test(_ context.Context, row domain.SCMConnection, token []byte) (TestResult, error) {
	f.calls++
	f.row = row
	f.token = append([]byte(nil), token...)
	return f.result, f.err
}

func newTestService(st *fakeStore, creds *fakeCredentials, tester ConnectionTester) *Service {
	return New(Deps{
		Store:       st,
		Credentials: creds,
		Tester:      tester,
		Clock: func() time.Time {
			return time.Date(2026, 7, 16, 12, 0, 0, 0, time.UTC)
		},
		NewCredentialRef: func(id string) (string, error) { return "scm/" + id + "/new", nil },
	})
}

func createInput(token *string) CreateInput {
	return CreateInput{
		ID: "gitlab-work", Provider: domain.SCMProviderGitLab,
		DisplayName: "Work GitLab", Token: token,
	}
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
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := newTestService(newFakeStore(), newFakeCredentials(), nil).Create(context.Background(), tc.in)
			assertAPIError(t, err, tc.code)
		})
	}

	t.Run("loopback HTTP and derived API", func(t *testing.T) {
		in := createInput(nil)
		in.WebBaseURL = "http://127.0.0.1:8080/gitlab/"
		got, err := newTestService(newFakeStore(), newFakeCredentials(), nil).Create(context.Background(), in)
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
				WebBaseURL: "https://gitlab.example.com", Token: tc.token,
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
			Provider: domain.SCMProviderGitLab, DisplayName: "x", Token: ptr("new"),
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
			Provider: domain.SCMProviderGitLab, DisplayName: "x", Token: ptr(""),
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
			Provider: domain.SCMProviderGitLab, DisplayName: "Renamed", Token: ptr("new"),
		})
		assertAPIError(t, err, "SCM_CREDENTIAL_STORE_FAILED")
		row := st.rows["gitlab-work"]
		if row.DisplayName != "Work" || row.CredentialRef != "scm/gitlab-work/old" || len(creds.secrets) != 1 {
			t.Fatalf("state after rollback = %#v credentials=%#v", row, creds.secrets)
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
}

func TestDeleteMapsNotFoundAndReferenceConflict(t *testing.T) {
	st, creds := seededConnection()
	svc := newTestService(st, creds, nil)
	st.deleteErr = store.ErrSCMConnectionReferenced
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
	if tester.calls != 1 || string(tester.token) != "old" || tester.row.CredentialRef == "" {
		t.Fatalf("tester call = %#v token=%q", tester.row, tester.token)
	}

	delete(creds.secrets, st.rows["gitlab-work"].CredentialRef)
	got, err = svc.Test(context.Background(), "gitlab-work")
	if err != nil || got.Status != StatusMissingCredential || tester.calls != 1 {
		t.Fatalf("missing credential test = (%#v, %v), calls=%d", got, err, tester.calls)
	}

	creds.secrets[st.rows["gitlab-work"].CredentialRef] = []byte("old")
	tester.err = errors.New("provider body contains glpat-secret")
	_, err = svc.Test(context.Background(), "gitlab-work")
	e := assertAPIError(t, err, "SCM_CONNECTION_TEST_FAILED")
	if strings.Contains(e.Message, "provider") || strings.Contains(e.Message, "glpat") {
		t.Fatalf("raw provider error leaked: %q", e.Message)
	}
}

func seededConnection() (*fakeStore, *fakeCredentials) {
	st, creds := newFakeStore(), newFakeCredentials()
	row := domain.SCMConnection{
		ID: "gitlab-work", Provider: domain.SCMProviderGitLab, DisplayName: "Work",
		WebBaseURL: "https://gitlab.com", APIBaseURL: "https://gitlab.com/api/v4",
		CredentialRef: "scm/gitlab-work/old", CreatedAt: time.Date(2026, 7, 15, 0, 0, 0, 0, time.UTC),
		UpdatedAt: time.Date(2026, 7, 15, 0, 0, 0, 0, time.UTC),
	}
	st.rows[row.ID] = row
	creds.secrets[row.CredentialRef] = []byte("old")
	return st, creds
}

func ptr(v string) *string { return &v }

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
