package trackerintake

import (
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

func TestIssueTrackerID(t *testing.T) {
	originOnly := domain.ProjectRecord{ID: "ao", RepoOriginURL: "git@github.com:acme/demo.git"}
	configured := domain.ProjectRecord{
		ID:            "ao",
		RepoOriginURL: "git@github.com:acme/demo.git",
		Config:        domain.ProjectConfig{TrackerIntake: domain.TrackerIntakeConfig{Enabled: true, Repo: "acme/other"}},
	}

	for _, tc := range []struct {
		name    string
		project domain.ProjectRecord
		issue   domain.IssueID
		want    domain.TrackerID
		wantOK  bool
	}{{
		name:    "canonical id round-trips",
		project: originOnly,
		issue:   "github:acme/demo#146",
		want:    domain.TrackerID{Provider: domain.TrackerProviderGitHub, Native: "acme/demo#146"},
		wantOK:  true,
	}, {
		// `ao spawn --issue 146` — a bare number only means something relative
		// to the project's repo.
		name:    "bare number resolves against the git origin",
		project: originOnly,
		issue:   "146",
		want:    domain.TrackerID{Provider: domain.TrackerProviderGitHub, Native: "acme/demo#146"},
		wantOK:  true,
	}, {
		name:    "bare number prefers the configured intake repo over the origin",
		project: configured,
		issue:   "146",
		want:    domain.TrackerID{Provider: domain.TrackerProviderGitHub, Native: "acme/other#146"},
		wantOK:  true,
	}, {
		name:    "hash-prefixed number is accepted",
		project: originOnly,
		issue:   "#146",
		want:    domain.TrackerID{Provider: domain.TrackerProviderGitHub, Native: "acme/demo#146"},
		wantOK:  true,
	}, {
		name:    "empty id is unmappable",
		project: originOnly,
		issue:   "",
		wantOK:  false,
	}, {
		// A URL has a colon but is not `provider:native`; misreading it would
		// send "https" to the tracker as a provider.
		name:    "url is not mistaken for a canonical id",
		project: originOnly,
		issue:   "https://github.com/acme/demo/issues/146",
		wantOK:  false,
	}, {
		name:    "unknown provider is rejected",
		project: originOnly,
		issue:   "jira:PROJ-1",
		wantOK:  false,
	}, {
		name:    "non-numeric bare id is rejected",
		project: originOnly,
		issue:   "some-bead-id",
		wantOK:  false,
	}, {
		name:    "bare number without a resolvable repo is unmappable",
		project: domain.ProjectRecord{ID: "ao"},
		issue:   "146",
		wantOK:  false,
	}} {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := IssueTrackerID(tc.project, tc.issue)
			if ok != tc.wantOK {
				t.Fatalf("ok = %v, want %v (got %#v)", ok, tc.wantOK, got)
			}
			if ok && got != tc.want {
				t.Fatalf("IssueTrackerID = %#v, want %#v", got, tc.want)
			}
		})
	}
}

// The canonical id produced at intake must map straight back to the tracker id
// it came from, or a re-fetch would silently target the wrong issue.
func TestIssueTrackerIDInvertsCanonicalIssueID(t *testing.T) {
	original := domain.TrackerID{Provider: domain.TrackerProviderGitHub, Native: "acme/demo#146"}
	roundTripped, ok := IssueTrackerID(domain.ProjectRecord{ID: "ao"}, CanonicalIssueID(original))
	if !ok {
		t.Fatal("canonical issue id did not map back to a tracker id")
	}
	if roundTripped != original {
		t.Fatalf("round trip = %#v, want %#v", roundTripped, original)
	}
}
