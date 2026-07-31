// The ambient `$AO_*` variables a stage runs with, resolved for one stage of a
// draft, plus the text helpers the prompt/run autocomplete needs.
//
// The catalog mirrors `ambientEnv` in
// backend/internal/pipeline/engine/engine.go, which is the only place the env
// map is built. Spec section 12.2 tabulates the same set, but where the two
// disagree the code is what runs and this file follows the code:
//
//   - AO_ATTEMPT is documented as "1, or 2 after a nudge". It is always 1. A
//     nudge deliberately does not relaunch the stage, and a running process's
//     environment cannot be rewritten, so the launch value stands
//     (docs/plans/2026-07-26-pipelines-v2-followups.md).
//   - AO_PREV_STAGE is set from the entry edge, so "exactly one predecessor"
//     means: entered on a success edge, and not a join (`len(needs) > 1`).
//   - AO_PR_HEAD is set for every PR subject, including one whose tracked head
//     sha is unknown, in which case it is present but empty.
//
// Availability is derived from the draft alone, so it is what the pipeline as
// written will produce. Three states, because two would have to lie: `always`
// (every run of this stage has it), `sometimes` (only some runs, `note` says
// which), `never` (`note` says what is missing). A `never` entry is still
// offered, greyed: the menu is where the model is learned.
//
// One caveat the per-entry notes cannot carry: a manual run names its own
// subject (service/pipeline resolveSubject), so it can be about a PR or a
// session that the `on:` block never mentions. The reference section states
// that once instead of qualifying every row with it.

import { draftEdges } from "./pipeline-graph";
import type { PipelineDraft, StageDraft } from "./pipeline-draft";

export type EnvAvailability = "always" | "sometimes" | "never";

export interface StageEnvVar {
	name: string;
	// One line, present tense, what the value is.
	description: string;
	// A representative value. Contextual where the draft knows the real one
	// (this stage's id, its `produces`, its sole predecessor).
	example: string;
	availability: EnvAvailability;
	// When `sometimes`, which runs have it. When `never`, what is missing.
	// Absent on `always`.
	note?: string;
}

// isAvailable is the greyed/not-greyed split the menu and the reference render.
export function isAvailable(v: StageEnvVar): boolean {
	return v.availability !== "never";
}

// The run folder root, written the way the engine's own comment does. The real
// path is absolute; the shape is what a prompt author needs.
const RUN_DIR = "<AO_DATA_DIR>/pipelines/<project>/<run-id>";

