import * as Dialog from "@radix-ui/react-dialog";
import { CheckCircle2, ChevronRight, Folder, FolderPlus, X, XCircle } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ImportFolderScan } from "../../preload";
import { aoBridge } from "../lib/bridge";
import { cn } from "../lib/utils";
import type { ProjectKind } from "../types/workspace";
import { CreateProjectAgentSheet, type CreateProjectAgentSelection } from "./CreateProjectAgentSheet";
import { Button } from "./ui/button";

export type CreateProjectInput = { path: string; asWorkspace?: boolean } & CreateProjectAgentSelection;

type CreateProjectFlowMode = ProjectKind | "choose";

// Shared create-project flow (native folder picker -> agent sheet -> create).
// Sidebar enables the import-type picker; first-run board CTAs keep the direct
// single-repo picker while still using the same Git setup recovery path.
export function CreateProjectFlow({
	children,
	idleLabel = "New project",
	mode = "single_repo",
	onCreateProject,
	onInitializeProject,
	openSignal,
}: {
	children: (state: { choosePath: () => void; disabled: boolean; error: string | null; label: string }) => ReactNode;
	idleLabel?: string;
	mode?: CreateProjectFlowMode;
	onCreateProject: (input: CreateProjectInput) => Promise<void>;
	onInitializeProject: (path: string) => Promise<void>;
	// Monotonic counter: each new value opens the flow programmatically (the ⌘N
	// "no project in scope" fallback). Lets the shortcut reuse the sidebar's own
	// create-project flow instead of a separate delegating component.
	openSignal?: number;
}) {
	const [error, setError] = useState<string | null>(null);
	const [modePickerOpen, setModePickerOpen] = useState(false);
	const [folderPickerOpen, setFolderPickerOpen] = useState(false);
	const [selectedKind, setSelectedKind] = useState<ProjectKind>(mode === "workspace" ? "workspace" : "single_repo");
	const [selectedPath, setSelectedPath] = useState<string | null>(null);
	const [validationScan, setValidationScan] = useState<ImportFolderScan | null>(null);
	const [isChoosingPath, setIsChoosingPath] = useState(false);
	const [isCreating, setIsCreating] = useState(false);
	const [isInitializing, setIsInitializing] = useState(false);
	const [repositorySetup, setRepositorySetup] = useState<"NOT_A_GIT_REPO" | "PROJECT_UNBORN" | null>(null);

	const hasModePicker = mode === "choose";
	const isBusy = isChoosingPath || isCreating || isInitializing;

	const openFolderStep = (kind: ProjectKind) => {
		// Keep the selector mounted behind the native picker. Closing it first
		// exposes a blank compositor frame on Windows before Explorer takes focus.
		void chooseDirectory(kind);
	};

	const chooseDirectory = async (kind: ProjectKind) => {
		setError(null);
		setValidationScan(null);
		setRepositorySetup(null);
		setSelectedKind(kind);
		setIsChoosingPath(true);
		try {
			const path = await aoBridge.app.chooseDirectory(
				kind === "workspace" ? "Choose a workspace folder" : "Choose a project repository",
			);
			if (path && kind === "single_repo") {
				const setupCode = await repositorySetupRequired(path);
				setRepositorySetup(setupCode);
			}
			if (path) {
				setModePickerOpen(false);
				setSelectedPath(path);
				setFolderPickerOpen(false);
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : "Could not add project");
		} finally {
			setIsChoosingPath(false);
		}
	};

	const startFlow = () => {
		if (hasModePicker) {
			setError(null);
			setModePickerOpen(true);
			return;
		}
		void chooseDirectory(mode);
	};

	// Seed with the current value so we never open on mount; open when it changes.
	const lastOpenSignal = useRef(openSignal);
	useEffect(() => {
		if (openSignal === undefined || openSignal === lastOpenSignal.current) return;
		lastOpenSignal.current = openSignal;
		startFlow();
	}, [openSignal]);

	const createProject = async (selection: CreateProjectAgentSelection) => {
		if (!selectedPath) return;
		setError(null);
		setIsCreating(true);
		try {
			if (selectedKind === "single_repo" && repositorySetup) {
				setIsCreating(false);
				setIsInitializing(true);
				await onInitializeProject(selectedPath);
				setRepositorySetup(null);
				setIsInitializing(false);
				setIsCreating(true);
			}
			await onCreateProject({ path: selectedPath, asWorkspace: selectedKind === "workspace", ...selection });
			setSelectedPath(null);
		} catch (err) {
			const code = err instanceof Error && "code" in err ? (err.code as string | undefined) : undefined;
			const message = err instanceof Error ? err.message : "Could not add project";
			if (selectedKind === "single_repo" && isRepositorySetupRecoveryCode(code)) setRepositorySetup(code);
			setError(message);
			if (hasModePicker) {
				if (shouldScanCreateFailure(message)) {
					try {
						const scan = await aoBridge.app.scanImportFolder({
							path: selectedPath,
							mode: selectedKind === "workspace" ? "workspace" : "project",
						});
						setValidationScan(scan);
					} catch {
						setValidationScan({ path: selectedPath, repos: [] });
					}
				} else {
					setValidationScan(null);
				}
				setSelectedPath(null);
				setFolderPickerOpen(true);
			}
		} finally {
			setIsCreating(false);
			setIsInitializing(false);
		}
	};

	const label = isChoosingPath
		? "Opening..."
		: isInitializing
			? hasModePicker
				? "Initializing..."
				: "Setting up..."
			: isCreating
				? "Creating..."
				: idleLabel;

	return (
		<>
			{children({
				choosePath: startFlow,
				disabled: isBusy,
				error,
				label,
			})}
			{hasModePicker && (
				<>
					<CreateProjectModeDialog
						disabled={isBusy}
						open={modePickerOpen}
						onOpenChange={(open) => !isBusy && setModePickerOpen(open)}
						onSelect={openFolderStep}
					/>
					<CreateProjectFolderDialog
						disabled={isBusy}
						error={error}
						kind={selectedKind}
						open={folderPickerOpen}
						scan={validationScan}
						onBack={() => {
							setError(null);
							setValidationScan(null);
							setFolderPickerOpen(false);
							window.requestAnimationFrame(() => setModePickerOpen(true));
						}}
						onChooseFolder={() => void chooseDirectory(selectedKind)}
						onOpenChange={(open) => {
							if (!isBusy) {
								setFolderPickerOpen(open);
								if (!open) {
									setError(null);
									setValidationScan(null);
								}
							}
						}}
					/>
				</>
			)}
			<CreateProjectAgentSheet
				error={error}
				isCreating={isCreating}
				isInitializing={isInitializing}
				kind={selectedKind}
				onOpenChange={(open) => {
					if (!open) {
						setSelectedPath(null);
						if (!folderPickerOpen) {
							setError(null);
						}
					}
				}}
				onSubmit={createProject}
				open={selectedPath !== null}
				path={selectedPath}
				repositorySetupNeeded={repositorySetup !== null}
			/>
			{error && !hasModePicker && (
				<span className="sr-only" role="status">
					{error}
				</span>
			)}
		</>
	);
}

