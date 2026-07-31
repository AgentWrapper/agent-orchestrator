package pipeline

import (
	"errors"
	"fmt"
	"time"
)

// Plan is everything a run can know before its first stage starts: which
// stages it could reach, how long each is allowed, and which tree each will
// run in.
//
// It exists so the one impossible combination (workspace: session with no
// session) fails the run before any stage runs, with the reason stated,
// rather than half way through (spec section 5.3).
type Plan struct {
	// Reachable lists every stage the run could enter, in document order.
	Reachable []string `json:"reachable"`
	// Deadlines is the effective deadline per reachable stage.
	Deadlines map[string]time.Duration `json:"deadlines"`
	// Workspaces is the resolved tree kind per reachable stage. A stage
	// entered only via failure edges and declaring no workspace stays
	// symbolic as "inherit": the tree it gets is whichever stage routed into
	// it, known only at runtime.
	Workspaces map[string]WorkspaceKind `json:"workspaces"`
}

// ComputePlan walks the routing graph from the entry stage and resolves the
// plan for this subject.
//
// It returns an error when a reachable stage requires a session workspace the
// subject cannot supply, or when a reachable stage's credentials cannot be
// injected: the subject is a fork PR (identity-only, decision D17), or the
// project no longer defines a name the definition asks for. Fail the run;
// never silently fall back.
//
// knownCreds answers whether the project defines a credential name; a nil
// predicate skips that check, for callers with no credential store in hand
// (see KnownCredentialSet).
func ComputePlan(def *Pipeline, subject Subject, knownCreds func(string) bool) (*Plan, error) {
	entry := def.EntryStage()
	if entry == nil {
		return nil, errors.New("pipeline declares no stages")
	}

	reached, viaSuccess := walk(def, entry.ID)

	plan := &Plan{
		Reachable:  make([]string, 0, len(reached)),
		Deadlines:  make(map[string]time.Duration, len(reached)),
		Workspaces: make(map[string]WorkspaceKind, len(reached)),
	}

	for i := range def.Stages {
		s := &def.Stages[i]
		if !reached[s.ID] {
			continue
		}
		plan.Reachable = append(plan.Reachable, s.ID)
		plan.Deadlines[s.ID] = s.EffectiveDeadline(def.Defaults)

		kind := resolveWorkspace(s.Workspace, viaSuccess[s.ID], subject)
		if kind == WorkspaceSession && !subject.HasSession() {
			return nil, fmt.Errorf("stage '%s' requires workspace 'session'; %s has no local session", s.ID, subject.describe())
		}
		if err := checkCredentials(s, subject, knownCreds); err != nil {
			return nil, err
		}
		plan.Workspaces[s.ID] = kind
	}

	return plan, nil
}

// walk enumerates the stages reachable from the entry stage over
// on_success union on_failure union defaults.on_failure, and records which of
// them can be entered via a success edge.
//
// The success flag can only ever turn on, so iterating to a fixpoint settles
// in at most one pass per stage. Stage counts are small enough that the
// simple loop beats maintaining a worklist.
func walk(def *Pipeline, entryID string) (reached, viaSuccess map[string]bool) {
	success := def.successEdges()
	failure := def.failureEdges()
	order := def.stageIDs()

	reached = map[string]bool{entryID: true}
	// The entry stage is entered by the trigger, which for workspace
	// defaulting behaves like a success entry: auto, not inherit.
	viaSuccess = map[string]bool{entryID: true}

	for changed := true; changed; {
		changed = false
		for _, id := range order {
			if !reached[id] {
				continue
			}
			for _, target := range success[id] {
				if def.StageByID(target) == nil {
					continue // unknown id; the validator owns that error
				}
				if !reached[target] {
					reached[target] = true
					changed = true
				}
				if !viaSuccess[target] {
					viaSuccess[target] = true
					changed = true
				}
			}
			for _, target := range failure[id] {
				if def.StageByID(target) == nil {
					continue
				}
				if !reached[target] {
					reached[target] = true
					changed = true
				}
			}
		}
	}
	return reached, viaSuccess
}

// resolveWorkspace applies the entry-edge default and then resolves auto.
//
// The key always means what it says; only which value is the default varies
// by entry edge (spec section 5.4). A stage reachable both ways defaults by
// its success entry, because it will be entered with a resolvable tree at
// least once and inherit would be wrong there.
func resolveWorkspace(declared WorkspaceKind, enteredViaSuccess bool, subject Subject) WorkspaceKind {
	kind := declared
	if kind == WorkspaceUnset {
		if enteredViaSuccess {
			kind = WorkspaceAuto
		} else {
			kind = WorkspaceInherit
		}
	}
	if kind == WorkspaceAuto {
		if subject.HasSession() {
			return WorkspaceSession
		}
		return WorkspaceRun
	}
	return kind
}
