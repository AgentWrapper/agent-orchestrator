/**
 * Development-only preview for the Chat surface.
 *
 * Deliberately outside the `_shell` layout so it renders with no daemon, no
 * workspace query, and no session: the point is to exercise the Chat components
 * against fixtures while the daemon side is still being wired. It is not linked
 * from anywhere in the app.
 *
 *   npm run dev:web   →   http://localhost:5173/chat-preview
 *
 * Delete this route once the real session surface renders Chat from
 * `session.mode`.
 */

import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useMemo, useState } from "react";
import { ChatWorkspace } from "../components/chat/ChatWorkspace";
import { Button } from "../components/ui/button";
import {
	chatFixture,
	chatFixtureEmpty,
	chatFixtureRecovering,
} from "../lib/chat-fixture";
import type { ConversationSnapshot } from "../types/conversation";

export const Route = createFileRoute("/chat-preview")({
	component: ChatPreview,
});

const SCENARIOS = {
	live: { label: "Live turn", snapshot: chatFixture },
	recovering: { label: "Controller lost", snapshot: chatFixtureRecovering },
	empty: { label: "New session", snapshot: chatFixtureEmpty },
} satisfies Record<string, { label: string; snapshot: ConversationSnapshot }>;

type ScenarioKey = keyof typeof SCENARIOS;

function ChatPreview() {
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

	/** Locally mimics what the daemon would do, so the card can be exercised. */
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
			<div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2">
				<span className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
					chat preview · fixtures
				</span>
				<div className="ml-2 flex gap-1.5">
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
				</div>
				{log.length > 0 ? (
					<span className="ml-auto truncate font-mono text-[11px] text-muted-foreground">
						{log[0]}
					</span>
				) : null}
			</div>

			<div className="min-h-0 flex-1">
				<ChatWorkspace
					snapshot={snapshot}
					onSend={(text) => note(`send: ${text.slice(0, 48)}`)}
					onDecide={decide}
					onInterrupt={() => note("interrupt active turn")}
					onPermissionChange={(mode) => note(`permission → ${mode}`)}
				/>
			</div>
		</div>
	);
}
