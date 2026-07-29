package controlplane

import (
	"context"
	"log/slog"
	"sync"
	"testing"
	"time"
)

// fakeUserStore records UpsertUser calls and signals each on done.
type fakeUserStore struct {
	mu    sync.Mutex
	calls []User
	done  chan struct{}
}

func (f *fakeUserStore) UpsertUser(_ context.Context, u User) error {
	f.mu.Lock()
	f.calls = append(f.calls, u)
	f.mu.Unlock()
	if f.done != nil {
		f.done <- struct{}{}
	}
	return nil
}

func (f *fakeUserStore) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.calls)
}

func userTestServer(users UserStore) *Server {
	return &Server{log: slog.Default(), users: users, userSeen: map[string]time.Time{}}
}

func TestRecordUser_UpsertsOnceThenThrottles(t *testing.T) {
	fake := &fakeUserStore{done: make(chan struct{}, 4)}
	s := userTestServer(fake)
	id := Identity{Tenant: "org_1", UserID: "user_1"}

	s.recordUser(id)
	select {
	case <-fake.done:
	case <-time.After(2 * time.Second):
		t.Fatal("first recordUser did not upsert")
	}
	if got := fake.calls[0]; got.UserID != "user_1" || got.TenantID != "org_1" {
		t.Fatalf("upserted wrong user: %+v", got)
	}

	// A second call inside the throttle window must NOT upsert.
	s.recordUser(id)
	select {
	case <-fake.done:
		t.Fatal("second recordUser within throttle window upserted (should be throttled)")
	case <-time.After(200 * time.Millisecond):
	}
	if got := fake.count(); got != 1 {
		t.Fatalf("want 1 upsert after throttle, got %d", got)
	}
}

func TestRecordUser_DistinctUsersEachUpsert(t *testing.T) {
	fake := &fakeUserStore{done: make(chan struct{}, 4)}
	s := userTestServer(fake)
	s.recordUser(Identity{Tenant: "t", UserID: "a"})
	s.recordUser(Identity{Tenant: "t", UserID: "b"})
	for i := 0; i < 2; i++ {
		select {
		case <-fake.done:
		case <-time.After(2 * time.Second):
			t.Fatal("distinct users should each upsert")
		}
	}
	if got := fake.count(); got != 2 {
		t.Fatalf("want 2 upserts for distinct users, got %d", got)
	}
}

func TestRecordUser_NilStoreAndEmptyUserAreNoOps(t *testing.T) {
	userTestServer(nil).recordUser(Identity{Tenant: "t", UserID: "u"}) // nil store: no panic

	fake := &fakeUserStore{done: make(chan struct{}, 1)}
	userTestServer(fake).recordUser(Identity{Tenant: "t", UserID: ""}) // empty user id: skipped
	select {
	case <-fake.done:
		t.Fatal("empty user id should not upsert")
	case <-time.After(200 * time.Millisecond):
	}
}
