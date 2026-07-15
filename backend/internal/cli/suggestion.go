package cli

import (
	"errors"
	"fmt"
	"net/url"
	"strings"
	"text/tabwriter"
	"time"

	"github.com/spf13/cobra"
)

type suggestionDTO struct {
	ID        string    `json:"id"`
	ProjectID string    `json:"projectId"`
	Title     string    `json:"title"`
	Note      string    `json:"note,omitempty"`
	Priority  string    `json:"priority"`
	Status    string    `json:"status"`
	SessionID string    `json:"sessionId,omitempty"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}

type suggestionListResult struct {
	Suggestions []suggestionDTO `json:"suggestions"`
}

type suggestionResult struct {
	Suggestion suggestionDTO `json:"suggestion"`
	SessionID  string        `json:"sessionId,omitempty"`
}

type suggestionCreateRequest struct {
	Title    string `json:"title"`
	Note     string `json:"note,omitempty"`
	Priority string `json:"priority,omitempty"`
}

func newSuggestionCommand(ctx *commandContext) *cobra.Command {
	cmd := &cobra.Command{Use: "suggestion", Short: "Manage deferred project suggestions"}
	cmd.AddCommand(newSuggestionListCommand(ctx))
	cmd.AddCommand(newSuggestionAddCommand(ctx))
	cmd.AddCommand(newSuggestionStartCommand(ctx))
	cmd.AddCommand(newSuggestionStatusCommand(ctx, "done", "done"))
	cmd.AddCommand(newSuggestionStatusCommand(ctx, "dismiss", "dismissed"))
	return cmd
}

func newSuggestionListCommand(ctx *commandContext) *cobra.Command {
	var project string
	var jsonOutput bool
	cmd := &cobra.Command{
		Use: "ls", Aliases: []string{"list"}, Short: "List a project's deferred suggestions", Args: noArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if strings.TrimSpace(project) == "" {
				return usageError{errors.New("--project is required")}
			}
			var result suggestionListResult
			if err := ctx.getJSON(cmd.Context(), suggestionBasePath(project), &result); err != nil {
				return err
			}
			if jsonOutput {
				return writeJSON(cmd.OutOrStdout(), result)
			}
			if len(result.Suggestions) == 0 {
				_, err := fmt.Fprintln(cmd.OutOrStdout(), "(no suggestions)")
				return err
			}
			w := tabwriter.NewWriter(cmd.OutOrStdout(), 0, 4, 2, ' ', 0)
			if _, err := fmt.Fprintln(w, "ID\tPRIORITY\tSTATUS\tSESSION\tTITLE"); err != nil {
				return err
			}
			for _, item := range result.Suggestions {
				if _, err := fmt.Fprintf(w, "%s\t%s\t%s\t%s\t%s\n", item.ID, item.Priority, item.Status, item.SessionID, item.Title); err != nil {
					return err
				}
			}
			return w.Flush()
		},
	}
	cmd.Flags().StringVar(&project, "project", "", "Project id")
	cmd.Flags().BoolVar(&jsonOutput, "json", false, "Output as JSON")
	return cmd
}

func newSuggestionAddCommand(ctx *commandContext) *cobra.Command {
	var project, title, note, priority string
	var jsonOutput bool
	cmd := &cobra.Command{
		Use: "add", Short: "Add a non-blocking grand-workflow suggestion", Args: noArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if strings.TrimSpace(project) == "" || strings.TrimSpace(title) == "" {
				return usageError{errors.New("--project and --title are required")}
			}
			var result suggestionResult
			if err := ctx.postJSON(cmd.Context(), suggestionBasePath(project), suggestionCreateRequest{Title: title, Note: note, Priority: priority}, &result); err != nil {
				return err
			}
			if jsonOutput {
				return writeJSON(cmd.OutOrStdout(), result)
			}
			_, err := fmt.Fprintf(cmd.OutOrStdout(), "Added %s: %s\n", result.Suggestion.ID, result.Suggestion.Title)
			return err
		},
	}
	cmd.Flags().StringVar(&project, "project", "", "Project id")
	cmd.Flags().StringVar(&title, "title", "", "Short suggestion title")
	cmd.Flags().StringVar(&note, "note", "", "Grand-workflow context or rationale")
	cmd.Flags().StringVar(&priority, "priority", "normal", "Priority: later, normal, or important")
	cmd.Flags().BoolVar(&jsonOutput, "json", false, "Output as JSON")
	return cmd
}

func newSuggestionStartCommand(ctx *commandContext) *cobra.Command {
	var project string
	var jsonOutput bool
	cmd := &cobra.Command{
		Use: "start <suggestion-id>", Short: "Start a dedicated worker for a backlog suggestion",
		Args: func(cmd *cobra.Command, args []string) error {
			if err := cobra.ExactArgs(1)(cmd, args); err != nil {
				return usageError{err}
			}
			if strings.TrimSpace(project) == "" {
				return usageError{errors.New("--project is required")}
			}
			return nil
		},
		RunE: func(cmd *cobra.Command, args []string) error {
			var result suggestionResult
			path := suggestionItemPath(project, args[0]) + "/start"
			if err := ctx.postJSON(cmd.Context(), path, nil, &result); err != nil {
				return err
			}
			if jsonOutput {
				return writeJSON(cmd.OutOrStdout(), result)
			}
			_, err := fmt.Fprintf(cmd.OutOrStdout(), "Started %s for %s\n", result.SessionID, result.Suggestion.Title)
			return err
		},
	}
	cmd.Flags().StringVar(&project, "project", "", "Project id")
	cmd.Flags().BoolVar(&jsonOutput, "json", false, "Output as JSON")
	return cmd
}

func newSuggestionStatusCommand(ctx *commandContext, name, status string) *cobra.Command {
	var project string
	cmd := &cobra.Command{
		Use: name + " <suggestion-id>", Short: name + " a suggestion",
		Args: func(cmd *cobra.Command, args []string) error {
			if err := cobra.ExactArgs(1)(cmd, args); err != nil {
				return usageError{err}
			}
			if strings.TrimSpace(project) == "" {
				return usageError{errors.New("--project is required")}
			}
			return nil
		},
		RunE: func(cmd *cobra.Command, args []string) error {
			var result suggestionResult
			if err := ctx.patchJSON(cmd.Context(), suggestionItemPath(project, args[0]), map[string]string{"status": status}, &result); err != nil {
				return err
			}
			_, err := fmt.Fprintf(cmd.OutOrStdout(), "%s: %s\n", status, result.Suggestion.Title)
			return err
		},
	}
	cmd.Flags().StringVar(&project, "project", "", "Project id")
	return cmd
}

func suggestionBasePath(project string) string {
	return "projects/" + url.PathEscape(strings.TrimSpace(project)) + "/suggestions"
}

func suggestionItemPath(project, id string) string {
	return suggestionBasePath(project) + "/" + url.PathEscape(strings.TrimSpace(id))
}
