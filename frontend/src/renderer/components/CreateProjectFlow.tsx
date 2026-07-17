import * as Dialog from "@radix-ui/react-dialog";
import { CheckCircle2, ChevronRight, Folder, FolderPlus, X, XCircle } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { ImportFolderScan } from "../../preload";
import { aoBridge } from "../lib/bridge";
import { apiErrorCode } from "../lib/api-client";
import { cn } from "../lib/utils";
import type { ProjectKind } from "../types/workspace";
import { CreateProjectAgentSheet, type CreateProjectAgentSelection } from "./CreateProjectAgentSheet";
import { RemoteDirectoryPickerDialog } from "./RemoteDirectoryPickerDialog";
import { Button } from "./ui/button";
import type { ImportRepoValidationCode } from "../../main/import-scan";

export type CreateProjectInput = { path: string; asWorkspace?: boolean } & CreateProjectAgentSelection;

const IMPORT_REPO_REASON_KEYS = {
	LINKED_WORKTREE: "projects.create.repositoryReasons.linkedWorktree",
	BARE_REPOSITORY: "projects.create.repositoryReasons.bareRepository",
	RESERVED_NAME: "projects.create.repositoryReasons.reservedName",
	NO_COMMITS: "projects.create.repositoryReasons.noCommits",
	NO_CHECKED_OUT_BRANCH: "projects.create.repositoryReasons.noCheckedOutBranch",
	NO_ORIGIN_REMOTE: "projects.create.repositoryReasons.noOriginRemote",
} as const satisfies Record<ImportRepoValidationCode, string>;

type CreateProjectFlowMode = ProjectKind | "choose";

