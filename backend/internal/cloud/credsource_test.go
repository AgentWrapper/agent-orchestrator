package cloud

import (
	"os"
	"testing"
)

func TestResolveLocalCredential_EnvVar(t *testing.T) {
	const key = "AO_TEST_CRED_ENV"
	t.Setenv(key, `{"token":"abc"}`)
	pf := PortedFile{Local: []CredSource{{EnvVar: key}}}
	b, ok := resolveLocalCredential(pf)
	if !ok {
		t.Fatal("expected the env-var credential to resolve")
	}
	if string(b) != `{"token":"abc"}` {
		t.Fatalf("env cred = %q, want the raw value", string(b))
	}
}

func TestResolveLocalCredential_EnvVarUnsetFallsThrough(t *testing.T) {
	// Unset env source must not resolve; the resolver should move on (on the
	// local daemon this falls through to the $HOME file / Keychain sources).
	pf := PortedFile{Local: []CredSource{{EnvVar: "AO_TEST_CRED_DEFINITELY_UNSET"}}}
	if _, ok := resolveLocalCredential(pf); ok {
		t.Fatal("unset env var must not resolve a credential")
	}
	_ = os.Getenv // keep os import if the file evolves
}
