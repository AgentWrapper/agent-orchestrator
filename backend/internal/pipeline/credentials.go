package pipeline

import (
	"context"
	"fmt"
)

// CredentialResolver is the daemon's view of a project's engine-held
// credentials (decision D13, spec section 8).
//
// Values live only in the daemon and only ever reach a command stage's process
// env at exec time. Nothing here echoes a value back to a user, a log line or
// an agent: Exists answers by name, and Resolve's result goes straight into a
// process environment.
type CredentialResolver interface {
	// Resolve returns the flattened environment of every named credential, in
	// order, so a later name wins a key collision. An unknown name is an
	// error: a stage that asked for a credential must never run without it.
	Resolve(ctx context.Context, projectID string, names []string) (map[string]string, error)
	// Exists reports whether the project declares a credential by that name.
	Exists(ctx context.Context, projectID, name string) (bool, error)
}

// ValidateCredentials is the resolver-dependent second validation pass: it
// rejects a credential name the project does not declare (spec section 13),
// pointing at "stages[i].credentials[j]".
//
// It is deliberately not part of Validate. Validate stays dependency-free so
// the parser and the canvas editor can call it without a store; the save path
// runs this pass after it, with the project's resolver in hand. A nil resolver
// is a no-op, which is what makes the pass optional.
//
// A store failure comes back as an ordinary error, not a *ValidationError:
// "unknown credential" on a failed read would tell the author to fix a name
// that is fine.
//
// The message names the exact command that fixes it. Two of the three starter
// templates declare credentials, so this error is the first thing a new user
// sees after clicking a template; a bare "unknown credential" there reads as
// the feature being broken rather than as one command being missing.
func ValidateCredentials(ctx context.Context, p *Pipeline, projectID string, r CredentialResolver) error {
	if r == nil || p == nil {
		return nil
	}
	var issues []Issue
	for i := range p.Stages {
		s := &p.Stages[i]
		for j, name := range s.Credentials {
			ok, err := r.Exists(ctx, projectID, name)
			if err != nil {
				return fmt.Errorf("check credential %q for project %s: %w", name, projectID, err)
			}
			if ok {
				continue
			}
			issues = append(issues, Issue{
				Path:    fmt.Sprintf("stages[%d].credentials[%d]", i, j),
				Message: unknownCredentialMessage(name, projectID),
			})
		}
	}
	if len(issues) > 0 {
		return &ValidationError{Issues: issues}
	}
	return nil
}

// unknownCredentialMessage spells the one command that turns this error into a
// working pipeline. KEY=VALUE stays a placeholder because only the author knows
// which environment variable the stage's script reads.
func unknownCredentialMessage(name, projectID string) string {
	cmd := fmt.Sprintf("ao pipeline credential set %s KEY=VALUE", name)
	if projectID != "" {
		cmd += " --project " + projectID
	}
	return fmt.Sprintf("unknown credential %q; create it with: %s", name, cmd)
}

// KnownCredentialSet turns the project's declared credential names into the
// predicate ComputePlan takes.
//
// A nil slice returns a nil predicate, which tells ComputePlan to skip the
// check: "the caller has no credential store" is not the same answer as "the
// project declares nothing", and only the second one may fail a run.
func KnownCredentialSet(names []string) func(string) bool {
	if names == nil {
		return nil
	}
	set := make(map[string]bool, len(names))
	for _, name := range names {
		set[name] = true
	}
	return func(name string) bool { return set[name] }
}

// checkCredentials applies both plan-time credential rules to one reachable
// stage. Reachability is the caller's business: a stage that never runs can
// never fail the plan.
//
// The rules are written executor-agnostic on purpose. Only a command stage can
// legitimately declare credentials (Validate rejects them on an agent stage and
// the schema forbids them), so an agent stage carrying one here means the
// definition is already invalid, and failing the run is the safe answer.
func checkCredentials(s *Stage, subject Subject, knownCreds func(string) bool) error {
	if len(s.Credentials) == 0 {
		return nil
	}

	// D17, spec section 8: a fork PR never blocks the run, but it forces
	// identity-only env, because PR contents are untrusted input to an LLM
	// with shell access. A stage that declared credentials would run without
	// them, so state the reason and fail instead of quietly dropping them.
	if subject.FromForkPR() {
		return fmt.Errorf("stage '%s' declares credentials %v, and %s is from a fork: fork PRs run identity-only, so no credential is injected anywhere in the run",
			s.ID, s.Credentials, subject.describe())
	}

	if knownCreds == nil {
		return nil
	}
	for _, name := range s.Credentials {
		if !knownCreds(name) {
			return fmt.Errorf("stage '%s' declares credential %q, which this project does not define", s.ID, name)
		}
	}
	return nil
}
