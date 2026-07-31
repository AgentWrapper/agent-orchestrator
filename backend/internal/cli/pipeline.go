package cli

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"os"
	"sort"
	"strconv"
	"strings"
	"text/tabwriter"
	"time"

	"github.com/spf13/cobra"
	"gopkg.in/yaml.v3"
)

// ---------------------------------------------------------------------------
// Wire DTOs (mirror controllers.Pipeline* response shapes). Human rendering
// decodes into these; --json output re-emits the raw daemon response so no
// field is silently dropped.
// ---------------------------------------------------------------------------

type pipelineDefinitionSummary struct {
	ID         string    `json:"id"`
	ProjectID  string    `json:"projectId"`
	Name       string    `json:"name"`
	YAMLSource string    `json:"yamlSource"`
	CreatedAt  time.Time `json:"createdAt"`
	UpdatedAt  time.Time `json:"updatedAt"`
}

type listPipelineDefinitionsResponse struct {
	Definitions []pipelineDefinitionSummary `json:"definitions"`
}

type pipelineDefinitionResponse struct {
	Definition pipelineDefinitionSummary `json:"definition"`
}

type deletePipelineDefinitionResponse struct {
	ID      string `json:"id"`
	Deleted bool   `json:"deleted"`
}

type pipelineValidationIssue struct {
	Path    string `json:"path"`
	Message string `json:"message"`
}

// validatePipelineDefinitionResponse carries both lists whether or not the
// document is valid: a warned pipeline still saves and still runs, so the two
// render differently.
type validatePipelineDefinitionResponse struct {
	Valid    bool                      `json:"valid"`
	Issues   []pipelineValidationIssue `json:"issues"`
	Warnings []pipelineValidationIssue `json:"warnings"`
}

// pipelineRunSummary is v2's run shape: a run status rollup and the subject the
// run is about, in place of v1's loop state and termination reason.
type pipelineRunSummary struct {
	RunID      string `json:"runId"`
	PipelineID string `json:"pipelineId"`
	// RunNumber is the per-pipeline counter a human refers to a run by
	// ("inform #3"), allocated at trigger time and never reassigned.
	RunNumber     int               `json:"runNumber"`
	PipelineName  string            `json:"pipelineName"`
	Status        string            `json:"status"`
	SubjectKind   string            `json:"subjectKind"`
	SessionID     string            `json:"sessionId,omitempty"`
	PRNumber      int               `json:"prNumber,omitempty"`
	HeadSHA       string            `json:"headSha,omitempty"`
	CancelReason  string            `json:"cancelReason,omitempty"`
	StageCount    int               `json:"stageCount"`
	StageOutcomes map[string]string `json:"stageOutcomes"`
	CreatedAt     time.Time         `json:"createdAt"`
	UpdatedAt     time.Time         `json:"updatedAt"`
	SettledAt     *time.Time        `json:"settledAt,omitempty"`
}

type listPipelineRunsResponse struct {
	Runs []pipelineRunSummary `json:"runs"`
}

type pipelineProducedArtifact struct {
	Name   string `json:"name"`
	Exists bool   `json:"exists"`
}

// pipelineStageView is one stage's v2 state: an outcome from the taxonomy, the
// attempt (2 means the stage was nudged), the edge it was entered by, and the
// reason behind a failure or a cancellation.
type pipelineStageView struct {
	StageID          string                    `json:"stageId"`
	Outcome          string                    `json:"outcome"`
	Attempt          int                       `json:"attempt"`
	EnteredVia       string                    `json:"enteredVia"`
	FailedStage      string                    `json:"failedStage,omitempty"`
	SessionID        string                    `json:"sessionId,omitempty"`
	WorkspaceKind    string                    `json:"workspaceKind,omitempty"`
	StartedAt        *time.Time                `json:"startedAt,omitempty"`
	SettledAt        *time.Time                `json:"settledAt,omitempty"`
	Reason           string                    `json:"reason,omitempty"`
	OutputTail       string                    `json:"outputTail,omitempty"`
	ProducedArtifact *pipelineProducedArtifact `json:"producedArtifact,omitempty"`
}

type pipelineRunDetail struct {
	pipelineRunSummary
	RunDir string              `json:"runDir,omitempty"`
	Stages []pipelineStageView `json:"stages"`
}

type pipelineRunDetailResponse struct {
	Run pipelineRunDetail `json:"run"`
}

type triggerPipelineRunResponse struct {
	RunID string `json:"runId"`
}

// listPipelineCredentialsResponse is names only, and there is no DTO here with
// a value field: decision D13 keeps credential values inside the daemon, so
// nothing the CLI can decode carries one.
type listPipelineCredentialsResponse struct {
	Names []string `json:"names"`
}

