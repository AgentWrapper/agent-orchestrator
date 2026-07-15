package domain

import (
	"errors"
	"strings"
	"testing"
	"time"
)

func TestRecoveryRungForAttempt(t *testing.T) {
	cases := []struct {
		attempt int
		want    RecoveryRung
	}{
		{0, RecoveryRungWorker},
		{1, RecoveryRungWorker},
		{2, RecoveryRungOrc},
		{3, RecoveryRungPrime},
		{9, RecoveryRungPrime},
	}
	for _, tc := range cases {
		if got := RecoveryRungForAttempt(tc.attempt); got != tc.want {
			t.Fatalf("RecoveryRungForAttempt(%d) = %q, want %q", tc.attempt, got, tc.want)
		}
	}
}

func TestRecoveryFingerprintUsesIssueReasonAndFailurePoint(t *testing.T) {
	base := RecoveryFingerprint("ao", "github:o/r#321", "runtime probe reported dead", "activity=active;open_pr=none")
	if base == RecoveryFingerprint("ao", "github:o/r#322", "runtime probe reported dead", "activity=active;open_pr=none") {
		t.Fatal("fingerprint must vary by issue")
	}
	if base == RecoveryFingerprint("ao", "github:o/r#321", "killed via session kill", "activity=active;open_pr=none") {
		t.Fatal("fingerprint must vary by terminal reason")
	}
	if base == RecoveryFingerprint("ao", "github:o/r#321", "runtime probe reported dead", "activity=blocked;open_pr=none") {
		t.Fatal("fingerprint must vary by failure point")
	}
	if !strings.HasPrefix(base, "sha256:") {
		t.Fatalf("fingerprint = %q, want sha256 prefix", base)
	}
}

func TestRecoveryIncidentValidate(t *testing.T) {
	now := time.Now().UTC()
	rec := RecoveryIncident{
		ID:            "recovery_abc",
		ProjectID:     "ao",
		IssueID:       "github:o/r#321",
		Fingerprint:   "sha256:abc",
		Status:        RecoveryIncidentOpen,
		Rung:          RecoveryRungWorker,
		Attempt:       1,
		DeadSessionID: "ao-1",
		LastSessionID: "ao-1",
		CreatedAt:     now,
		UpdatedAt:     now,
	}
	if err := rec.Validate(); err != nil {
		t.Fatalf("valid incident rejected: %v", err)
	}
	rec.Attempt = 0
	if !errors.Is(rec.Validate(), ErrInvalidRecoveryIncident) {
		t.Fatal("attempt=0 accepted")
	}
	rec.Attempt = 1
	rec.Status = RecoveryIncidentResolved
	if !errors.Is(rec.Validate(), ErrInvalidRecoveryIncident) {
		t.Fatal("resolved incident without ResolvedAt accepted")
	}
}
