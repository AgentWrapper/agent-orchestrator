package cli

import (
	"errors"
	"fmt"
	"net/url"
	"strings"

	"github.com/spf13/cobra"
)

// mergePRResponse mirrors controllers.MergePRResponse.
type mergePRResponse struct {
	OK       bool   `json:"ok"`
	PRNumber int    `json:"prNumber"`
	Method   string `json:"method"`
}

// resolveCommentsRequest mirrors controllers.ResolveCommentsRequest.
type resolveCommentsRequest struct {
	CommentIDs []string `json:"commentIds,omitempty"`
}

// resolveCommentsResponse mirrors controllers.ResolveCommentsResponse.
type resolveCommentsResponse struct {
	OK       bool `json:"ok"`
	Resolved int  `json:"resolved"`
}

func newPRCommand(ctx *commandContext) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "pr",
		Short: "Run pull-request actions through the AO daemon",
	}
	cmd.AddCommand(newPRMergeCommand(ctx))
	cmd.AddCommand(newPRResolveCommentsCommand(ctx))
	return cmd
}

func newPRMergeCommand(ctx *commandContext) *cobra.Command {
	return &cobra.Command{
		Use:   "merge <pr-number>",
		Short: "Squash-merge a pull request",
		Args:  onePRIDArg,
		RunE: func(cmd *cobra.Command, args []string) error {
			prID := strings.TrimSpace(args[0])
			var res mergePRResponse
			if err := ctx.postJSON(cmd.Context(), "prs/"+url.PathEscape(prID)+"/merge", nil, &res); err != nil {
				return err
			}
			prNumber := res.PRNumber
			if prNumber == 0 {
				_, err := fmt.Fprintf(cmd.OutOrStdout(), "merged PR %s with %s\n", prID, res.Method)
				return err
			}
			_, err := fmt.Fprintf(cmd.OutOrStdout(), "merged PR #%d with %s\n", prNumber, res.Method)
			return err
		},
	}
}

func newPRResolveCommentsCommand(ctx *commandContext) *cobra.Command {
	return &cobra.Command{
		Use:   "resolve-comments <pr-number> [comment-id...]",
		Short: "Resolve review threads on a pull request",
		Args:  atLeastOnePRArg,
		RunE: func(cmd *cobra.Command, args []string) error {
			prID := strings.TrimSpace(args[0])
			commentIDs := make([]string, 0, len(args)-1)
			for _, id := range args[1:] {
				if trimmed := strings.TrimSpace(id); trimmed != "" {
					commentIDs = append(commentIDs, trimmed)
				}
			}
			var res resolveCommentsResponse
			path := "prs/" + url.PathEscape(prID) + "/resolve-comments"
			if err := ctx.postJSON(cmd.Context(), path, resolveCommentsRequest{CommentIDs: commentIDs}, &res); err != nil {
				return err
			}
			_, err := fmt.Fprintf(cmd.OutOrStdout(), "resolved %d review comment(s) on PR %s\n", res.Resolved, prID)
			return err
		},
	}
}

func onePRIDArg(cmd *cobra.Command, args []string) error {
	if err := cobra.ExactArgs(1)(cmd, args); err != nil {
		return usageError{err}
	}
	if strings.TrimSpace(args[0]) == "" {
		return usageError{errors.New("usage: PR number is required")}
	}
	return nil
}

func atLeastOnePRArg(cmd *cobra.Command, args []string) error {
	if err := cobra.MinimumNArgs(1)(cmd, args); err != nil {
		return usageError{err}
	}
	if strings.TrimSpace(args[0]) == "" {
		return usageError{errors.New("usage: PR number is required")}
	}
	return nil
}