type pipelineCredentialResponse struct {
	Name string   `json:"name"`
	Keys []string `json:"keys"`
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

type pipelineListOptions struct {
	project string
	json    bool
}

type pipelineRunsOptions struct {
	project  string
	pipeline string
	status   string
	limit    int
	json     bool
}

type pipelineShowOptions struct {
	project string
	json    bool
}

type pipelineRunOptions struct {
	project  string
	session  string
	prNumber int
	json     bool
}

type pipelineCreateOptions struct {
	project string
	file    string
	json    bool
}

type pipelineGetOptions struct {
	project string
	json    bool
}

type pipelineUpdateOptions struct {
	project string
	file    string
	json    bool
}

type pipelineDeleteOptions struct {
	project string
	yes     bool
	json    bool
}

type pipelineValidateOptions struct {
	project string
	file    string
	json    bool
}

// ---------------------------------------------------------------------------
// Command wiring
// ---------------------------------------------------------------------------

// pipelineLongHelp is the root help text: enough for someone who has never
// used the feature. Every claim here is grounded in docs/pipelines.md and the
// engine code, not the design spec.
const pipelineLongHelp = `Pipelines run multi-stage automation against your project, a pull request, or
a session. A pipeline is a set of stages joined by on_success and on_failure
edges: when a stage settles, the engine follows the matching edge to whatever
comes next. Runs are triggered by PR events (created, updated, merge-ready,
merged), session events (idle, exited, blocked), or manually with
"ao pipeline run". A run freezes its definition at trigger time and executes
that copy, so editing a definition never affects a run in flight.

There are two stage executors:

  command  a shell script run with sh; its exit status is the outcome
  agent    a real AO session, which settles itself from inside the session
           with "ao pipeline done" or "ao pipeline fail --reason ...".
           Idling or losing the session is not success: the engine nudges an
           idle session once, then settles the stage no_signal.

Outcomes are wider than pass/fail. A stage is pending or running until it
settles on one of: succeeded, succeeded_unverified, failed, no_output,
no_signal, timed_out, cancelled, skipped. The width is the point: an agent
that claimed success but never wrote the artifact it declared (no_output) is
a different failure from one that went quiet without claiming anything
(no_signal), and each calls for a different fix.

An agent stage may declare "produces: <filename>", one artifact the engine
verifies exists non-empty before calling the stage succeeded. When the signal
or the artifact is missing, the engine sends the still-live session exactly
one nudge (two attempts total) before settling the stage.

Each stage picks the tree it runs in with "workspace:": session (the subject
session's worktree), run (one worktree shared by the run), stage (a fresh
worktree per entry), checkout (the project's primary checkout), or inherit
(the tree of the stage that routed here). The default is auto, which is
session when the subject has one and otherwise run; a stage entered via a
failure edge defaults to inherit instead.

Concurrency groups (scope plus group name) decide which runs collide: runs
sharing an effective key serialize, and cancel-in-progress: true makes a new
run cancel the in-flight one.

Engine-held credentials (see "ao pipeline credential") are injected into
command stages only, never agent stages, and no verb prints a value back.

Every run keeps its record on disk under ~/.ao/data/pipelines/<project>/<run>/
(more precisely <AO_DATA_DIR>/pipelines/): the frozen definition, run.json,
stage logs, and declared artifacts.

Pipelines are experimental and off by default: toggle them in Settings, or
set AO_PIPELINES=on in the daemon's environment. While off, every pipeline
API route answers 501.

A typical first session:

  ao pipeline validate -f pipeline.yaml   # dry-run the document
  ao pipeline create -f pipeline.yaml     # store it
  ao pipeline run pr-review --pr 42       # trigger a run
  ao pipeline runs                        # list runs, newest first
  ao pipeline show <runId>                # stage outcomes for one run`

// newPipelineCommand builds the v2 verb set. There is no `resume`: a settled
// run is final (spec section 14.1), and re-running means triggering a new run.
func newPipelineCommand(ctx *commandContext) *cobra.Command {
	cmd := &cobra.Command{
		Use:     "pipeline",
		Aliases: []string{"pipelines"},
		Short:   "Manage AO pipelines (definitions, runs, credentials)",
		Long:    pipelineLongHelp,
	}
	cmd.AddCommand(newPipelineListCommand(ctx))
	cmd.AddCommand(newPipelineCreateCommand(ctx))
	cmd.AddCommand(newPipelineGetCommand(ctx))
	cmd.AddCommand(newPipelineUpdateCommand(ctx))
	cmd.AddCommand(newPipelineDeleteCommand(ctx))
	cmd.AddCommand(newPipelineValidateCommand(ctx))
	cmd.AddCommand(newPipelineSchemaCommand(ctx))
	cmd.AddCommand(newPipelineRunsCommand(ctx))
	cmd.AddCommand(newPipelineShowCommand(ctx))
	cmd.AddCommand(newPipelineRunCommand(ctx))
	cmd.AddCommand(newPipelineCancelCommand(ctx))
	cmd.AddCommand(newPipelineCredentialCommand(ctx))
	cmd.AddCommand(newPipelineDoneCommand(ctx))
	cmd.AddCommand(newPipelineFailCommand(ctx))
	return cmd
}

func newPipelineListCommand(ctx *commandContext) *cobra.Command {
	var opts pipelineListOptions
	cmd := &cobra.Command{
		Use:   "list",
		Short: "List configured pipeline definitions for a project",
		Args:  noArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			return ctx.pipelineList(cmd, opts)
		},
	}
	f := cmd.Flags()
	f.StringVarP(&opts.project, "project", "p", "", "Project id to scope to")
	f.BoolVar(&opts.json, "json", false, "Output as JSON")
	return cmd
}

func newPipelineCreateCommand(ctx *commandContext) *cobra.Command {
	var opts pipelineCreateOptions
	cmd := &cobra.Command{
		Use:   "create -f <file>",
		Short: "Create a pipeline definition from a YAML document",
		Long: "Create a pipeline definition from a YAML document.\n\n" +
			"The document is validated server-side and stored only if it is valid; its " +
			"name comes from the document's name: key. Pass `-f -` to read stdin.",
		Args: noArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			return ctx.pipelineCreate(cmd, opts)
		},
	}
	f := cmd.Flags()
	f.StringVarP(&opts.file, "file", "f", "", "Path to the YAML definition (- for stdin)")
	f.StringVarP(&opts.project, "project", "p", "", "Project id to scope to")
	f.BoolVar(&opts.json, "json", false, "Output as JSON")
	return cmd
}

func newPipelineGetCommand(ctx *commandContext) *cobra.Command {
	var opts pipelineGetOptions
	cmd := &cobra.Command{
		Use:     "get <pipeline-ref>",
		Aliases: []string{"cat"},
		Short:   "Print a stored pipeline definition's YAML (by id or name)",
		Long: "Print a stored pipeline definition's YAML exactly as authored.\n\n" +
			"The ref is the definition's id or its name, the same as `run` takes. The " +
			"output is the raw document, so it pipes cleanly into a file or an editor.",
		Args: onePipelineRefArg,
		RunE: func(cmd *cobra.Command, args []string) error {
			return ctx.pipelineGet(cmd, args[0], opts)
		},
	}
	f := cmd.Flags()
	f.StringVarP(&opts.project, "project", "p", "", "Project id to scope to")
	f.BoolVar(&opts.json, "json", false, "Output as JSON")
	return cmd
}

func newPipelineUpdateCommand(ctx *commandContext) *cobra.Command {
	var opts pipelineUpdateOptions
	cmd := &cobra.Command{
		Use:   "update <pipeline-ref> -f <file>",
		Short: "Replace a stored pipeline definition (by id or name)",
		Long: "Replace a stored pipeline definition with a new YAML document.\n\n" +
			"The ref is the definition's id or its name. The new document is validated " +
			"server-side and replaces the stored one only if it is valid; runs already " +
			"in flight keep their frozen copy. Pass `-f -` to read stdin.",
		Args: onePipelineRefArg,
		RunE: func(cmd *cobra.Command, args []string) error {
			return ctx.pipelineUpdate(cmd, args[0], opts)
		},
	}
	f := cmd.Flags()
	f.StringVarP(&opts.file, "file", "f", "", "Path to the YAML definition (- for stdin)")
	f.StringVarP(&opts.project, "project", "p", "", "Project id to scope to")
	f.BoolVar(&opts.json, "json", false, "Output as JSON")
	return cmd
}

