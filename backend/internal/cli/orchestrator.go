package cli

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/spf13/cobra"
)

type orchestratorListOptions struct {
	json bool
}

type orchestratorListOutput struct {
	Data []sessionListEntry `json:"data"`
}

func newOrchestratorCommand(ctx *commandContext) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "orchestrator",
		Short: "Manage orchestrator sessions",
	}
	cmd.AddCommand(newOrchestratorListCommand(ctx))
	cmd.AddCommand(newOrchestratorDoneCommand(ctx))
	return cmd
}

func newOrchestratorDoneCommand(ctx *commandContext) *cobra.Command {
	var sessionID string
	cmd := &cobra.Command{
		Use:   "done",
		Short: "Stop automatic re-engagement for a completed orchestrator",
		Args:  noArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if strings.TrimSpace(sessionID) == "" {
				return usageError{errors.New("--session is required")}
			}
			var res struct {
				OK        bool   `json:"ok"`
				SessionID string `json:"sessionId"`
			}
			if err := ctx.postJSON(cmd.Context(), "orchestrators/"+sessionID+"/done", nil, &res); err != nil {
				return err
			}
			_, err := fmt.Fprintf(cmd.OutOrStdout(), "Orchestrator %s marked done.\n", res.SessionID)
			return err
		},
	}
	cmd.Flags().StringVar(&sessionID, "session", "", "Orchestrator session id")
	return cmd
}

func newOrchestratorListCommand(ctx *commandContext) *cobra.Command {
	var opts orchestratorListOptions
	cmd := &cobra.Command{
		Use:     "ls",
		Aliases: []string{"list"},
		Short:   "List orchestrator sessions",
		Args:    noArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			return ctx.listOrchestrators(cmd.Context(), cmd, opts)
		},
	}
	cmd.Flags().BoolVar(&opts.json, "json", false, "Output as JSON")
	return cmd
}

func (c *commandContext) listOrchestrators(ctx context.Context, cmd *cobra.Command, opts orchestratorListOptions) error {
	var res sessionListResponse
	if err := c.getJSON(ctx, "orchestrators", &res); err != nil {
		return err
	}
	orchestrators := filterAndSortOrchestrators(res.Sessions)
	if opts.json {
		return writeJSON(cmd.OutOrStdout(), orchestratorListOutput{Data: sessionListEntries(orchestrators)})
	}
	return writeOrchestratorList(cmd, orchestrators)
}

func filterAndSortOrchestrators(sessions []sessionDTO) []sessionDTO {
	out := make([]sessionDTO, 0, len(sessions))
	for _, sess := range sessions {
		if sess.Kind != "orchestrator" {
			continue
		}
		out = append(out, sess)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].ProjectID != out[j].ProjectID {
			return out[i].ProjectID < out[j].ProjectID
		}
		return out[i].ID < out[j].ID
	})
	return out
}

func writeOrchestratorList(cmd *cobra.Command, sessions []sessionDTO) error {
	out := cmd.OutOrStdout()
	if len(sessions) == 0 {
		_, err := fmt.Fprintln(out, "(no orchestrators)")
		return err
	}
	currentProject := ""
	for _, sess := range sessions {
		if sess.ProjectID != currentProject {
			if currentProject != "" {
				if _, err := fmt.Fprintln(out); err != nil {
					return err
				}
			}
			currentProject = sess.ProjectID
			if _, err := fmt.Fprintf(out, "%s:\n", currentProject); err != nil {
				return err
			}
		}
		if _, err := fmt.Fprintf(out, "  %s", sess.ID); err != nil {
			return err
		}
		parts := orchestratorLineParts(sess)
		if len(parts) > 0 {
			if _, err := fmt.Fprintf(out, "  %s", strings.Join(parts, "  ")); err != nil {
				return err
			}
		}
		if _, err := fmt.Fprintln(out); err != nil {
			return err
		}
	}
	return nil
}

func orchestratorLineParts(sess sessionDTO) []string {
	parts := []string{}
	if !sess.Activity.LastActivityAt.IsZero() {
		parts = append(parts, "("+formatSessionAge(time.Since(sess.Activity.LastActivityAt))+")")
	}
	if sess.Status != "" {
		parts = append(parts, "["+sess.Status+"]")
	}
	if sess.IsTerminated {
		parts = append(parts, "terminated")
	}
	return parts
}
