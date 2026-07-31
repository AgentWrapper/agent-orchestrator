package controllers

import (
	"errors"
	"mime"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apispec"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/envelope"
	"github.com/aoagents/agent-orchestrator/backend/internal/pipeline"
	pipelinesvc "github.com/aoagents/agent-orchestrator/backend/internal/service/pipeline"
)

// The wire shapes below are v2's: run statuses and stage outcomes from the v2
// taxonomy, one declared artifact per stage instead of a findings subsystem,
// and no resume (spec section 14.1).

// ---------------------------------------------------------------------------
// Path / query params (reflected into the OpenAPI spec by apispec.Build)
// ---------------------------------------------------------------------------

// PipelineIDParam is the {id} path parameter for definition update/delete.
type PipelineIDParam struct {
	ID string `path:"id" description:"Pipeline definition identifier."`
}

// PipelineRunIDParam is the {runId} path parameter shared by run routes.
type PipelineRunIDParam struct {
	RunID string `path:"runId" description:"Pipeline run identifier."`
}

// PipelineStageIDParam carries both path segments of the stage signal and log
// routes.
type PipelineStageIDParam struct {
	RunID   string `path:"runId" description:"Pipeline run identifier."`
	StageID string `path:"stageId" description:"Stage id as declared in the pipeline definition."`
}

// PipelineOutputParam carries both path segments of the run output route.
type PipelineOutputParam struct {
	RunID    string `path:"runId" description:"Pipeline run identifier."`
	Filename string `path:"filename" description:"Artifact filename. Only a name the run's frozen definition declares as a stage's produces is served."`
}

// PipelineCredentialNameParam is the {name} path parameter of the credential
// write routes.
type PipelineCredentialNameParam struct {
	Name string `path:"name" description:"Credential name as stages reference it in credentials:."`
}

// PipelineProjectQuery is the shared `project` scoping query for the collection
// and lifecycle routes.
type PipelineProjectQuery struct {
	Project string `query:"project,omitempty" description:"Project id the pipeline belongs to (required)."`
}

// PipelineRunsQuery is the query string for GET /pipelines/runs.
type PipelineRunsQuery struct {
	Project  string `query:"project,omitempty" description:"Project id (required)."`
	Pipeline string `query:"pipeline,omitempty" description:"Filter runs to one pipeline name."`
	Status   string `query:"status,omitempty" enum:"pending,running,succeeded,failed,cancelled" description:"Filter runs by run status."`
	Limit    *int   `query:"limit,omitempty" minimum:"1" description:"Cap the number of runs returned (newest first)."`
}

// PipelineStageLogQuery is the query string for the stage log route.
type PipelineStageLogQuery struct {
	Tail *int `query:"tail,omitempty" minimum:"1" description:"Return only the last N lines. Omitted returns the whole log."`
}

// ---------------------------------------------------------------------------
// Request / response DTOs
// ---------------------------------------------------------------------------

// PipelineDefinitionSummary is the wire shape for a stored definition: identity,
// name, raw YAML as authored, and timestamps. The normalized config is not
// surfaced here; the editor works from the YAML plus the JSON schema endpoint.
type PipelineDefinitionSummary struct {
	ID         string    `json:"id"`
	ProjectID  string    `json:"projectId"`
	Name       string    `json:"name"`
	YAMLSource string    `json:"yamlSource"`
	CreatedAt  time.Time `json:"createdAt"`
	UpdatedAt  time.Time `json:"updatedAt"`
}

// ListPipelineDefinitionsResponse is the body of GET /api/v1/pipelines.
type ListPipelineDefinitionsResponse struct {
	Definitions []PipelineDefinitionSummary `json:"definitions"`
}

// PipelineDefinitionResponse is the body of create (201) and update (200).
type PipelineDefinitionResponse struct {
	Definition PipelineDefinitionSummary `json:"definition"`
}

// SavePipelineDefinitionRequest is the create/update body: the raw YAML the
// author edits. Identity and timestamps are assigned server-side.
type SavePipelineDefinitionRequest struct {
	YAMLSource string `json:"yamlSource" description:"Raw YAML pipeline definition document."`
}

// DeletePipelineDefinitionResponse is the body of DELETE /api/v1/pipelines/{id}.
type DeletePipelineDefinitionResponse struct {
	ID      string `json:"id"`
	Deleted bool   `json:"deleted"`
}

