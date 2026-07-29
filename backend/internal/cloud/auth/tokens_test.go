package auth

import (
	"testing"
	"time"
)

func TestIssuerSessionTokenIsScopedClaim(t *testing.T) {
	issuer, err := NewIssuer(IssuerConfig{
		Secret: "test-secret",
		Now:    func() time.Time { return time.Unix(100, 0) },
	})
	if err != nil {
		t.Fatal(err)
	}
	token, expires, err := issuer.IssueSessionToken("org-1", "sess-1", time.Hour)
	if err != nil {
		t.Fatalf("IssueSessionToken: %v", err)
	}
	if want := time.Unix(100, 0).Add(time.Hour); !expires.Equal(want) {
		t.Fatalf("expires = %s, want %s", expires, want)
	}
	claims, err := issuer.VerifyAccessToken(token)
	if err != nil {
		t.Fatalf("VerifyAccessToken: %v", err)
	}
	if claims.SessionID != "sess-1" || claims.Subject != "session:sess-1" || len(claims.OrgIDs) != 1 || claims.OrgIDs[0] != "org-1" {
		t.Fatalf("claims = %#v", claims)
	}
}
