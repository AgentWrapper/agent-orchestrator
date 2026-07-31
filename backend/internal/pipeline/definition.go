package pipeline

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"time"

	"gopkg.in/yaml.v3"
)

// DefaultStageDeadline bounds any stage that declares no deadline and belongs
// to a pipeline whose defaults declare none either. Every stage has a
// deadline: an agent that hangs must eventually settle as timed_out, or the
// run board grows entries nobody ever closes (spec section 13.1).
const DefaultStageDeadline = 30 * time.Minute

// ExecutorKind names how a stage does its work. There is no agent taxonomy:
// "review agent" versus "answer agent" is a property of the stage's contract
// (`produces:`), not of the executor (spec section 6.2).
type ExecutorKind string

// Every executor kind.
const (
	ExecutorAgent   ExecutorKind = "agent"
	ExecutorCommand ExecutorKind = "command"
)

// AllExecutorKinds lists every executor kind.
var AllExecutorKinds = []ExecutorKind{ExecutorAgent, ExecutorCommand}

// IsKnown reports whether k is a defined executor kind.
func (k ExecutorKind) IsKnown() bool {
	for _, known := range AllExecutorKinds {
		if k == known {
			return true
		}
	}
	return false
}

// WorkspaceKind names the tree a stage runs in (spec section 5.1). The key
// always means what it says; only which value is the default varies by entry
// edge, so there are no hidden semantics to discover.
type WorkspaceKind string

// Every workspace kind. The zero value means the author declared nothing, in
// which case the entry edge picks the default: auto on a success entry,
// inherit on a failure entry (spec section 5.4).
const (
	WorkspaceUnset    WorkspaceKind = ""
	WorkspaceAuto     WorkspaceKind = "auto"
	WorkspaceInherit  WorkspaceKind = "inherit"
	WorkspaceSession  WorkspaceKind = "session"
	WorkspaceRun      WorkspaceKind = "run"
	WorkspaceStage    WorkspaceKind = "stage"
	WorkspaceCheckout WorkspaceKind = "checkout"
)

// AllWorkspaceKinds lists every workspace value an author can write. The unset
// zero value is deliberately absent: it is not something anyone types.
var AllWorkspaceKinds = []WorkspaceKind{
	WorkspaceAuto, WorkspaceInherit, WorkspaceSession, WorkspaceRun, WorkspaceStage, WorkspaceCheckout,
}

// IsKnown reports whether k is a workspace value an author can write.
func (k WorkspaceKind) IsKnown() bool {
	for _, known := range AllWorkspaceKinds {
		if k == known {
			return true
		}
	}
	return false
}

// PREvent names a pull-request event a pipeline reacts to. The subject is the
// PR, which may or may not have a local session tracking it.
type PREvent string

// Every PR trigger event.
const (
	PREventCreated    PREvent = "created"
	PREventUpdated    PREvent = "updated"
	PREventMergeReady PREvent = "merge-ready"
	PREventMerged     PREvent = "merged"
)

// AllPREvents lists every PR trigger event.
var AllPREvents = []PREvent{PREventCreated, PREventUpdated, PREventMergeReady, PREventMerged}

// IsKnown reports whether e is a defined PR trigger event.
func (e PREvent) IsKnown() bool {
	for _, known := range AllPREvents {
		if e == known {
			return true
		}
	}
	return false
}

// SessionEvent names a session lifecycle event a pipeline reacts to. The
// subject is that session, which always exists.
type SessionEvent string

// Every session trigger event.
const (
	SessionEventIdle    SessionEvent = "idle"
	SessionEventExited  SessionEvent = "exited"
	SessionEventBlocked SessionEvent = "blocked"
)

// AllSessionEvents lists every session trigger event.
var AllSessionEvents = []SessionEvent{SessionEventIdle, SessionEventExited, SessionEventBlocked}

// IsKnown reports whether e is a defined session trigger event.
func (e SessionEvent) IsKnown() bool {
	for _, known := range AllSessionEvents {
		if e == known {
			return true
		}
	}
	return false
}

