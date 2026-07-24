import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { useCommandPaletteEnabled } from "../hooks/useCommandPaletteEnabled";
import { useWorkspaceQuery, workspaceQueryKey } from "../hooks/useWorkspaceQuery";
import { aoBridge } from "../lib/bridge";
import {
	buildCommands,
	displayGroups,
	type CommandItem as CommandItemModel,
	type NavigateTarget,
} from "../lib/command-palette";
import { isDialogOrMenuOpen } from "../lib/dom-selectors";
import { spawnOrchestrator } from "../lib/spawn-orchestrator";
import { useShell } from "../lib/shell-context";
import { findProjectOrchestrator } from "../types/workspace";
import { useUiStore } from "../stores/ui-store";
import { CreateProjectFlow } from "./CreateProjectFlow";
import { NewTaskDialog } from "./NewTaskDialog";
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "./ui/command";

function isMacPlatform(): boolean {
	return typeof navigator !== "undefined" && /Mac|iPod|iPhone|iPad/.test(navigator.userAgent);
}

function terminalHasFocus(): boolean {
	if (typeof document === "undefined") return false;
	const active = document.activeElement;
	return active instanceof Element && active.closest(".xterm") !== null;
}

export function CommandPalette() {
	const enabled = useCommandPaletteEnabled();
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const params = useParams({ strict: false }) as { projectId?: string; sessionId?: string };
	const workspaces = useWorkspaceQuery().data ?? [];
	const { createProject, initializeProjectRepository } = useShell();
	const resolvedTheme = useUiStore((s) => s.resolvedTheme);
	const setThemePreference = useUiStore((s) => s.setThemePreference);
	const isOpen = useUiStore((s) => s.isCommandPaletteOpen);
	const setOpen = useUiStore((s) => s.setCommandPaletteOpen);
	const restartingProjectIds = useUiStore((s) => s.restartingProjectIds);

	const [query, setQuery] = useState("");
	const [selectedValue, setSelectedValue] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [newTaskProjectId, setNewTaskProjectId] = useState<string | undefined>();
	const [isNewTaskOpen, setIsNewTaskOpen] = useState(false);
	const [pendingId, setPendingId] = useState<string | null>(null);
	const pendingRef = useRef(false);
	const choosePathRef = useRef<(() => void) | null>(null);

	const currentSession = params.sessionId
		? workspaces.flatMap((w) => w.sessions).find((s) => s.id === params.sessionId)
		: undefined;
	const currentProjectId = currentSession?.workspaceId ?? params.projectId;

	const items = useMemo(
		() =>
			buildCommands({
				workspaces,
				currentProjectId,
				currentSessionId: params.sessionId,
				restartingProjectIds,
			}),
		[workspaces, currentProjectId, params.sessionId, restartingProjectIds],
	);
	const groups = useMemo(() => displayGroups(items, query), [items, query]);

	const visibleItems = useMemo(() => groups.flatMap((group) => group.items), [groups]);
	const value =
		(visibleItems.some((item) => item.id === selectedValue && !item.disabled)
			? selectedValue
			: (visibleItems.find((item) => !item.disabled) ?? visibleItems[0])?.id) ?? "";

	const closePalette = useCallback(() => {
		setOpen(false);
		setQuery("");
		setSelectedValue("");
		setError(null);
	}, [setOpen]);

	const toggleTheme = useCallback(() => {
		setThemePreference(resolvedTheme === "dark" ? "light" : "dark");
	}, [resolvedTheme, setThemePreference]);

	const navigateToTarget = useCallback(
		(target: NavigateTarget) => {
			switch (target.to) {
				case "/settings":
					void navigate({ to: "/settings" });
					break;
				case "/projects/$projectId":
					void navigate({ to: target.to, params: target.params });
					break;
				case "/projects/$projectId/settings":
					void navigate({ to: target.to, params: target.params });
					break;
				case "/projects/$projectId/sessions/$sessionId":
					void navigate({ to: target.to, params: target.params });
					break;
			}
		},
		[navigate],
	);

	const blockedByRestart = useCallback((projectId: string) => {
		if (!useUiStore.getState().restartingProjectIds.has(projectId)) return false;
		setError("Orchestrator is restarting");
		return true;
	}, []);

	const openOrchestrator = useCallback(
		async (projectId: string) => {
			if (blockedByRestart(projectId)) return;
			const orchestrator = findProjectOrchestrator(workspaces, projectId);
			if (orchestrator) {
				navigateToTarget({
					to: "/projects/$projectId/sessions/$sessionId",
					params: { projectId, sessionId: orchestrator.id },
				});
				closePalette();
				return;
			}
			const sessionId = await spawnOrchestrator(projectId, "command_palette");
			await queryClient.invalidateQueries({ queryKey: workspaceQueryKey });
			navigateToTarget({ to: "/projects/$projectId/sessions/$sessionId", params: { projectId, sessionId } });
			closePalette();
		},
		[workspaces, navigateToTarget, queryClient, closePalette, blockedByRestart],
	);

	const runAction = useCallback(
		async (item: CommandItemModel) => {
			const action = item.action;
			if (!action) return;
			setError(null);
			pendingRef.current = true;
			setPendingId(item.id);
			try {
				switch (action.kind) {
					case "navigate":
						navigateToTarget(action.target);
						closePalette();
						break;
					case "toggle-theme":
						toggleTheme();
						closePalette();
						break;
					case "copy-branch":
						await aoBridge.clipboard.writeText(action.branch);
						closePalette();
						break;
					case "open-new-task":
						if (blockedByRestart(action.projectId)) break;
						setNewTaskProjectId(action.projectId);
						setIsNewTaskOpen(true);
						closePalette();
						break;
					case "open-new-project":
						closePalette();
						choosePathRef.current?.();
						break;
					case "open-orchestrator":
						await openOrchestrator(action.projectId);
						break;
				}
			} catch (err) {
				setError(err instanceof Error ? err.message : "Command failed");
			} finally {
				pendingRef.current = false;
				setPendingId(null);
			}
		},
		[navigateToTarget, closePalette, toggleTheme, openOrchestrator, blockedByRestart],
	);

	const onSelectItem = useCallback(
		(item: CommandItemModel) => {
			if (item.disabled || !item.action) return;
			if (pendingRef.current) return;
			void runAction(item);
		},
		[runAction],
	);

	const handleTaskCreated = useCallback(
		async (sessionId: string) => {
			if (!newTaskProjectId) return;
			await queryClient.invalidateQueries({ queryKey: workspaceQueryKey });
			void navigate({
				to: "/projects/$projectId/sessions/$sessionId",
				params: { projectId: newTaskProjectId, sessionId },
			});
		},
		[navigate, newTaskProjectId, queryClient],
	);

	useEffect(() => {
		if (!enabled) return;
		const handleKeyDown = (event: KeyboardEvent) => {
			if (isOpen && (event.metaKey || event.ctrlKey) && /^[1-9]$/.test(event.key)) {
				event.preventDefault();
				event.stopPropagation();
				return;
			}

			if (event.altKey || event.shiftKey || event.key.toLowerCase() !== "k") return;

			const isMac = isMacPlatform();
			const paletteModifier = isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
			if (!paletteModifier) return;

			if (isOpen) {
				event.preventDefault();
				closePalette();
				return;
			}
			// Returns without preventDefault so a focused terminal keeps Ctrl+K for readline's kill-to-end-of-line.
			if (!isMac && terminalHasFocus()) return;
			if (isDialogOrMenuOpen()) return;
			event.preventDefault();
			setOpen(true);
		};
		window.addEventListener("keydown", handleKeyDown, true);
		return () => window.removeEventListener("keydown", handleKeyDown, true);
	}, [enabled, isOpen, setOpen, closePalette]);

	if (!enabled) return null;

	return (
		<>
			<CommandDialog
				open={isOpen}
				onOpenChange={(open) => (open ? setOpen(true) : closePalette())}
				commandProps={{
					shouldFilter: false,
					value,
					onValueChange: setSelectedValue,
					loop: true,
					label: "Command palette",
				}}
			>
				<CommandInput
					value={query}
					onValueChange={(next) => {
						setQuery(next);
						setError(null);
					}}
					placeholder="Search projects, sessions, PRs, and commands…"
				/>
				<CommandList>
					<CommandEmpty>No results.</CommandEmpty>
					{error && (
						<div
							role="alert"
							className="mx-1 mb-1 overflow-hidden rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs wrap-break-word text-destructive"
						>
							{error}
						</div>
					)}
					{groups.map((group) => (
						<CommandGroup key={group.id} heading={group.label}>
							{group.items.map((item) => (
								<CommandItem
									key={item.id}
									value={item.id}
									disabled={item.disabled || (pendingId !== null && pendingId !== item.id)}
									onSelect={() => onSelectItem(item)}
								>
									<span className="min-w-0 flex-1 truncate">{item.title}</span>
									{pendingId === item.id ? (
										<Loader2 className="ml-auto size-3.5 animate-spin text-passive" aria-hidden="true" />
									) : item.disabled && item.disabledReason ? (
										<span className="ml-auto text-2xs text-passive">{item.disabledReason}</span>
									) : item.subtitle ? (
										<span className="ml-auto max-w-[45%] truncate text-2xs text-passive">{item.subtitle}</span>
									) : null}
								</CommandItem>
							))}
						</CommandGroup>
					))}
				</CommandList>
			</CommandDialog>

			<NewTaskDialog
				open={isNewTaskOpen}
				projectId={newTaskProjectId}
				onCreated={(sessionId) => void handleTaskCreated(sessionId)}
				onOpenChange={setIsNewTaskOpen}
			/>

			<CreateProjectFlow
				mode="choose"
				onCreateProject={createProject}
				onInitializeProject={initializeProjectRepository}
			>
				{({ choosePath }) => <BindChoosePath choosePath={choosePath} choosePathRef={choosePathRef} />}
			</CreateProjectFlow>
		</>
	);
}

function BindChoosePath({
	choosePath,
	choosePathRef,
}: {
	choosePath: () => void;
	choosePathRef: MutableRefObject<(() => void) | null>;
}) {
	useEffect(() => {
		choosePathRef.current = choosePath;
		return () => {
			choosePathRef.current = null;
		};
	}, [choosePath, choosePathRef]);
	return null;
}
