package auth

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
)

func TestDeviceApproveRequiresAccessTokenAndDerivesUser(t *testing.T) {
	issuer, err := NewIssuer(IssuerConfig{Secret: "test-secret", Issuer: "ao-cloud"})
	if err != nil {
		t.Fatalf("issuer: %v", err)
	}
	pair, err := issuer.Issue("user-real", []string{"org-1"})
	if err != nil {
		t.Fatalf("issue token: %v", err)
	}
	store := &fakeAuthStore{approveOK: true}
	handler := &Handler{Store: store, Issuer: issuer, Now: func() time.Time { return time.Unix(100, 0).UTC() }}
	router := chi.NewRouter()
	handler.Register(router)

	req := httptest.NewRequest(http.MethodPost, "/auth/device/approve", strings.NewReader(`{"userCode":"ABCD"}`))
	req.Header.Set("Content-Type", "application/json")
	resp := httptest.NewRecorder()
	router.ServeHTTP(resp, req)
	if resp.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated approve status = %d, want 401", resp.Code)
	}
	if store.approvedUserID != "" {
		t.Fatalf("unauthenticated approve reached store with user %q", store.approvedUserID)
	}

	req = httptest.NewRequest(http.MethodPost, "/auth/device/approve", strings.NewReader(`{"userId":"victim","userCode":"ABCD"}`))
	req.Header.Set("Authorization", "Bearer "+pair.AccessToken)
	req.Header.Set("Content-Type", "application/json")
	resp = httptest.NewRecorder()
	router.ServeHTTP(resp, req)
	if resp.Code != http.StatusBadRequest {
		t.Fatalf("approve with userId status = %d, want 400", resp.Code)
	}

	req = httptest.NewRequest(http.MethodPost, "/auth/device/approve", strings.NewReader(`{"userCode":"ABCD"}`))
	req.Header.Set("Authorization", "Bearer "+pair.AccessToken)
	req.Header.Set("Content-Type", "application/json")
	resp = httptest.NewRecorder()
	router.ServeHTTP(resp, req)
	if resp.Code != http.StatusNoContent {
		t.Fatalf("authenticated approve status = %d, want 204", resp.Code)
	}
	if store.approvedUserID != "user-real" {
		t.Fatalf("approved user = %q, want token subject", store.approvedUserID)
	}
	if store.approvedUserCode != "ABCD" {
		t.Fatalf("approved code = %q, want ABCD", store.approvedUserCode)
	}
}

func TestGoogleCallbackRequiresMatchingStateCookie(t *testing.T) {
	store := &fakeAuthStore{}
	handler := &Handler{
		Store:  store,
		Issuer: mustIssuer(t),
		Google: fakeGoogleProvider{},
	}
	router := chi.NewRouter()
	handler.Register(router)

	req := httptest.NewRequest(http.MethodGet, "/auth/google/callback?code=ok&state=missing", nil)
	resp := httptest.NewRecorder()
	router.ServeHTTP(resp, req)
	if resp.Code != http.StatusBadRequest {
		t.Fatalf("callback without state cookie status = %d, want 400", resp.Code)
	}
	if store.upserted {
		t.Fatalf("callback without valid state reached user upsert")
	}
}

func TestIssuerRejectsWrongAudience(t *testing.T) {
	issuerA, err := NewIssuer(IssuerConfig{Secret: "test-secret", Issuer: "ao-cloud", Audience: "ao-cloud"})
	if err != nil {
		t.Fatalf("issuer A: %v", err)
	}
	issuerB, err := NewIssuer(IssuerConfig{Secret: "test-secret", Issuer: "ao-cloud", Audience: "other-service"})
	if err != nil {
		t.Fatalf("issuer B: %v", err)
	}
	pair, err := issuerA.Issue("user-1", []string{"org-1"})
	if err != nil {
		t.Fatalf("issue token: %v", err)
	}
	if _, err := issuerB.VerifyAccessToken(pair.AccessToken); err == nil {
		t.Fatalf("wrong audience token verified successfully")
	}
}

func mustIssuer(t *testing.T) *Issuer {
	t.Helper()
	issuer, err := NewIssuer(IssuerConfig{Secret: "test-secret", Issuer: "ao-cloud"})
	if err != nil {
		t.Fatalf("issuer: %v", err)
	}
	return issuer
}

type fakeGoogleProvider struct{}

func (fakeGoogleProvider) AuthCodeURL(state string) string {
	return "/auth/google/callback?state=" + state
}
func (fakeGoogleProvider) Exchange(context.Context, string) (GoogleProfile, error) {
	return GoogleProfile{Subject: "google-1", Email: "a@example.com"}, nil
}

type fakeAuthStore struct {
	approveOK        bool
	approvedUserID   string
	approvedUserCode string
	upserted         bool
}

func (s *fakeAuthStore) UpsertGoogleUser(context.Context, GoogleProfile) (User, []Org, error) {
	s.upserted = true
	return User{ID: "user-1", Email: "a@example.com"}, []Org{{ID: "org-1", Name: "Org"}}, nil
}
func (s *fakeAuthStore) StoreRefreshToken(context.Context, APIToken) error { return nil }
func (s *fakeAuthStore) ConsumeRefreshToken(context.Context, string, time.Time) (User, []Org, bool, error) {
	return User{}, nil, false, nil
}
func (s *fakeAuthStore) CreateDeviceCode(context.Context, DeviceCode) error { return nil }
func (s *fakeAuthStore) ApproveDeviceCode(_ context.Context, userID, userCode string, _ time.Time) (bool, error) {
	s.approvedUserID = userID
	s.approvedUserCode = userCode
	return s.approveOK, nil
}
func (s *fakeAuthStore) PollDeviceCode(context.Context, string, time.Time) (DeviceCode, User, []Org, bool, error) {
	return DeviceCode{}, User{}, nil, false, nil
}
