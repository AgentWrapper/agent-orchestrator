package pipeline

import (
	"context"
	"errors"
	"sort"
	"strings"
	"testing"
)

// memResolver is the in-memory CredentialResolver the tests run against: the
// real one reads the project's credential table (Task 15 wires it).
type memResolver struct {
	creds map[string]map[string]string
	err   error
}

func newMemResolver(creds map[string]map[string]string) *memResolver {
	return &memResolver{creds: creds}
}

func (r *memResolver) Resolve(_ context.Context, _ string, names []string) (map[string]string, error) {
	if r.err != nil {
		return nil, r.err
	}
	env := map[string]string{}
	for _, name := range names {
		got, ok := r.creds[name]
		if !ok {
			return nil, errors.New("unknown credential " + name)
		}
		for k, v := range got {
			env[k] = v
		}
	}
	return env, nil
}

func (r *memResolver) Exists(_ context.Context, _ string, name string) (bool, error) {
	if r.err != nil {
		return false, r.err
	}
	_, ok := r.creds[name]
	return ok, nil
}

func knownCredentials(names ...string) func(string) bool { return KnownCredentialSet(names) }

func credsPipeline(t *testing.T) *Pipeline {
	t.Helper()
	return mustParse(t, []byte(`
name: p
stages:
  - id: build
    executor: command
    run: make
    on_success: sign
  - id: sign
    executor: command
    run: make sign
    credentials: [apple-signing, notary]
`))
}

func TestValidateCredentials_UnknownNameFlagsTheExactPath(t *testing.T) {
	def := credsPipeline(t)
	resolver := newMemResolver(map[string]map[string]string{
		"apple-signing": {"AC_USER": "someone"},
	})

	err := ValidateCredentials(context.Background(), def, "proj", resolver)
	if err == nil {
		t.Fatal("expected an error for the unknown credential, got nil")
	}
	var verr *ValidationError
	if !errors.As(err, &verr) {
		t.Fatalf("error = %T (%v), want *ValidationError", err, err)
	}
	if len(verr.Issues) != 1 {
		t.Fatalf("issues = %v, want exactly one", verr.Issues)
	}
	// stages[1] is sign, credentials[1] is notary: the index pair is what the
	// editor highlights, so it has to point at the offending entry itself.
	if got, want := verr.Issues[0].Path, "stages[1].credentials[1]"; got != want {
		t.Errorf("path = %q, want %q", got, want)
	}
	if !strings.Contains(verr.Issues[0].Message, "notary") {
		t.Errorf("message = %q, want it to name the credential", verr.Issues[0].Message)
	}
}

// The starter templates declare credentials, so this message is the first thing
// a new user sees after clicking a template and saving. It has to be the fix,
// not just the diagnosis.
func TestValidateCredentials_UnknownNameNamesTheFixingCommand(t *testing.T) {
	def := credsPipeline(t)
	err := ValidateCredentials(context.Background(), def, "proj-7", newMemResolver(nil))

	var verr *ValidationError
	if !errors.As(err, &verr) {
		t.Fatalf("error = %T (%v), want *ValidationError", err, err)
	}
	msg := verr.Issues[0].Message
	for _, want := range []string{
		`unknown credential "apple-signing"`,
		"ao pipeline credential set apple-signing",
		"--project proj-7",
	} {
		if !strings.Contains(msg, want) {
			t.Errorf("message = %q, want it to contain %q", msg, want)
		}
	}
}

func TestValidateCredentials_EveryNameKnownIsClean(t *testing.T) {
	def := credsPipeline(t)
	resolver := newMemResolver(map[string]map[string]string{
		"apple-signing": {"AC_USER": "someone"},
		"notary":        {"AC_PASSWORD": "shh"},
	})

	if err := ValidateCredentials(context.Background(), def, "proj", resolver); err != nil {
		t.Fatalf("ValidateCredentials: %v", err)
	}
}

// The second pass is optional: the parser and the canvas editor validate
// without a store, and pure Validate stays dependency-free.
func TestValidateCredentials_NilResolverIsANoOp(t *testing.T) {
	if err := ValidateCredentials(context.Background(), credsPipeline(t), "proj", nil); err != nil {
		t.Fatalf("ValidateCredentials with no resolver: %v", err)
	}
}

