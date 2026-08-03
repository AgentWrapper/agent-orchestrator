package auth

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/lestrrat-go/jwx/v3/jwa"
	"github.com/lestrrat-go/jwx/v3/jwk"
	"github.com/lestrrat-go/jwx/v3/jwt"
)

func TestExternalJWTAuthenticatorVerifiesWorkOSJWTWithoutAudience(t *testing.T) {
	t.Parallel()
	privateKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("GenerateKey() error = %v", err)
	}
	signingKey, err := jwk.Import(privateKey)
	if err != nil {
		t.Fatalf("jwk.Import(private) error = %v", err)
	}
	if err := signingKey.Set(jwk.KeyIDKey, "test-key"); err != nil {
		t.Fatalf("Set(kid) error = %v", err)
	}
	if err := signingKey.Set(jwk.AlgorithmKey, jwa.RS256()); err != nil {
		t.Fatalf("Set(alg) error = %v", err)
	}
	publicKey, err := jwk.PublicKeyOf(signingKey)
	if err != nil {
		t.Fatalf("PublicKeyOf() error = %v", err)
	}
	keySet := jwk.NewSet()
	if err := keySet.AddKey(publicKey); err != nil {
		t.Fatalf("AddKey() error = %v", err)
	}
	jwksServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(keySet)
	}))
	t.Cleanup(jwksServer.Close)

	issuer := "https://auth.example.com"
	token, err := jwt.NewBuilder().
		Subject("workos-user-123").
		Issuer(issuer).
		IssuedAt(time.Now()).
		Expiration(time.Now().Add(time.Hour)).
		Claim("client_id", "client_123").
		Build()
	if err != nil {
		t.Fatalf("Build() error = %v", err)
	}
	signed, err := jwt.Sign(token, jwt.WithKey(jwa.RS256(), signingKey))
	if err != nil {
		t.Fatalf("Sign() error = %v", err)
	}
	authenticator, err := NewExternalJWTAuthenticator(ExternalJWTConfig{
		Provider: "workos",
		Issuer:   issuer,
		ClientID: "client_123",
		JWKSURL:  jwksServer.URL,
		ProfileResolver: func(context.Context, string) (ExternalProfile, error) {
			return ExternalProfile{
				Email:       "Person@Example.com",
				DisplayName: "Person",
			}, nil
		},
	})
	if err != nil {
		t.Fatalf("NewExternalJWTAuthenticator() error = %v", err)
	}

	principal, err := authenticator.Verify(context.Background(), string(signed))
	if err != nil {
		t.Fatalf("Verify() error = %v", err)
	}
	if principal.AuthProvider != "workos" || principal.ExternalUserID != "workos-user-123" {
		t.Fatalf("principal identity = %#v", principal)
	}
	if principal.Email != "person@example.com" || principal.DisplayName != "Person" {
		t.Fatalf("principal profile = %#v", principal)
	}
}

func TestExternalJWTAuthenticatorRejectsWrongAudience(t *testing.T) {
	t.Parallel()
	privateKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("GenerateKey() error = %v", err)
	}
	signingKey, err := jwk.Import(privateKey)
	if err != nil {
		t.Fatalf("jwk.Import(private) error = %v", err)
	}
	if err := signingKey.Set(jwk.KeyIDKey, "test-key"); err != nil {
		t.Fatalf("Set(kid) error = %v", err)
	}
	if err := signingKey.Set(jwk.AlgorithmKey, jwa.RS256()); err != nil {
		t.Fatalf("Set(alg) error = %v", err)
	}
	publicKey, err := jwk.PublicKeyOf(signingKey)
	if err != nil {
		t.Fatalf("PublicKeyOf() error = %v", err)
	}
	keySet := jwk.NewSet()
	if err := keySet.AddKey(publicKey); err != nil {
		t.Fatalf("AddKey() error = %v", err)
	}
	jwksServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(keySet)
	}))
	t.Cleanup(jwksServer.Close)

	token, err := jwt.NewBuilder().
		Subject("workos-user-123").
		Issuer("https://auth.example.com").
		Audience([]string{"https://wrong.example.com"}).
		IssuedAt(time.Now()).
		Expiration(time.Now().Add(time.Hour)).
		Build()
	if err != nil {
		t.Fatalf("Build() error = %v", err)
	}
	signed, err := jwt.Sign(token, jwt.WithKey(jwa.RS256(), signingKey))
	if err != nil {
		t.Fatalf("Sign() error = %v", err)
	}
	authenticator, err := NewExternalJWTAuthenticator(ExternalJWTConfig{
		Provider: "workos",
		Issuer:   "https://auth.example.com",
		Audience: "https://auth.example.com",
		JWKSURL:  jwksServer.URL,
	})
	if err != nil {
		t.Fatalf("NewExternalJWTAuthenticator() error = %v", err)
	}

	if _, err := authenticator.Verify(context.Background(), string(signed)); err == nil {
		t.Fatal("Verify() error = nil, want invalid audience")
	}
}

func TestExternalJWTAuthenticatorRejectsWrongWorkOSClientID(t *testing.T) {
	t.Parallel()
	privateKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("GenerateKey() error = %v", err)
	}
	signingKey, err := jwk.Import(privateKey)
	if err != nil {
		t.Fatalf("jwk.Import(private) error = %v", err)
	}
	if err := signingKey.Set(jwk.KeyIDKey, "test-key"); err != nil {
		t.Fatalf("Set(kid) error = %v", err)
	}
	if err := signingKey.Set(jwk.AlgorithmKey, jwa.RS256()); err != nil {
		t.Fatalf("Set(alg) error = %v", err)
	}
	publicKey, err := jwk.PublicKeyOf(signingKey)
	if err != nil {
		t.Fatalf("PublicKeyOf() error = %v", err)
	}
	keySet := jwk.NewSet()
	if err := keySet.AddKey(publicKey); err != nil {
		t.Fatalf("AddKey() error = %v", err)
	}
	jwksServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(keySet)
	}))
	t.Cleanup(jwksServer.Close)

	issuer := "https://api.workos.com"
	token, err := jwt.NewBuilder().
		Subject("workos-user-123").
		Issuer(issuer).
		IssuedAt(time.Now()).
		Expiration(time.Now().Add(time.Hour)).
		Claim("client_id", "client_wrong").
		Build()
	if err != nil {
		t.Fatalf("Build() error = %v", err)
	}
	signed, err := jwt.Sign(token, jwt.WithKey(jwa.RS256(), signingKey))
	if err != nil {
		t.Fatalf("Sign() error = %v", err)
	}
	authenticator, err := NewExternalJWTAuthenticator(ExternalJWTConfig{
		Provider: "workos",
		Issuer:   issuer,
		ClientID: "client_expected",
		JWKSURL:  jwksServer.URL,
	})
	if err != nil {
		t.Fatalf("NewExternalJWTAuthenticator() error = %v", err)
	}

	if _, err := authenticator.Verify(context.Background(), string(signed)); err == nil {
		t.Fatal("Verify() error = nil, want invalid client ID")
	}
}