// Shared create-project flow (native folder picker -> agent sheet -> create).
// Sidebar enables the import-type picker; first-run board CTAs keep the direct
// single-repo picker while still using the same Git setup recovery path.
export function CreateProjectFlow({
	children,
	idleLabel,
	mode = "single_repo",
	onCreateProject,
	onInitializeProject,
}: {
	children: (state: { choosePath: () => void; disabled: boolean; error: string | null; label: string }) => ReactNode;
	idleLabel?: string;
	mode?: CreateProjectFlowMode;
	onCreateProject: (input: CreateProjectInput) => Promise<void>;
	onInitializeProject: (path: string) => Promise<void>;
}) {
	const { t } = useTranslation();
	const [error, setError] = useState<string | null>(null);
	const [errorCode, setErrorCode] = useState<string | undefined>();
	const [modePickerOpen, setModePickerOpen] = useState(false);
	const [folderPickerOpen, setFolderPickerOpen] = useState(false);
	const [selectedKind, setSelectedKind] = useState<ProjectKind>(mode === "workspace" ? "workspace" : "single_repo");
	const [selectedPath, setSelectedPath] = useState<string | null>(null);
	const [validationScan, setValidationScan] = useState<ImportFolderScan | null>(null);
	const [isChoosingPath, setIsChoosingPath] = useState(false);
	const [isCreating, setIsCreating] = useState(false);
	const [isInitializing, setIsInitializing] = useState(false);
	const [repositorySetup, setRepositorySetup] = useState<"NOT_A_GIT_REPO" | "PROJECT_UNBORN" | null>(null);
	const [remoteClient, setRemoteClient] = useState<boolean | null>(null);
	const [remotePathDialogOpen, setRemotePathDialogOpen] = useState(false);

	useEffect(() => {
		let active = true;
		const detect = aoBridge.remoteServer?.isRemoteClient?.() ?? Promise.resolve(false);
		void detect.then((remote) => {
			if (active) setRemoteClient(remote);
		});
		return () => {
			active = false;
		};
	}, []);

	const hasModePicker = mode === "choose";
	const isBusy = isChoosingPath || isCreating || isInitializing;

	const openFolderStep = (kind: ProjectKind) => {
		// Keep the selector mounted behind the native picker. Closing it first
		// exposes a blank compositor frame on Windows before Explorer takes focus.
		void chooseDirectory(kind);
	};

	const chooseDirectory = async (kind: ProjectKind) => {
		setError(null);
		setErrorCode(undefined);
		setValidationScan(null);
		setRepositorySetup(null);
		setSelectedKind(kind);
		const isRemote = remoteClient ?? (await (aoBridge.remoteServer?.isRemoteClient?.() ?? Promise.resolve(false)));
		if (remoteClient === null) setRemoteClient(isRemote);
		if (isRemote) {
			setModePickerOpen(false);
			setFolderPickerOpen(false);
			setRemotePathDialogOpen(true);
			return;
		}
		setIsChoosingPath(true);
		try {
			const path = await aoBridge.app.chooseDirectory(
				kind === "workspace"
					? t("projects.create.chooseWorkspaceDirectory")
					: t("projects.create.chooseProjectDirectory"),
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
			setError(err instanceof Error ? err.message : t("projects.create.addFailed"));
			setErrorCode(apiErrorCode(err));
		} finally {
			setIsChoosingPath(false);
		}
	};

	const startFlow = () => {
		if (hasModePicker) {
			setError(null);
			setErrorCode(undefined);
			setModePickerOpen(true);
			return;
		}
		void chooseDirectory(mode);
	};

	const createProject = async (selection: CreateProjectAgentSelection) => {
		if (!selectedPath) return;
		setError(null);
		setErrorCode(undefined);
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
			const code = apiErrorCode(err);
			const message = err instanceof Error ? err.message : t("projects.create.addFailed");
			if (selectedKind === "single_repo" && isRepositorySetupRecoveryCode(code)) setRepositorySetup(code);
			setError(message);
			setErrorCode(code);
			if (hasModePicker && !remoteClient) {
				if (shouldScanCreateFailure(err)) {
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
		? t("projects.create.opening")
		: isInitializing
			? hasModePicker
				? t("projects.create.initializing")
				: t("projects.create.settingUp")
			: isCreating
				? t("projects.create.creating")
				: (idleLabel ?? t("projects.create.newProject"));

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
							setErrorCode(undefined);
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
									setErrorCode(undefined);
									setValidationScan(null);
								}
							}
						}}
					/>
				</>
			)}
			<RemoteDirectoryPickerDialog
				kind={selectedKind}
				open={remotePathDialogOpen}
				disabled={isBusy}
				onOpenChange={(open) => !isBusy && setRemotePathDialogOpen(open)}
				onSelect={(path) => {
					setRemotePathDialogOpen(false);
					setSelectedPath(path);
				}}
			/>
			<CreateProjectAgentSheet
				error={error}
				errorCode={errorCode}
				isCreating={isCreating}
				isInitializing={isInitializing}
				kind={selectedKind}
				onOpenChange={(open) => {
					if (!open) {
						setSelectedPath(null);
						if (!folderPickerOpen) {
							setError(null);
							setErrorCode(undefined);
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
		return scan.repos[0]?.setupCode === "PROJECT_UNBORN" ? "PROJECT_UNBORN" : null;
	} catch {
		return null;
	}
}

const SCANNABLE_CREATE_FAILURE_CODES = new Set([
	"PATH_REQUIRED",
	"INVALID_PATH",
	"NOT_A_GIT_REPO",
	"PROJECT_UNBORN",
	"PROJECT_BARE_REPOSITORY",
	"PROJECT_PATH_NOT_REPO_ROOT",
	"UNSUPPORTED_GIT_REPO",
	"PROJECT_SETUP_PATH_UNSAFE",
	"PROJECT_NESTED_REPO_SCAN_FAILED",
	"PROJECT_NESTED_GIT_REPOSITORY",
	"WORKSPACE_REPOS_REQUIRED",
	"WORKSPACE_PARENT_IS_WORKTREE",
	"WORKSPACE_PARENT_BARE",
	"WORKSPACE_CHILD_RESERVED_NAME",
	"INVALID_WORKSPACE_CHILD",
	"WORKSPACE_CHILD_IS_WORKTREE",
	"WORKSPACE_CHILD_BARE",
	"WORKSPACE_CHILD_UNBORN",
	"WORKSPACE_CHILD_DEFAULT_BRANCH_UNKNOWN",
	"WORKSPACE_CHILD_ORIGIN_REQUIRED",
	"WORKSPACE_PARENT_GITLINK",
]);

function shouldScanCreateFailure(error: unknown): boolean {
	const code = apiErrorCode(error);
	return code !== undefined && SCANNABLE_CREATE_FAILURE_CODES.has(code);
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
	const { t } = useTranslation();
	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			<Dialog.Portal>
				<Dialog.Overlay className="fixed inset-0 z-50 bg-black/55 data-[state=open]:animate-overlay-in" />
				<Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[min(720px,calc(100svh-24px))] w-[min(680px,calc(100vw-24px))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-lg border border-border bg-popover p-0 text-popover-foreground shadow-xl data-[state=open]:animate-modal-in">
					<div className="flex shrink-0 items-start justify-between gap-4 px-4 pb-3 pt-4 sm:px-6 sm:pb-4 sm:pt-5">
						<div className="min-w-0">
							<Dialog.Title className="text-[18px] font-semibold text-foreground">
								{t("projects.create.addTitle")}
							</Dialog.Title>
							<Dialog.Description className="mt-1 text-[13px] font-medium text-muted-foreground">
								{t("projects.create.chooseType")}
							</Dialog.Description>
						</div>
						<Dialog.Close asChild>
							<button
								type="button"
								className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition hover:bg-surface hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
								aria-label={t("projects.create.closeType")}
								disabled={disabled}
							>
								<X className="size-4" aria-hidden="true" />
							</button>
						</Dialog.Close>
					</div>
					<div className="grid min-h-0 gap-3 overflow-y-auto px-4 pb-4 sm:grid-cols-2 sm:px-6 sm:pb-6">
						<ProjectModeButton disabled={disabled} kind="workspace" onClick={() => onSelect("workspace")} />
						<ProjectModeButton disabled={disabled} kind="single_repo" onClick={() => onSelect("single_repo")} />
					</div>
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	);
}

function ProjectModeButton({ disabled, kind, onClick }: { disabled: boolean; kind: ProjectKind; onClick: () => void }) {
	const { t } = useTranslation();
	const isWorkspace = kind === "workspace";
	const label = isWorkspace ? t("projects.create.workspace") : t("projects.create.project");
	return (
		<button
			type="button"
			aria-label={label}
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
			<span className="block text-[15px] font-semibold text-foreground sm:text-[16px]">{label}</span>
			<span className="mt-2 block text-[12px] leading-5 text-muted-foreground sm:min-h-[40px] sm:text-[13px]">
				{isWorkspace ? t("projects.create.workspaceDescription") : t("projects.create.projectDescription")}
			</span>
			<span className="mt-3 font-mono text-[12px] font-semibold text-passive">
				<span className="mr-2 text-passive">•</span>
				{isWorkspace ? t("projects.create.multipleRepositories") : t("projects.create.oneRepository")}
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
	const { t } = useTranslation();
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
							aria-label={t("projects.create.backToType")}
							disabled={disabled}
							onClick={onBack}
						>
							<ChevronRight className="size-4 rotate-180" aria-hidden="true" />
						</button>
						<div className="min-w-0 flex-1">
							<Dialog.Title className="text-[18px] font-semibold text-foreground">
								{isWorkspace ? t("projects.create.workspaceTitle") : t("projects.create.projectTitle")}
							</Dialog.Title>
							<Dialog.Description className="mt-1 max-w-[520px] text-[13px] font-medium leading-5 text-muted-foreground">
								{isWorkspace
									? t("projects.create.workspaceFolderDescription")
									: t("projects.create.projectFolderDescription")}
							</Dialog.Description>
						</div>
						<Dialog.Close asChild>
							<button
								type="button"
								className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition hover:bg-surface hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
								aria-label={t("projects.create.closeImport")}
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
											{isWorkspace ? t("projects.create.workspaceRoot") : t("projects.create.projectFolder")}
										</div>
									</div>
									<Button type="button" variant="outline" disabled={disabled} onClick={onChooseFolder}>
										{t("projects.create.change")}
									</Button>
								</div>

								{error && (
									<div className="rounded-lg border border-destructive/40 bg-destructive/10">
										<div className="border-b border-destructive/30 px-4 py-3 font-mono text-[12px] font-semibold uppercase tracking-[0.12em] text-destructive">
											<span className="mr-2 inline-block size-2 rounded-full bg-destructive" aria-hidden="true" />
											{isWorkspace
												? t("projects.create.workspaceNotRegistered")
												: t("projects.create.projectNotRegistered")}
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
										{t("projects.create.noRepositoriesDetected")}
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
									{isWorkspace ? t("projects.create.chooseFolder") : t("projects.create.chooseProjectFolder")}
								</span>
								<span className="mt-2 max-w-full text-pretty text-[12px] text-muted-foreground sm:text-[13px]">
									{isWorkspace ? t("projects.create.workspacePickerHint") : t("projects.create.projectPickerHint")}
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
								? t("projects.create.resolveFailures", { count: failedRepos.length })
								: isWorkspace
									? t("projects.create.noRepositoriesToImport")
									: t("projects.create.noProjectSelected")}
						</p>
						<div className="flex flex-wrap items-center justify-end gap-2 sm:gap-3">
							<Button type="button" variant="outline" disabled={disabled} onClick={() => onOpenChange(false)}>
								{t("ui.cancel")}
							</Button>
							<Button type="button" variant="primary" disabled>
								{isWorkspace ? t("projects.create.importWorkspace") : t("projects.create.importProject")}
							</Button>
						</div>
					</div>
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	);
}

function ImportRepoRow({ failed = false, repo }: { failed?: boolean; repo: ImportFolderScan["repos"][number] }) {
	const { t } = useTranslation();
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
				{failed
					? repo.reasonCode
						? t(IMPORT_REPO_REASON_KEYS[repo.reasonCode])
						: t("projects.create.repositoryCannotImport")
					: `${repo.branch} ${remoteDisplay(repo.remote)}`}
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
