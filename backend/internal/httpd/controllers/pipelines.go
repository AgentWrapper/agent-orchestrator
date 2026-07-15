package controllers

import (
	"errors"
	"net/http"
	"sort"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apispec"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/envelope"
	"github.com/aoagents/agent-orchestrator/backend/internal/pipeline"
	pipelinesvc "github.com/aoagents/agent-orchestrator/backend/internal/service/pipeline"
)

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

// PipelineArtifactIDParam carries both path segments of the artifact route.
type PipelineArtifactIDParam struct {
	RunID      string `path:"runId" description:"Pipeline run identifier."`
	ArtifactID string `path:"artifactId" description:"Artifact identifier."`
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
	Status   string `query:"status,omitempty" description:"Filter runs by loop state (running|awaiting_context|done|stalled|terminated)."`
	Limit    *int   `query:"limit,omitempty" minimum:"1" description:"Cap the number of runs returned (newest first)."`
}

// ---------------------------------------------------------------------------
// Request / response DTOs
// ---------------------------------------------------------------------------

// PipelineDefinitionSummary is the wire shape for a stored definition: identity,
// name, raw YAML as authored, and timestamps. The normalized config is not
// surfaced here — the editor works from the YAML plus the JSON schema endpoint.
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

// PipelineRunSummary is the compact per-run wire shape (list + detail base).
type PipelineRunSummary struct {
	RunID             string            `json:"runId"`
	PipelineID        string            `json:"pipelineId"`
	PipelineName      string            `json:"pipelineName"`
	SessionID         string            `json:"sessionId"`
	LoopState         string            `json:"loopState"`
	TerminationReason string            `json:"terminationReason,omitempty"`
	LoopRounds        int               `json:"loopRounds"`
	HeadSHA           string            `json:"headSha"`
	StageCount        int               `json:"stageCount"`
	StageStatuses     map[string]string `json:"stageStatuses"`
	HasOpenFindings   bool              `json:"hasOpenFindings"`
	CreatedAt         time.Time         `json:"createdAt"`
	UpdatedAt         time.Time         `json:"updatedAt"`
}

// ListPipelineRunsResponse is the body of GET /api/v1/pipelines/runs.
type ListPipelineRunsResponse struct {
	Runs []PipelineRunSummary `json:"runs"`
}

// PipelineStageView is one stage's state within a run detail. Artifact bodies
// are referenced by id (fetch one via the artifact route); materialized
// findings are included inline at the run level.
type PipelineStageView struct {
	StageName    string     `json:"stageName"`
	StageRunID   string     `json:"stageRunId"`
	Status       string     `json:"status"`
	Attempt      int        `json:"attempt"`
	Verdict      string     `json:"verdict,omitempty"`
	StartedAt    *time.Time `json:"startedAt,omitempty"`
	CompletedAt  *time.Time `json:"completedAt,omitempty"`
	ErrorMessage string     `json:"errorMessage,omitempty"`
	ArtifactIDs  []string   `json:"artifactIds"`
}

// PipelineRunDetail is the full reconstructed run: the summary plus per-stage
// state and the run's materialized findings.
type PipelineRunDetail struct {
	PipelineRunSummary
	Stages   []PipelineStageView `json:"stages"`
	Findings []pipeline.Artifact `json:"findings"`
}

// PipelineRunDetailResponse is the body of GET /api/v1/pipelines/runs/{runId},
// cancel, and resume.
type PipelineRunDetailResponse struct {
	Run PipelineRunDetail `json:"run"`
}

// TriggerPipelineRunRequest is the manual-trigger body.
type TriggerPipelineRunRequest struct {
	Pipeline  string `json:"pipeline" description:"Definition reference to run: its id or name."`
	SessionID string `json:"sessionId,omitempty" description:"Session id to scope the run's loop key."`
	HeadSHA   string `json:"headSha,omitempty" description:"Head commit SHA to pin the run to."`
}

// TriggerPipelineRunResponse is the body of POST /api/v1/pipelines/runs (201).
type TriggerPipelineRunResponse struct {
	RunID string `json:"runId"`
}

// PipelineArtifactResponse is the body of the artifact-fetch route.
type PipelineArtifactResponse struct {
	Artifact pipeline.Artifact `json:"artifact"`
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

// PipelinesController owns the /pipelines routes (definitions CRUD, runs, manual
// trigger, artifacts). A nil Svc keeps routes registered but returns 501.
type PipelinesController struct {
	Svc pipelinesvc.Manager
}

// Register mounts the pipeline routes. Static run/schema segments are declared
// before the {id} definition routes so chi matches them ahead of the param.
func (c *PipelinesController) Register(r chi.Router) {
	r.Get("/pipelines", c.listDefinitions)
	r.Post("/pipelines", c.createDefinition)
	r.Get("/pipelines/schema", c.schema)

	r.Get("/pipelines/runs", c.listRuns)
	r.Post("/pipelines/runs", c.triggerRun)
	r.Get("/pipelines/runs/{runId}", c.getRun)
	r.Post("/pipelines/runs/{runId}/cancel", c.cancelRun)
	r.Post("/pipelines/runs/{runId}/resume", c.resumeRun)
	r.Get("/pipelines/runs/{runId}/artifacts/{artifactId}", c.getArtifact)

	r.Put("/pipelines/{id}", c.updateDefinition)
	r.Delete("/pipelines/{id}", c.deleteDefinition)
}

func (c *PipelinesController) listDefinitions(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, "GET", "/api/v1/pipelines")
		return
	}
	projectID, ok := requireProject(w, r)
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
	projectID, ok := requireProject(w, r)
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

