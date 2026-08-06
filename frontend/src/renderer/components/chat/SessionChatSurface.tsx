/**
 * The central surface for a chat-mode session.
 *
 * Mounted by SessionView when the session's persisted mode is `chat`. It owns the
 * conversation query and command wiring so ChatWorkspace stays a pure view of a
 * snapshot — which is what lets the same component render fixtures in the dev
 * preview and live data here.
 */

import { AlertTriangle, Loader2 } from "lucide-react";
import type { ReactNode } from "react";
import { ChatWorkspace } from "./ChatWorkspace";
import {
	useConversation,
	useConversationCommands,
	useConversationConfigOptions,
	useConversationModels,
	useConversationSkills,
	useStageAttachments,
	useWorkspaceFilePaths,
} from "../../hooks/useConversation";
import { can } from "../../types/conversation";
import type { WorkspaceSession } from "../../types/workspace";

export function SessionChatSurface({
	session,
	onOpenShell,
	openingShell,
	shellError,
	headerActions,
	controllerTransitioning,
}: {
	session: WorkspaceSession;
	onOpenShell?: () => void;
	openingShell?: boolean;
	shellError?: string;
	headerActions?: ReactNode;
	/** The target controller is being installed by an interface handoff. */
	controllerTransitioning?: boolean;
}) {
	const {
		snapshot,
		isLoading,
		unavailable,
		error,
		hasOlder,
		isLoadingOlder,
		loadOlder,
	} = useConversation(session.id);
	const commands = useConversationCommands(session.id);
	const hasProviderConfig = Boolean(snapshot && can(snapshot, "config_options"));
	// Only asked for once the conversation is actually readable: the catalog comes
	// from the live controller, so there is nothing to fetch before then.
	const { models } = useConversationModels(
		session.id,
		Boolean(snapshot) && !hasProviderConfig,
	);
	const configOptions = useConversationConfigOptions(
		session.id,
		hasProviderConfig,
	);
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
	// run Chat is a state to explain rather than an error to spin on. A compatible
	// session may switch interfaces, but retrying this failed controller by itself
	// cannot change the answer.
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
			sessionTitle={session.title}
			sessionRole={session.kind}
			headerActions={headerActions}
			controllerTransitioning={controllerTransitioning}
			hasOlder={hasOlder}
			loadingOlder={isLoadingOlder}
			onLoadOlder={loadOlder}
			busy={commands.busy}
			onSend={(text, attachments) => commands.send({ text, attachments })}
			commandError={commands.error}
			onDecide={commands.resolve}
			onResolveInput={commands.resolveInput}
			onInterrupt={commands.interrupt}
			onResumeAgent={() => {
				void commands.resumeAgent().catch(() => {});
			}}
			resumingAgent={commands.resumingAgent}
			resumeError={commands.resumeError}
			onOpenShell={onOpenShell}
			openingShell={openingShell}
			shellError={shellError}
			models={models}
			onChooseSettings={hasProviderConfig ? undefined : commands.chooseSettings}
			configOptions={configOptions.options}
			onChooseConfigOption={configOptions.setOption}
			configOptionPending={configOptions.pending}
			configOptionError={configOptions.error}
			onCompact={commands.compact}
			compacting={commands.compacting}
			compactUnavailable={commands.compactUnavailable}
			// The rejection is swallowed here because the mutation already holds it:
			// rollbackError is what the confirmation shows, and an unhandled rejection
			// would only add a console error the user cannot act on.
			onRollback={(turnId) => {
				void commands.rollback(turnId).catch(() => {});
			}}
			rollbackPending={commands.rollbackPending}
			rollbackError={commands.rollbackError}
			skills={skills}
			filePaths={paths}
			filePathsTruncated={truncated}
			onStageAttachments={stageAttachments}
			nativeImages={can(snapshot, "images")}
			// Gated on what the daemon advertises, so the control is never drawn for a
			// harness that cannot steer. The refusal check stays as a backstop: it
			// covers the window before the controller reports, and it is the last word
			// afterwards, since the capability is a property of the driver.
			onSteer={can(snapshot, "steer") && !commands.steerUnsupported ? commands.steer : undefined}
			steerPending={commands.steerPending}
			steerRefusal={commands.steerRefusal}
			onReloadMcpServers={
				!can(snapshot, "mcp_reload") || commands.mcpReloadUnsupported
					? undefined
					: () => {
							// The rejection is already held by the mutation and rendered from
							// `mcpReloadError`; rethrowing it would only add a console error.
							void commands.reloadMcpServers().catch(() => {});
						}
			}
			reloadingMcpServers={commands.reloadingMcpServers}
			mcpReloadError={commands.mcpReloadError}
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
