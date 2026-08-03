package postgres

import "testing"

func TestNormalizeShareEmail(t *testing.T) {
	got, err := normalizeShareEmail(" Reader@Example.COM ")
	if err != nil {
		t.Fatalf("normalizeShareEmail() error = %v", err)
	}
	if got != "reader@example.com" {
		t.Fatalf("normalizeShareEmail() = %q, want reader@example.com", got)
	}

	for _, value := range []string{"", "not-an-email", "Name <reader@example.com>"} {
		if _, err := normalizeShareEmail(value); err != ErrProjectShareInvalidRecipient {
			t.Fatalf("normalizeShareEmail(%q) error = %v, want ErrProjectShareInvalidRecipient", value, err)
		}
	}
}
