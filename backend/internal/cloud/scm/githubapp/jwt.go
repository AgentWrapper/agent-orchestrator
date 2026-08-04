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
	"errors"
	"fmt"
	"time"
)

const (
	appJWTIssuedAtSkew = time.Minute
	appJWTLifetime     = 9 * time.Minute
)

// ParseRSAPrivateKey parses an unencrypted PKCS#1 or PKCS#8 PEM private key.
func ParseRSAPrivateKey(value []byte) (*rsa.PrivateKey, error) {
	block, _ := pem.Decode(value)
	if block == nil {
		return nil, errors.New("GitHub App private key is not PEM encoded")
	}

	var key *rsa.PrivateKey
	switch block.Type {
	case "RSA PRIVATE KEY":
		parsed, err := x509.ParsePKCS1PrivateKey(block.Bytes)
		if err != nil {
			return nil, fmt.Errorf("parse GitHub App PKCS#1 private key: %w", err)
		}
		key = parsed
	case "PRIVATE KEY":
		parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
		if err != nil {
			return nil, fmt.Errorf("parse GitHub App PKCS#8 private key: %w", err)
		}
		var ok bool
		key, ok = parsed.(*rsa.PrivateKey)
		if !ok {
			return nil, errors.New("GitHub App private key is not RSA")
		}
	case "ENCRYPTED PRIVATE KEY":
		return nil, errors.New("encrypted GitHub App private keys are not supported")
	default:
		return nil, fmt.Errorf("unsupported GitHub App private key PEM type %q", block.Type)
	}
	if err := key.Validate(); err != nil {
		return nil, fmt.Errorf("validate GitHub App RSA private key: %w", err)
	}
	key.Precompute()
	return key, nil
}

// AppJWT returns a newly signed, short-lived RS256 JWT for App-authenticated
// GitHub API operations.
func (c *Client) AppJWT() (string, error) {
	now := c.now().UTC()
	claims := appJWTClaims{
		IssuedAt:  now.Add(-appJWTIssuedAtSkew).Unix(),
		ExpiresAt: now.Add(appJWTLifetime).Unix(),
		Issuer:    c.appID,
	}
	return signJWT(c.privateKey, claims)
}

type appJWTClaims struct {
	IssuedAt  int64 `json:"iat"`
	ExpiresAt int64 `json:"exp"`
	Issuer    int64 `json:"iss"`
}

func signJWT(key *rsa.PrivateKey, claims appJWTClaims) (string, error) {
	header, err := json.Marshal(struct {
		Algorithm string `json:"alg"`
		Type      string `json:"typ"`
	}{
		Algorithm: "RS256",
		Type:      "JWT",
	})
	if err != nil {
		return "", fmt.Errorf("encode GitHub App JWT header: %w", err)
	}
	payload, err := json.Marshal(claims)
	if err != nil {
		return "", fmt.Errorf("encode GitHub App JWT claims: %w", err)
	}

	encoding := base64.RawURLEncoding
	unsigned := encoding.EncodeToString(header) + "." + encoding.EncodeToString(payload)
	digest := sha256.Sum256([]byte(unsigned))
	signature, err := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, digest[:])
	if err != nil {
		return "", fmt.Errorf("sign GitHub App JWT: %w", err)
	}
	return unsigned + "." + encoding.EncodeToString(signature), nil
}
