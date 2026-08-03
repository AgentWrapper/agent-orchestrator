package cli

import (
	"fmt"
	"io"
	"path/filepath"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/aoagents/agent-orchestrator/backend/internal/aobackup"
	"github.com/aoagents/agent-orchestrator/backend/internal/config"
	"github.com/aoagents/agent-orchestrator/backend/internal/runfile"
)

type backupCreateOptions struct {
	json bool
}

type backupRestoreOptions struct {
	dryRun bool
	yes    bool
	json   bool
}

func newBackupCommand(ctx *commandContext) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "backup",
		Short: "Backup and restore durable AO state under ~/.ao",
		Long: "Backup and restore the durable Agent Orchestrator state directory " +
			"(~/.ao, or the parent of AO_RUN_FILE).\n\n" +
			"Reinstalling the desktop app does NOT wipe ~/.ao: projects, sessions, " +
			"and settings already survive a normal uninstall/reinstall. Use this " +
			"command for machine migration, disaster recovery, or when you may " +
			"manually delete the state directory.\n\n" +
			"Ephemeral files are excluded: running.json, windows-pty-hosts.json, " +
			"electron/ (Chromium cache), staging/, daemon.log, and lock/temp files.\n\n" +
			"The daemon must be stopped for both create and restore so SQLite and " +
			"other on-disk state are consistent.",
	}
	cmd.AddCommand(newBackupCreateCommand(ctx))
	cmd.AddCommand(newBackupRestoreCommand(ctx))
	return cmd
}

func newBackupCreateCommand(ctx *commandContext) *cobra.Command {
	var opts backupCreateOptions
	cmd := &cobra.Command{
		Use:   "create [path]",
		Short: "Write a zip of durable ~/.ao state",
		Long: "Create a zip archive of durable AO state (database, settings, worktrees, " +
			"skills, mobile config, and related files under the state directory).\n\n" +
			"If path is omitted, writes ao-backup-YYYYMMDD-HHMMSS.zip in the current " +
			"working directory. The path must not already exist.\n\n" +
			"The daemon must be stopped first (`ao stop`).",
		Args: atMostOneArg,
		RunE: func(cmd *cobra.Command, args []string) error {
			return ctx.runBackupCreate(cmd, opts, args)
		},
	}
	cmd.Flags().BoolVar(&opts.json, "json", false, "Output the create report as JSON")
	return cmd
}

func newBackupRestoreCommand(ctx *commandContext) *cobra.Command {
	var opts backupRestoreOptions
	cmd := &cobra.Command{
		Use:   "restore <path>",
		Short: "Restore durable ~/.ao state from a backup zip",
		Long: "Restore durable AO state from a zip produced by `ao backup create`.\n\n" +
			"The archive is fully extracted to a temporary staging directory before " +
			"any files under the state directory are replaced. Existing durable " +
			"top-level items that would be overwritten are moved under " +
			".ao-pre-restore-<timestamp>/ first.\n\n" +
			"Ephemeral local files (running.json, electron/, etc.) are left in place.\n\n" +
			"The daemon must be stopped first (`ao stop`).",
		Args: usageArgs(cobra.ExactArgs(1)),
		RunE: func(cmd *cobra.Command, args []string) error {
			return ctx.runBackupRestore(cmd, opts, args[0])
		},
	}
	cmd.Flags().BoolVar(&opts.dryRun, "dry-run", false, "Validate the archive and report planned replaces without writing")
	cmd.Flags().BoolVarP(&opts.yes, "yes", "y", false, "Skip the confirmation prompt (for non-interactive use)")
	cmd.Flags().BoolVar(&opts.json, "json", false, "Output the restore report as JSON")
	return cmd
}