// ValidatePipelineDefinitionRequest is the dry-run validate body: the raw YAML
// the editor is authoring. Nothing is persisted.
type ValidatePipelineDefinitionRequest struct {
	YAMLSource string `json:"yamlSource" description:"Raw YAML pipeline definition document to validate."`
}

// PipelineValidationIssue is one validation problem: a dotted path into the
// definition document plus a human-readable message.
type PipelineValidationIssue struct {
	Path    string `json:"path" description:"Dotted path to the offending location, e.g. stages[2].dependsOn."`
	Message string `json:"message" description:"Human-readable description of the problem."`
}

// ValidatePipelineDefinitionResponse is the body of POST /api/v1/pipelines/validate.
// A validation failure is reported here as data (valid=false with the issue
// list), not as an error envelope, so the editor can render the Problems list.
//
// Warnings are a separate array from issues, and they arrive whether or not the
// document is valid: a warned pipeline still saves and still runs, so the editor
// renders the two lists differently (spec section 13).
type ValidatePipelineDefinitionResponse struct {
	Valid    bool                      `json:"valid"`
	Issues   []PipelineValidationIssue `json:"issues"`
	Warnings []PipelineValidationIssue `json:"warnings"`
}

// PipelineRunSummary is the compact per-run wire shape (list + detail base).
// It is what one Kanban card needs: the run status column, the subject it is
// about, and the stage outcome map the card's progress strip renders.
type PipelineRunSummary struct {
	RunID      string `json:"runId"`
	PipelineID string `json:"pipelineId"`
	// RunNumber is the per-pipeline counter humans refer to a run by, the way
	// GitHub Actions numbers workflow runs: pipeline "inform" run #3. It is
	// allocated once at trigger time and never reassigned.
	RunNumber    int    `json:"runNumber" minimum:"1" description:"Per-pipeline run counter, allocated at trigger time and stable forever."`
	PipelineName string `json:"pipelineName"`
	Status       string `json:"status" enum:"pending,running,succeeded,failed,cancelled" description:"Run-level rollup of the stage outcomes."`
	SubjectKind  string `json:"subjectKind" enum:"session,pr,project" description:"What the run is about."`
	// SessionID is set for a session subject, and for a PR subject that has a
	// local session tracking it. Sessionless PR runs are first-class.
	SessionID string `json:"sessionId,omitempty"`
	PRNumber  int    `json:"prNumber,omitempty"`
	HeadSHA   string `json:"headSha,omitempty"`
	// CancelReason is why a cancelled run was torn down.
	CancelReason string `json:"cancelReason,omitempty"`
	StageCount   int    `json:"stageCount"`
	// StageOutcomes maps stage id to its v2 outcome, for every planned stage.
	StageOutcomes map[string]string `json:"stageOutcomes"`
	CreatedAt     time.Time         `json:"createdAt"`
	UpdatedAt     time.Time         `json:"updatedAt"`
	SettledAt     *time.Time        `json:"settledAt,omitempty"`
}

// ListPipelineRunsResponse is the body of GET /api/v1/pipelines/runs.
type ListPipelineRunsResponse struct {
	Runs []PipelineRunSummary `json:"runs"`
}

// PipelineProducedArtifact is a stage's declared `produces` file and whether the
// engine found it. Exists=false with a name is the missing-artifact state run
// detail renders next to a no_output stage.
type PipelineProducedArtifact struct {
	Name   string `json:"name"`
	Exists bool   `json:"exists"`
}

// PipelineStageView is one stage's state within a run detail.
type PipelineStageView struct {
	StageID string `json:"stageId"`
	Outcome string `json:"outcome" enum:"pending,running,succeeded,succeeded_unverified,failed,no_output,no_signal,timed_out,cancelled,skipped"`
	// Attempt is 0 before the stage starts, 1 normally, and 2 after its one
	// nudge. Run detail tags attempt 2 as "nudged".
	Attempt    int    `json:"attempt"`
	EnteredVia string `json:"enteredVia" enum:"trigger,success,failure" description:"Which edge started this stage."`
	// FailedStage names the stage whose failure routed here, set only when
	// enteredVia is failure.
	FailedStage string `json:"failedStage,omitempty"`
	// SessionID is the AO session the stage ran in (agent stages), so the UI can
	// link straight to it. It survives a settled stage whose session was kept.
	SessionID     string     `json:"sessionId,omitempty"`
	WorkspaceKind string     `json:"workspaceKind,omitempty"`
	StartedAt     *time.Time `json:"startedAt,omitempty"`
	SettledAt     *time.Time `json:"settledAt,omitempty"`
	// Reason carries the fail reason, cancel reason, or plan-failure reason.
	Reason string `json:"reason,omitempty"`
	// OutputTail is a capped tail of the stage's captured stdout+stderr, so run
	// detail can say why a command failed without fetching the full log.
	OutputTail       string                    `json:"outputTail,omitempty"`
	ProducedArtifact *PipelineProducedArtifact `json:"producedArtifact,omitempty"`
}

