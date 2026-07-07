package httpd

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/mobilebridge"
)

func newAuthUnderTest(pw string, now func() time.Time) (http.Handler, *lockout) {
	st := &authState{}
	h := mobilebridge.HashPassword(pw)
	st.setHash(h)
	lock := newLockout(5, time.Minute, now)
	ok := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusOK) })
	return authMiddleware(st, lock)(ok), lock
}

func req(auth string) *http.Request {
	r := httptest.NewRequest(http.MethodGet, "/api/v1/sessions", nil)
	r.RemoteAddr = "192.168.1.50:5555"
	if auth != "" {
		r.Header.Set("Authorization", auth)
	}
	return r
}

func TestAuthRejectsMissingAndWrong(t *testing.T) {
	h, _ := newAuthUnderTest("secret12", time.Now)
	for _, tc := range []struct{ name, auth string; want int }{
		{"missing", "", http.StatusUnauthorized},
		{"wrong", "Bearer nope", http.StatusUnauthorized},
		{"right", "Bearer secret12", http.StatusOK},
	} {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, req(tc.auth))
		if w.Code != tc.want {
			t.Errorf("%s: got %d want %d", tc.name, w.Code, tc.want)
		}
	}
}

func TestAuthLockoutAfterFive(t *testing.T) {
	now := time.Now()
	h, _ := newAuthUnderTest("secret12", func() time.Time { return now })
	for i := 0; i < 5; i++ {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, req("Bearer wrong"))
		if w.Code != http.StatusUnauthorized {
			t.Fatalf("attempt %d: got %d want 401", i, w.Code)
		}
	}
	// 6th attempt — even with the RIGHT password — is locked out.
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req("Bearer secret12"))
	if w.Code != http.StatusTooManyRequests {
		t.Fatalf("locked attempt: got %d want 429", w.Code)
	}
}
