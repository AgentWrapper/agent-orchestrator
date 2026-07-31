// The three static "New pipeline" templates. Baked into the renderer (spec
// decision: no template API); each is a full PipelineDraft in the normalized
// codec shape, so instantiating one is just serializeToYaml(template.draft())
// and the result parses clean through backend ParseDefinition (/validate).
// pipeline-templates.test.ts mirrors the Go validation rules to keep them
// honest.

import type { PipelineDraft } from "./pipeline-draft";

export interface PipelineTemplate {
	id: "pr-review" | "session-idle-triage" | "release-gate";
	name: string;
	description: string;
	// Accent dot in the modal's template list.
	dotClass: string;
	// Fresh draft per call so an edited instantiation never mutates the template.
	draft: () => PipelineDraft;
}

// An agent produces the review, a command posts it: the §6.4 split that makes
// the outcome measurable, and the reason the agent stage carries no credentials.
function prReview(): PipelineDraft {
	return {
		name: "pr-review",
		on: { pr: ["created", "updated"] },
		// The head moved, so an in-flight review is reading stale code (§10). The
		// group is left implicit: it defaults to the pipeline name.
		concurrency: { scope: "pr", cancelInProgress: true },
		defaults: { onFailure: "notify-failure" },
		stages: [
			{
				id: "review",
				executor: "agent",
				agent: "claude-code",
				produces: "review.md",
				deadline: "20m",
				session: { killOn: ["succeeded", "failed"] },
				prompt: [
					"Review the diff for correctness, security, and convention drift.",
					"Write the review to $AO_OUTPUT, then `ao pipeline done`.",
					'If the change cannot be reviewed, `ao pipeline fail --reason "..."`.',
				].join("\n"),
				onSuccess: ["post-review"],
			},
			{
				id: "post-review",
				executor: "command",
				workspace: "run",
				credentials: ["github-review"],
				run: 'gh pr comment "$AO_PR_NUMBER" --body-file "$AO_RUN_DIR/agent-outputs/review.md"',
			},
			{
				id: "notify-failure",
				executor: "command",
				workspace: "run",
				run: 'echo "pr-review failed at $AO_FAILED_STAGE ($AO_FAILED_OUTCOME)"',
			},
		],
	};
}

// One agent in the user's own session, so it must never be killed (§7.2).
function sessionIdleTriage(): PipelineDraft {
	return {
		name: "session-idle-triage",
		on: { session: ["idle"] },
		// No scope: a session trigger already defaults to per-session, so the only
		// thing worth declaring is that a fresh idle event replaces a stale triage
		// rather than queueing behind it (§10).
		concurrency: { cancelInProgress: true },
		stages: [
			{
				id: "triage",
				executor: "agent",
				agent: "claude-code",
				workspace: "session",
				produces: "triage.md",
				deadline: "10m",
				// kill-on: [] never kills: this stage runs in a live human session.
				session: { killOn: [] },
				prompt: [
					"The session has gone idle. Summarize where the work stands,",
					"what is blocked, and the single next action.",
					"Write it to $AO_OUTPUT, then `ao pipeline done`.",
				].join("\n"),
			},
		],
	};
}

// A six-stage trim of the spec §11 release pipeline, keeping the four things
// that example exists to teach: the fan-out onto `workspace: stage`, the join
// declaring `needs`, credentials on the command stage that performs (never on
// the agent that produces), and one failure route reached by
// `defaults.on_failure` instead of six copies of the same key.
//
// Trimmed away, all of it recoverable by hand: the three per-OS builds collapse
// to one, signing and notarization collapse into `verify`, and §11's
// diagnose-build agent is gone (session-idle-triage already shows
// `kill-on: []`).
function releaseGate(): PipelineDraft {
	return {
		name: "release-gate",
		on: { pr: ["merged"] },
		// Nothing is worse than killing a run mid-release, so no cancellation, and
		// the scope is the project rather than the merged PR: pr.merged would
		// otherwise default to per-PR scope and let two merges release at once
		// (§10).
		concurrency: { scope: "project", group: "release", cancelInProgress: false },
		defaults: { deadline: "45m", onFailure: "notify-failure" },
		stages: [
			{
				id: "prepare",
				executor: "command",
				workspace: "run",
				run: 'mkdir -p "$AO_RUN_DIR/artifacts"\nao release resolve-version > "$AO_RUN_DIR/version"',
				onSuccess: ["build", "release-notes"],
			},
			{
				id: "build",
				executor: "command",
				// A fresh tree per entry, so a second concurrent build could never
				// share this one's node_modules (§5.2).
				workspace: "stage",
				deadline: "60m",
				run: 'npm ci\nnpm run build -- --version "$(cat "$AO_RUN_DIR/version")"\ncp -R dist/. "$AO_RUN_DIR/artifacts/"',
				onSuccess: ["verify"],
			},
			{
				id: "release-notes",
				executor: "agent",
				agent: "claude-code",
				workspace: "stage",
				produces: "release-notes.md",
				deadline: "15m",
				session: { killOn: ["succeeded", "failed"] },
				prompt: [
					'Write release notes for version $(cat "$AO_RUN_DIR/version").',
					"Group by user-visible change, not by commit.",
					"Write them to $AO_OUTPUT, then `ao pipeline done`.",
					'If there are no user-visible changes, `ao pipeline fail --reason "..."`.',
				].join("\n"),
				onSuccess: ["publish"],
			},
			{
				id: "verify",
				executor: "command",
				// The run tree, so publish sees the artifacts this stage checked.
				workspace: "run",
				run: 'ao release verify-artifacts "$AO_RUN_DIR/artifacts"',
				onSuccess: ["publish"],
			},
			{
				id: "publish",
				executor: "command",
				// Two inbound success edges, so `needs` is required and must name
				// exactly them (§13).
				needs: ["release-notes", "verify"],
				workspace: "run",
				// Credentials are engine-held and injected here, at the stage that
				// performs; the agent above cannot express the key at all (§8).
				credentials: ["github-release"],
				run: 'gh release create "v$(cat "$AO_RUN_DIR/version")" "$AO_RUN_DIR/artifacts/"* --notes-file "$AO_RUN_DIR/agent-outputs/release-notes.md"',
			},
			{
				id: "notify-failure",
				executor: "command",
				// Reached from every stage above through defaults.on_failure, so a
				// post-publication failure is never silent (§13.3).
				workspace: "run",
				run: 'echo "release failed at $AO_FAILED_STAGE ($AO_FAILED_OUTCOME)"',
			},
		],
	};
}

export const PIPELINE_TEMPLATES: PipelineTemplate[] = [
	{
		id: "pr-review",
		name: "PR review",
		description: "an agent reviews the diff, a command posts it",
		dotClass: "bg-accent",
		draft: prReview,
	},
	{
		id: "session-idle-triage",
		name: "Session idle triage",
		description: "summarize where an idle session stands",
		dotClass: "bg-warning",
		draft: sessionIdleTriage,
	},
	{
		id: "release-gate",
		name: "Release gate",
		description: "build and notes fan out, join, publish",
		dotClass: "bg-success",
		draft: releaseGate,
	},
];
