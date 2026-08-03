package githubapp

import (
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"strings"
	"sync"
	"testing"
	"time"
)

var (
	testKeyOnce sync.Once
	testKey     *rsa.PrivateKey
	testKeyErr  error
)

func testRSAKey(t *testing.T) (*rsa.PrivateKey, []byte) {
	t.Helper()
	testKeyOnce.Do(func() {
		testKey, testKeyErr = rsa.GenerateKey(rand.Reader, 2048)
	})
	if testKeyErr != nil {
		t.Fatalf("generate RSA key: %v", testKeyErr)
	}
	encoded := pem.EncodeToMemory(&pem.Block{
		Type:  "RSA PRIVATE KEY",
		Bytes: x509.MarshalPKCS1PrivateKey(testKey),
	})
	return testKey, encoded
}

func TestAppJWTClaimsAndSignature(t *testing.T) {
	key, encoded := testRSAKey(t)
	now := time.Date(2026, 8, 3, 12, 34, 56, 0, time.UTC)
	client, err := New(Config{
		ClientID:      "Iv1.client-id",
		PrivateKeyPEM: encoded,
		Now:           func() time.Time { return now },
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	token, err := client.AppJWT()
	if err != nil {
		t.Fatalf("AppJWT: %v", err)
	}
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		t.Fatalf("JWT has %d segments, want 3", len(parts))
	}

	var header map[string]string
	decodeJWTSegment(t, parts[0], &header)
	if header["alg"] != "RS256" || header["typ"] != "JWT" {
		t.Fatalf("unexpected JWT header: %#v", header)
	}
	var claims appJWTClaims
	decodeJWTSegment(t, parts[1], &claims)
	if claims.Issuer != "Iv1.client-id" {
		t.Fatalf("issuer = %q", claims.Issuer)
	}
	if claims.IssuedAt != now.Add(-time.Minute).Unix() {
		t.Fatalf("iat = %d, want %d", claims.IssuedAt, now.Add(-time.Minute).Unix())
	}
	if claims.ExpiresAt != now.Add(9*time.Minute).Unix() {
		t.Fatalf("exp = %d, want %d", claims.ExpiresAt, now.Add(9*time.Minute).Unix())
	}
	if lifetime := time.Duration(claims.ExpiresAt-claims.IssuedAt) * time.Second; lifetime > 10*time.Minute {
		t.Fatalf("JWT lifetime = %s, exceeds 10m", lifetime)
	}

	signature, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		t.Fatalf("decode signature: %v", err)
	}
	digest := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
	if err := rsa.VerifyPKCS1v15(&key.PublicKey, crypto.SHA256, digest[:], signature); err != nil {
		t.Fatalf("verify RS256 signature: %v", err)
	}
}

func TestParseRSAPrivateKeyPKCS8(t *testing.T) {
	key, _ := testRSAKey(t)
	der, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatalf("marshal PKCS#8: %v", err)
	}
	parsed, err := ParseRSAPrivateKey(pem.EncodeToMemory(&pem.Block{
		Type:  "PRIVATE KEY",
		Bytes: der,
	}))
	if err != nil {
		t.Fatalf("ParseRSAPrivateKey: %v", err)
	}
	if parsed.N.Cmp(key.N) != 0 {
		t.Fatal("parsed key modulus does not match")
	}
}

func TestParseRSAPrivateKeyRejectsMalformedPEM(t *testing.T) {
	if _, err := ParseRSAPrivateKey([]byte("not a private key")); err == nil {
		t.Fatal("ParseRSAPrivateKey unexpectedly succeeded")
	}
}

func decodeJWTSegment(t *testing.T, value string, output any) {
	t.Helper()
	decoded, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil {
		t.Fatalf("decode JWT segment: %v", err)
	}
	if err := json.Unmarshal(decoded, output); err != nil {
		t.Fatalf("unmarshal JWT segment: %v", err)
	}
}
