package project

import (
	"os/exec"
	"testing"
)

func TestIsGitRepoRecognizesRepositoryRoot(t *testing.T) {
	dir := t.TempDir()
	if out, err := exec.Command("git", "init", "-b", "main", dir).CombinedOutput(); err != nil {
		t.Fatalf("git init: %v (%s)", err, out)
	}
	if out, err := exec.Command("git", "-C", dir, "-c", "user.email=ao@example.com", "-c", "user.name=AO Test", "commit", "--allow-empty", "-m", "initial").CombinedOutput(); err != nil {
		t.Fatalf("git commit: %v (%s)", err, out)
	}

	if !isGitRepo(dir) {
		t.Fatalf("isGitRepo(%q) = false, want true", dir)
	}
}