function isRepositorySetupRecoveryCode(code: string | undefined): code is "NOT_A_GIT_REPO" | "PROJECT_UNBORN" {
	return code === "NOT_A_GIT_REPO" || code === "PROJECT_UNBORN";
}

async function repositorySetupRequired(path: string): Promise<"NOT_A_GIT_REPO" | "PROJECT_UNBORN" | null> {
	try {
		const scan = await aoBridge.app.scanImportFolder({ path, mode: "project" });
		if (scan.repos.length === 0) return "NOT_A_GIT_REPO";
		return scan.repos[0]?.reason === "Repository must have at least one commit." ? "PROJECT_UNBORN" : null;
	} catch {
		return null;
	}
}

function shouldScanCreateFailure(message: string): boolean {
	if (/daemon|server|conflict|already exists|not ready|start|orchestrator|permission denied/i.test(message))
		return false;
	if (/\b(?:PATH|ID)_ALREADY_REGISTERED\b/i.test(message) || /already registered/i.test(message)) return false;
	return /workspace|repo|repository|git|path|folder|worktree|bare|branch|commit|remote/i.test(message);
}

function CreateProjectModeDialog({
	disabled,
	onOpenChange,
	onSelect,
	open,
}: {
	disabled: boolean;
	onOpenChange: (open: boolean) => void;
	onSelect: (kind: ProjectKind) => void;
	open: boolean;
}) {
	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			<Dialog.Portal>
				<Dialog.Overlay className="fixed inset-0 z-50 bg-black/55 data-[state=open]:animate-overlay-in" />
				<Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[min(720px,calc(100svh-24px))] w-[min(680px,calc(100vw-24px))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-lg border border-border bg-popover p-0 text-popover-foreground shadow-xl data-[state=open]:animate-modal-in">
					<div className="flex shrink-0 items-start justify-between gap-4 px-4 pb-3 pt-4 sm:px-6 sm:pb-4 sm:pt-5">
						<div className="min-w-0">
							<Dialog.Title className="text-[18px] font-semibold text-foreground">
								Import to Agent Orchestrator
							</Dialog.Title>
							<Dialog.Description className="mt-1 text-[13px] font-medium text-muted-foreground">
								What are you importing?
							</Dialog.Description>
						</div>
						<Dialog.Close asChild>
							<button
								type="button"
								className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition hover:bg-surface hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
								aria-label="Close new project dialog"
								disabled={disabled}
							>
								<X className="size-4" aria-hidden="true" />
							</button>
						</Dialog.Close>
					</div>
					<div className="grid min-h-0 gap-3 overflow-y-auto px-4 pb-4 sm:grid-cols-2 sm:px-6 sm:pb-6">
						<ProjectModeButton
							description="Several Git repos that live under one parent folder."
							disabled={disabled}
							kind="workspace"
							onClick={() => onSelect("workspace")}
						/>
						<ProjectModeButton
							description="A single Git repository — one codebase, tracked in one repo."
							disabled={disabled}
							kind="single_repo"
							onClick={() => onSelect("single_repo")}
						/>
					</div>
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	);
}