// stageEnvVars is the catalog for one stage of one draft, in spec section 12.2
// order: the seven that are always there, then the conditional ones.
export function stageEnvVars(draft: PipelineDraft, stage: StageDraft): StageEnvVar[] {
	const edges = draftEdges(draft);
	// A stage id is the config-level identity, so predecessors resolve by id.
	// An empty id cannot be routed to at all, so it has no predecessors.
	const successPreds = stage.id
		? edges.filter((e) => e.to === stage.id && e.kind === "success").map((e) => e.from)
		: [];
	const failurePreds = stage.id
		? edges.filter((e) => e.to === stage.id && e.kind !== "success").map((e) => e.from)
		: [];
	// The run starts at the first stage in document order (Pipeline.EntryStage),
	// which is therefore reachable without any inbound edge. Matched by identity
	// first so a stage with no id still resolves.
	const first = draft.stages[0];
	const isEntry = !!first && (first === stage || (!!stage.id && first.id === stage.id));
	// A join is where AO_PREV_* would be ambiguous. The engine tests `needs`,
	// not the inbound edge count, so this does too; the canvas keeps the two in
	// sync (reconcileNeeds).
	const isJoin = (stage.needs?.length ?? 0) > 1;

	const prTriggered = (draft.on?.pr?.length ?? 0) > 0;
	const sessionTriggered = (draft.on?.session?.length ?? 0) > 0;

	return [
		{
			name: "AO_PROJECT",
			description: "Id of the project this run belongs to.",
			example: "agent-orchestrator",
			availability: "always",
		},
		{
			name: "AO_RUN_ID",
			description: "Id of this run. `ao pipeline done|fail` resolves itself from it, so it is never absent.",
			example: "run-3f77f931-27ee-4185-ad3d-891226c9f874",
			availability: "always",
		},
		{
			name: "AO_RUN_DIR",
			description: "The run folder: frozen definition, run.json, Context.md, agent-outputs, stage-logs.",
			example: RUN_DIR,
			availability: "always",
		},
		{
			name: "AO_STAGE",
			description: "This stage's id. The other half of what `ao pipeline done|fail` resolves itself from.",
			example: stage.id || "review",
			availability: "always",
		},
		{
			name: "AO_ATTEMPT",
			description:
				"Always 1. A nudge does not relaunch the stage, so the environment keeps its launch value; the nudge message is what tells an agent it is on its last attempt.",
			example: "1",
			availability: "always",
		},
		{
			name: "AO_CONTEXT",
			description: "Path to Context.md, the engine's index of what earlier stages produced.",
			example: `${RUN_DIR}/Context.md`,
			availability: "always",
		},
		{
			name: "AO_WORKSPACE",
			description: "Path to the tree this stage runs in, resolved from `workspace:`.",
			example: workspaceExample(stage),
			availability: "always",
		},
		{
			name: "AO_SESSION_ID",
			description: "Id of the session the run is about.",
			example: "agent-orchestrator-152",
			...sessionAvailability(sessionTriggered, prTriggered),
		},
		...prVars(prTriggered, sessionTriggered),
		{
			name: "AO_OUTPUT",
			description:
				"Where this stage writes its declared artifact. The stage only succeeds if that file exists and is not empty.",
			example: `${RUN_DIR}/agent-outputs/${stage.produces || "review.md"}`,
			...outputAvailability(stage),
		},
		...prevVars(successPreds, failurePreds.length > 0, isEntry, isJoin),
		...failedVars(failurePreds, successPreds.length > 0, isEntry),
	];
}

// workspaceExample names the tree the stage's own `workspace:` resolves to, so
// the example is the one this stage will actually get rather than a generic
// path. `auto`/`inherit` depend on the subject and the entry edge at run time,
// which is exactly when the shape cannot be stated up front.
function workspaceExample(stage: StageDraft): string {
	switch (stage.workspace) {
		case "run":
			return `${RUN_DIR}/workspace`;
		case "stage":
			return `${RUN_DIR}/workspaces/${stage.id || "review"}`;
		case "session":
			return "<AO_DATA_DIR>/worktrees/<project>/<session-id>";
		default:
			return `${RUN_DIR}/workspace`;
	}
}

type Availability = Pick<StageEnvVar, "availability" | "note">;

function sessionAvailability(sessionTriggered: boolean, prTriggered: boolean): Availability {
	// A PR subject may or may not carry a local session, and sessionless is
	// first-class (pipeline.Subject), so a pr.* trigger alone never guarantees
	// it.
	if (sessionTriggered && !prTriggered) return { availability: "always" };
	if (sessionTriggered)
		return {
			availability: "sometimes",
			note: "PR runs only have it when a local session tracks the PR",
		};
	if (prTriggered)
		return {
			availability: "sometimes",
			note: "only when a local session tracks the PR",
		};
	return {
		availability: "never",
		note: "needs a `session.*` trigger, or a manual run naming a session",
	};
}

function prVars(prTriggered: boolean, sessionTriggered: boolean): StageEnvVar[] {
	const availability: Availability = prTriggered
		? sessionTriggered
			? { availability: "sometimes", note: "PR runs only" }
			: { availability: "always" }
		: {
				availability: "never",
				note: "needs a `pr.*` trigger, or a manual run naming a PR",
			};
	return [
		{
			name: "AO_PR_NUMBER",
			description: "Number of the pull request the run is about.",
			example: "412",
			...availability,
		},
		{
			name: "AO_PR_REPO",
			description: "The pull request's repository, as owner/name.",
			example: "AgentWrapper/agent-orchestrator",
			...availability,
		},
		{
			name: "AO_PR_HEAD",
			description: "Head commit sha of the pull request. Present but empty when no head sha is recorded for it.",
			example: "9f3c1ab4c0d2e77a1b5f8c3d9e0a2b4c6d8e0f13",
			...availability,
		},
	];
}