func (c *PipelinesController) schema(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, "GET", "/api/v1/pipelines/schema")
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(c.Svc.ConfigSchema())
}

func (c *PipelinesController) listRuns(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, "GET", "/api/v1/pipelines/runs")
		return
	}
	projectID, ok := requireProject(w, r)
	if !ok {
		return
	}
	filter := pipeline.RunFilter{
		PipelineName: r.URL.Query().Get("pipeline"),
		Status:       pipeline.LoopStateName(r.URL.Query().Get("status")),
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

func (c *PipelinesController) triggerRun(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, "POST", "/api/v1/pipelines/runs")
		return
	}
	projectID, ok := requireProject(w, r)
	if !ok {
		return
	}
	var in TriggerPipelineRunRequest
	if err := decodeJSONStrict(r, &in); err != nil {
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "INVALID_JSON", "Invalid JSON body", nil)
		return
	}
	runID, err := c.Svc.TriggerRun(r.Context(), projectID, pipelinesvc.TriggerInput{
		Ref:       in.Pipeline,
		SessionID: in.SessionID,
		HeadSHA:   in.HeadSHA,
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
	projectID, ok := requireProject(w, r)
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

func (c *PipelinesController) resumeRun(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, "POST", "/api/v1/pipelines/runs/{runId}/resume")
		return
	}
	projectID, ok := requireProject(w, r)
	if !ok {
		return
	}
	run, err := c.Svc.ResumeRun(r.Context(), projectID, pipeline.RunID(chi.URLParam(r, "runId")))
	if err != nil {
		writePipelineError(w, r, err)
		return
	}
	envelope.WriteJSON(w, http.StatusOK, PipelineRunDetailResponse{Run: runDetail(run)})
}

func (c *PipelinesController) getArtifact(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, "GET", "/api/v1/pipelines/runs/{runId}/artifacts/{artifactId}")
		return
	}
	art, err := c.Svc.GetArtifact(r.Context(), pipeline.ArtifactID(chi.URLParam(r, "artifactId")))
	if err != nil {
		writePipelineError(w, r, err)
		return
	}
	envelope.WriteJSON(w, http.StatusOK, PipelineArtifactResponse{Artifact: art})
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// requireProject reads the mandatory `project` query param, writing a 400 and
// returning ok=false when it is absent.
func requireProject(w http.ResponseWriter, r *http.Request) (domain.ProjectID, bool) {
	project := r.URL.Query().Get("project")
	if project == "" {
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "PROJECT_REQUIRED", "project query parameter is required", nil)
		return "", false
	}
	return domain.ProjectID(project), true
}

// writePipelineError renders a service error. A *pipeline.ValidationError is
// unpacked into the locked envelope's details as the full issue list (path +
// message per issue) so the editor can surface every problem at once; every
// other error goes through the standard apierr → status mapping.
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

func runSummary(run pipeline.RunState) PipelineRunSummary {
	statuses := make(map[string]string, len(run.Stages))
	for name, st := range run.Stages {
		statuses[name] = string(st.Status)
	}
	return PipelineRunSummary{
		RunID:             string(run.RunID),
		PipelineID:        string(run.PipelineID),
		PipelineName:      run.PipelineName,
		SessionID:         run.SessionID,
		LoopState:         string(run.LoopState),
		TerminationReason: string(run.TerminationReason),
		LoopRounds:        run.LoopRounds,
		HeadSHA:           run.HeadSHA,
		StageCount:        len(run.Stages),
		StageStatuses:     statuses,
		HasOpenFindings:   hasOpenFindings(run),
		CreatedAt:         run.CreatedAt,
		UpdatedAt:         run.UpdatedAt,
	}
}

func runDetail(run pipeline.RunState) PipelineRunDetail {
	stages := make([]PipelineStageView, 0, len(run.Stages))
	for name, st := range run.Stages {
		ids := make([]string, 0, len(st.Artifacts))
		for _, id := range st.Artifacts {
			ids = append(ids, string(id))
		}
		stages = append(stages, PipelineStageView{
			StageName:    name,
			StageRunID:   string(st.StageRunID),
			Status:       string(st.Status),
			Attempt:      st.Attempt,
			Verdict:      string(st.Verdict),
			StartedAt:    st.StartedAt,
			CompletedAt:  st.CompletedAt,
			ErrorMessage: st.ErrorMessage,
			ArtifactIDs:  ids,
		})
	}
	sort.Slice(stages, func(i, j int) bool { return stages[i].StageName < stages[j].StageName })

	findings := run.Findings
	if findings == nil {
		findings = []pipeline.Artifact{}
	}
	return PipelineRunDetail{
		PipelineRunSummary: runSummary(run),
		Stages:             stages,
		Findings:           findings,
	}
}

func hasOpenFindings(run pipeline.RunState) bool {
	for _, a := range run.Findings {
		if a.Kind == pipeline.ArtifactKindFinding && a.Status == pipeline.ArtifactStatusOpen {
			return true
		}
	}
	return false
}