// A store that cannot answer is not a validation finding: reporting "unknown
// credential" on a read failure would tell the author to fix a name that is
// fine.
func TestValidateCredentials_StoreErrorIsNotAValidationIssue(t *testing.T) {
	resolver := newMemResolver(nil)
	resolver.err = errors.New("database is locked")

	err := ValidateCredentials(context.Background(), credsPipeline(t), "proj", resolver)
	if err == nil {
		t.Fatal("expected the store error to surface, got nil")
	}
	var verr *ValidationError
	if errors.As(err, &verr) {
		t.Fatalf("store failure reported as a validation error: %v", err)
	}
	if !strings.Contains(err.Error(), "database is locked") {
		t.Errorf("error = %v, want it to wrap the store failure", err)
	}
}

func forkSubject(number int) Subject {
	s := prSubject(number)
	s.PR.FromFork = true
	return s
}

// D17, spec section 8: a fork PR never blocks the run, but it forces
// identity-only env. A stage that declared credentials would run without them,
// so the run fails at plan time with the reason stated instead.
func TestComputePlan_ForkPRWithACredentialsStageFails(t *testing.T) {
	def := credsPipeline(t)

	_, err := ComputePlan(def, forkSubject(412), nil)
	if err == nil {
		t.Fatal("expected ComputePlan to fail for a fork PR with a credentials stage, got nil")
	}
	for _, want := range []string{"sign", "fork", "identity-only", "PR #412"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error = %q, want it to mention %q", err.Error(), want)
		}
	}
}

func TestComputePlan_ForkPRWithoutCredentialsPlansFine(t *testing.T) {
	def := mustParse(t, []byte(`
name: p
stages:
  - id: build
    executor: command
    run: make
    on_success: review
  - id: review
    executor: agent
    agent: claude-code
    prompt: look at the diff
`))
	plan, err := ComputePlan(def, forkSubject(412), nil)
	if err != nil {
		t.Fatalf("ComputePlan: %v", err)
	}
	if len(plan.Reachable) != 2 {
		t.Errorf("reachable = %v, want both stages", plan.Reachable)
	}
}

// The rule is about the fork, not about credentials: the same pipeline on an
// in-repo PR runs with its credentials injected.
func TestComputePlan_SameRepoPRWithCredentialsPlansFine(t *testing.T) {
	def := credsPipeline(t)

	if _, err := ComputePlan(def, prSubject(412), knownCredentials("apple-signing", "notary")); err != nil {
		t.Fatalf("ComputePlan: %v", err)
	}
}

// An unreachable stage never runs, so it cannot make the plan fail.
func TestComputePlan_ForkPRIgnoresUnreachableCredentialsStages(t *testing.T) {
	def := mustParse(t, []byte(`
name: p
stages:
  - id: build
    executor: command
    run: make
  - id: orphan
    executor: command
    run: make sign
    credentials: [apple-signing]
`))
	if _, err := ComputePlan(def, forkSubject(412), nil); err != nil {
		t.Fatalf("ComputePlan: %v", err)
	}
}

// The name was known when the pipeline was saved and the credential was
// deleted since. Fail the run rather than run the stage with the variable
// missing from its environment.
func TestComputePlan_CredentialDeletedSinceSaveFails(t *testing.T) {
	def := credsPipeline(t)

	_, err := ComputePlan(def, prSubject(412), knownCredentials("apple-signing"))
	if err == nil {
		t.Fatal("expected ComputePlan to fail for the deleted credential, got nil")
	}
	for _, want := range []string{"sign", "notary"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error = %q, want it to mention %q", err.Error(), want)
		}
	}
}

func TestKnownCredentialSet(t *testing.T) {
	if KnownCredentialSet(nil) != nil {
		t.Error("KnownCredentialSet(nil) must stay nil: unknown is not the same as none")
	}
	known := KnownCredentialSet([]string{})
	if known == nil {
		t.Fatal("KnownCredentialSet of an empty slice must answer, not skip the check")
	}
	if known("apple-signing") {
		t.Error("a project with no credentials must know no names")
	}
	if known = KnownCredentialSet([]string{"apple-signing"}); !known("apple-signing") || known("notary") {
		t.Error("KnownCredentialSet does not answer its own set")
	}
}

// Resolve flattens every named credential's environment into one map, which is
// what a command stage's process env needs.
func TestResolverFlattensNamedEnvironments(t *testing.T) {
	resolver := newMemResolver(map[string]map[string]string{
		"apple-signing": {"AC_USER": "someone", "AC_TEAM": "J432"},
		"notary":        {"AC_PASSWORD": "shh"},
	})

	env, err := resolver.Resolve(context.Background(), "proj", []string{"apple-signing", "notary"})
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	keys := make([]string, 0, len(env))
	for k := range env {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	if strings.Join(keys, ",") != "AC_PASSWORD,AC_TEAM,AC_USER" {
		t.Errorf("flattened keys = %v, want every variable from both credentials", keys)
	}
}