func newPipelineDeleteCommand(ctx *commandContext) *cobra.Command {
	var opts pipelineDeleteOptions
	cmd := &cobra.Command{
		Use:     "delete <pipeline-ref>",
		Aliases: []string{"rm"},
		Short:   "Delete a stored pipeline definition (by id or name)",
		Long: "Delete a stored pipeline definition.\n\n" +
			"A definition is user-authored content and deleting one is not recoverable " +
			"from the CLI, so an interactive session is asked to confirm; pass --yes to " +
			"skip the prompt. Non-interactive sessions require --yes. Past runs are kept.",
		Args: onePipelineRefArg,
		RunE: func(cmd *cobra.Command, args []string) error {
			return ctx.pipelineDelete(cmd, args[0], opts)
		},
	}
	f := cmd.Flags()
	f.BoolVarP(&opts.yes, "yes", "y", false, "Skip the confirmation prompt (required when not interactive)")
	f.StringVarP(&opts.project, "project", "p", "", "Project id to scope to")
	f.BoolVar(&opts.json, "json", false, "Output as JSON")
	return cmd
}

func newPipelineValidateCommand(ctx *commandContext) *cobra.Command {
	var opts pipelineValidateOptions
	cmd := &cobra.Command{
		Use:   "validate -f <file>",
		Short: "Validate a pipeline YAML document without storing it",
		Long: "Validate a pipeline YAML document without storing anything.\n\n" +
			"Errors block saving; warnings do not, and arrive even for a valid document. " +
			"An invalid document lists its problems and exits 1, so the verb gates CI " +
			"cleanly. Pass `-f -` to read stdin.",
		Args: noArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			return ctx.pipelineValidate(cmd, opts)
		},
	}
	f := cmd.Flags()
	f.StringVarP(&opts.file, "file", "f", "", "Path to the YAML definition (- for stdin)")
	f.StringVarP(&opts.project, "project", "p", "", "Project id to scope to")
	f.BoolVar(&opts.json, "json", false, "Output as JSON")
	return cmd
}

func newPipelineSchemaCommand(ctx *commandContext) *cobra.Command {
	var jsonOut bool
	cmd := &cobra.Command{
		Use:   "schema",
		Short: "Print the JSON schema for pipeline definition documents",
		Long: "Print the JSON schema for pipeline definition documents.\n\n" +
			"This is the same schema the visual editor consumes; point an editor or a " +
			"linter at it for completion and validation while authoring YAML.",
		Args: noArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			return ctx.pipelineSchema(cmd)
		},
	}
	// The schema is JSON in both modes; the flag exists so every verb takes it.
	cmd.Flags().BoolVar(&jsonOut, "json", false, "Output as JSON (the schema always is)")
	return cmd
}

func newPipelineRunsCommand(ctx *commandContext) *cobra.Command {
	var opts pipelineRunsOptions
	cmd := &cobra.Command{
		Use:   "runs",
		Short: "List pipeline runs (newest first)",
		Args:  noArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			return ctx.pipelineRuns(cmd, opts)
		},
	}
	f := cmd.Flags()
	f.StringVarP(&opts.project, "project", "p", "", "Project id to scope to")
	f.StringVar(&opts.pipeline, "pipeline", "", "Filter by pipeline name")
	f.StringVar(&opts.status, "status", "", "Filter by run status (pending|running|succeeded|failed|cancelled)")
	f.IntVar(&opts.limit, "limit", 0, "Cap the number of runs returned")
	f.BoolVar(&opts.json, "json", false, "Output as JSON")
	return cmd
}

func newPipelineShowCommand(ctx *commandContext) *cobra.Command {
	var opts pipelineShowOptions
	cmd := &cobra.Command{
		Use:   "show <runId>",
		Short: "Show run detail (stage outcomes, attempts, reasons, artifacts)",
		Args:  onePipelineRunIDArg,
		RunE: func(cmd *cobra.Command, args []string) error {
			return ctx.pipelineShow(cmd, args[0], opts)
		},
	}
	f := cmd.Flags()
	f.StringVarP(&opts.project, "project", "p", "", "Project id to scope to")
	f.BoolVar(&opts.json, "json", false, "Output as JSON")
	return cmd
}

func newPipelineRunCommand(ctx *commandContext) *cobra.Command {
	var opts pipelineRunOptions
	cmd := &cobra.Command{
		Use:   "run <pipeline-ref>",
		Short: "Trigger a manual run for a pipeline (by id or name)",
		Long: "Trigger a manual run for a pipeline (by id or name).\n\n" +
			"The subject is resolved by the daemon: --session runs against a session, " +
			"--pr against a tracked pull request (whose head SHA and fork provenance the " +
			"daemon looks up), and neither makes it a project run.",
		Args: onePipelineRefArg,
		RunE: func(cmd *cobra.Command, args []string) error {
			return ctx.pipelineRun(cmd, args[0], opts)
		},
	}
	f := cmd.Flags()
	f.StringVarP(&opts.project, "project", "p", "", "Project id to scope to")
	f.StringVar(&opts.session, "session", "", "Run against this session as the subject")
	f.IntVar(&opts.prNumber, "pr", 0, "Run against this tracked pull request as the subject")
	f.BoolVar(&opts.json, "json", false, "Output as JSON")
	return cmd
}

func newPipelineCancelCommand(ctx *commandContext) *cobra.Command {
	var project string
	cmd := &cobra.Command{
		Use:   "cancel <runId>",
		Short: "Cancel an in-flight run",
		Args:  onePipelineRunIDArg,
		RunE: func(cmd *cobra.Command, args []string) error {
			return ctx.pipelineCancel(cmd, args[0], project)
		},
	}
	cmd.Flags().StringVarP(&project, "project", "p", "", "Project id to scope to")
	return cmd
}

func newPipelineDoneCommand(ctx *commandContext) *cobra.Command {
	return &cobra.Command{
		Use:   "done",
		Short: "Settle the current pipeline stage as done (run from inside an agent stage)",
		Args:  noArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			return ctx.pipelineSignal(cmd, "done", "")
		},
	}
}

