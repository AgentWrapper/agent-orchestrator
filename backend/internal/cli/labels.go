package cli

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/spf13/cobra"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

type labelsSyncOptions struct {
	repo string
	json bool
}

type labelsSyncResult struct {
	Repo     string                  `json:"repo"`
	Created  []string                `json:"created"`
	Existing []string                `json:"existing"`
	Labels   []domain.IssueLabelSpec `json:"labels"`
}

type ghLabel struct {
	Name string `json:"name"`
}

func newLabelsCommand(ctx *commandContext) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "labels",
		Short: "Manage ao-standard GitHub labels",
	}
	cmd.AddCommand(newLabelsSyncCommand(ctx))
	return cmd
}

func newLabelsSyncCommand(ctx *commandContext) *cobra.Command {
	var opts labelsSyncOptions
	cmd := &cobra.Command{
		Use:   "sync",
		Short: "Create missing ao-standard labels on a GitHub repo",
		Args:  noArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			opts.repo = strings.TrimSpace(opts.repo)
			if opts.repo == "" {
				return usageError{errors.New("usage: --repo owner/repo is required")}
			}
			res, err := ctx.syncStandardLabels(cmd.Context(), opts.repo)
			if err != nil {
				return err
			}
			if opts.json {
				return writeJSON(cmd.OutOrStdout(), res)
			}
			return writeLabelsSyncResult(cmd, res)
		},
	}
	cmd.Flags().StringVar(&opts.repo, "repo", "", "GitHub repo to provision (owner/repo)")
	cmd.Flags().BoolVar(&opts.json, "json", false, "Output result as JSON")
	return cmd
}

func (c *commandContext) syncStandardLabels(ctx context.Context, repo string) (labelsSyncResult, error) {
	specs := domain.StandardIssueLabels()
	existing, err := c.existingGitHubLabels(ctx, repo)
	if err != nil {
		return labelsSyncResult{}, err
	}

	res := labelsSyncResult{Repo: repo, Labels: specs}
	for _, spec := range specs {
		if existing[strings.ToLower(spec.Name)] {
			res.Existing = append(res.Existing, spec.Name)
			continue
		}
		if _, err := c.deps.CommandOutput(ctx, "gh", "label", "create", spec.Name, "--repo", repo, "--description", spec.Description, "--color", spec.Color); err != nil {
			return labelsSyncResult{}, fmt.Errorf("create label %q on %s: %w", spec.Name, repo, err)
		}
		res.Created = append(res.Created, spec.Name)
	}
	return res, nil
}

func (c *commandContext) existingGitHubLabels(ctx context.Context, repo string) (map[string]bool, error) {
	out, err := c.deps.CommandOutput(ctx, "gh", "label", "list", "--repo", repo, "--json", "name", "--limit", "1000")
	if err != nil {
		return nil, fmt.Errorf("list labels on %s: %w", repo, err)
	}
	var labels []ghLabel
	if err := json.Unmarshal(out, &labels); err != nil {
		return nil, fmt.Errorf("decode labels for %s: %w", repo, err)
	}
	existing := make(map[string]bool, len(labels))
	for _, label := range labels {
		existing[strings.ToLower(label.Name)] = true
	}
	return existing, nil
}

func writeLabelsSyncResult(cmd *cobra.Command, res labelsSyncResult) error {
	if _, err := fmt.Fprintf(cmd.OutOrStdout(), "synced ao labels for %s\n", res.Repo); err != nil {
		return err
	}
	if err := writeLabelNameSection(cmd, "created", res.Created); err != nil {
		return err
	}
	return writeLabelNameSection(cmd, "existing", res.Existing)
}

func writeLabelNameSection(cmd *cobra.Command, title string, names []string) error {
	if _, err := fmt.Fprintf(cmd.OutOrStdout(), "%s:\n", title); err != nil {
		return err
	}
	if len(names) == 0 {
		_, err := fmt.Fprintln(cmd.OutOrStdout(), "  (none)")
		return err
	}
	for _, name := range names {
		if _, err := fmt.Fprintf(cmd.OutOrStdout(), "  %s\n", name); err != nil {
			return err
		}
	}
	return nil
}
