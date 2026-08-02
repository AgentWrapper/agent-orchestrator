/**
 * The central surface for a chat-mode session.
 *
 * Mounted by SessionView when the session's persisted mode is `chat`. It owns the
 * conversation query and command wiring so ChatWorkspace stays a pure view of a
 * snapshot — which is what lets the same component render fixtures in the dev
 * preview and live data here.
 */

import { AlertTriangle, Loader2 } from "lucide-react";
import { ChatWorkspace } from "./ChatWorkspace";
import {
	useConversation,
	useConversationCommands,
	useConversationModels,
	useConversationSkills,
	useStageAttachments,
	useWorkspaceFilePaths,
} from "../../hooks/useConversation";
import type { WorkspaceSession } from "../../types/workspace";

export function SessionChatSurface({ session }: { session: WorkspaceSession }) {
	const { snapshot, isLoading, unavailable, error } = useConversation(session.id);
	const commands = useConversationCommands(session.id);
	// Only asked for once the conversation is actually readable: the catalog comes
	// from the live controller, so there is nothing to fetch before then.
	const { models } = useConversationModels(session.id, Boolean(snapshot));
	const { skills } = useConversationSkills(session.id, Boolean(snapshot));
	const { paths, truncated } = useWorkspaceFilePaths(session.id, Boolean(snapshot));
	const stageAttachments = useStageAttachments(session.id);

	if (isLoading) {
		return (
			<Centered>
				<Loader2 aria-hidden="true" className="size-4 animate-spin text-muted-foreground" />
				<span className="text-xs text-muted-foreground">Loading conversation…</span>
			</Centered>
		);
	}

	// A chat session whose controller has not started yet, or whose agent cannot
	// run chat, is a state to explain rather than an error to retry — the mode is
	// immutable, so retrying can never change the answer.
	if (unavailable) {
		return (
			<Centered>
				<AlertTriangle aria-hidden="true" className="size-4 text-warning" />
				<strong className="text-sm text-foreground">Conversation unavailable</strong>
				<p className="max-w-sm text-center text-xs leading-relaxed text-muted-foreground">
					{unavailable.message}
				</p>
				<p className="max-w-sm text-center text-xs leading-relaxed text-muted-foreground">
					The worktree is untouched. Open a shell from the inspector to work in it directly.
				</p>
			</Centered>
		);
	}

	if (error || !snapshot) {
		return (
			<Centered>
				<AlertTriangle aria-hidden="true" className="size-4 text-destructive" />
				<p className="max-w-sm text-center text-xs leading-relaxed text-muted-foreground">
					{error ?? "Could not load this conversation."}
				</p>
			</Centered>
		);
	}

	return (
		<ChatWorkspace
			snapshot={snapshot}
			busy={commands.busy}
			onSend={commands.send}
			onDecide={commands.resolve}
			onInterrupt={commands.interrupt}
			models={models}
			onChooseSettings={commands.chooseSettings}
			skills={skills}
			filePaths={paths}
			filePathsTruncated={truncated}
			onStageAttachments={stageAttachments}
		/>
	);
}

function Centered({ children }: { children: React.ReactNode }) {
	return (
		<div className="flex h-full flex-col items-center justify-center gap-2 bg-background px-6">
			{children}
		</div>
	);
}