func newPipelineFailCommand(ctx *commandContext) *cobra.Command {
	var reason string
	cmd := &cobra.Command{
		Use:   "fail",
		Short: "Settle the current pipeline stage as failed (run from inside an agent stage)",
		Args:  noArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			// The reason is the whole point of the failure channel: it is what
			// the run detail and the failure edge's AO_FAILED_* variables show.
			if strings.TrimSpace(reason) == "" {
				return usageError{fmt.Errorf("--reason is required: say why the stage failed")}
			}
			return ctx.pipelineSignal(cmd, "fail", reason)
		},
	}
	cmd.Flags().StringVar(&reason, "reason", "", "Why the stage failed")
	return cmd
}

// ---------------------------------------------------------------------------
// Credential verbs (decision D13)
// ---------------------------------------------------------------------------

// newPipelineCredentialCommand groups the engine-held credential verbs. Values
// travel one way: in through `set`, out only into a command stage's process env
// at exec time. No verb here prints one back, and `ls` answers with names.
func newPipelineCredentialCommand(ctx *commandContext) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "credential",
		Short: "Manage engine-held credentials for command stages",
	}
	cmd.AddCommand(newPipelineCredentialSetCommand(ctx))
	cmd.AddCommand(newPipelineCredentialLsCommand(ctx))
	cmd.AddCommand(newPipelineCredentialRmCommand(ctx))
	return cmd
}

func newPipelineCredentialSetCommand(ctx *commandContext) *cobra.Command {
	var project string
	cmd := &cobra.Command{
		Use:   "set <name> KEY=VALUE...",
		Short: "Create or replace a credential (values are never printed back)",
		Long: "Create or replace a credential.\n\n" +
			"The variables given replace the credential's whole environment, so dropping " +
			"a KEY=VALUE removes that variable. Values live in the daemon and are injected " +
			"into a command stage's process env at exec time; no command prints one back.\n\n" +
			"Values passed here land in your shell history: prefer a shell that skips " +
			"history for the command, or set the credential from a script.",
		Args: cobra.ArbitraryArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			return ctx.pipelineCredentialSet(cmd, args, project)
		},
	}
	cmd.Flags().StringVarP(&project, "project", "p", "", "Project id to scope to")
	return cmd
}

func newPipelineCredentialLsCommand(ctx *commandContext) *cobra.Command {
	var project string
	cmd := &cobra.Command{
		Use:   "ls",
		Short: "List credential names for a project",
		Args:  noArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			return ctx.pipelineCredentialLs(cmd, project)
		},
	}
	cmd.Flags().StringVarP(&project, "project", "p", "", "Project id to scope to")
	return cmd
}

func newPipelineCredentialRmCommand(ctx *commandContext) *cobra.Command {
	var project string
	cmd := &cobra.Command{
		Use:   "rm <name>",
		Short: "Delete a credential",
		Args:  onePipelineCredentialNameArg,
		RunE: func(cmd *cobra.Command, args []string) error {
			return ctx.pipelineCredentialRm(cmd, args[0], project)
		},
	}
	cmd.Flags().StringVarP(&project, "project", "p", "", "Project id to scope to")
	return cmd
}

func onePipelineRunIDArg(cmd *cobra.Command, args []string) error {
	if err := cobra.ExactArgs(1)(cmd, args); err != nil {
		return usageError{err}
	}
	if strings.TrimSpace(args[0]) == "" {
		return usageError{fmt.Errorf("run id is required")}
	}
	return nil
}

func onePipelineRefArg(cmd *cobra.Command, args []string) error {
	if err := cobra.ExactArgs(1)(cmd, args); err != nil {
		return usageError{err}
	}
	if strings.TrimSpace(args[0]) == "" {
		return usageError{fmt.Errorf("pipeline id or name is required")}
	}
	return nil
}

func onePipelineCredentialNameArg(cmd *cobra.Command, args []string) error {
	if err := cobra.ExactArgs(1)(cmd, args); err != nil {
		return usageError{err}
	}
	if strings.TrimSpace(args[0]) == "" {
		return usageError{fmt.Errorf("credential name is required")}
	}
	return nil
}

// ---------------------------------------------------------------------------
// Implementations
// ---------------------------------------------------------------------------

func (c *commandContext) pipelineList(cmd *cobra.Command, opts pipelineListOptions) error {
	ctx := cmd.Context()
	projectID, err := c.resolvePipelineProjectID(ctx, opts.project)
	if err != nil {
		return err
	}
	params := url.Values{}
	params.Set("project", projectID)

	raw, err := c.getPipelineRaw(ctx, apiPath("pipelines", params))
	if err != nil {
		return err
	}
	if opts.json {
		return writeJSON(cmd.OutOrStdout(), raw)
	}
	var res listPipelineDefinitionsResponse
	if err := json.Unmarshal(raw, &res); err != nil {
		return fmt.Errorf("decode response: %w", err)
	}
	return writePipelineList(cmd, projectID, res.Definitions)
}

func (c *commandContext) pipelineCreate(cmd *cobra.Command, opts pipelineCreateOptions) error {
	yamlSource, err := readPipelineDocument(cmd.InOrStdin(), opts.file)
	if err != nil {
		return err
	}
	ctx := cmd.Context()
	projectID, err := c.resolvePipelineProjectID(ctx, opts.project)
	if err != nil {
		return err
	}
	params := url.Values{}
	params.Set("project", projectID)

	var raw json.RawMessage
	if err := c.postJSON(ctx, apiPath("pipelines", params), map[string]string{"yamlSource": yamlSource}, &raw); err != nil {
		return err
	}
	if opts.json {
		return writeJSON(cmd.OutOrStdout(), raw)
	}
	var res pipelineDefinitionResponse
	if err := json.Unmarshal(raw, &res); err != nil {
		return fmt.Errorf("decode response: %w", err)
	}
	_, err = fmt.Fprintf(cmd.OutOrStdout(), "pipeline %s created (%s)\n", res.Definition.Name, res.Definition.ID)
	return err
}

func (c *commandContext) pipelineGet(cmd *cobra.Command, ref string, opts pipelineGetOptions) error {
	ctx := cmd.Context()
	projectID, err := c.resolvePipelineProjectID(ctx, opts.project)
	if err != nil {
		return err
	}
	def, err := c.resolvePipelineDefinition(ctx, projectID, ref)
	if err != nil {
		return err
	}
	if opts.json {
		// There is no single-definition GET route to re-emit; the decoded
		// summary is the whole daemon-provided record for this definition.
		return writeJSON(cmd.OutOrStdout(), def)
	}
	src := def.YAMLSource
	if !strings.HasSuffix(src, "\n") {
		src += "\n"
	}
	_, err = io.WriteString(cmd.OutOrStdout(), src)
	return err
}