// ConcurrencyScope decides which runs collide (spec section 10). It is paired
// with a literal group name, which decides which pipelines share a bucket; the
// effective concurrency key is (resolved scope identity, group).
type ConcurrencyScope string

// Every concurrency scope. The zero value means "the subject's natural
// scope", resolved by Subject.DefaultScope.
const (
	ConcurrencyScopeUnset   ConcurrencyScope = ""
	ConcurrencyScopePR      ConcurrencyScope = "pr"
	ConcurrencyScopeSession ConcurrencyScope = "session"
	ConcurrencyScopeProject ConcurrencyScope = "project"
)

// AllConcurrencyScopes lists every scope an author can write.
var AllConcurrencyScopes = []ConcurrencyScope{ConcurrencyScopePR, ConcurrencyScopeSession, ConcurrencyScopeProject}

// IsKnown reports whether s is a scope an author can write.
func (s ConcurrencyScope) IsKnown() bool {
	for _, known := range AllConcurrencyScopes {
		if s == known {
			return true
		}
	}
	return false
}

// Pipeline is one pipeline definition document. One pipeline per YAML
// document, authored in the definitions editor and stored in SQLite; the ID is
// assigned by the store, never part of the document.
type Pipeline struct {
	Name        string          `yaml:"name" json:"name"`
	On          TriggerSpec     `yaml:"on" json:"on"`
	Concurrency ConcurrencySpec `yaml:"concurrency" json:"concurrency"`
	Defaults    DefaultsSpec    `yaml:"defaults" json:"defaults"`
	Stages      []Stage         `yaml:"stages" json:"stages"`
}

// TriggerSpec names the events that start a run. Declaring neither family is
// legal and means a manual-only pipeline.
type TriggerSpec struct {
	PR      []PREvent      `yaml:"pr" json:"pr,omitempty"`
	Session []SessionEvent `yaml:"session" json:"session,omitempty"`
}

// ConcurrencySpec serializes runs that share an effective key. Queue depth is
// 1: a third arrival evicts the queued run rather than stacking.
type ConcurrencySpec struct {
	Scope            ConcurrencyScope `yaml:"scope" json:"scope,omitempty"`
	Group            string           `yaml:"group" json:"group,omitempty"`
	CancelInProgress bool             `yaml:"cancel-in-progress" json:"cancelInProgress,omitempty"`
}

// DefaultsSpec holds the pipeline-wide fallbacks. Deadline decodes from a Go
// duration string ("45m"), which yaml.v3 handles natively for time.Duration
// fields. OnFailure names the stage every unrouted failure lands on, so that
// silence on failure is never the accidental outcome (spec section 9.4).
type DefaultsSpec struct {
	Deadline  time.Duration `yaml:"deadline" json:"deadline,omitempty"`
	OnFailure string        `yaml:"on_failure" json:"onFailure,omitempty"`
}

// SessionSpec configures what happens to an agent stage's session once the
// stage settles.
type SessionSpec struct {
	// KillOn lists the outcomes that kill the session. A nil slice (no
	// kill-on key) means the default pair {succeeded, failed}; an explicit
	// empty list means never kill, which is correct for any stage running in
	// a user's live session.
	KillOn []Outcome `yaml:"kill-on" json:"killOn,omitempty"`
}

// Stage is one node of the state machine. Each stage names its successors, so
// the graph is a state machine rather than a DAG, which is why cycles have to
// be rejected at validation time.
type Stage struct {
	ID       string       `yaml:"id" json:"id"`
	Executor ExecutorKind `yaml:"executor" json:"executor"`

	// Agent-stage keys.
	Agent    string       `yaml:"agent" json:"agent,omitempty"`
	Prompt   string       `yaml:"prompt" json:"prompt,omitempty"`
	Produces string       `yaml:"produces" json:"produces,omitempty"`
	Session  *SessionSpec `yaml:"session" json:"session,omitempty"`

	// Command-stage keys.
	Run         string   `yaml:"run" json:"run,omitempty"`
	Credentials []string `yaml:"credentials" json:"credentials,omitempty"`

	// Common keys.
	Workspace WorkspaceKind `yaml:"workspace" json:"workspace,omitempty"`
	Deadline  time.Duration `yaml:"deadline" json:"deadline,omitempty"`
	OnSuccess StageList     `yaml:"on_success" json:"onSuccess,omitempty"`
	OnFailure string        `yaml:"on_failure" json:"onFailure,omitempty"`
	Needs     []string      `yaml:"needs" json:"needs,omitempty"`
}

