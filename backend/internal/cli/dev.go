package cli

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/spf13/cobra"

	"github.com/aoagents/agent-orchestrator/backend/internal/config"
	"github.com/aoagents/agent-orchestrator/backend/internal/devimport"
	"github.com/aoagents/agent-orchestrator/backend/internal/runfile"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite"
)

type devImportProjectsOptions struct {
	fromDataDir string
	dryRun      bool
	json        bool
}

func newDevCommand(ctx *commandContext) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "dev",
		Short: "Developer utilities",
	}
	cmd.AddCommand(newDevImportProjectsCommand(ctx))
	return cmd
}

func newDevImportProjectsCommand(ctx *commandContext) *cobra.Command {
	var opts devImportProjectsOptions
	cmd := &cobra.Command{
		Use:   "import-projects",
		Short: "Copy project registry data into the current AO data dir",
		Long: "Copy active project registry rows from the normal AO data dir into " +
			"the current AO_DATA_DIR. This copies only project metadata, project config, " +
			"and workspace child repo registry; sessions and runtime state are never copied.\n\n" +
			"The target daemon must be stopped because the daemon is the sole live writer.",
		Args: noArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			return ctx.runDevImportProjects(cmd, opts)
		},
	}
	cmd.Flags().StringVar(&opts.fromDataDir, "from-data-dir", "", "AO data dir to read (default ~/.ao/data)")
	cmd.Flags().BoolVar(&opts.dryRun, "dry-run", false, "Report planned changes without writing")
	cmd.Flags().BoolVar(&opts.json, "json", false, "Output the import report as JSON")
	return cmd
}

func (c *commandContext) runDevImportProjects(cmd *cobra.Command, opts devImportProjectsOptions) error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}

	if live, err := runfile.CheckStale(cfg.RunFilePath); err != nil {
		return fmt.Errorf("inspect run-file: %w", err)
	} else if live != nil {
		return usageError{fmt.Errorf("the target AO daemon is running (pid %d); stop it before importing projects", live.PID)}
	}

	sourceDataDir := opts.fromDataDir
	if strings.TrimSpace(sourceDataDir) == "" {
		sourceDataDir, err = defaultNormalDataDir()
		if err != nil {
			return err
		}
	}
	sourceDataDir, err = expandHomePath(sourceDataDir)
	if err != nil {
		return err
	}
	targetDataDir, err := expandHomePath(cfg.DataDir)
	if err != nil {
		return err
	}

	same, err := sameResolvedPath(sourceDataDir, targetDataDir)
	if err != nil {
		return err
	}
	if same {
		return usageError{fmt.Errorf("source and target data dirs are the same: %s", sourceDataDir)}
	}

	rep, err := c.executeDevImportProjects(cmd.Context(), sourceDataDir, targetDataDir, opts.dryRun)
	if err != nil {
		return err
	}
	if opts.json {
		return writeJSON(cmd.OutOrStdout(), rep)
	}
	return writeDevImportProjectsSummary(cmd.OutOrStdout(), rep)
}

func (c *commandContext) executeDevImportProjects(ctx context.Context, sourceDataDir, targetDataDir string, dryRun bool) (devimport.Report, error) {
	source, err := sqlite.Open(sourceDataDir)
	if err != nil {
		return devimport.Report{}, fmt.Errorf("open source store: %w", err)
	}
	defer func() { _ = source.Close() }()

	target, err := sqlite.Open(targetDataDir)
	if err != nil {
		return devimport.Report{}, fmt.Errorf("open target store: %w", err)
	}
	defer func() { _ = target.Close() }()

	return devimport.Run(ctx, source, target, devimport.Options{
		SourceDataDir: sourceDataDir,
		TargetDataDir: targetDataDir,
		DryRun:        dryRun,
	})
}

func writeDevImportProjectsSummary(w io.Writer, rep devimport.Report) error {
	var b strings.Builder
	if rep.DryRun {
		b.WriteString("Dry run -- no changes written.\n")
	}
	fmt.Fprintf(&b, "Source data dir: %s\n", rep.SourceDataDir)
	fmt.Fprintf(&b, "Target data dir: %s\n", rep.TargetDataDir)
	fmt.Fprintf(&b, "Inserted: %d\n", rep.Inserted)
	fmt.Fprintf(&b, "Updated: %d\n", rep.Updated)
	fmt.Fprintf(&b, "Skipped/conflicts: %d\n", rep.Skipped)
	if len(rep.Conflicts) > 0 {
		b.WriteString("\nConflicts:\n")
		for _, conflict := range rep.Conflicts {
			fmt.Fprintf(&b, "  - %s (%s): %s", conflict.ProjectID, conflict.Path, conflict.Reason)
			if conflict.TargetID != "" || conflict.TargetPath != "" {
				fmt.Fprintf(&b, " [target: %s %s]", conflict.TargetID, conflict.TargetPath)
			}
			b.WriteByte('\n')
		}
	}
	_, err := io.WriteString(w, b.String())
	return err
}

func defaultNormalDataDir() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("resolve home dir: %w", err)
	}
	return filepath.Join(home, ".ao", "data"), nil
}

func expandHomePath(path string) (string, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return "", errors.New("path is required")
	}
	if path == "~" {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", fmt.Errorf("resolve home dir: %w", err)
		}
		return home, nil
	}
	if strings.HasPrefix(path, "~/") {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", fmt.Errorf("resolve home dir: %w", err)
		}
		return filepath.Join(home, path[2:]), nil
	}
	return path, nil
}

func sameResolvedPath(a, b string) (bool, error) {
	ra, err := resolvedPath(a)
	if err != nil {
		return false, err
	}
	rb, err := resolvedPath(b)
	if err != nil {
		return false, err
	}
	return ra == rb, nil
}

func resolvedPath(path string) (string, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return "", fmt.Errorf("resolve path %s: %w", path, err)
	}
	resolved, err := filepath.EvalSymlinks(abs)
	if err == nil {
		return filepath.Clean(resolved), nil
	}
	if errors.Is(err, os.ErrNotExist) {
		return filepath.Clean(abs), nil
	}
	return "", fmt.Errorf("resolve path %s: %w", path, err)
}
