package githubapp

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strings"
)

const webhookSignaturePrefix = "sha256="

// VerifyWebhookSignature verifies GitHub's HMAC-SHA256 signature over the
// exact raw webhook request bytes using a constant-time MAC comparison.
func VerifyWebhookSignature(secret, payload []byte, signature string) bool {
	if len(secret) == 0 || !strings.HasPrefix(signature, webhookSignaturePrefix) {
		return false
	}
	provided, err := hex.DecodeString(strings.TrimPrefix(signature, webhookSignaturePrefix))
	if err != nil || len(provided) != sha256.Size {
		return false
	}
	mac := hmac.New(sha256.New, secret)
	_, _ = mac.Write(payload)
	return hmac.Equal(mac.Sum(nil), provided)
}

// ValidateWebhookSignature is the error-returning form of
// VerifyWebhookSignature.
func ValidateWebhookSignature(secret, payload []byte, signature string) error {
	if !VerifyWebhookSignature(secret, payload, signature) {
		return errors.New("invalid GitHub webhook signature")
	}
	return nil
}