function outputAvailability(stage: StageDraft): Availability {
	// `produces:` is agent-only (validation), and the inspector drops it when a
	// stage switches to command, so a command stage can never express it.
	if (stage.executor !== "agent") return { availability: "never", note: "agent stages only" };
	if (!stage.produces) return { availability: "never", note: "needs `produces:`" };
	return { availability: "always" };
}

function prevVars(successPreds: string[], failureReachable: boolean, isEntry: boolean, isJoin: boolean): StageEnvVar[] {
	const availability: Availability = isJoin
		? {
				availability: "never",
				note: "unset at a join, where the predecessor would be ambiguous",
			}
		: successPreds.length === 0
			? {
					availability: "never",
					note: isEntry ? "the stage a run starts at has no predecessor" : "no stage routes here on success",
				}
			: isEntry || failureReachable
				? {
						availability: "sometimes",
						note: isEntry ? "unset when this stage starts the run" : "unset when a failure edge routes here instead",
					}
				: { availability: "always" };
	const prev = successPreds.length === 1 ? successPreds[0] : "build";
	return [
		{
			name: "AO_PREV_STAGE",
			description: "Id of the single stage that routed here on success.",
			example: prev,
			...availability,
		},
		{
			name: "AO_PREV_OUTCOME",
			description: "The outcome that stage settled on.",
			example: "succeeded",
			...availability,
		},
	];
}

function failedVars(failurePreds: string[], successReachable: boolean, isEntry: boolean): StageEnvVar[] {
	const availability: Availability =
		failurePreds.length === 0
			? {
					availability: "never",
					note: "only on stages entered via `on_failure`",
				}
			: successReachable || isEntry
				? { availability: "sometimes", note: "only when a failure routes here" }
				: { availability: "always" };
	const failed = failurePreds.length === 1 ? failurePreds[0] : "build";
	return [
		{
			name: "AO_FAILED_STAGE",
			description: "Id of the stage whose failure routed here.",
			example: failed,
			...availability,
		},
		{
			name: "AO_FAILED_OUTCOME",
			description: "The outcome that stage failed with.",
			example: "timed_out",
			...availability,
		},
	];
}

// --- completion over the prompt / run text ----------------------------------

export interface EnvCompletion {
	// Index of the `$`, i.e. where the replacement starts.
	start: number;
	// What was typed after the `$`, e.g. "AO_PR".
	query: string;
}

const WORD = /[A-Za-z0-9_]/;

// envCompletionAt reports the `$AO...` token the caret sits at the end of, or
// null. `$` alone does not open the menu: the trigger is `$AO`, so ordinary
// shell variables in a `run:` script are left alone.
//
// ponytail: the braced form `${AO_OUTPUT}` does not trigger. Extend the scan
// past a `{` if anyone writes prompts that way.
export function envCompletionAt(value: string, caret: number): EnvCompletion | null {
	if (caret < 0 || caret > value.length) return null;
	let i = caret;
	while (i > 0 && WORD.test(value[i - 1])) i -= 1;
	if (i === 0 || value[i - 1] !== "$") return null;
	const query = value.slice(i, caret);
	if (!/^ao/i.test(query)) return null;
	return { start: i - 1, query };
}

// matchEnvVars is the menu's contents for a query: prefix matches on the name,
// available ones first so a greyed entry never sits above an offered one.
export function matchEnvVars(vars: StageEnvVar[], query: string): StageEnvVar[] {
	const needle = query.toUpperCase();
	const hits = vars.filter((v) => v.name.startsWith(needle));
	return [...hits.filter(isAvailable), ...hits.filter((v) => !isAvailable(v))];
}

// applyEnvCompletion replaces the typed token with the full `$NAME` and reports
// where the caret lands.
export function applyEnvCompletion(
	value: string,
	completion: EnvCompletion,
	name: string,
): { value: string; caret: number } {
	const end = completion.start + 1 + completion.query.length;
	const inserted = `$${name}`;
	return {
		value: value.slice(0, completion.start) + inserted + value.slice(end),
		caret: completion.start + inserted.length,
	};
}
