package scm

import "testing"

// forkFromRepos derives the pr.is_from_fork tri-state the SCM observer persists:
// a PR whose head repo differs from the base repo is from a fork; an unknown
// repo on either side is fail-safe unknown (nil).
func TestForkFromRepos(t *testing.T) {
	cases := []struct {
		name       string
		base, head string
		want       *bool
	}{
		{"same repo is not a fork", "owner/repo", "owner/repo", boolp(false)},
		{"different head repo is a fork", "owner/repo", "contributor/repo", boolp(true)},
		{"case-insensitive same repo", "Owner/Repo", "owner/repo", boolp(false)},
		{"unknown base repo is unknown", "", "contributor/repo", nil},
		{"unknown head repo is unknown", "owner/repo", "", nil},
		{"both unknown is unknown", "", "", nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := forkFromRepos(tc.base, tc.head)
			switch {
			case tc.want == nil && got != nil:
				t.Fatalf("forkFromRepos(%q,%q) = %v, want nil (unknown)", tc.base, tc.head, *got)
			case tc.want != nil && got == nil:
				t.Fatalf("forkFromRepos(%q,%q) = nil, want %v", tc.base, tc.head, *tc.want)
			case tc.want != nil && got != nil && *got != *tc.want:
				t.Fatalf("forkFromRepos(%q,%q) = %v, want %v", tc.base, tc.head, *got, *tc.want)
			}
		})
	}
}

func boolp(v bool) *bool { return &v }