function ProjectModeButton({
	description,
	disabled,
	kind,
	onClick,
}: {
	description: string;
	disabled: boolean;
	kind: ProjectKind;
	onClick: () => void;
}) {
	const isWorkspace = kind === "workspace";
	return (
		<button
			type="button"
			aria-label={isWorkspace ? "Workspace" : "Project"}
			className="flex min-h-[176px] w-full flex-col justify-end rounded-lg border border-border bg-card px-4 py-4 text-left transition-colors hover:bg-background focus-visible:bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 disabled:pointer-events-none disabled:opacity-50 sm:min-h-[220px] sm:px-5 sm:py-5"
			disabled={disabled}
			onClick={onClick}
		>
			<span className="mb-3 flex min-h-[70px] w-full items-center justify-center sm:mb-4 sm:min-h-[92px]">
				{isWorkspace ? (
					<span className="mx-auto w-[min(210px,100%)] rounded-lg border border-dashed border-border px-3 py-3">
						<span className="mx-auto mb-2 flex w-[min(160px,100%)] items-center gap-2 font-mono text-[11px] font-semibold text-muted-foreground">
							<Folder className="size-3.5" aria-hidden="true" />
							my-workspace/
						</span>
						{["web-app", "api-server", "shared-libs"].map((repo) => (
							<span
								key={repo}
								className="mx-auto mb-1.5 flex w-[min(170px,100%)] items-center gap-2 rounded-md bg-background px-2.5 py-1.5 font-mono text-[12px] font-semibold text-foreground last:mb-0"
							>
								<span className="size-1.5 rounded-full bg-success" aria-hidden="true" />
								{repo}
							</span>
						))}
					</span>
				) : (
					<span className="mx-auto max-w-full rounded-lg border border-border bg-background px-4 py-3 font-mono text-[12px] font-semibold text-foreground sm:px-5 sm:py-3.5 sm:text-[13px]">
						<span className="mr-2 inline-block size-1.5 rounded-full bg-success" aria-hidden="true" />
						web-app <span className="px-2 text-muted-foreground">·</span>
						<span className="text-muted-foreground">main</span>
					</span>
				)}
			</span>
			<span className="block text-[15px] font-semibold text-foreground sm:text-[16px]">
				{isWorkspace ? "Workspace" : "Project"}
			</span>
			<span className="mt-2 block text-[12px] leading-5 text-muted-foreground sm:min-h-[40px] sm:text-[13px]">
				{description}
			</span>
			<span className="mt-3 font-mono text-[12px] font-semibold text-passive">
				<span className="mr-2 text-passive">•</span>
				{isWorkspace ? "Multiple repositories" : "One repository"}
			</span>
		</button>
	);
}

