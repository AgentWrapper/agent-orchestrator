/**
 * A conversation fixture for developing the Chat surface before the daemon can
 * serve one.
 *
 * The shapes are taken from a real `codex app-server` session (codex-cli
 * 0.146.0), not invented — including the details that are easy to get wrong:
 *
 *  - the approval offers `accept`, an object-shaped `acceptWithExecpolicyAmendment`,
 *    and `cancel`, with **no decline**, which is what the provider actually sent;
 *  - the command arrives wrapped in a login shell (`/bin/zsh -lc '…'`);
 *  - a command's captured output is flagged as possibly partial, because the
 *    provider's own aggregation dropped its leading bytes;
 *  - one `commandExecution` is left `running` with no completion, because the
 *    provider does start commands it then supersedes.
 */

import type { ConversationSnapshot } from "../types/conversation";

/**
 * Timestamps are relative to load so the live turn's elapsed counter reads
 * realistically instead of clamping at zero. `minute` counts forward from the
 * start of the conversation, which is placed nine minutes in the past.
 */
const CONVERSATION_START = Date.now() - 9 * 60_000;

const t = (minute: number, second = 0): string =>
	new Date(CONVERSATION_START + (minute - 31) * 60_000 + second * 1000).toISOString();

export const chatFixture: ConversationSnapshot = {
	conversationId: "conv-ao-14",
	sessionId: "ao-14",
	harness: "codex",
	mode: "chat",
	controller: { state: "busy" },
	latestSequence: 12,
	settings: { model: "gpt-5.6-terra", reasoningEffort: "high" },
	turns: [
		{
			id: "turn-1",
			state: "completed",
			providerTurnId: "019fbdd1-a5fc-7f93",
			requestedAt: t(31),
			startedAt: t(31, 1),
			completedAt: t(33, 12),
		},
		{
			id: "turn-2",
			state: "running",
			providerTurnId: "019fbdd1-fdac-76f2",
			requestedAt: t(38),
			startedAt: t(38, 1),
		},
	],
	items: [
		{
			kind: "message",
			id: "m-1",
			turnId: "turn-1",
			sequence: 1,
			revision: 0,
			role: "user",
			origin: "human",
			text: "Check the worktree state and tell me what changed since the base commit.",
			streaming: false,
			delivery: "accepted",
			createdAt: t(31),
		},
		{
			kind: "activity",
			id: "a-1",
			turnId: "turn-1",
			sequence: 2,
			revision: 0,
			activityKind: "reasoning",
			status: "completed",
			summary: "Reasoning",
			createdAt: t(31, 4),
		},
		{
			kind: "activity",
			id: "a-2",
			turnId: "turn-1",
			sequence: 3,
			revision: 1,
			activityKind: "command",
			status: "completed",
			summary: "git status --short",
			detail: {
				command: "git status --short",
				rawCommand: "/bin/zsh -lc 'git status --short'",
				cwd: "/Users/dhruv/.ao/data/worktrees/agent-orchestrator-1/ao-14",
				output: " M backend/internal/session_manager/manager.go\n M backend/internal/ports/chat.go\n",
				outputMayBePartial: true,
				exitCode: 0,
				durationMs: 31,
			},
			createdAt: t(31, 8),
		},
		{
			kind: "activity",
			id: "a-3",
			turnId: "turn-1",
			sequence: 4,
			revision: 0,
			activityKind: "file_change",
			status: "completed",
			summary: "Edited 2 files",
			detail: {
				files: [
					{ path: "backend/internal/session_manager/manager.go", additions: 184, deletions: 26 },
					{ path: "backend/internal/ports/chat.go", additions: 41, deletions: 0 },
				],
			},
			createdAt: t(32, 2),
		},
		{
			kind: "message",
			id: "m-2",
			turnId: "turn-1",
			sequence: 5,
			revision: 7,
			role: "assistant",
			origin: "provider",
			text:
				"Two files are modified against the base commit. `manager.go` carries the spawn split, " +
				"and `chat.go` adds the driver port. Nothing is staged yet, so the worktree is safe to reset " +
				"if you want to start over.",
			streaming: false,
			createdAt: t(32, 30),
		},
		{
			kind: "activity",
			id: "a-4",
			turnId: "turn-1",
			sequence: 6,
			revision: 0,
			activityKind: "usage",
			status: "completed",
			summary: "Token usage updated",
			detail: { inputTokens: 12_480, outputTokens: 612, totalTokens: 13_092 },
			createdAt: t(33, 10),
		},
		{
			kind: "message",
			id: "m-3",
			turnId: "turn-2",
			sequence: 7,
			revision: 0,
			role: "user",
			origin: "human",
			text: "Run the backend tests, then spawn a worker to write the HTTP layer.",
			streaming: false,
			delivery: "accepted",
			createdAt: t(38),
		},
		{
			kind: "message",
			id: "m-4",
			sequence: 8,
			revision: 0,
			role: "user",
			origin: "automation",
			senderLabel: "CI · agent-orchestrator #3431",
			text: "Checks failed on the base branch: lint (golangci-lint) exited 1.",
			streaming: false,
			delivery: "accepted",
			createdAt: t(38, 20),
		},
		{
			kind: "activity",
			id: "a-5",
			turnId: "turn-2",
			sequence: 9,
			revision: 0,
			activityKind: "command",
			status: "running",
			summary: "go test ./internal/...",
			detail: {
				command: "go test ./internal/...",
				rawCommand: "/bin/sh -c 'go test ./internal/...'",
				cwd: "/Users/dhruv/.ao/data/worktrees/agent-orchestrator-1/ao-14",
			},
			createdAt: t(38, 41),
		},
		{
			kind: "activity",
			id: "a-6",
			turnId: "turn-2",
			sequence: 10,
			revision: 0,
			activityKind: "plan",
			status: "completed",
			summary: "Updated plan",
			detail: {
				reason:
					"1. Land the conversation store\n2. Add the snapshot endpoint\n3. Delegate the HTTP layer to a worker",
			},
			createdAt: t(39, 2),
		},
		{
			kind: "activity",
			id: "a-7",
			turnId: "turn-2",
			sequence: 11,
			revision: 0,
			activityKind: "approval",
			status: "pending",
			summary: "Run ao spawn --project agent-orchestrator-1 --name http-layer",
			requestId: "0",
			// Exactly what the provider offered in the captured session: no decline,
			// and one object-shaped decision carrying a policy amendment.
			decisions: [
				{ id: "accept", label: "Approve" },
				{ id: "acceptWithExecpolicyAmendment", label: "Approve and remember this command" },
				{ id: "cancel", label: "Cancel" },
			],
			detail: {
				command: "ao spawn --project agent-orchestrator-1 --name http-layer --prompt '…'",
				rawCommand:
					"/bin/zsh -lc \"ao spawn --project agent-orchestrator-1 --name http-layer --prompt '…'\"",
				cwd: "/Users/dhruv/.ao/data/worktrees/agent-orchestrator-1/ao-14",
				reason: "Delegate the conversation HTTP layer to a new worker",
			},
			createdAt: t(39, 18),
		},
		{
			kind: "message",
			id: "m-5",
			turnId: "turn-2",
			sequence: 12,
			revision: 3,
			role: "assistant",
			origin: "provider",
			text: "Tests are still running. I need approval before spawning the worker, since",
			streaming: true,
			createdAt: t(39, 24),
		},
	],
};

/** A second fixture: the controller died mid-turn, which must not read as idle. */
export const chatFixtureRecovering: ConversationSnapshot = {
	...chatFixture,
	controller: {
		state: "recovering",
		error: "app-server exited during a turn; reconnecting",
	},
	turns: [{ ...chatFixture.turns[0]! }, { ...chatFixture.turns[1]!, state: "running" }],
};

/** A third: an empty conversation, the first thing a new session shows. */
export const chatFixtureEmpty: ConversationSnapshot = {
	conversationId: "conv-ao-15",
	sessionId: "ao-15",
	harness: "codex",
	mode: "chat",
	controller: { state: "ready" },
	latestSequence: 0,
	settings: {},
	turns: [],
	items: [],
};
