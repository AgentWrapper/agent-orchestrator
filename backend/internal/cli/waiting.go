package cli

import (
	"fmt"
	"text/tabwriter"
	"time"

	"github.com/spf13/cobra"
)

type waitingOptions struct {
	json bool
}

type waitingResponse struct {
	Items []waitingItem `json:"items"`
}

type waitingItem struct {
	ID           string    `json:"id"`
	Kind         string    `json:"kind"`
	ProjectID    string    `json:"projectId"`
	SessionID    string    `json:"sessionId,omitempty"`
	SessionTitle string    `json:"sessionTitle,omitempty"`
	Reason       string    `json:"reason"`
	Action       string    `json:"action"`
	DeepLink     string    `json:"deepLink"`
	UpdatedAt    time.Time `json:"updatedAt"`
	DecisionKind string    `json:"decisionKind,omitempty"`
	Question     string    `json:"question,omitempty"`
	PRNumber     int       `json:"prNumber,omitempty"`
	PRURL        string    `json:"prUrl,omitempty"`
	PRTitle      string    `json:"prTitle,omitempty"`
}

func newWaitingCommand(ctx *commandContext) *cobra.Command {
	var opts waitingOptions
	cmd := &cobra.Command{
		Use:   "waiting",
		Short: "Show what is waiting on the operator",
		Args:  noArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			var resp waitingResponse
			if err := ctx.getJSON(cmd.Context(), "attention/operator", &resp); err != nil {
				return err
			}
			if opts.json {
				return writeJSON(cmd.OutOrStdout(), resp)
			}
			return writeWaiting(cmd, resp.Items)
		},
	}
	cmd.Flags().BoolVar(&opts.json, "json", false, "Output waiting items as JSON")
	return cmd
}

func writeWaiting(cmd *cobra.Command, items []waitingItem) error {
	if len(items) == 0 {
		_, err := fmt.Fprintln(cmd.OutOrStdout(), "Nothing is waiting on you.")
		return err
	}
	tw := tabwriter.NewWriter(cmd.OutOrStdout(), 0, 0, 2, ' ', 0)
	if _, err := fmt.Fprintln(tw, "KIND\tPROJECT\tSESSION/PR\tREASON\tACTION"); err != nil {
		return err
	}
	for _, item := range items {
		target := item.SessionID
		if item.PRNumber > 0 {
			target = fmt.Sprintf("#%d", item.PRNumber)
		}
		if _, err := fmt.Fprintf(tw, "%s\t%s\t%s\t%s\t%s\n", item.Kind, item.ProjectID, target, item.Reason, item.Action); err != nil {
			return err
		}
	}
	return tw.Flush()
}