// PipelineRunDetail is the full reconstructed run: the summary plus per-stage
// state, in plan order.
type PipelineRunDetail struct {
	PipelineRunSummary
	// RunDir is the run folder on disk, shown in run detail so a human can go
	// look at what actually happened.
	RunDir string              `json:"runDir,omitempty"`
	Stages []PipelineStageView `json:"stages"`
}

// PipelineRunDetailResponse is the body of GET /api/v1/pipelines/runs/{runId}
// and cancel.
type PipelineRunDetailResponse struct {
	Run PipelineRunDetail `json:"run"`
}

// TriggerPipelineRunRequest is the manual-trigger body. The subject is resolved
// server-side from these pointers: a PR number wins over a session id, and
// neither makes it a project-subject run.
type TriggerPipelineRunRequest struct {
	Pipeline  string `json:"pipeline" description:"Definition reference to run: its id or name."`
	SessionID string `json:"sessionId,omitempty" description:"Run against this session as the subject."`
	PRNumber  int    `json:"prNumber,omitempty" minimum:"1" description:"Run against this tracked pull request as the subject."`
}

// TriggerPipelineRunResponse is the body of POST /api/v1/pipelines/runs (201).
type TriggerPipelineRunResponse struct {
	RunID string `json:"runId"`
}

// PipelineStageLogResponse is the body of the stage log route: the captured
// stdout+stderr of one stage, optionally tailed.
type PipelineStageLogResponse struct {
	RunID   string `json:"runId"`
	StageID string `json:"stageId"`
	Content string `json:"content"`
	// Truncated says content is a tail, so the viewer can offer the whole log.
	Truncated bool `json:"truncated"`
}

// SignalPipelineStageRequest is the body of the stage signal route: how an
// agent settles its own stage, sent by `ao pipeline done|fail`.
type SignalPipelineStageRequest struct {
	Status string `json:"status" enum:"done,fail" description:"How the stage settled: done | fail."`
	Reason string `json:"reason,omitempty" description:"Why the stage failed. Carried on the failure edge and shown in run detail."`
}

// SignalPipelineStageResponse acknowledges a recorded signal. The stage does
// not settle here: the engine reads the signal on its next poll, so this is an
// acceptance receipt rather than an outcome.
type SignalPipelineStageResponse struct {
	Accepted bool `json:"accepted"`
}

// SetPipelineCredentialRequest is the body of the credential upsert: the whole
// environment the credential stands for. It replaces any previous environment
// under that name rather than merging, so a variable can be removed.
type SetPipelineCredentialRequest struct {
	Env map[string]string `json:"env" description:"Environment variables the credential injects, keyed by variable name. Values are write-only: no read path returns them."`
}

// PipelineCredentialResponse acknowledges a stored credential by name and the
// variable names it carries. Values are never in a response body (decision
// D13): they exist to be injected into a command stage's process env, and that
// is the only place they go.
type PipelineCredentialResponse struct {
	Name string   `json:"name"`
	Keys []string `json:"keys" description:"Names of the environment variables stored, sorted. Never their values."`
}

// ListPipelineCredentialsResponse is the body of GET /api/v1/pipelines/credentials.
// Names only, by design.
type ListPipelineCredentialsResponse struct {
	Names []string `json:"names"`
}

