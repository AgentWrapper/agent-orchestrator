/**
 * Development harness for the Chat surface.
 *
 * Two modes, because both are useful:
 *
 *   /#/chat-preview                  fixtures — exercises states that are hard to
 *                                    produce on demand (controller lost, empty)
 *   /#/chat-preview?session=ao-14    the real endpoint, against a running daemon
 *
 * Deliberately outside the `_shell` layout so it renders with no workspace query.
 * Not linked from anywhere. Delete it once the real session surface renders Chat
 * from `session.mode`.
 */

import { createFileRoute, useSearch } from "@tanstack/react-router";
import { useCallback, useMemo, useState } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import { ChatWorkspace } from "../components/chat/ChatWorkspace";
import { Button } from "../components/ui/button";
import {
	useConversation,
	useConversationCommands,
	useConversationModels,
} from "../hooks/useConversation";
import { chatFixture, chatFixtureEmpty, chatFixtureRecovering } from "../lib/chat-fixture";
import type { ConversationSnapshot } from "../types/conversation";

export const Route = createFileRoute("/chat-preview")({
	validateSearch: (search: Record<string, unknown>): { session?: string } => ({
		session: typeof search.session === "string" && search.session ? search.session : undefined,
	}),
	component: ChatPreview,
});

const SCENARIOS = {
	live: { label: "Live turn", snapshot: chatFixture },
	recovering: { label: "Controller lost", snapshot: chatFixtureRecovering },
	empty: { label: "New session", snapshot: chatFixtureEmpty },
} satisfies Record<string, { label: string; snapshot: ConversationSnapshot }>;

type ScenarioKey = keyof typeof SCENARIOS;

function ChatPreview() {
	const { session } = useSearch({ from: "/chat-preview" });
	return session ? <LiveChat sessionId={session} /> : <FixtureChat />;
}

/* ---- live: the real endpoint -------------------------------------------- */

function LiveChat({ sessionId }: { sessionId: string }) {
	const { snapshot, isLoading, unavailable, error } = useConversation(sessionId);
	const commands = useConversationCommands(sessionId);
	const { models } = useConversationModels(sessionId, Boolean(snapshot));

	return (
		<div className="flex h-screen flex-col bg-background">
			<PreviewBar
				label={`live · ${sessionId}`}
				note={commands.error ?? (snapshot ? `seq ${snapshot.latestSequence}` : undefined)}
			/>
			<div className="min-h-0 flex-1">
				{isLoading ? (
					<Centered>
						<Loader2 aria-hidden="true" className="size-4 animate-spin text-muted-foreground" />
						<span className="text-xs text-muted-foreground">Loading conversation…</span>
					</Centered>
				) : unavailable ? (
					// A TUI session has no conversation and never will, so this explains
					// rather than offering a retry that cannot succeed.
					<Centered>
						<AlertTriangle aria-hidden="true" className="size-4 text-warning" />
						<strong className="text-sm text-foreground">No chat conversation</strong>
						<p className="max-w-sm text-center text-xs leading-relaxed text-muted-foreground">
							{unavailable.message}
						</p>
						<code className="text-[11px] text-muted-foreground">{unavailable.code}</code>
					</Centered>
				) : error ? (
					<Centered>
						<AlertTriangle aria-hidden="true" className="size-4 text-destructive" />
						<p className="max-w-sm text-center text-xs leading-relaxed text-muted-foreground">
							{error}
						</p>
					</Centered>
				) : snapshot ? (
					<ChatWorkspace
						snapshot={snapshot}
						busy={commands.busy}
						onSend={commands.send}
						onDecide={commands.resolve}
						onInterrupt={commands.interrupt}
						models={models}
						onChooseSettings={commands.chooseSettings}
					/>
				) : null}
			</div>
		</div>
	);
}

/* ---- fixtures: states that are hard to produce on demand ---------------- */

function FixtureChat() {
	const [scenario, setScenario] = useState<ScenarioKey>("live");
	const [overrides, setOverrides] = useState<Partial<ConversationSnapshot>>({});
	const [log, setLog] = useState<string[]>([]);

	const snapshot = useMemo(
		() => ({ ...SCENARIOS[scenario].snapshot, ...overrides }),
		[scenario, overrides],
	);

	const note = useCallback((entry: string) => {
		setLog((prev) => [entry, ...prev].slice(0, 6));
	}, []);

	// Mimics locally what the daemon would do, so the card can be exercised
	// without one running.
	const decide = useCallback(
		(requestId: string, decisionId: string) => {
			note(`resolve req ${requestId} → ${decisionId}`);
			setOverrides((prev) => {
				const base = { ...SCENARIOS[scenario].snapshot, ...prev };
				return {
					...prev,
					items: base.items.map((item) =>
						item.kind === "activity" && item.requestId === requestId
							? { ...item, status: "resolved" as const }
							: item,
					),
				};
			});
		},
		[note, scenario],
	);

	return (
		<div className="flex h-screen flex-col bg-background">
			<PreviewBar label="fixtures" note={log[0]}>
				{(Object.keys(SCENARIOS) as ScenarioKey[]).map((key) => (
					<Button
						key={key}
						type="button"
						size="sm"
						variant={key === scenario ? "primary" : "ghost"}
						onClick={() => {
							setScenario(key);
							setOverrides({});
							setLog([]);
						}}
					>
						{SCENARIOS[key].label}
					</Button>
				))}
			</PreviewBar>

			<div className="min-h-0 flex-1">
				<ChatWorkspace
					snapshot={snapshot}
					onSend={(text) => note(`send: ${text.slice(0, 48)}`)}
					onDecide={decide}
					onInterrupt={() => note("interrupt active turn")}
				/>
			</div>
		</div>
	);
}

/* ---- chrome ------------------------------------------------------------- */

function PreviewBar({
	label,
	note,
	children,
}: {
	label: string;
	note?: string;
	children?: React.ReactNode;
}) {
	return (
		<div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2">
			<span className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
				chat preview · {label}
			</span>
			{children ? <div className="ml-2 flex gap-1.5">{children}</div> : null}
			{note ? (
				<span className="ml-auto truncate font-mono text-[11px] text-muted-foreground">{note}</span>
			) : null}
		</div>
	);
}

function Centered({ children }: { children: React.ReactNode }) {
	return (
		<div className="flex h-full flex-col items-center justify-center gap-2 px-6">{children}</div>
	);
}