function CreateProjectFolderDialog({
	disabled,
	error,
	kind,
	onBack,
	onChooseFolder,
	onOpenChange,
	open,
	scan,
}: {
	disabled: boolean;
	error: string | null;
	kind: ProjectKind;
	onBack: () => void;
	onChooseFolder: () => void;
	onOpenChange: (open: boolean) => void;
	open: boolean;
	scan: ImportFolderScan | null;
}) {
	const isWorkspace = kind === "workspace";
	const failedRepos = scan?.repos.filter((repo) => repo.status === "error" || !repo.hasRemote) ?? [];
	const hasScan = scan !== null;
	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			<Dialog.Portal>
				<Dialog.Overlay className="fixed inset-0 z-50 bg-black/55 data-[state=open]:animate-overlay-in" />
				<Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[min(640px,calc(100svh-24px))] w-[min(640px,calc(100vw-24px))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-lg border border-border bg-popover p-0 text-popover-foreground shadow-xl data-[state=open]:animate-modal-in">
					<div className="flex shrink-0 items-start gap-3 border-b border-border px-4 py-4 sm:gap-4 sm:px-6 sm:py-5">
						<button
							type="button"
							className="grid size-8 shrink-0 place-items-center rounded-lg border border-border text-muted-foreground transition hover:bg-surface hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
							aria-label="Back to import type"
							disabled={disabled}
							onClick={onBack}
						>
							<ChevronRight className="size-4 rotate-180" aria-hidden="true" />
						</button>
						<div className="min-w-0 flex-1">
							<Dialog.Title className="text-[18px] font-semibold text-foreground">
								{isWorkspace ? "Import workspace" : "Import project"}
							</Dialog.Title>
							<Dialog.Description className="mt-1 max-w-[520px] text-[13px] font-medium leading-5 text-muted-foreground">
								{isWorkspace
									? "Pick a folder that contains your Git repositories. Each repo inside it joins the workspace."
									: "Import a single Git repository as one project."}
							</Dialog.Description>
						</div>
						<Dialog.Close asChild>
							<button
								type="button"
								className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition hover:bg-surface hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
								aria-label="Close import dialog"
								disabled={disabled}
							>
								<X className="size-4" aria-hidden="true" />
							</button>
						</Dialog.Close>
					</div>
					<div className="min-h-0 overflow-y-auto px-4 py-4 sm:px-6 sm:py-6">
						{hasScan ? (
							<div className="space-y-4">
								<div className="flex items-center gap-3 rounded-lg border border-border bg-background px-4 py-3">
									<Folder className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
									<div className="min-w-0 flex-1">
										<div className="truncate font-mono text-[14px] font-semibold text-foreground">
											{displayImportPath(scan.path)}
										</div>
										<div className="mt-0.5 text-[12px] text-muted-foreground">
											{isWorkspace ? "Workspace root" : "Project folder"}
										</div>
									</div>
									<Button type="button" variant="outline" disabled={disabled} onClick={onChooseFolder}>
										Change
									</Button>
								</div>

								{error && (
									<div className="rounded-lg border border-destructive/40 bg-destructive/10">
										<div className="border-b border-destructive/30 px-4 py-3 font-mono text-[12px] font-semibold uppercase tracking-[0.12em] text-destructive">
											<span className="mr-2 inline-block size-2 rounded-full bg-destructive" aria-hidden="true" />
											Import failed · {isWorkspace ? "workspace" : "project"} not registered
										</div>
										<div className="px-4 py-3 text-[12px] leading-5 text-destructive">{error}</div>
										{failedRepos.length > 0 && (
											<div className="border-t border-destructive/30">
												{failedRepos.map((repo) => (
													<ImportRepoRow key={repo.path} repo={repo} failed />
												))}
											</div>
										)}
									</div>
								)}

								{scan.repos
									.filter((repo) => repo.status !== "error" && repo.hasRemote)
									.map((repo) => (
										<div key={repo.path} className="rounded-lg border border-border bg-background">
											<ImportRepoRow repo={repo} />
										</div>
									))}

								{scan.repos.length === 0 && (
									<div className="rounded-lg border border-border bg-background px-4 py-4 text-[12px] text-muted-foreground">
										No repositories detected in this folder.
									</div>
								)}
							</div>
						) : (
							<button
								type="button"
								className="flex min-h-[132px] w-full flex-col items-center justify-center rounded-lg border border-dashed border-border bg-background px-4 py-5 text-center transition-colors hover:bg-surface disabled:pointer-events-none disabled:opacity-50 sm:min-h-[160px] sm:px-5 sm:py-6"
								disabled={disabled}
								onClick={onChooseFolder}
							>
								<span className="mb-4 grid size-11 place-items-center rounded-xl bg-card text-muted-foreground">
									<FolderPlus className="size-5" aria-hidden="true" />
								</span>
								<span className="text-[15px] font-semibold text-foreground">
									{isWorkspace ? "Choose a folder" : "Choose a project folder"}
								</span>
								<span className="mt-2 max-w-full text-pretty text-[12px] text-muted-foreground sm:text-[13px]">
									{isWorkspace
										? "Opens your system file picker — pick the folder that holds your repos"
										: "Opens your system file picker — select one repo folder"}
								</span>
							</button>
						)}
						{error && !hasScan && (
							<div
								className={cn(
									"mt-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[12px] leading-5 text-destructive",
								)}
							>
								{error}
							</div>
						)}
					</div>
					<div className="flex shrink-0 flex-col gap-3 border-t border-border px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
						<p className="text-[12px] font-medium text-muted-foreground">
							{hasScan && failedRepos.length > 0
								? `Resolve ${failedRepos.length} failed ${failedRepos.length === 1 ? "repository" : "repositories"} to continue`
								: isWorkspace
									? "No repositories to import"
									: "No project selected"}
						</p>
						<div className="flex flex-wrap items-center justify-end gap-2 sm:gap-3">
							<Button type="button" variant="outline" disabled={disabled} onClick={() => onOpenChange(false)}>
								Cancel
							</Button>
							<Button type="button" variant="primary" disabled>
								{isWorkspace ? "Import workspace" : "Import project"}
							</Button>
						</div>
					</div>
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	);
}