// DeletePipelineCredentialResponse is the body of the credential delete.
type DeletePipelineCredentialResponse struct {
	Name    string `json:"name"`
	Deleted bool   `json:"deleted"`
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

// PipelinesController owns the /pipelines routes. A nil Svc (the AO_PIPELINES
// flag off) answers 501 on every one of them.
type PipelinesController struct {
	Svc pipelinesvc.Manager
}

// Register mounts the pipeline routes. Static run/schema segments are declared
// before the {id} definition routes so chi matches them ahead of the param.
//
// There is no resume route (spec section 14.1: failed runs are dead, re-running
// means a new run) and no artifact routes: v2's replacement for the findings
// subsystem is the per-stage declared artifact served by the outputs route.
func (c *PipelinesController) Register(r chi.Router) {
	r.Get("/pipelines", c.listDefinitions)
	r.Post("/pipelines", c.createDefinition)
	r.Post("/pipelines/validate", c.validateDefinition)
	r.Get("/pipelines/schema", c.schema)

	r.Get("/pipelines/credentials", c.listCredentials)
	r.Put("/pipelines/credentials/{name}", c.setCredential)
	r.Delete("/pipelines/credentials/{name}", c.deleteCredential)

	r.Get("/pipelines/runs", c.listRuns)
	r.Post("/pipelines/runs", c.triggerRun)
	r.Get("/pipelines/runs/{runId}", c.getRun)
	r.Post("/pipelines/runs/{runId}/cancel", c.cancelRun)
	r.Post("/pipelines/runs/{runId}/stages/{stageId}/signal", c.signalStage)
	r.Get("/pipelines/runs/{runId}/stages/{stageId}/log", c.stageLog)
	r.Get("/pipelines/runs/{runId}/outputs/{filename}", c.runOutput)

	r.Put("/pipelines/{id}", c.updateDefinition)
	r.Delete("/pipelines/{id}", c.deleteDefinition)
}

// signalStagePath spells the signal route the way the OpenAPI document does.
const signalStagePath = "/api/v1/pipelines/runs/{runId}/stages/{stageId}/signal"

// signalStage records how an agent settled its own stage (spec section 6.3).
// The signal is only recorded here; the engine reads it on its next poll and
// decides the outcome, so the answer is 202 rather than the settled stage.
func (c *PipelinesController) signalStage(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, "POST", signalStagePath)
		return
	}
	var in SignalPipelineStageRequest
	if err := decodeJSON(r, &in); err != nil {
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "INVALID_JSON", "Invalid JSON body", nil)
		return
	}
	kind := pipeline.SignalKind(strings.TrimSpace(in.Status))
	if !kind.IsKnown() {
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "INVALID_SIGNAL_STATUS",
			`status must be "done" or "fail"`, nil)
		return
	}

	runID := pipeline.RunID(chi.URLParam(r, "runId"))
	stageID := chi.URLParam(r, "stageId")
	if err := c.Svc.SignalStage(r.Context(), runID, stageID, kind, strings.TrimSpace(in.Reason)); err != nil {
		writePipelineSignalError(w, r, err)
		return
	}
	envelope.WriteJSON(w, http.StatusAccepted, SignalPipelineStageResponse{Accepted: true})
}

// writePipelineSignalError maps the signal service's sentinels onto the wire
// contract, falling back to 500 for unexpected failures.
func writePipelineSignalError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, pipelinesvc.ErrRunNotFound):
		envelope.WriteAPIError(w, r, http.StatusNotFound, "not_found", "PIPELINE_RUN_NOT_FOUND", "Unknown pipeline run", nil)
	case errors.Is(err, pipelinesvc.ErrStageNotFound):
		envelope.WriteAPIError(w, r, http.StatusNotFound, "not_found", "PIPELINE_STAGE_NOT_FOUND", "Unknown pipeline stage", nil)
	case errors.Is(err, pipelinesvc.ErrStageNotRunning):
		envelope.WriteAPIError(w, r, http.StatusConflict, "conflict", "PIPELINE_STAGE_NOT_RUNNING", "Pipeline stage is not running", nil)
	case errors.Is(err, pipelinesvc.ErrUnknownSignalKind):
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "INVALID_SIGNAL_STATUS", `status must be "done" or "fail"`, nil)
	default:
		envelope.WriteAPIError(w, r, http.StatusInternalServerError, "internal", "PIPELINE_SIGNAL_FAILED", "Recording the stage signal failed", nil)
	}
}

// ---------------------------------------------------------------------------
// Run folder: stage logs and declared outputs
// ---------------------------------------------------------------------------

const (
	stageLogPath  = "/api/v1/pipelines/runs/{runId}/stages/{stageId}/log"
	runOutputPath = "/api/v1/pipelines/runs/{runId}/outputs/{filename}"
)

