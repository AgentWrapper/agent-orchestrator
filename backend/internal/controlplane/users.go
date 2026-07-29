package controlplane

import (
	"context"
	"time"
)

// User is a person who has authenticated to the control plane. UserID is the
// Clerk user id (sub); TenantID is their org (or their own sub for a solo user).
// Email/Name are reserved for later enrichment (a custom Clerk JWT template or a
// Clerk Backend API call) and are empty today. The users table also carries a
// free-form JSONB metadata column so the model can grow (preferences, flags,
// links to sandboxes/sessions/chats) without a schema change.
type User struct {
	UserID   string
	TenantID string
	Email    string
	Name     string
}

// UserStore records the humans who sign in. It is deliberately small and
// separate from cloud.Store (the session registry) so the control plane can
// extend user-scoped state — sandboxes already link back via
// cloud_sessions.created_by_user_id; sessions/chats can follow — without
// bleeding those concerns into the vendor-neutral cloud package.
type UserStore interface {
	UpsertUser(ctx context.Context, u User) error
}

// userUpsertInterval throttles the per-request upsert: a user's row is touched at
// most once per this window, so a client polling every few seconds does not write
// to Postgres on every request.
const userUpsertInterval = 5 * time.Minute

// recordUser best-effort records the authenticated user. It is throttled in
// memory (one upsert per user per userUpsertInterval) and runs off the request
// path in a goroutine, so it never blocks or fails a request. On a store error
// the throttle stamp is rolled back so the next request retries.
func (s *Server) recordUser(id Identity) {
	if s.users == nil || id.UserID == "" {
		return
	}
	now := time.Now()
	s.userSeenMu.Lock()
	if last, ok := s.userSeen[id.UserID]; ok && now.Sub(last) < userUpsertInterval {
		s.userSeenMu.Unlock()
		return
	}
	s.userSeen[id.UserID] = now
	s.userSeenMu.Unlock()

	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := s.users.UpsertUser(ctx, User{UserID: id.UserID, TenantID: id.Tenant}); err != nil {
			s.log.Warn("controlplane: upsert user failed", "err", err, "user", id.UserID)
			s.userSeenMu.Lock()
			delete(s.userSeen, id.UserID)
			s.userSeenMu.Unlock()
		}
	}()
}