// StageList is a list of stage ids that YAML may write as a bare scalar
// ("on_success: build") or as a sequence ("on_success: [a, b]"). A list fans
// out; the targets start concurrently. This is the only fan-out mechanism.
type StageList []string

// UnmarshalYAML accepts either a scalar or a sequence of scalars.
func (l *StageList) UnmarshalYAML(value *yaml.Node) error {
	if value.Kind == yaml.ScalarNode {
		var one string
		if err := value.Decode(&one); err != nil {
			return err
		}
		*l = StageList{one}
		return nil
	}
	var many []string
	if err := value.Decode(&many); err != nil {
		return err
	}
	*l = many
	return nil
}

// ParseDefinition decodes a single-document YAML pipeline definition and
// validates it, returning the normalized *Pipeline.
//
// Unknown keys are rejected (strict decoding), and every validation rule
// failure is collected into a single *ValidationError rather than stopping at
// the first one, so an author sees every problem in one pass. Warnings are
// dropped here; callers that want to surface them (the editor) call
// ParseDefinitionWithWarnings.
func ParseDefinition(src []byte) (*Pipeline, error) {
	p, _, err := ParseDefinitionWithWarnings(src)
	return p, err
}

// ParseDefinitionWithWarnings is ParseDefinition keeping the warnings.
//
// Warnings travel separately from errors all the way to the wire because a
// warned pipeline still saves and still runs: the editor renders the two
// lists differently, and folding them together would make a save look
// impossible when it is merely worth a second look.
func ParseDefinitionWithWarnings(src []byte) (*Pipeline, []Issue, error) {
	var p Pipeline
	if err := decodeStrict(src, &p); err != nil {
		return nil, nil, err
	}
	warnings, err := Validate(&p)
	if err != nil {
		return nil, warnings, err
	}
	return &p, warnings, nil
}

// decodeStrict runs one strict yaml.v3 decode into out. An empty document is
// not an error here: it decodes to the zero value and falls through to
// validation, which reports the missing name and stages together with
// everything else rather than as a bare parse failure.
func decodeStrict(src []byte, out any) error {
	dec := yaml.NewDecoder(bytes.NewReader(src))
	dec.KnownFields(true)
	if err := dec.Decode(out); err != nil {
		if errors.Is(err, io.EOF) {
			return nil
		}
		return fmt.Errorf("parse pipeline definition: %w", err)
	}
	return nil
}

// StageByID returns the stage with the given id, or nil. The returned pointer
// aliases the pipeline's own slice, so callers must not retain it across a
// mutation of Stages.
func (p *Pipeline) StageByID(id string) *Stage {
	for i := range p.Stages {
		if p.Stages[i].ID == id {
			return &p.Stages[i]
		}
	}
	return nil
}

// EntryStage returns the stage a run starts from: the first in document order.
// It returns nil for a pipeline with no stages.
func (p *Pipeline) EntryStage() *Stage {
	if len(p.Stages) == 0 {
		return nil
	}
	return &p.Stages[0]
}

// stageIDs lists every stage id in document order.
func (p *Pipeline) stageIDs() []string {
	ids := make([]string, 0, len(p.Stages))
	for i := range p.Stages {
		ids = append(ids, p.Stages[i].ID)
	}
	return ids
}

// successEdges maps each stage id to its on_success targets, in declaration
// order. Targets naming an unknown stage are kept: the unknown-stage-id rule
// owns that error, and the cycle detector tolerates dangling nodes.
func (p *Pipeline) successEdges() map[string][]string {
	edges := make(map[string][]string, len(p.Stages))
	for i := range p.Stages {
		s := &p.Stages[i]
		if len(s.OnSuccess) > 0 {
			edges[s.ID] = append(edges[s.ID], s.OnSuccess...)
		}
	}
	return edges
}