// stageLog serves a stage's captured stdout and stderr from the run folder's
// stage-logs directory, optionally tailed to the last N lines.
func (c *PipelinesController) stageLog(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, "GET", stageLogPath)
		return
	}
	tail := 0
	if raw := r.URL.Query().Get("tail"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n < 1 {
			envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "INVALID_TAIL", "tail must be a positive integer", nil)
			return
		}
		tail = n
	}

	runID := pipeline.RunID(chi.URLParam(r, "runId"))
	stageID := chi.URLParam(r, "stageId")
	log, err := c.Svc.StageLog(r.Context(), runID, stageID, tail)
	if err != nil {
		writeRunFileError(w, r, err)
		return
	}
	envelope.WriteJSON(w, http.StatusOK, PipelineStageLogResponse{
		RunID:     string(runID),
		StageID:   log.StageID,
		Content:   log.Content,
		Truncated: log.Truncated,
	})
}

// runOutput serves one declared artifact out of the run folder's agent-outputs
// directory, as the file itself so the browser can download it.
//
// The filename is authorization, not a path: the service matches it against the
// run's frozen `produces` set before anything touches the filesystem, so an
// undeclared name, a traversal, an absolute path and a planted symlink are all
// the same 404.
func (c *PipelinesController) runOutput(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, "GET", runOutputPath)
		return
	}
	runID := pipeline.RunID(chi.URLParam(r, "runId"))
	out, err := c.Svc.RunOutput(r.Context(), runID, chi.URLParam(r, "filename"))
	if err != nil {
		writeRunFileError(w, r, err)
		return
	}

	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	// Never let a browser render agent-authored bytes inline as HTML, and never
	// let the filename be sniffed into something else.
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": out.Filename}))
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(out.Content)
}

// writeRunFileError maps the run-folder read errors onto the wire. Every "there
// is nothing at this URL" cause is a 404: an undeclared filename must not be
// distinguishable from a missing one, or the endpoint becomes an oracle for
// what the run folder contains.
func writeRunFileError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, pipeline.ErrOutputNotDeclared):
		envelope.WriteAPIError(w, r, http.StatusNotFound, "not_found", "PIPELINE_OUTPUT_NOT_FOUND", "Unknown pipeline run output", nil)
	case errors.Is(err, pipelinesvc.ErrOutputMissing):
		envelope.WriteAPIError(w, r, http.StatusNotFound, "not_found", "PIPELINE_OUTPUT_NOT_FOUND", "Unknown pipeline run output", nil)
	case errors.Is(err, pipelinesvc.ErrStageNotFound):
		envelope.WriteAPIError(w, r, http.StatusNotFound, "not_found", "PIPELINE_STAGE_NOT_FOUND", "Unknown pipeline stage", nil)
	case errors.Is(err, pipelinesvc.ErrStageLogMissing), errors.Is(err, pipelinesvc.ErrRunFolderMissing):
		envelope.WriteAPIError(w, r, http.StatusNotFound, "not_found", "PIPELINE_STAGE_LOG_NOT_FOUND", "Pipeline stage has no log yet", nil)
	default:
		writePipelineError(w, r, err)
	}
}

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

func (c *PipelinesController) listDefinitions(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, "GET", "/api/v1/pipelines")
		return
	}
	projectID, ok := requirePipelineProject(w, r)
	if !ok {
		return
	}
	defs, err := c.Svc.ListDefinitions(r.Context(), projectID)
	if err != nil {
		writePipelineError(w, r, err)
		return
	}
	out := make([]PipelineDefinitionSummary, 0, len(defs))
	for _, d := range defs {
		out = append(out, definitionSummary(d))
	}
	envelope.WriteJSON(w, http.StatusOK, ListPipelineDefinitionsResponse{Definitions: out})
}

func (c *PipelinesController) createDefinition(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, "POST", "/api/v1/pipelines")
		return
	}
	projectID, ok := requirePipelineProject(w, r)
	if !ok {
		return
	}
	var in SavePipelineDefinitionRequest
	if err := decodeJSONStrict(r, &in); err != nil {
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "INVALID_JSON", "Invalid JSON body", nil)
		return
	}
	def, err := c.Svc.CreateDefinition(r.Context(), projectID, in.YAMLSource)
	if err != nil {
		writePipelineError(w, r, err)
		return
	}
	envelope.WriteJSON(w, http.StatusCreated, PipelineDefinitionResponse{Definition: definitionSummary(def)})
}

