package cli

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"os"
	"strconv"
	"strings"
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

type pipelineRunSummary struct {
	RunID             string    `json:"runId"`
	PipelineID        string    `json:"pipelineId"`
	PipelineName      string    `json:"pipelineName"`
	SessionID         string    `json:"sessionId"`
	LoopState         string    `json:"loopState"`
	TerminationReason string    `json:"terminationReason,omitempty"`
	LoopRounds        int       `json:"loopRounds"`
	HeadSHA           string    `json:"headSha"`
	StageCount        int       `json:"stageCount"`
	HasOpenFindings   bool      `json:"hasOpenFindings"`
	CreatedAt         time.Time `json:"createdAt"`
	UpdatedAt         time.Time `json:"updatedAt"`
}

type listPipelineRunsResponse struct {
	Runs []pipelineRunSummary `json:"runs"`
}

type pipelineStageView struct {
	StageName    string   `json:"stageName"`
	StageRunID   string   `json:"stageRunId"`
	Status       string   `json:"status"`
	Attempt      int      `json:"attempt"`
	Verdict      string   `json:"verdict,omitempty"`
	ErrorMessage string   `json:"errorMessage,omitempty"`
	ArtifactIDs  []string `json:"artifactIds"`
}

// pipelineFinding captures the finding fields the human view renders; the full
// artifact blob is preserved in --json output via the raw response.
type pipelineFinding struct {
	Kind      string `json:"kind"`
	StageName string `json:"stageName"`
	Title     string `json:"title,omitempty"`
	FilePath  string `json:"filePath,omitempty"`
	Severity  string `json:"severity,omitempty"`
	Status    string `json:"status"`
}

type pipelineRunDetail struct {
	pipelineRunSummary
	Stages   []pipelineStageView `json:"stages"`
	Findings []pipelineFinding   `json:"findings"`
}

type pipelineRunDetailResponse struct {
	Run pipelineRunDetail `json:"run"`
}

type triggerPipelineRunResponse struct {
	RunID string `json:"runId"`
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
	project string
	session string
	headSHA string
	json    bool
}

// ---------------------------------------------------------------------------
// Command wiring
// ---------------------------------------------------------------------------

func newPipelineCommand(ctx *commandContext) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "pipeline",
		Short: "Manage AO pipelines (definitions and runs)",
	}
	cmd.AddCommand(newPipelineListCommand(ctx))
	cmd.AddCommand(newPipelineRunsCommand(ctx))
	cmd.AddCommand(newPipelineShowCommand(ctx))
	cmd.AddCommand(newPipelineRunCommand(ctx))
	cmd.AddCommand(newPipelineCancelCommand(ctx))
	cmd.AddCommand(newPipelineResumeCommand(ctx))
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
	f.StringVar(&opts.status, "status", "", "Filter by loop state (running|awaiting_context|done|stalled|terminated)")
	f.IntVar(&opts.limit, "limit", 0, "Cap the number of runs returned")
	f.BoolVar(&opts.json, "json", false, "Output as JSON")
	return cmd
}

func newPipelineShowCommand(ctx *commandContext) *cobra.Command {
	var opts pipelineShowOptions
	cmd := &cobra.Command{
		Use:   "show <runId>",
		Short: "Show run detail (stages, attempts, verdicts, findings)",
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
		Args:  onePipelineRefArg,
		RunE: func(cmd *cobra.Command, args []string) error {
			return ctx.pipelineRun(cmd, args[0], opts)
		},
	}
	f := cmd.Flags()
	f.StringVarP(&opts.project, "project", "p", "", "Project id to scope to")
	f.StringVar(&opts.session, "session", "", "Session id to scope the run's loop key")
	f.StringVar(&opts.headSHA, "head-sha", "", "Head commit SHA to pin the run to")
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
			return ctx.pipelineLifecycle(cmd, args[0], project, "cancel")
		},
	}
	cmd.Flags().StringVarP(&project, "project", "p", "", "Project id to scope to")
	return cmd
}