func (c *commandContext) runBackupCreate(cmd *cobra.Command, opts backupCreateOptions, args []string) error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	if err := refuseIfDaemonRunning(cfg.RunFilePath, "creating a backup"); err != nil {
		return err
	}

	stateDir := filepath.Dir(cfg.RunFilePath)
	archive := ""
	if len(args) == 1 {
		archive = args[0]
	} else {
		archive = defaultBackupArchiveName(c.deps.Now)
	}

	rep, err := aobackup.Create(stateDir, archive)
	if err != nil {
		return err
	}
	if opts.json {
		return writeJSON(cmd.OutOrStdout(), rep)
	}
	return writeBackupCreateSummary(cmd.OutOrStdout(), rep)
}

func (c *commandContext) runBackupRestore(cmd *cobra.Command, opts backupRestoreOptions, archive string) error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	if err := refuseIfDaemonRunning(cfg.RunFilePath, "restoring a backup"); err != nil {
		return err
	}

	stateDir := filepath.Dir(cfg.RunFilePath)

	if !opts.dryRun && !opts.yes {
		ok, err := confirm(c.deps.In, cmd.OutOrStdout(),
			fmt.Sprintf("Restore durable AO state from %s into %s?\nExisting durable files will be moved aside under .ao-pre-restore-*.", archive, stateDir),
			false)
		if err != nil {
			return err
		}
		if !ok {
			_, err := fmt.Fprintln(cmd.OutOrStdout(), "Restore cancelled.")
			return err
		}
	}

	rep, err := aobackup.Restore(archive, stateDir, aobackup.RestoreOptions{DryRun: opts.dryRun})
	if err != nil {
		return err
	}
	if opts.json {
		return writeJSON(cmd.OutOrStdout(), rep)
	}
	return writeBackupRestoreSummary(cmd.OutOrStdout(), rep, opts.dryRun)
}

func refuseIfDaemonRunning(runFilePath, action string) error {
	live, err := runfile.CheckStale(runFilePath)
	if err != nil {
		return fmt.Errorf("inspect run-file: %w", err)
	}
	if live != nil {
		return usageError{fmt.Errorf("the AO daemon is running (pid %d); stop it first with `ao stop` before %s", live.PID, action)}
	}
	return nil
}

func defaultBackupArchiveName(now func() time.Time) string {
	if now == nil {
		now = time.Now
	}
	return fmt.Sprintf("ao-backup-%s.zip", now().UTC().Format("20060102-150405"))
}

func writeBackupCreateSummary(w io.Writer, rep aobackup.CreateReport) error {
	var b strings.Builder
	fmt.Fprintf(&b, "Backup written: %s\n", rep.Archive)
	fmt.Fprintf(&b, "State dir:     %s\n", rep.StateDir)
	fmt.Fprintf(&b, "Files:         %d (%d bytes)\n", rep.Files, rep.Bytes)
	if len(rep.Excluded) > 0 {
		fmt.Fprintf(&b, "Excluded:      %s\n", strings.Join(rep.Excluded, ", "))
	}
	_, err := io.WriteString(w, b.String())
	return err
}

func writeBackupRestoreSummary(w io.Writer, rep aobackup.RestoreReport, dryRun bool) error {
	var b strings.Builder
	if dryRun {
		b.WriteString("Dry run -- no changes written.\n")
	}
	fmt.Fprintf(&b, "Archive:   %s\n", rep.Archive)
	fmt.Fprintf(&b, "State dir: %s\n", rep.StateDir)
	fmt.Fprintf(&b, "Files:     %d\n", rep.Files)
	if len(rep.Replaced) > 0 {
		fmt.Fprintf(&b, "Replaced:  %s\n", strings.Join(rep.Replaced, ", "))
	}
	if rep.PreRestoreDir != "" {
		fmt.Fprintf(&b, "Prior durable items moved to: %s\n", rep.PreRestoreDir)
	}
	if !dryRun {
		b.WriteString("Restore complete. Start the desktop app or run `ao start` when ready.\n")
	}
	_, err := io.WriteString(w, b.String())
	return err
}