func (c *PipelinesController) updateDefinition(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, "PUT", "/api/v1/pipelines/{id}")
		return
	}
	var in SavePipelineDefinitionRequest
	if err := decodeJSONStrict(r, &in); err != nil {
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "INVALID_JSON", "Invalid JSON body", nil)
		return
	}
	def, err := c.Svc.UpdateDefinition(r.Context(), pipeline.ID(chi.URLParam(r, "id")), in.YAMLSource)
	if err != nil {
		writePipelineError(w, r, err)
		return
	}
	envelope.WriteJSON(w, http.StatusOK, PipelineDefinitionResponse{Definition: definitionSummary(def)})
}

func (c *PipelinesController) deleteDefinition(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, "DELETE", "/api/v1/pipelines/{id}")
		return
	}
	id := chi.URLParam(r, "id")
	if err := c.Svc.DeleteDefinition(r.Context(), pipeline.ID(id)); err != nil {
		writePipelineError(w, r, err)
		return
	}
	envelope.WriteJSON(w, http.StatusOK, DeletePipelineDefinitionResponse{ID: id, Deleted: true})
}

// validateDefinition dry-runs the YAML and returns the outcome as data: 200
// {valid, issues}. A validation failure is not a 4xx, because the editor wants
// the issue list as a result rather than an error envelope. Persists nothing.
func (c *PipelinesController) validateDefinition(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, "POST", "/api/v1/pipelines/validate")
		return
	}
	projectID, ok := requirePipelineProject(w, r)
	if !ok {
		return
	}
	var in ValidatePipelineDefinitionRequest
	if err := decodeJSONStrict(r, &in); err != nil {
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "INVALID_JSON", "Invalid JSON body", nil)
		return
	}
	valid, issues, warnings, err := c.Svc.ValidateDefinition(r.Context(), projectID, in.YAMLSource)
	if err != nil {
		writePipelineError(w, r, err)
		return
	}
	envelope.WriteJSON(w, http.StatusOK, ValidatePipelineDefinitionResponse{
		Valid:    valid,
		Issues:   validationIssues(issues),
		Warnings: validationIssues(warnings),
	})
}

// validationIssues maps the service's issue list onto the wire, never nil so a
// clean document sends [] rather than null.
func validationIssues(in []pipeline.Issue) []PipelineValidationIssue {
	out := make([]PipelineValidationIssue, 0, len(in))
	for _, is := range in {
		out = append(out, PipelineValidationIssue{Path: is.Path, Message: is.Message})
	}
	return out
}

func (c *PipelinesController) schema(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, "GET", "/api/v1/pipelines/schema")
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(c.Svc.ConfigSchema())
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

func (c *PipelinesController) listRuns(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, "GET", "/api/v1/pipelines/runs")
		return
	}
	projectID, ok := requirePipelineProject(w, r)
	if !ok {
		return
	}
	filter := pipeline.RunFilter{
		PipelineName: r.URL.Query().Get("pipeline"),
		Status:       r.URL.Query().Get("status"),
	}
	if raw := r.URL.Query().Get("limit"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n < 0 {
			envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "INVALID_LIMIT", "limit must be a non-negative integer", nil)
			return
		}
		filter.Limit = n
	}
	runs, err := c.Svc.ListRuns(r.Context(), projectID, filter)
	if err != nil {
		writePipelineError(w, r, err)
		return
	}
	out := make([]PipelineRunSummary, 0, len(runs))
	for _, run := range runs {
		out = append(out, runSummary(run))
	}
	envelope.WriteJSON(w, http.StatusOK, ListPipelineRunsResponse{Runs: out})
}

func (c *PipelinesController) getRun(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, "GET", "/api/v1/pipelines/runs/{runId}")
		return
	}
	run, err := c.Svc.GetRun(r.Context(), pipeline.RunID(chi.URLParam(r, "runId")))
	if err != nil {
		writePipelineError(w, r, err)
		return
	}
	envelope.WriteJSON(w, http.StatusOK, PipelineRunDetailResponse{Run: runDetail(run)})
}

