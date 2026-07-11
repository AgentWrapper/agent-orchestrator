package cli

import (
	"fmt"
	"net/url"
	"strings"

	"github.com/spf13/cobra"
)

// fleetStatusResult is the { paused } body of the fleet endpoints.
type fleetStatusResult struct {
	Paused bool `json:"paused"`
}

func newPauseCommand(ctx *commandContext) *cobra.Command {
	var all, hard bool
	cmd := &cobra.Command{
		Use:   "pause [project]",
		Short: "Pause a project (or the whole fleet with --all): stop dispatching new work",
		Long: "Pause stops the fleet from dispatching new work. In-flight workers keep " +
			"running to completion; intake and new spawns are gated. Config is left " +
			"untouched, so `ao resume` restores the prior behavior exactly.\n\n" +
			"Pass a project id to pause one project, or --all to pause the whole fleet " +
			"(a distinct global flag, so a project registered while paused starts paused).\n\n" +
			"--hard terminates the project's live workers immediately instead of " +
			"draining; --hard --all also terminates orchestrators (emergency stop).",
		Args: pauseTargetArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			return runPauseResume(ctx, cmd, args, all, true, hard)
		},
	}
	cmd.Flags().BoolVar(&all, "all", false, "Pause the whole fleet (daemon-global)")
	cmd.Flags().BoolVar(&hard, "hard", false, "Terminate live workers now instead of draining (with --all, orchestrators too)")
	return cmd
}

func newResumeCommand(ctx *commandContext) *cobra.Command {
	var all bool
	cmd := &cobra.Command{
		Use:   "resume [project]",
		Short: "Resume a paused project (or the whole fleet with --all)",
		Args:  pauseTargetArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			return runPauseResume(ctx, cmd, args, all, false, false)
		},
	}
	cmd.Flags().BoolVar(&all, "all", false, "Resume the whole fleet (daemon-global)")
	return cmd
}

// pauseTargetArgs accepts at most one project id; --all vs a project id is
// reconciled in runPauseResume so the two mutually-exclusive targets share one
// usage error path.
func pauseTargetArgs(cmd *cobra.Command, args []string) error {
	if len(args) > 1 {
		return usageError{fmt.Errorf("usage: expected at most one project id")}
	}
	if len(args) == 1 && strings.TrimSpace(args[0]) == "" {
		return usageError{fmt.Errorf("usage: project id must not be empty")}
	}
	return nil
}

func runPauseResume(ctx *commandContext, cmd *cobra.Command, args []string, all, paused, hard bool) error {
	verb := "resume"
	if paused {
		verb = "pause"
	}
	out := cmd.OutOrStdout()

	if all {
		if len(args) > 0 {
			return usageError{fmt.Errorf("usage: pass either a project id or --all, not both")}
		}
		var res fleetStatusResult
		if err := ctx.postJSON(cmd.Context(), "fleet/"+verb+hardQuery(hard), nil, &res); err != nil {
			return err
		}
		_, err := fmt.Fprintf(out, "Fleet %sd (paused=%v)\n", verb, res.Paused)
		return err
	}

	if len(args) == 0 {
		return usageError{fmt.Errorf("usage: specify a project id or --all")}
	}
	id := strings.TrimSpace(args[0])
	var res projectResult
	if err := ctx.postJSON(cmd.Context(), "projects/"+url.PathEscape(id)+"/"+verb+hardQuery(hard), nil, &res); err != nil {
		return err
	}
	_, err := fmt.Fprintf(out, "Project %s %sd (state=%s)\n", id, verb, formatPauseState(res.Project.PauseState, res.Project.DrainingWorkers))
	return err
}

// hardQuery appends ?hard=true when a hard pause was requested.
func hardQuery(hard bool) string {
	if hard {
		return "?hard=true"
	}
	return ""
}