func newPipelineResumeCommand(ctx *commandContext) *cobra.Command {
	var project string
	cmd := &cobra.Command{
		Use:   "resume <runId>",
		Short: "Resume a stalled or failed run",
		Args:  onePipelineRunIDArg,
		RunE: func(cmd *cobra.Command, args []string) error {
			return ctx.pipelineLifecycle(cmd, args[0], project, "resume")
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
	body := map[string]string{"pipeline": strings.TrimSpace(ref)}
	if s := strings.TrimSpace(opts.session); s != "" {
		body["sessionId"] = s
	}
	if s := strings.TrimSpace(opts.headSHA); s != "" {
		body["headSha"] = s
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

func (c *commandContext) pipelineLifecycle(cmd *cobra.Command, runID, project, action string) error {
	ctx := cmd.Context()
	projectID, err := c.resolvePipelineProjectID(ctx, project)
	if err != nil {
		return err
	}
	params := url.Values{}
	params.Set("project", projectID)
	path := apiPath("pipelines/runs/"+url.PathEscape(strings.TrimSpace(runID))+"/"+action, params)

	var res pipelineRunDetailResponse
	if err := c.postJSON(ctx, path, struct{}{}, &res); err != nil {
		return err
	}
	run := res.Run
	line := fmt.Sprintf("run %s → %s", run.RunID, run.LoopState)
	if run.TerminationReason != "" {
		line += fmt.Sprintf(" (%s)", run.TerminationReason)
	}
	_, err = fmt.Fprintln(cmd.OutOrStdout(), line)
	return err
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
		state := run.LoopState
		if run.TerminationReason != "" {
			state += fmt.Sprintf(" (%s)", run.TerminationReason)
		}
		if _, err := fmt.Fprintf(out, "  %s  %s  %s  %s\n",
			run.RunID, run.PipelineName, state, formatPipelineTime(run.CreatedAt)); err != nil {
			return err
		}
	}
	return nil
}

func writePipelineRunDetail(cmd *cobra.Command, run pipelineRunDetail) error {
	out := cmd.OutOrStdout()
	fields := [][2]string{
		{"pipeline", run.PipelineName},
		{"session", run.SessionID},
		{"state", run.LoopState},
		{"reason", run.TerminationReason},
		{"rounds", strconv.Itoa(run.LoopRounds)},
		{"headSha", run.HeadSHA},
		{"created", formatPipelineTime(run.CreatedAt)},
		{"updated", formatPipelineTime(run.UpdatedAt)},
	}
	if _, err := fmt.Fprintf(out, "Run %s\n", run.RunID); err != nil {
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
		if _, err := fmt.Fprintln(out, "  (none)"); err != nil {
			return err
		}
	}
	for _, st := range run.Stages {
		line := fmt.Sprintf("  %s  %s", st.StageName, st.Status)
		if st.Verdict != "" {
			line += fmt.Sprintf(" verdict=%s", st.Verdict)
		}
		line += fmt.Sprintf("  attempt=%d  artifacts=%d", st.Attempt, len(st.ArtifactIDs))
		if _, err := fmt.Fprintln(out, line); err != nil {
			return err
		}
		if st.ErrorMessage != "" {
			if _, err := fmt.Fprintf(out, "    error: %s\n", st.ErrorMessage); err != nil {
				return err
			}
		}
	}

	return writePipelineFindings(out, run.Findings)
}

func writePipelineFindings(out io.Writer, findings []pipelineFinding) error {
	open := 0
	for _, f := range findings {
		if f.Kind == "finding" && f.Status == "open" {
			open++
		}
	}
	if len(findings) == 0 {
		return nil
	}
	if _, err := fmt.Fprintf(out, "\nFindings: %d open, %d total\n", open, len(findings)); err != nil {
		return err
	}
	for _, f := range findings {
		if f.Kind != "finding" {
			continue
		}
		loc := f.FilePath
		if loc == "" {
			loc = f.StageName
		}
		sev := f.Severity
		if sev == "" {
			sev = "-"
		}
		if _, err := fmt.Fprintf(out, "  [%s] %s  %s  (%s)\n", sev, f.Title, loc, f.Status); err != nil {
			return err
		}
	}
	return nil
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