func (c *commandContext) pipelineUpdate(cmd *cobra.Command, ref string, opts pipelineUpdateOptions) error {
	yamlSource, err := readPipelineDocument(cmd.InOrStdin(), opts.file)
	if err != nil {
		return err
	}
	ctx := cmd.Context()
	projectID, err := c.resolvePipelineProjectID(ctx, opts.project)
	if err != nil {
		return err
	}
	def, err := c.resolvePipelineDefinition(ctx, projectID, ref)
	if err != nil {
		return err
	}

	var raw json.RawMessage
	if err := c.putJSON(ctx, "pipelines/"+url.PathEscape(def.ID), map[string]string{"yamlSource": yamlSource}, &raw); err != nil {
		return err
	}
	if opts.json {
		return writeJSON(cmd.OutOrStdout(), raw)
	}
	var res pipelineDefinitionResponse
	if err := json.Unmarshal(raw, &res); err != nil {
		return fmt.Errorf("decode response: %w", err)
	}
	_, err = fmt.Fprintf(cmd.OutOrStdout(), "pipeline %s updated (%s)\n", res.Definition.Name, res.Definition.ID)
	return err
}

func (c *commandContext) pipelineDelete(cmd *cobra.Command, ref string, opts pipelineDeleteOptions) error {
	ctx := cmd.Context()
	projectID, err := c.resolvePipelineProjectID(ctx, opts.project)
	if err != nil {
		return err
	}
	def, err := c.resolvePipelineDefinition(ctx, projectID, ref)
	if err != nil {
		return err
	}
	// A definition is user-authored content and this delete is not recoverable
	// from the CLI, so it is confirmed interactively. A non-interactive caller
	// must say --yes; silently proceeding (or silently cancelling) would both
	// be wrong in a script.
	if !opts.yes {
		if !stdinIsInteractive(cmd.InOrStdin()) {
			return usageError{fmt.Errorf("deleting pipeline %s needs confirmation: pass --yes when not running interactively", def.Name)}
		}
		ok, err := confirm(cmd.InOrStdin(), cmd.OutOrStdout(),
			fmt.Sprintf("Delete pipeline %s (%s)? Past runs are kept.", def.Name, def.ID), false)
		if err != nil {
			return err
		}
		if !ok {
			_, err := fmt.Fprintln(cmd.OutOrStdout(), "Delete cancelled.")
			return err
		}
	}

	var raw json.RawMessage
	if err := c.deleteJSON(ctx, "pipelines/"+url.PathEscape(def.ID), &raw); err != nil {
		return err
	}
	if opts.json {
		return writeJSON(cmd.OutOrStdout(), raw)
	}
	var res deletePipelineDefinitionResponse
	if err := json.Unmarshal(raw, &res); err != nil {
		return fmt.Errorf("decode response: %w", err)
	}
	_, err = fmt.Fprintf(cmd.OutOrStdout(), "pipeline %s deleted (%s)\n", def.Name, res.ID)
	return err
}

func (c *commandContext) pipelineValidate(cmd *cobra.Command, opts pipelineValidateOptions) error {
	yamlSource, err := readPipelineDocument(cmd.InOrStdin(), opts.file)
	if err != nil {
		return err
	}
	ctx := cmd.Context()
	projectID, err := c.resolvePipelineProjectID(ctx, opts.project)
	if err != nil {
		return err
	}
	params := url.Values{}
	params.Set("project", projectID)

	var raw json.RawMessage
	if err := c.postJSON(ctx, apiPath("pipelines/validate", params), map[string]string{"yamlSource": yamlSource}, &raw); err != nil {
		return err
	}
	var res validatePipelineDefinitionResponse
	if err := json.Unmarshal(raw, &res); err != nil {
		return fmt.Errorf("decode response: %w", err)
	}
	if opts.json {
		if err := writeJSON(cmd.OutOrStdout(), raw); err != nil {
			return err
		}
		return pipelineValidationVerdict(res)
	}
	if err := writePipelineValidation(cmd, res); err != nil {
		return err
	}
	return pipelineValidationVerdict(res)
}

// pipelineValidationVerdict turns an invalid document into a non-zero exit.
// The problems are already on stdout as data; this is deliberately a plain
// error (exit 1), not a usageError, because the CLI was used correctly.
func pipelineValidationVerdict(res validatePipelineDefinitionResponse) error {
	if res.Valid {
		return nil
	}
	n := len(res.Issues)
	return fmt.Errorf("pipeline definition is invalid (%d error%s)", n, pluralS(n))
}

func (c *commandContext) pipelineSchema(cmd *cobra.Command) error {
	raw, err := c.getPipelineRaw(cmd.Context(), "pipelines/schema")
	if err != nil {
		return err
	}
	return writeJSON(cmd.OutOrStdout(), raw)
}

// readPipelineDocument reads the YAML document for create/update/validate from
// the given path, or from stdin when the path is "-".
func readPipelineDocument(in io.Reader, path string) (string, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return "", usageError{fmt.Errorf("-f/--file is required (use `-f -` to read stdin)")}
	}
	var data []byte
	var err error
	if path == "-" {
		data, err = io.ReadAll(in)
	} else {
		data, err = os.ReadFile(path) // #nosec G304 -- the path is the user's own -f argument.
	}
	if err != nil {
		return "", fmt.Errorf("read pipeline definition: %w", err)
	}
	if strings.TrimSpace(string(data)) == "" {
		return "", usageError{fmt.Errorf("pipeline definition is empty")}
	}
	return string(data), nil
}

// resolvePipelineDefinition resolves a pipeline ref (id or name) against the
// project's stored definitions. There is no GET /pipelines/{id} route, so the
// CLI lists and matches client-side, the same reference shape `run` resolves
// server-side. Ids win over names; names are unique per project.
func (c *commandContext) resolvePipelineDefinition(ctx context.Context, projectID, ref string) (pipelineDefinitionSummary, error) {
	var res listPipelineDefinitionsResponse
	params := url.Values{}
	params.Set("project", projectID)
	if err := c.getJSON(ctx, apiPath("pipelines", params), &res); err != nil {
		return pipelineDefinitionSummary{}, err
	}
	ref = strings.TrimSpace(ref)
	for _, d := range res.Definitions {
		if d.ID == ref {
			return d, nil
		}
	}
	for _, d := range res.Definitions {
		if d.Name == ref {
			return d, nil
		}
	}
	return pipelineDefinitionSummary{}, fmt.Errorf("no pipeline %q in project %s", ref, projectID)
}