function ImportRepoRow({ failed = false, repo }: { failed?: boolean; repo: ImportFolderScan["repos"][number] }) {
	return (
		<div className="flex items-center gap-3 px-4 py-3">
			{failed ? (
				<XCircle className="size-5 shrink-0 text-destructive" aria-hidden="true" />
			) : (
				<CheckCircle2 className="size-5 shrink-0 text-success" aria-hidden="true" />
			)}
			<div className="min-w-0 flex-1">
				<div className="truncate text-[14px] font-semibold text-foreground">{repo.name}</div>
				<div className="mt-0.5 truncate font-mono text-[12px] text-muted-foreground">
					{displayImportPath(repo.path)}
				</div>
			</div>
			<div
				className={cn(
					"hidden max-w-[260px] shrink-0 truncate text-right font-mono text-[12px] sm:block",
					failed ? "text-muted-foreground" : "text-muted-foreground",
				)}
			>
				{failed ? (repo.reason ?? "Repository cannot be imported") : `${repo.branch} ${remoteDisplay(repo.remote)}`}
			</div>
		</div>
	);
}

function displayImportPath(value: string) {
	return value.replace(/^\/Users\/[^/]+/, "~");
}

function remoteDisplay(remote: string) {
	const ssh = remote.match(/^[^@]+@([^:]+):(.+)$/);
	if (ssh?.[1] && ssh[2]) return `${ssh[1]}/${ssh[2].replace(/\.git$/, "")}`;
	try {
		const url = new URL(remote);
		return `${url.host}${url.pathname.replace(/\.git$/, "")}`;
	} catch {
		return remote.replace(/^https?:\/\//, "").replace(/\.git$/, "");
	}
}
