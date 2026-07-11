package cli

import (
	"fmt"

	"github.com/spf13/cobra"

	"github.com/aoagents/agent-orchestrator/backend/internal/buildinfo"
)

// Version, Commit, and Date are backward-compatibility aliases for the build
// metadata that release tooling historically stamped with
// `-ldflags "-X .../backend/internal/cli.Version=v1.2.3"`. The canonical
// symbols now live in the buildinfo package; these forward any values an
// existing release invocation still stamps here into buildinfo so such builds
// keep reporting their release metadata. New tooling should target buildinfo
// directly. Left unset, they defer entirely to buildinfo's own defaults and the
// toolchain-embedded VCS data.
var (
	Version = ""
	Commit  = ""
	Date    = ""
)

// init forwards any release-time ldflags overrides stamped on the legacy cli.*
// symbols into buildinfo, so both the old and new -X targets resolve to the
// same reported provenance.
func init() {
	if Version != "" {
		buildinfo.Version = Version
	}
	if Commit != "" {
		buildinfo.Commit = Commit
	}
	if Date != "" {
		buildinfo.Date = Date
	}
}

// VersionString renders the resolved build metadata as a single human-readable
// line, e.g. "dev commit abc1234 (dirty) built 2026-07-09T12:00:00Z". The
// revision, build time, and dirty flag come from the toolchain-embedded VCS
// data (debug.ReadBuildInfo) so an ordinary `go build` reports the real commit
// instead of a bare "dev"; release tooling can still override the version via
// buildinfo's (or the legacy cli.*) ldflags variables.
func VersionString() string {
	return buildinfo.Read().String()
}

func newVersionCommand() *cobra.Command {
	var asJSON bool
	cmd := &cobra.Command{
		Use:   "version",
		Short: "Print version information",
		Args:  noArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			info := buildinfo.Read()
			if asJSON {
				return writeJSON(cmd.OutOrStdout(), info)
			}
			_, err := fmt.Fprintln(cmd.OutOrStdout(), info.String())
			return err
		},
	}
	cmd.Flags().BoolVar(&asJSON, "json", false, "Output version information as JSON")
	return cmd
}