func (c *commandContext) pipelineRuns(cmd *cobra.Command, opts pipelineRunsOptions) error {
	ctx := cmd.Context()
	projectID, err := c.resolvePipelineProjectID(ctx, opts.project)
	if err != nil {
		return err
	}
	params := url.Values{}
	params.Set("project", projectID)
	if opts.pipeline != "" {
		params.Set("pipeline", opts.pipeline)
	}
	if opts.status != "" {
		params.Set("status", opts.status)
	}
	if opts.limit > 0 {
		params.Set("limit", strconv.Itoa(opts.limit))
	}

	raw, err := c.getPipelineRaw(ctx, apiPath("pipelines/runs", params))
	if err != nil {
		return err
	}
	if opts.json {
		return writeJSON(cmd.OutOrStdout(), raw)
	}
	var res listPipelineRunsResponse
	if err := json.Unmarshal(raw, &res); err != nil {
		return fmt.Errorf("decode response: %w", err)
	}
	return writePipelineRuns(cmd, projectID, res.Runs)
}

func (c *commandContext) pipelineShow(cmd *cobra.Command, runID string, opts pipelineShowOptions) error {
	ctx := cmd.Context()
	// The run-detail route keys off the globally-unique run id; project is not
	// required. Forward it when given so the flag stays meaningful.
	path := "pipelines/runs/" + url.PathEscape(strings.TrimSpace(runID))
	if p := strings.TrimSpace(opts.project); p != "" {
		params := url.Values{}
		params.Set("project", p)
		path = apiPath(path, params)
	}
	raw, err := c.getPipelineRaw(ctx, path)
	if err != nil {
		return err
	}
	if opts.json {
		return writeJSON(cmd.OutOrStdout(), raw)
	}
	var res pipelineRunDetailResponse
	if err := json.Unmarshal(raw, &res); err != nil {
		return fmt.Errorf("decode response: %w", err)
	}
	return writePipelineRunDetail(cmd, res.Run)
}

func (c *commandContext) pipelineRun(cmd *cobra.Command, ref string, opts pipelineRunOptions) error {
	ctx := cmd.Context()
	projectID, err := c.resolvePipelineProjectID(ctx, opts.project)
	if err != nil {
		return err
	}
	params := url.Values{}
	params.Set("project", projectID)
	body := map[string]any{"pipeline": strings.TrimSpace(ref)}
	if s := strings.TrimSpace(opts.session); s != "" {
		body["sessionId"] = s
	}
	if opts.prNumber > 0 {
		body["prNumber"] = opts.prNumber
	}

	var raw json.RawMessage
	if err := c.postJSON(ctx, apiPath("pipelines/runs", params), body, &raw); err != nil {
		return err
	}
	if opts.json {
		return writeJSON(cmd.OutOrStdout(), raw)
	}
	var res triggerPipelineRunResponse
	if err := json.Unmarshal(raw, &res); err != nil {
		return fmt.Errorf("decode response: %w", err)
	}
	_, err = fmt.Fprintf(cmd.OutOrStdout(), "triggered %s → run %s\n", ref, res.RunID)
	return err
}

func (c *commandContext) pipelineCancel(cmd *cobra.Command, runID, project string) error {
	ctx := cmd.Context()
	projectID, err := c.resolvePipelineProjectID(ctx, project)
	if err != nil {
		return err
	}
	params := url.Values{}
	params.Set("project", projectID)
	path := apiPath("pipelines/runs/"+url.PathEscape(strings.TrimSpace(runID))+"/cancel", params)

	var res pipelineRunDetailResponse
	if err := c.postJSON(ctx, path, struct{}{}, &res); err != nil {
		return err
	}
	run := res.Run
	line := fmt.Sprintf("run %s → %s", run.RunID, run.Status)
	if run.CancelReason != "" {
		line += fmt.Sprintf(" (%s)", run.CancelReason)
	}
	_, err = fmt.Fprintln(cmd.OutOrStdout(), line)
	return err
}

// pipelineCredentialSet stores one credential's whole environment. The
// KEY=VALUE arguments are parsed here rather than server-side so a malformed
// pair is caught before the value travels anywhere.
func (c *commandContext) pipelineCredentialSet(cmd *cobra.Command, args []string, project string) error {
	if len(args) == 0 || strings.TrimSpace(args[0]) == "" {
		return usageError{fmt.Errorf("credential name is required")}
	}
	name := strings.TrimSpace(args[0])
	env, err := parseCredentialPairs(args[1:])
	if err != nil {
		return err
	}

	ctx := cmd.Context()
	projectID, err := c.resolvePipelineProjectID(ctx, project)
	if err != nil {
		return err
	}
	params := url.Values{}
	params.Set("project", projectID)
	path := apiPath("pipelines/credentials/"+url.PathEscape(name), params)

	var res pipelineCredentialResponse
	if err := c.putJSON(ctx, path, map[string]any{"env": env}, &res); err != nil {
		return err
	}
	// Variable names, never their values: this line is the receipt for what
	// landed, and it has to be safe to paste into an issue.
	_, err = fmt.Fprintf(cmd.OutOrStdout(), "credential %s set (%d variable%s: %s)\n",
		res.Name, len(res.Keys), pluralS(len(res.Keys)), strings.Join(res.Keys, ", "))
	return err
}

func (c *commandContext) pipelineCredentialLs(cmd *cobra.Command, project string) error {
	ctx := cmd.Context()
	projectID, err := c.resolvePipelineProjectID(ctx, project)
	if err != nil {
		return err
	}
	params := url.Values{}
	params.Set("project", projectID)

	// Decoded into a names-only struct on purpose: whatever else a response
	// carries, this verb has no field to put a value in.
	var res listPipelineCredentialsResponse
	if err := c.getJSON(ctx, apiPath("pipelines/credentials", params), &res); err != nil {
		return err
	}
	out := cmd.OutOrStdout()
	if len(res.Names) == 0 {
		_, err := fmt.Fprintf(out, "(no credentials for %s)\n", projectID)
		return err
	}
	if _, err := fmt.Fprintf(out, "Credentials for %s:\n", projectID); err != nil {
		return err
	}
	names := append([]string(nil), res.Names...)
	sort.Strings(names)
	for _, name := range names {
		if _, err := fmt.Fprintf(out, "  %s\n", name); err != nil {
			return err
		}
	}
	return nil
}

