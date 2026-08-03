package githubapp

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"testing"
)

func TestVerifyWebhookSignature(t *testing.T) {
	secret := []byte("webhook-secret")
	payload := []byte(`{"action":"created","installation":{"id":42}}`)
	mac := hmac.New(sha256.New, secret)
	_, _ = mac.Write(payload)
	signature := "sha256=" + hex.EncodeToString(mac.Sum(nil))

	if !VerifyWebhookSignature(secret, payload, signature) {
		t.Fatal("valid signature was rejected")
	}
	if err := ValidateWebhookSignature(secret, payload, signature); err != nil {
		t.Fatalf("ValidateWebhookSignature: %v", err)
	}

	tests := []struct {
		name      string
		secret    []byte
		payload   []byte
		signature string
	}{
		{name: "changed body", secret: secret, payload: append(payload, '\n'), signature: signature},
		{name: "wrong secret", secret: []byte("other"), payload: payload, signature: signature},
		{name: "missing prefix", secret: secret, payload: payload, signature: signature[7:]},
		{name: "wrong algorithm", secret: secret, payload: payload, signature: "sha1=" + signature[7:]},
		{name: "invalid hex", secret: secret, payload: payload, signature: "sha256=not-hex"},
		{name: "short digest", secret: secret, payload: payload, signature: "sha256=00"},
		{name: "empty secret", payload: payload, signature: signature},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if VerifyWebhookSignature(test.secret, test.payload, test.signature) {
				t.Fatal("invalid signature was accepted")
			}
			if ValidateWebhookSignature(test.secret, test.payload, test.signature) == nil {
				t.Fatal("ValidateWebhookSignature unexpectedly succeeded")
			}
		})
	}
}
