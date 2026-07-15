package domain

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strings"
	"time"
)

// RecoveryIncidentStatus is the durable state of a worker-death recovery loop.
type RecoveryIncidentStatus string

const (
	// RecoveryIncidentOpen means the failure needs diagnosis or a new fix.
	RecoveryIncidentOpen RecoveryIncidentStatus = "open"
	// RecoveryIncidentVerifying means a fix has been recorded and a worker is proving it.
	RecoveryIncidentVerifying RecoveryIncidentStatus = "verifying"
	// RecoveryIncidentResolved means the recovery loop completed successfully.
	RecoveryIncidentResolved RecoveryIncidentStatus = "resolved"
)

// Valid reports whether s is a known recovery incident status.
func (s RecoveryIncidentStatus) Valid() bool {
	switch s {
	case RecoveryIncidentOpen, RecoveryIncidentVerifying, RecoveryIncidentResolved:
		return true
	default:
		return false
	}
}

// RecoveryRung describes which fleet hierarchy level owns the current
// investigation pass.
type RecoveryRung string

const (
	// RecoveryRungWorker assigns the current diagnosis pass to a worker.
	RecoveryRungWorker RecoveryRung = "worker"
	// RecoveryRungOrc escalates repeat failures to the project orchestrator.
	RecoveryRungOrc RecoveryRung = "orc"
	// RecoveryRungPrime escalates persistent failures to prime.
	RecoveryRungPrime RecoveryRung = "prime"
)

// Valid reports whether r is a known recovery escalation rung.
func (r RecoveryRung) Valid() bool {
	switch r {
	case RecoveryRungWorker, RecoveryRungOrc, RecoveryRungPrime:
		return true
	default:
		return false
	}
}

// RecoveryRungForAttempt escalates repeated same-fingerprint deaths through the
// fleet hierarchy.
func RecoveryRungForAttempt(attempt int) RecoveryRung {
	switch {
	case attempt <= 1:
		return RecoveryRungWorker
	case attempt == 2:
		return RecoveryRungOrc
	default:
		return RecoveryRungPrime
	}
}

// RecoveryIncident is the durable record for diagnosing and verifying one
// worker-death failure fingerprint.
type RecoveryIncident struct {
	ID                     string
	ProjectID              ProjectID
	IssueID                IssueID
	Fingerprint            string
	Status                 RecoveryIncidentStatus
	Rung                   RecoveryRung
	Attempt                int
	DeadSessionID          SessionID
	LastSessionID          SessionID
	TerminalFailureReason  string
	FailurePoint           string
	OpenPRURL              string
	FixReference           string
	LastFailedFixReference string
	VerificationSessionID  SessionID
	Diagnosis              string
	CreatedAt              time.Time
	UpdatedAt              time.Time
	ResolvedAt             time.Time
}

// ErrInvalidRecoveryIncident reports malformed recovery incident state.
var ErrInvalidRecoveryIncident = errors.New("invalid recovery incident")

// Validate checks the required fields and enum values for persistence.
func (r RecoveryIncident) Validate() error {
	if r.ID == "" || r.ProjectID == "" || r.IssueID == "" || r.Fingerprint == "" ||
		r.DeadSessionID == "" || r.LastSessionID == "" || r.CreatedAt.IsZero() || r.UpdatedAt.IsZero() {
		return ErrInvalidRecoveryIncident
	}
	if !r.Status.Valid() || !r.Rung.Valid() || r.Attempt < 1 {
		return ErrInvalidRecoveryIncident
	}
	if r.Status == RecoveryIncidentResolved && r.ResolvedAt.IsZero() {
		return ErrInvalidRecoveryIncident
	}
	return nil
}

// RecoveryFailurePoint returns the v1 structured failure-point marker used in
// repeat-death fingerprints. It intentionally uses bounded metadata only.
func RecoveryFailurePoint(sess SessionRecord, openPRURL string) string {
	parts := []string{
		"activity=" + string(sess.Activity.State),
	}
	if strings.TrimSpace(openPRURL) != "" {
		parts = append(parts, "open_pr="+strings.TrimSpace(openPRURL))
	} else {
		parts = append(parts, "open_pr=none")
	}
	return strings.Join(parts, ";")
}

// RecoveryFingerprint identifies a repeat death for one issue without storing
// raw logs or terminal output.
func RecoveryFingerprint(projectID ProjectID, issueID IssueID, terminalFailureReason, failurePoint string) string {
	canonical := strings.Join([]string{
		string(projectID),
		string(issueID),
		strings.TrimSpace(terminalFailureReason),
		strings.TrimSpace(failurePoint),
	}, "\x00")
	sum := sha256.Sum256([]byte(canonical))
	return "sha256:" + hex.EncodeToString(sum[:])
}

// RecoveryIncidentID derives a stable id for one created incident generation.
// Unresolved dedupe is enforced by fingerprint; the dead session keeps a later
// post-resolution generation from colliding with the old primary key.
func RecoveryIncidentID(projectID ProjectID, issueID IssueID, fingerprint string, deadSessionID SessionID) string {
	canonical := strings.Join([]string{string(projectID), string(issueID), strings.TrimSpace(fingerprint), string(deadSessionID)}, "\x00")
	sum := sha256.Sum256([]byte(canonical))
	return "recovery_" + hex.EncodeToString(sum[:12])
}
