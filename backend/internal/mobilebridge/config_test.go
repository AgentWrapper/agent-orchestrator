package mobilebridge

import (
	"os"
	"path/filepath"
	"regexp"
	"testing"
)

func TestSaveLoadRoundTrip(t *testing.T) {
	dir := t.TempDir()
	p := Path(dir)
	want := State{Enabled: true, Password: "abc", LastPort: 3011}
	if err := Save(p, want); err != nil {
		t.Fatalf("save: %v", err)
	}
	got, err := Load(p)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if got != want {
		t.Fatalf("round trip: got %+v want %+v", got, want)
	}
	info, _ := os.Stat(p)
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("mode = %v want 0600", info.Mode().Perm())
	}
}

func TestLoadMissingIsZero(t *testing.T) {
	got, err := Load(filepath.Join(t.TempDir(), "mobile", "config.json"))
	if err != nil || got != (State{}) {
		t.Fatalf("missing file: got %+v err %v", got, err)
	}
}

func TestGeneratePasswordFormat(t *testing.T) {
	pw, err := GeneratePassword()
	if err != nil {
		t.Fatal(err)
	}
	if !regexp.MustCompile(`^[A-Za-z0-9]{8}$`).MatchString(pw) {
		t.Fatalf("password %q not 8 alnum", pw)
	}
}

func TestPasswordMatches(t *testing.T) {
	pw, _ := GeneratePassword()
	h := HashPassword(pw)
	if !PasswordMatches(h, pw) {
		t.Fatal("expected match")
	}
	if PasswordMatches(h, pw+"x") {
		t.Fatal("expected mismatch")
	}
}
