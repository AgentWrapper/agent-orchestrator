package buildinfo

import "testing"

func TestInfoStringOmitsUnknownParts(t *testing.T) {
	cases := []struct {
		name string
		info Info
		want string
	}{
		{
			name: "version only",
			info: Info{Version: "dev"},
			want: "dev",
		},
		{
			name: "version and revision",
			info: Info{Version: "dev", Revision: "abc123"},
			want: "dev commit abc123",
		},
		{
			name: "dirty marker after commit",
			info: Info{Version: "dev", Revision: "abc123", Modified: true},
			want: "dev commit abc123 (dirty)",
		},
		{
			name: "full line",
			info: Info{Version: "v1.2.3", Revision: "abc123", Modified: false, Time: "2026-07-09T12:00:00Z"},
			want: "v1.2.3 commit abc123 built 2026-07-09T12:00:00Z",
		},
		{
			name: "dirty with time",
			info: Info{Version: "dev", Revision: "abc123", Modified: true, Time: "2026-07-09T12:00:00Z"},
			want: "dev commit abc123 (dirty) built 2026-07-09T12:00:00Z",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := tc.info.String(); got != tc.want {
				t.Errorf("String() = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestReadIsPopulatedFromBuildInfo(t *testing.T) {
	// `go test` compiles a test binary with embedded build info, so Read()
	// should at minimum report the Go toolchain version and a non-empty
	// version string. It must never panic or return a zero-value Version.
	info := Read()
	if info.Version == "" {
		t.Error("Read().Version is empty; want at least the default")
	}
	if info.GoVersion == "" {
		t.Error("Read().GoVersion is empty; expected the embedded toolchain version")
	}
}

func TestReadPrefersLdflagsOverridesOverEmbedded(t *testing.T) {
	// Simulate a release build where tooling stamped the version/commit/date
	// via -ldflags. The explicit overrides must win over the toolchain-embedded
	// VCS data so release binaries keep their stamped provenance.
	origVersion, origCommit, origDate := Version, Commit, Date
	t.Cleanup(func() { Version, Commit, Date = origVersion, origCommit, origDate })

	Version = "v9.9.9"
	Commit = "deadbeef"
	Date = "2020-01-01T00:00:00Z"

	info := Read()
	if info.Version != "v9.9.9" {
		t.Errorf("Version = %q, want the ldflags override v9.9.9", info.Version)
	}
	if info.Revision != "deadbeef" {
		t.Errorf("Revision = %q, want the ldflags override deadbeef", info.Revision)
	}
	if info.Time != "2020-01-01T00:00:00Z" {
		t.Errorf("Time = %q, want the ldflags override", info.Time)
	}
}
