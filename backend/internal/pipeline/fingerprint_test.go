package pipeline

import "testing"

func TestComputeFindingFingerprint(t *testing.T) {
	base := findingInput("x.go", "bug", "correctness", SeverityError)

	t.Run("stable and 16 hex chars", func(t *testing.T) {
		fp := computeFindingFingerprint(base, "review")
		if len(fp) != 16 {
			t.Fatalf("fingerprint length = %d, want 16", len(fp))
		}
		if fp != computeFindingFingerprint(base, "review") {
			t.Fatal("fingerprint should be deterministic")
		}
	})

	t.Run("stage name is part of the identity", func(t *testing.T) {
		if computeFindingFingerprint(base, "review") == computeFindingFingerprint(base, "lint") {
			t.Fatal("different stages must yield different fingerprints")
		}
	})

	t.Run("anchorSignature overrides the line-range anchor", func(t *testing.T) {
		withAnchor := base
		withAnchor.AnchorSignature = "func Foo"
		if computeFindingFingerprint(withAnchor, "review") == computeFindingFingerprint(base, "review") {
			t.Fatal("anchor signature should change the fingerprint")
		}
		// Same anchor signature is stable even if the line range shifts.
		moved := withAnchor
		moved.StartLine, moved.EndLine = 99, 120
		if computeFindingFingerprint(withAnchor, "review") != computeFindingFingerprint(moved, "review") {
			t.Fatal("anchor-based fingerprint should be stable across line moves")
		}
	})

	t.Run("materializeArtifact only fingerprints findings", func(t *testing.T) {
		jsonArt := materializeArtifact(ArtifactInput{Kind: ArtifactKindJSON}, "r1", "sr-a", "a", 0, testNow)
		if jsonArt.Fingerprint != "" {
			t.Fatal("JSON artifacts must not carry a fingerprint")
		}
		finding := materializeArtifact(base, "r1", "sr-a", "a", 0, testNow)
		if finding.Fingerprint == "" {
			t.Fatal("finding artifacts must carry a fingerprint")
		}
		if finding.ArtifactID != "sr-a-0" {
			t.Fatalf("artifactId = %v, want sr-a-0", finding.ArtifactID)
		}
	})
}
