// Package buildinfo exposes the daemon/CLI build provenance so operators can
// tell exactly which commit is running. It reads Go's embedded build info
// (debug.ReadBuildInfo) — the VCS revision, commit time, and dirty flag the
// toolchain stamps into every module build — and layers release-time ldflags
// overrides on top. No ldflags plumbing is required for the revision/time/
// dirty data: `go build` records it automatically.
package buildinfo

import (
	"runtime/debug"
	"strings"
)

// Release tooling can override these with
// -ldflags "-X github.com/aoagents/agent-orchestrator/backend/internal/buildinfo.Version=v1.2.3".
// When unset, Read() falls back to the toolchain-embedded VCS data so an
// ordinary `go build` still reports a real revision instead of "dev".
var (
	Version = "dev"
	Commit  = ""
	Date    = ""
)

// Info is the resolved build provenance, shared by the `ao version` command,
// `ao status`, and the /api/v1/version endpoint so every surface reports the
// same thing.
type Info struct {
	// Version is the release version string, or "dev" for untagged builds.
	Version string `json:"version"`
	// Revision is the VCS commit the binary was built from, when known.
	Revision string `json:"revision,omitempty"`
	// Time is the commit timestamp (RFC3339) recorded by the VCS, when known.
	Time string `json:"time,omitempty"`
	// Modified is true when the binary was built from a dirty working tree
	// (uncommitted changes). A true value means the running revision does not
	// fully describe the code on disk.
	Modified bool `json:"modified"`
	// GoVersion is the toolchain that produced the binary, when known.
	GoVersion string `json:"goVersion,omitempty"`
}

// Read resolves the build provenance. Explicit ldflags overrides win over the
// embedded VCS data; otherwise it reads debug.ReadBuildInfo(). It never panics
// and degrades gracefully when build info is unavailable (e.g. `go run`, a
// stripped binary, or a build outside a VCS checkout): the returned Info still
// carries at least the Version string.
func Read() Info {
	info := Info{
		Version:  Version,
		Revision: Commit,
		Time:     Date,
	}

	bi, ok := debug.ReadBuildInfo()
	if !ok {
		return info
	}
	info.GoVersion = bi.GoVersion

	// A release-tagged module version is more meaningful than the "dev"
	// default, so adopt it when the ldflags override was left unset.
	if info.Version == "dev" && bi.Main.Version != "" && bi.Main.Version != "(devel)" {
		info.Version = bi.Main.Version
	}

	for _, s := range bi.Settings {
		switch s.Key {
		case "vcs.revision":
			// Only fall back to the embedded revision when no ldflags
			// override was supplied, so release builds keep their stamped
			// commit.
			if info.Revision == "" {
				info.Revision = s.Value
			}
		case "vcs.time":
			if info.Time == "" {
				info.Time = s.Value
			}
		case "vcs.modified":
			info.Modified = s.Value == "true"
		}
	}

	return info
}

// String renders the build metadata as a single human-readable line, e.g.
// "dev commit abc1234 (dirty) built 2026-07-09T12:00:00Z". Unknown parts are
// omitted. It preserves the historical shape of `ao version` output (version
// first, then "commit <c>", then "built <d>") so existing consumers keep
// working, adding a "(dirty)" marker after the commit when the tree was dirty.
func (i Info) String() string {
	parts := []string{i.Version}
	if i.Revision != "" {
		parts = append(parts, "commit "+i.Revision)
	}
	if i.Modified {
		parts = append(parts, "(dirty)")
	}
	if i.Time != "" {
		parts = append(parts, "built "+i.Time)
	}
	return strings.Join(parts, " ")
}