// failureEdges maps each stage id to its single failure target: the explicit
// on_failure when present, otherwise defaults.on_failure.
//
// The one carve-out (spec section 9.4): the stage named by defaults.on_failure
// does not inherit the default, because routing to itself would be a self-edge
// rejected as a cycle. Its own failure ends the branch.
func (p *Pipeline) failureEdges() map[string][]string {
	edges := make(map[string][]string, len(p.Stages))
	for i := range p.Stages {
		s := &p.Stages[i]
		switch {
		case s.OnFailure != "":
			edges[s.ID] = []string{s.OnFailure}
		case p.Defaults.OnFailure != "" && s.ID != p.Defaults.OnFailure:
			edges[s.ID] = []string{p.Defaults.OnFailure}
		}
	}
	return edges
}

// routingEdges is the union of successEdges and failureEdges: every edge a run
// can actually traverse. Success targets come first so traversal order matches
// document intent.
func (p *Pipeline) routingEdges() map[string][]string {
	success := p.successEdges()
	failure := p.failureEdges()
	edges := make(map[string][]string, len(p.Stages))
	for i := range p.Stages {
		id := p.Stages[i].ID
		combined := make([]string, 0, len(success[id])+len(failure[id]))
		combined = append(combined, success[id]...)
		combined = append(combined, failure[id]...)
		if len(combined) > 0 {
			edges[id] = combined
		}
	}
	return edges
}

// inboundSuccess maps each stage id to the set of stages that name it in their
// on_success. Failure edges are never counted: they never join and never
// require a needs key (spec section 9.2). A stage listed twice by the same
// source counts once.
func (p *Pipeline) inboundSuccess() map[string][]string {
	inbound := make(map[string][]string, len(p.Stages))
	for i := range p.Stages {
		s := &p.Stages[i]
		seen := make(map[string]bool, len(s.OnSuccess))
		for _, target := range s.OnSuccess {
			if seen[target] {
				continue
			}
			seen[target] = true
			inbound[target] = append(inbound[target], s.ID)
		}
	}
	return inbound
}

// EffectiveDeadline resolves the stage's deadline: its own, else the
// pipeline defaults, else DefaultStageDeadline. The canvas editor surfaces
// this on every stage, which was the actual goal behind bounding stages
// (spec section 13.1).
func (s *Stage) EffectiveDeadline(d DefaultsSpec) time.Duration {
	if s.Deadline > 0 {
		return s.Deadline
	}
	if d.Deadline > 0 {
		return d.Deadline
	}
	return DefaultStageDeadline
}

// EffectiveKillOn returns the outcomes that kill this stage's session. An
// absent session block, or a session block with no kill-on key, means the
// default {succeeded, failed}: no_output, no_signal and timed_out keep the
// session alive, because those are precisely the cases where a human needs to
// see what the agent was doing (spec section 7.2). An explicit empty list
// means never.
func (s *Stage) EffectiveKillOn() []Outcome {
	if s.Session == nil || s.Session.KillOn == nil {
		return []Outcome{OutcomeSucceeded, OutcomeFailed}
	}
	out := make([]Outcome, len(s.Session.KillOn))
	copy(out, s.Session.KillOn)
	return out
}

// KillsOn reports whether this stage's disposition kills its session for the
// given outcome.
//
// The list is matched literally with one exception: `succeeded` also covers
// `succeeded_unverified`. The two differ by whether there was an artifact to
// verify, not by whether the agent finished, so a stage with no `produces:`
// would otherwise keep its session alive after every clean run. That is the
// same subsumption Outcome.IsSuccess makes for the on_success edge.
func (s *Stage) KillsOn(outcome Outcome) bool {
	for _, killOn := range s.EffectiveKillOn() {
		if killOn == outcome || (killOn == OutcomeSucceeded && outcome == OutcomeSucceededUnverified) {
			return true
		}
	}
	return false
}