func (c *commandContext) pipelineCredentialRm(cmd *cobra.Command, name, project string) error {
	ctx := cmd.Context()
	projectID, err := c.resolvePipelineProjectID(ctx, project)
	if err != nil {
		return err
	}
	params := url.Values{}
	params.Set("project", projectID)
	path := apiPath("pipelines/credentials/"+url.PathEscape(strings.TrimSpace(name)), params)

	if err := c.deleteJSON(ctx, path, nil); err != nil {
		return err
	}
	_, err = fmt.Fprintf(cmd.OutOrStdout(), "credential %s removed\n", strings.TrimSpace(name))
	return err
}

// parseCredentialPairs turns KEY=VALUE arguments into the environment map.
//
// A malformed argument is reported by position and never quoted back: the most
// likely way to mistype one of these is to paste the secret on its own, and an
// error message that echoed it would put it in the terminal scrollback, the
// shell's error log and any CI transcript.
func parseCredentialPairs(args []string) (map[string]string, error) {
	if len(args) == 0 {
		return nil, usageError{fmt.Errorf("at least one KEY=VALUE is required")}
	}
	env := make(map[string]string, len(args))
	for i, arg := range args {
		key, value, ok := strings.Cut(arg, "=")
		key = strings.TrimSpace(key)
		if !ok || key == "" {
			return nil, usageError{fmt.Errorf("argument %d is not KEY=VALUE (not echoed here, in case it is the secret)", i+1)}
		}
		env[key] = value
	}
	return env, nil
}

// pipelineSignal settles the stage the caller is running inside, by posting to
// the signal endpoint. The target comes from the ambient stage environment
// alone.
func (c *commandContext) pipelineSignal(cmd *cobra.Command, status, reason string) error {
	runID, stageID, err := stageSignalTarget()
	if err != nil {
		return err
	}
	body := map[string]string{"status": status}
	if r := strings.TrimSpace(reason); r != "" {
		body["reason"] = r
	}
	path := "pipelines/runs/" + url.PathEscape(runID) + "/stages/" + url.PathEscape(stageID) + "/signal"
	if err := c.postJSON(cmd.Context(), path, body, nil); err != nil {
		return err
	}
	_, err = fmt.Fprintf(cmd.OutOrStdout(), "stage %s in run %s → %s\n", stageID, runID, status)
	return err
}

// stageSignalTarget reads which stage is being settled from AO_RUN_ID and
// AO_STAGE (spec section 6.3). A missing variable is an error naming it, never
// a guess: an agent that shelled into another tree, or a nested session that
// did not inherit the stage environment, must fail loudly instead of silently
// settling somebody else's stage.
func stageSignalTarget() (runID, stageID string, err error) {
	runID = strings.TrimSpace(os.Getenv("AO_RUN_ID"))
	stageID = strings.TrimSpace(os.Getenv("AO_STAGE"))
	const hint = "run `ao pipeline done|fail` from inside the pipeline stage that set it"
	switch {
	case runID == "" && stageID == "":
		return "", "", fmt.Errorf("AO_RUN_ID and AO_STAGE are not set: %s", hint)
	case runID == "":
		return "", "", fmt.Errorf("AO_RUN_ID is not set: %s", hint)
	case stageID == "":
		return "", "", fmt.Errorf("AO_STAGE is not set: %s", hint)
	}
	return runID, stageID, nil
}

// getPipelineRaw fetches a GET endpoint and returns the raw JSON body so --json
// output stays byte-faithful to the daemon while human rendering decodes a
// subset.
func (c *commandContext) getPipelineRaw(ctx context.Context, path string) (json.RawMessage, error) {
	var raw json.RawMessage
	if err := c.getJSON(ctx, path, &raw); err != nil {
		return nil, err
	}
	return raw, nil
}

// resolvePipelineProjectID resolves the project id from the flag, then
// AO_PROJECT_ID, then the shared session/cwd resolver. Explicit and env values
// are trusted as-is (the daemon validates them), avoiding an extra round-trip.
func (c *commandContext) resolvePipelineProjectID(ctx context.Context, explicit string) (string, error) {
	if id := strings.TrimSpace(explicit); id != "" {
		return id, nil
	}
	if id := strings.TrimSpace(os.Getenv("AO_PROJECT_ID")); id != "" {
		return id, nil
	}
	project, err := c.resolveSpawnProject(ctx, "")
	if err != nil {
		return "", err
	}
	return project.ID, nil
}

// ---------------------------------------------------------------------------
// Human rendering
// ---------------------------------------------------------------------------

func writePipelineList(cmd *cobra.Command, projectID string, defs []pipelineDefinitionSummary) error {
	out := cmd.OutOrStdout()
	if len(defs) == 0 {
		_, err := fmt.Fprintf(out, "(no pipelines configured for %s)\n", projectID)
		return err
	}
	if _, err := fmt.Fprintf(out, "Pipelines for %s:\n", projectID); err != nil {
		return err
	}
	for _, d := range defs {
		n := pipelineStageCount(d.YAMLSource)
		if _, err := fmt.Fprintf(out, "  %s  %s  %d stage%s  %s\n",
			d.ID, d.Name, n, pluralS(n), formatPipelineTime(d.UpdatedAt)); err != nil {
			return err
		}
	}
	return nil
}

// writePipelineValidation renders the two lists distinctly because they mean
// different things: errors block saving, warnings do not, and warnings arrive
// whether or not the document is valid.
func writePipelineValidation(cmd *cobra.Command, res validatePipelineDefinitionResponse) error {
	out := cmd.OutOrStdout()
	verdict := "valid"
	if !res.Valid {
		verdict = "invalid"
	}
	if _, err := fmt.Fprintf(out, "pipeline definition is %s\n", verdict); err != nil {
		return err
	}
	for _, group := range []struct {
		label  string
		issues []pipelineValidationIssue
	}{
		{"Errors", res.Issues},
		{"Warnings", res.Warnings},
	} {
		if len(group.issues) == 0 {
			continue
		}
		if _, err := fmt.Fprintf(out, "\n%s:\n", group.label); err != nil {
			return err
		}
		for _, issue := range group.issues {
			line := issue.Message
			if issue.Path != "" {
				line = issue.Path + ": " + issue.Message
			}
			if _, err := fmt.Fprintf(out, "  %s\n", line); err != nil {
				return err
			}
		}
	}
	return nil
}

