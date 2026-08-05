package secrets

import (
	"bytes"
	"testing"
)

func TestCipherBindsSecretToAccountAndProvider(t *testing.T) {
	cipher, err := New([]byte("01234567890123456789012345678901"))
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	encrypted, nonce, err := cipher.Encrypt([]byte("daytona-key"), "account-one:daytona")
	if err != nil {
		t.Fatalf("Encrypt() error = %v", err)
	}
	plaintext, err := cipher.Decrypt(encrypted, nonce, "account-one:daytona")
	if err != nil {
		t.Fatalf("Decrypt() error = %v", err)
	}
	if !bytes.Equal(plaintext, []byte("daytona-key")) {
		t.Fatalf("plaintext = %q", plaintext)
	}
	if _, err := cipher.Decrypt(encrypted, nonce, "account-two:daytona"); err == nil {
		t.Fatal("Decrypt(wrong associated data) error = nil")
	}
}
