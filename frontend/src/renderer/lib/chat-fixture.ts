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

import type {
	ConversationItem,
	ConversationSnapshot,
	ConversationTurn,
} from "../types/conversation";

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
			// A settled turn diff, parsed by the daemon out of the one aggregated
			// unified diff string `turn/diff/updated` carries.
			diff: {
				files: [
					{ path: "backend/internal/ports/chat.go", additions: 34, deletions: 2, status: "modified" },
					{ path: "backend/internal/adapters/chatdriver/codexappserver/diff.go", additions: 128, deletions: 0, status: "added" },
					{ path: "backend/internal/chat/legacy_shim.go", additions: 0, deletions: 61, status: "deleted" },
					{ path: "backend/internal/chat/normalize.go", oldPath: "backend/internal/chat/translate.go", additions: 4, deletions: 4, status: "renamed" },
				],
			},
		},
		{
			id: "turn-2",
			state: "running",
			providerTurnId: "019fbdd1-fdac-76f2",
			requestedAt: t(38),
			startedAt: t(38, 1),
			// Still running, so the list can still grow. The panel says so rather than
			// looking like a final answer.
			diff: {
				files: [
					{ path: "backend/internal/storage/sqlite/queries/conversations.sql", additions: 27, deletions: 0, status: "modified" },
				],
				truncated: true,
			},
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
				outputSource: "aggregate",
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
				"if you want to start over.\n\n" +
				"```go\n" +
				"// Spawn hands the worker its own worktree before the agent starts.\n" +
				"func (m *Manager) Spawn(ctx context.Context, req SpawnRequest) (*Session, error) {\n" +
				'\tif req.Project == "" {\n' +
				'\t\treturn nil, fmt.Errorf("spawn: %w", ErrProjectRequired)\n' +
				"\t}\n" +
				"\ttree, err := m.worktrees.Create(ctx, req.Project, req.Branch)\n" +
				"\tif err != nil {\n" +
				"\t\treturn nil, err\n" +
				"\t}\n" +
				"\treturn m.start(ctx, tree, req.Kind == KindOrchestrator)\n" +
				"}\n" +
				"```\n\n" +
				"The port itself is small:\n\n" +
				"```ts\n" +
				"export interface ChatDriver {\n" +
				"\tsend(text: string, settings?: TurnSettings): Promise<TurnId>;\n" +
				"\tresolve(requestId: string, decisionId: string): Promise<void>;\n" +
				"\tinterrupt(): Promise<void>;\n" +
				"}\n" +
				"```\n\n" +
				"One line you will want to wrap rather than scroll:\n\n" +
				"```sh\n" +
				"AO_DATA_DIR=~/.ao go test ./internal/... -run 'TestConversation|TestSpawn' -count=1 -race -timeout 300s -coverprofile=/tmp/ao-cover.out && go tool cover -func=/tmp/ao-cover.out | tail -1\n" +
				"```\n\n" +
				"A fence with no language is still a block, not inline code:\n\n" +
				"```\n" +
				"ok  \tgithub.com/aoagents/ao/internal/domain\t0.412s\n" +
				"```",
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
				// A command still running, already printing. Before output deltas were
				// accumulated there was nothing to show here until it finished, because
				// the provider's aggregate does not exist until completion.
				output:
					"ok  \tgithub.com/aoagents/agent-orchestrator/backend/internal/domain\t0.412s\n" +
					"ok  \tgithub.com/aoagents/agent-orchestrator/backend/internal/ports\t0.286s\n" +
					"ok  \tgithub.com/aoagents/agent-orchestrator/backend/internal/service/chat\t11.554s\n",
				outputSource: "stream",
				outputMayBePartial: true,
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

/**
 * A settled conversation: nothing in flight, and the thread has a name.
 *
 * This is the state the history operations live in. Undo is only offered while the
 * agent is idle, so the live fixture (which is mid-turn on purpose) cannot show it.
 */
export const chatFixtureSettled: ConversationSnapshot = {
	...chatFixture,
	controller: { state: "ready" },
	title: "Restore Canvas Renderer Fallback",
	turns: chatFixture.turns.map((turn) =>
		turn.state === "running"
			? { ...turn, state: "completed" as const, completedAt: t(39, 40) }
			: turn,
	),
};

/**
 * A long conversation, for the case the fixtures above cannot show: an
 * orchestrator session that has been running for hours.
 *
 * Generated rather than transcribed because the point is the shape and the count,
 * not the content — a real capture of this length would be thousands of lines of
 * fixture nobody reads. The proportions are taken from real sessions: a few tool
 * calls per turn, prose at the end of most of them, code in about one in three.
 */
export function chatFixtureLongHistory(turns: number): ConversationSnapshot {
	const items: ConversationItem[] = [];
	const conversationTurns: ConversationTurn[] = [];
	let sequence = 0;

	for (let index = 0; index < turns; index += 1) {
		const turnId = `turn-h${index}`;
		const minute = index * 3;
		conversationTurns.push({
			id: turnId,
			state: "completed",
			requestedAt: t(minute),
			startedAt: t(minute, 1),
			completedAt: t(minute, 40 + (index % 20)),
		});

		items.push({
			kind: "message",
			id: `hm-${index}`,
			turnId,
			sequence: (sequence += 1),
			revision: 0,
			role: "user",
			origin: "human",
			text: `${QUESTIONS[index % QUESTIONS.length]} (round ${index + 1})`,
			streaming: false,
			delivery: "accepted",
			createdAt: t(minute),
		});

		for (let call = 0; call < 3 + (index % 3); call += 1) {
			items.push({
				kind: "activity",
				id: `ha-${index}-${call}`,
				turnId,
				sequence: (sequence += 1),
				revision: 0,
				activityKind: "command",
				status: "completed",
				summary: COMMANDS[(index + call) % COMMANDS.length]!,
				detail: {
					command: COMMANDS[(index + call) % COMMANDS.length]!,
					output: `line one\nline two\nline three\n`,
					exitCode: 0,
					durationMs: 12 + call * 7,
				},
				createdAt: t(minute, 5 + call * 3),
			});
		}

		items.push({
			kind: "activity",
			id: `hf-${index}`,
			turnId,
			sequence: (sequence += 1),
			revision: 0,
			activityKind: "file_change",
			status: "completed",
			summary: "Edited 1 file",
			detail: {
				files: [
					{
						path: `backend/internal/${SUBJECTS[index % SUBJECTS.length]}/handler.go`,
						additions: 12 + index,
						deletions: index % 7,
					},
				],
			},
			createdAt: t(minute, 25),
		});

		items.push({
			kind: "message",
			id: `hr-${index}`,
			turnId,
			sequence: (sequence += 1),
			revision: 2,
			role: "assistant",
			origin: "provider",
			text:
				`Done. ${SUBJECTS[index % SUBJECTS.length]} now returns the durable snapshot instead of ` +
				`re-deriving it, and the handler is thinner by ${8 + index} lines.` +
				(index % 3 === 0
					? `\n\n\`\`\`go\nfunc (h *Handler) snapshot(ctx context.Context, id string) (*Conversation, error) {\n\treturn h.store.Snapshot(ctx, id)\n}\n\`\`\``
					: ""),
			streaming: false,
			createdAt: t(minute, 38),
		});
	}

	return {
		conversationId: "conv-ao-long",
		sessionId: "ao-long",
		harness: "codex",
		mode: "chat",
		controller: { state: "ready" },
		latestSequence: sequence,
		settings: { model: "gpt-5.6-terra", reasoningEffort: "medium" },
		turns: conversationTurns,
		items,
	};
}

const QUESTIONS = [
	"Wire the snapshot endpoint into the handler",
	"Why is the conversation store re-deriving turn state?",
	"Move the approval fan-out behind the port",
	"Check the migration applies on an existing database",
];

const COMMANDS = [
	"rg -n 'Snapshot' backend/internal",
	"go build ./...",
	"git diff --stat",
	"sed -n '1,80p' backend/internal/domain/conversation.go",
	"go test ./internal/conversation/...",
];

const SUBJECTS = ["conversation", "session_manager", "httpd", "ports"];

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