// triggerRun starts a manual run. The body names what the run is about; the
// subject itself (including the PR's head SHA and fork provenance) is resolved
// server-side, because the fork flag decides whether credentials are injected
// anywhere in the run.
func (c *PipelinesController) triggerRun(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, "POST", "/api/v1/pipelines/runs")
		return
	}
	projectID, ok := requirePipelineProject(w, r)
	if !ok {
		return
	}
	var in TriggerPipelineRunRequest
	if err := decodeJSONStrict(r, &in); err != nil {
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "INVALID_JSON", "Invalid JSON body", nil)
		return
	}
	if in.PRNumber < 0 {
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "INVALID_PR_NUMBER", "prNumber must be a positive integer", nil)
		return
	}
	runID, err := c.Svc.TriggerRun(r.Context(), projectID, pipelinesvc.TriggerInput{
		Ref:       in.Pipeline,
		SessionID: in.SessionID,
		PRNumber:  in.PRNumber,
	})
	if err != nil {
		writePipelineError(w, r, err)
		return
	}
	envelope.WriteJSON(w, http.StatusCreated, TriggerPipelineRunResponse{RunID: string(runID)})
}

func (c *PipelinesController) cancelRun(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, "POST", "/api/v1/pipelines/runs/{runId}/cancel")
		return
	}
	projectID, ok := requirePipelineProject(w, r)
	if !ok {
		return
	}
	run, err := c.Svc.CancelRun(r.Context(), projectID, pipeline.RunID(chi.URLParam(r, "runId")))
	if err != nil {
		writePipelineError(w, r, err)
		return
	}
	envelope.WriteJSON(w, http.StatusOK, PipelineRunDetailResponse{Run: runDetail(run)})
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

const (
	credentialsPath     = "/api/v1/pipelines/credentials"
	credentialNamePath  = "/api/v1/pipelines/credentials/{name}"
	credentialNameParam = "name"
)

// listCredentials answers with the project's credential names. There is no
// route that returns a value: a credential leaves the daemon only as an
// environment variable inside a command stage's process (decision D13).
func (c *PipelinesController) listCredentials(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, "GET", credentialsPath)
		return
	}
	projectID, ok := requirePipelineProject(w, r)
	if !ok {
		return
	}
	names, err := c.Svc.ListCredentialNames(r.Context(), projectID)
	if err != nil {
		writePipelineError(w, r, err)
		return
	}
	if names == nil {
		names = []string{}
	}
	envelope.WriteJSON(w, http.StatusOK, ListPipelineCredentialsResponse{Names: names})
}

// setCredential creates or replaces one credential. The receipt echoes the
// variable names that landed, never their values.
func (c *PipelinesController) setCredential(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, "PUT", credentialNamePath)
		return
	}
	projectID, ok := requirePipelineProject(w, r)
	if !ok {
		return
	}
	var in SetPipelineCredentialRequest
	if err := decodeJSONStrict(r, &in); err != nil {
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "INVALID_JSON", "Invalid JSON body", nil)
		return
	}
	name := chi.URLParam(r, credentialNameParam)
	if err := c.Svc.SetCredential(r.Context(), projectID, name, in.Env); err != nil {
		writePipelineError(w, r, err)
		return
	}
	keys := make([]string, 0, len(in.Env))
	for key := range in.Env {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	envelope.WriteJSON(w, http.StatusOK, PipelineCredentialResponse{Name: name, Keys: keys})
}

func (c *PipelinesController) deleteCredential(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, "DELETE", credentialNamePath)
		return
	}
	projectID, ok := requirePipelineProject(w, r)
	if !ok {
		return
	}
	name := chi.URLParam(r, credentialNameParam)
	if err := c.Svc.DeleteCredential(r.Context(), projectID, name); err != nil {
		writePipelineError(w, r, err)
		return
	}
	envelope.WriteJSON(w, http.StatusOK, DeletePipelineCredentialResponse{Name: name, Deleted: true})
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// requirePipelineProject reads the mandatory `project` query parameter, writing
// a 400 and returning ok=false when it is absent.
func requirePipelineProject(w http.ResponseWriter, r *http.Request) (domain.ProjectID, bool) {
	project := r.URL.Query().Get("project")
	if project == "" {
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "PROJECT_REQUIRED", "project query parameter is required", nil)
		return "", false
	}
	return domain.ProjectID(project), true
}