func writePipelineRuns(cmd *cobra.Command, projectID string, runs []pipelineRunSummary) error {
	out := cmd.OutOrStdout()
	if len(runs) == 0 {
		_, err := fmt.Fprintln(out, "(no runs)")
		return err
	}
	if _, err := fmt.Fprintf(out, "Runs for %s:\n", projectID); err != nil {
		return err
	}
	for _, run := range runs {
		status := run.Status
		if run.CancelReason != "" {
			status += fmt.Sprintf(" (%s)", run.CancelReason)
		}
		if _, err := fmt.Fprintf(out, "  %s  %s  %s  %s  %s\n",
			run.RunID, pipelineRunLabel(run), status, describePipelineSubject(run),
			formatPipelineTime(run.CreatedAt)); err != nil {
			return err
		}
	}
	return nil
}

// pipelineRunLabel is how a human refers to a run out loud: "inform #3", the
// same shape GitHub Actions uses. A run number of 0 means the daemon predates
// the counter, so the label degrades to the bare pipeline name rather than
// printing a "#0" nobody can look up.
func pipelineRunLabel(run pipelineRunSummary) string {
	if run.RunNumber <= 0 {
		return run.PipelineName
	}
	return fmt.Sprintf("%s #%d", run.PipelineName, run.RunNumber)
}

// describePipelineSubject names what the run is about, which is what tells two
// runs of the same pipeline apart.
func describePipelineSubject(run pipelineRunSummary) string {
	switch run.SubjectKind {
	case "pr":
		s := fmt.Sprintf("pr #%d", run.PRNumber)
		if run.HeadSHA != "" {
			s += " " + run.HeadSHA
		}
		return s
	case "session":
		if run.SessionID != "" {
			return "session " + run.SessionID
		}
		return "session"
	case "":
		return "-"
	default:
		return run.SubjectKind
	}
}

// writePipelineRunDetail renders a run's v2 outcomes. The stage table carries
// attempt and reason columns so a nudged stage (attempt 2) and a stage that
// produced nothing (outcome no_output, artifact missing) read differently at a
// glance instead of collapsing into one "failed" line.
func writePipelineRunDetail(cmd *cobra.Command, run pipelineRunDetail) error {
	out := cmd.OutOrStdout()
	fields := [][2]string{
		{"runId", run.RunID},
		{"status", run.Status},
		{"subject", describePipelineSubject(run.pipelineRunSummary)},
		{"session", run.SessionID},
		{"cancelled", run.CancelReason},
		{"runDir", run.RunDir},
		{"created", formatPipelineTime(run.CreatedAt)},
		{"updated", formatPipelineTime(run.UpdatedAt)},
		{"settled", formatPipelineTimePtr(run.SettledAt)},
	}
	// The heading is the human handle ("review #7"); the run id it resolves to
	// moves into the field list, because that is what `show` and `cancel` take.
	if _, err := fmt.Fprintf(out, "Run %s\n", pipelineRunLabel(run.pipelineRunSummary)); err != nil {
		return err
	}
	for _, f := range fields {
		if f[1] == "" {
			continue
		}
		if _, err := fmt.Fprintf(out, "  %-9s %s\n", f[0]+":", f[1]); err != nil {
			return err
		}
	}

	if _, err := fmt.Fprintln(out, "\nStages:"); err != nil {
		return err
	}
	if len(run.Stages) == 0 {
		_, err := fmt.Fprintln(out, "  (none)")
		return err
	}
	return writePipelineStageTable(out, run.Stages)
}

func writePipelineStageTable(out io.Writer, stages []pipelineStageView) error {
	tw := tabwriter.NewWriter(out, 0, 0, 2, ' ', 0)
	if _, err := fmt.Fprintln(tw, "  STAGE\tOUTCOME\tATTEMPT\tVIA\tARTIFACT\tREASON"); err != nil {
		return err
	}
	for _, st := range stages {
		reason := st.Reason
		if reason == "" {
			reason = "-"
		}
		if _, err := fmt.Fprintf(tw, "  %s\t%s\t%s\t%s\t%s\t%s\n",
			st.StageID, st.Outcome, describeStageAttempt(st), describeStageEntry(st),
			describeStageArtifact(st), reason); err != nil {
			return err
		}
	}
	return tw.Flush()
}

// describeStageAttempt tags the one nudge an agent stage gets (spec section
// 6.4): attempt 2 exists only because the engine nudged an idle stage, so
// saying so is more useful than the bare number.
func describeStageAttempt(st pipelineStageView) string {
	if st.Attempt >= 2 {
		return fmt.Sprintf("%d (nudged)", st.Attempt)
	}
	return strconv.Itoa(st.Attempt)
}

// describeStageEntry names the edge the stage was entered by, and for a failure
// edge the stage whose failure routed here.
func describeStageEntry(st pipelineStageView) string {
	if st.EnteredVia == "" {
		return "-"
	}
	if st.FailedStage != "" {
		return fmt.Sprintf("%s(%s)", st.EnteredVia, st.FailedStage)
	}
	return st.EnteredVia
}

// describeStageArtifact renders the stage's declared `produces` file and
// whether the engine found it, which is the evidence behind a no_output
// outcome.
func describeStageArtifact(st pipelineStageView) string {
	if st.ProducedArtifact == nil || st.ProducedArtifact.Name == "" {
		return "-"
	}
	if st.ProducedArtifact.Exists {
		return st.ProducedArtifact.Name
	}
	return st.ProducedArtifact.Name + " (missing)"
}

// pipelineStageCount counts stages in the authored YAML for the list view. A
// definition is only stored after it validates, so a parse failure here is not
// expected; fall back to 0 rather than erroring the whole listing.
func pipelineStageCount(yamlSource string) int {
	var doc struct {
		Stages []yaml.Node `yaml:"stages"`
	}
	if err := yaml.Unmarshal([]byte(yamlSource), &doc); err != nil {
		return 0
	}
	return len(doc.Stages)
}

func formatPipelineTime(t time.Time) string {
	if t.IsZero() {
		return ""
	}
	return t.Format(time.RFC3339)
}

func formatPipelineTimePtr(t *time.Time) string {
	if t == nil {
		return ""
	}
	return formatPipelineTime(*t)
}