// writePipelineError renders a service error. A *pipeline.ValidationError is
// unpacked into the envelope's details as the full issue list, so the editor
// surfaces every problem at once.
func writePipelineError(w http.ResponseWriter, r *http.Request, err error) {
	var verr *pipeline.ValidationError
	if errors.As(err, &verr) {
		issues := make([]map[string]string, 0, len(verr.Issues))
		for _, issue := range verr.Issues {
			issues = append(issues, map[string]string{"path": issue.Path, "message": issue.Message})
		}
		envelope.WriteAPIError(w, r, http.StatusUnprocessableEntity, "unprocessable", "PIPELINE_VALIDATION_FAILED",
			"pipeline definition is invalid", map[string]any{"issues": issues})
		return
	}
	envelope.WriteError(w, r, err)
}

func definitionSummary(d pipeline.Definition) PipelineDefinitionSummary {
	return PipelineDefinitionSummary{
		ID:         string(d.ID),
		ProjectID:  d.ProjectID,
		Name:       d.Name,
		YAMLSource: d.YAMLSource,
		CreatedAt:  d.CreatedAt,
		UpdatedAt:  d.UpdatedAt,
	}
}

// runSummary maps a v2 run onto the Kanban card's wire shape.
func runSummary(run pipeline.RunState) PipelineRunSummary {
	outcomes := make(map[string]string, len(run.Stages))
	for id, st := range run.Stages {
		outcomes[id] = string(st.Outcome)
	}
	out := PipelineRunSummary{
		RunID:         string(run.RunID),
		PipelineID:    string(run.PipelineID),
		RunNumber:     run.RunNumber,
		PipelineName:  run.PipelineName,
		Status:        string(run.Status),
		SubjectKind:   string(run.Subject.Kind),
		SessionID:     run.Subject.SessionID,
		CancelReason:  run.CancelReason,
		StageCount:    len(run.Stages),
		StageOutcomes: outcomes,
		CreatedAt:     run.CreatedAt,
		UpdatedAt:     run.UpdatedAt,
	}
	if run.Subject.PR != nil {
		out.PRNumber = run.Subject.PR.Number
		out.HeadSHA = run.Subject.PR.HeadSHA
	}
	if !run.SettledAt.IsZero() {
		settled := run.SettledAt
		out.SettledAt = &settled
	}
	return out
}

// runDetail adds per-stage state, in the definition's document order so run
// detail reads top to bottom the way the pipeline was written. Stages the plan
// never reached are simply absent from run.Stages.
func runDetail(run pipeline.RunState) PipelineRunDetail {
	folder := pipeline.RunFolder{Dir: run.RunDir}
	stages := make([]PipelineStageView, 0, len(run.Stages))
	seen := make(map[string]bool, len(run.Stages))

	appendStage := func(id string) {
		st, ok := run.Stages[id]
		if !ok || st == nil || seen[id] {
			return
		}
		seen[id] = true
		view := PipelineStageView{
			StageID:       id,
			Outcome:       string(st.Outcome),
			Attempt:       st.Attempt,
			EnteredVia:    string(st.EnteredVia),
			FailedStage:   st.FailedStage,
			SessionID:     st.SessionID,
			WorkspaceKind: string(st.WorkspaceKind),
			Reason:        st.Reason,
			OutputTail:    st.OutputTail,
		}
		if !st.StartedAt.IsZero() {
			started := st.StartedAt
			view.StartedAt = &started
		}
		if !st.SettledAt.IsZero() {
			settled := st.SettledAt
			view.SettledAt = &settled
		}
		if stage := run.Def.StageByID(id); stage != nil && stage.Produces != "" {
			view.ProducedArtifact = &PipelineProducedArtifact{
				Name: stage.Produces,
				// Verified against the run folder rather than inferred from the
				// outcome: a no_output stage and a run folder someone deleted
				// look the same in the outcome and different on disk.
				Exists: run.RunDir != "" && folder.VerifyArtifact(stage),
			}
		}
		stages = append(stages, view)
	}

	for i := range run.Def.Stages {
		appendStage(run.Def.Stages[i].ID)
	}
	// Anything the frozen definition does not list (it should be nothing) still
	// has to reach the UI rather than vanish.
	leftovers := make([]string, 0, len(run.Stages))
	for id := range run.Stages {
		if !seen[id] {
			leftovers = append(leftovers, id)
		}
	}
	sort.Strings(leftovers)
	for _, id := range leftovers {
		appendStage(id)
	}

	return PipelineRunDetail{
		PipelineRunSummary: runSummary(run),
		RunDir:             run.RunDir,
		Stages:             stages,
	}
}
