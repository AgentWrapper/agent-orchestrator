import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, Eye, EyeOff, Pencil, Plus, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { components } from "../../api/schema";
import {
	scmConnectionsQueryKey,
	type SCMConnection,
	useSCMConnections,
} from "../hooks/useSCMConnections";
import { apiClient, apiErrorCode, apiErrorMessage } from "../lib/api-client";
import {
	defaultSCMApiBaseUrl,
	defaultSCMWebBaseUrl,
	deriveProviderRepo,
	type SCMProvider,
} from "../lib/scm-repo";
import { Button } from "./ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./ui/tooltip";

type SCMProjectConfig = components["schemas"]["DomainSCMProjectConfig"];
type SCMConnectionTestResult = components["schemas"]["SCMConnectionTestResult"];

export type SCMSelection = {
	provider: SCMProvider;
	connectionId: string;
	repo: string;
};

type TestState =
	| { key: string; kind: "success"; result: SCMConnectionTestResult }
	| { key: string; kind: "error"; error: unknown };

type ConnectionTestVariables = Readonly<{
	provider: SCMProvider;
	connectionId: string;
	repository: string;
	testKey: string;
}>;

const GITHUB_DEFAULT_ID = "github-default";

const STATUS_KEYS = {
	unknown: "projects.scm.status.unknown",
	connected: "projects.scm.status.connected",
	missing_credential: "projects.scm.status.missingCredential",
	unauthorized: "projects.scm.status.unauthorized",
	forbidden: "projects.scm.status.forbidden",
	unreachable: "projects.scm.status.unreachable",
	tls_error: "projects.scm.status.tlsError",
	rate_limited: "projects.scm.status.rateLimited",
} as const;

const ERROR_STATUS_KEYS: Record<string, keyof typeof STATUS_KEYS> = {
	SCM_AUTH_FAILED: "unauthorized",
	SCM_FORBIDDEN: "forbidden",
	SCM_INSTANCE_UNREACHABLE: "unreachable",
	SCM_TLS_FAILED: "tls_error",
	SCM_RATE_LIMITED: "rate_limited",
};

const ERROR_DETAIL_KEYS = {
	SCM_AUTH_FAILED: "errors.codes.SCM_AUTH_FAILED",
	SCM_FORBIDDEN: "errors.codes.SCM_FORBIDDEN",
	SCM_INSTANCE_UNREACHABLE: "errors.codes.SCM_INSTANCE_UNREACHABLE",
	SCM_TLS_FAILED: "errors.codes.SCM_TLS_FAILED",
	SCM_RATE_LIMITED: "errors.codes.SCM_RATE_LIMITED",
} as const;

type LocalSCMFailure = { localCode: "TEST_RESULT_MISSING" | "SAVE_RESULT_MISSING" };

function isLocalSCMFailure(error: unknown): error is LocalSCMFailure {
	return typeof error === "object" && error !== null && "localCode" in error;
}

function testErrorText(error: unknown, t: TFunction): { label: string; message: string } {
	if (isLocalSCMFailure(error)) {
		return { label: t("projects.scm.connectionFailed"), message: t("projects.scm.connectionFailed") };
	}
	const code = apiErrorCode(error);
	const status = code ? ERROR_STATUS_KEYS[code] : undefined;
	const detailKey = code && code in ERROR_DETAIL_KEYS ? ERROR_DETAIL_KEYS[code as keyof typeof ERROR_DETAIL_KEYS] : undefined;
	return {
		label: status ? t(STATUS_KEYS[status]) : t("projects.scm.connectionFailed"),
		message: detailKey ? t(detailKey) : apiErrorMessage(error, t("projects.scm.connectionFailed")),
	};
}

export function scmSelectionConfig(value: SCMSelection): SCMProjectConfig | undefined {
	const repo = value.repo.trim() || undefined;
	if (value.provider === "github" && value.connectionId === GITHUB_DEFAULT_ID && !repo) return undefined;
	return {
		provider: value.provider,
		connectionId: value.connectionId || undefined,
		repo,
	};
}

export function SCMConnectionFields({
	compact = false,
	onChange,
	onValidationChange,
	origin,
	value,
}: {
	compact?: boolean;
	onChange: (value: SCMSelection) => void;
	onValidationChange?: (valid: boolean) => void;
	origin?: string;
	value: SCMSelection;
}) {
	const { t } = useTranslation();
	const queryClient = useQueryClient();
	const connectionsQuery = useSCMConnections();
	const connections = connectionsQuery.data ?? [];
	const [dialogMode, setDialogMode] = useState<"create" | "edit" | null>(null);
	const [testState, setTestState] = useState<TestState | null>(null);
	const effectiveRepo = value.repo.trim() || deriveProviderRepo(origin, value.provider) || "";
	const testKey = `${value.connectionId}|${effectiveRepo}`;
	const selected = connections.find((connection) => connection.id === value.connectionId);
	const providerConnections = connections.filter((connection) => connection.provider === value.provider);
	const isGitHubDefault = value.provider === "github" && value.connectionId === GITHUB_DEFAULT_ID;
	const validated =
		isGitHubDefault ||
		(testState?.key === testKey && testState.kind === "success" && testState.result.status === "connected");

	useEffect(() => onValidationChange?.(validated), [onValidationChange, validated]);
	useEffect(() => {
		if (value.connectionId || connectionsQuery.isLoading) return;
		const connectionId =
			value.provider === "github"
				? GITHUB_DEFAULT_ID
				: connections.find((connection) => connection.provider === value.provider)?.id;
		if (connectionId) onChange({ ...value, connectionId });
	}, [connections, connectionsQuery.isLoading, onChange, value]);

	const testMutation = useMutation({
		mutationFn: async (variables: ConnectionTestVariables) => {
			const { data, error } = await apiClient.POST("/api/v1/scm/connections/{id}/test", {
				params: { path: { id: variables.connectionId } },
				body: { repository: variables.repository },
			});
			if (error) {
				throw error;
			}
			if (!data?.result) throw { localCode: "TEST_RESULT_MISSING" } satisfies LocalSCMFailure;
			return data.result;
		},
		onSuccess: (result, variables) => {
			setTestState({ key: variables.testKey, kind: "success", result });
			queryClient.setQueryData<SCMConnection[]>(scmConnectionsQueryKey, (current = []) =>
				current.map((connection) =>
					connection.provider === variables.provider && connection.id === variables.connectionId
						? { ...connection, status: result.status, username: result.identity.username }
						: connection,
				),
			);
		},
		onError: (error, variables) => {
			setTestState({
				key: variables.testKey,
				kind: "error",
				error,
			});
		},
	});

	const changeProvider = (provider: SCMProvider) => {
		const connectionId =
			provider === "github"
				? GITHUB_DEFAULT_ID
				: connections.find((connection) => connection.provider === provider)?.id ?? "";
		setTestState(null);
		onChange({ provider, connectionId, repo: "" });
	};

	const changeConnection = (connectionId: string) => {
		setTestState(null);
		onChange({ ...value, connectionId });
	};

	const changeRepo = (repo: string) => {
		setTestState(null);
		onChange({ ...value, repo });
	};

	return (
		<div className={compact ? "flex flex-col gap-3" : "flex flex-col gap-4"}>
		<div className="grid gap-3 sm:grid-cols-2">
			<Field label={t("projects.scm.provider")} htmlFor="scmProvider">
				<Select value={value.provider} onValueChange={(next) => changeProvider(next as SCMProvider)}>
					<SelectTrigger id="scmProvider" size="sm" className="w-full text-control">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="github">GitHub</SelectItem>
						<SelectItem value="gitlab">GitLab</SelectItem>
					</SelectContent>
				</Select>
			</Field>

			<Field label={t("projects.scm.connection")} htmlFor="scmConnection">
				<div className="flex min-w-0 gap-2">
					<Select value={value.connectionId} onValueChange={changeConnection}>
						<SelectTrigger id="scmConnection" size="sm" className="min-w-0 flex-1 text-control">
							<SelectValue placeholder={t("projects.scm.selectConnection")} />
						</SelectTrigger>
						<SelectContent>
							{value.provider === "github" && (
								<SelectItem value={GITHUB_DEFAULT_ID}>{t("projects.scm.githubDefault")}</SelectItem>
							)}
							{providerConnections.map((connection) => (
								<SelectItem key={connection.id} value={connection.id}>
									{connection.displayName}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					<IconButton label={t("projects.scm.createConnectionAria")} onClick={() => setDialogMode("create")}>
						<Plus className="size-icon-base" aria-hidden="true" />
					</IconButton>
					{selected && (
						<IconButton
							label={t("projects.scm.editConnectionAria", { name: selected.displayName })}
							onClick={() => setDialogMode("edit")}
						>
							<Pencil className="size-icon-sm" aria-hidden="true" />
						</IconButton>
					)}
				</div>
			</Field>
		</div>

		<Field label={t("projects.scm.repository")} htmlFor="scmRepository">
			<Input
				id="scmRepository"
				value={value.repo}
				onChange={(event) => changeRepo(event.target.value)}
				placeholder={effectiveRepo || (value.provider === "gitlab" ? "group/subgroup/project" : "owner/repository")}
			/>
		</Field>

		{selected && (
			<p className="min-w-0 truncate text-xs text-muted-foreground" title={selected.webBaseUrl}>
				{selected.webBaseUrl}
			</p>
		)}
		{connectionsQuery.isError && (
			<p className="text-xs text-error">{t("projects.scm.loadFailed")}</p>
		)}

		<div className="flex flex-wrap items-center gap-2">
			{isGitHubDefault ? (
				<span className="text-xs text-muted-foreground">{t("projects.scm.builtInGitHub")}</span>
			) : (
				<>
					<Button
						type="button"
						variant="outline"
						size="sm"
						disabled={!selected || !effectiveRepo || testMutation.isPending}
						onClick={() =>
							testMutation.mutate({
								provider: value.provider,
								connectionId: value.connectionId,
								repository: effectiveRepo,
								testKey,
							})
						}
					>
						{testMutation.isPending ? t("projects.scm.testing") : t("projects.scm.test")}
					</Button>
					{testState?.key === testKey ? (
						testState.kind === "success" ? (
							<ConnectionTestSuccess result={testState.result} />
						) : (
							<TestFailure error={testState.error} />
						)
					) : selected ? (
						<span className="text-xs text-muted-foreground">{t(STATUS_KEYS[selected.status])}</span>
					) : (
						<span className="text-xs text-muted-foreground">{t("projects.scm.selectOrCreate")}</span>
					)}
				</>
			)}
		</div>

		<ConnectionEditor
			connection={dialogMode === "edit" ? selected : undefined}
			mode={dialogMode}
			onClose={() => setDialogMode(null)}
			onSaved={(connection) => {
				setTestState(null);
				onChange({ ...value, provider: connection.provider, connectionId: connection.id });
				setDialogMode(null);
			}}
			onDeleted={() => {
				setTestState(null);
				onChange({ ...value, connectionId: value.provider === "github" ? GITHUB_DEFAULT_ID : "" });
				setDialogMode(null);
			}}
			provider={value.provider}
		/>
		</div>
	);
}

function TestFailure({ error }: { error: unknown }) {
	const { t } = useTranslation();
	const text = testErrorText(error, t);
	return (
		<span role="status" className="text-xs text-error">
			<b>{text.label}</b> · {text.message}
		</span>
	);
}

function ConnectionTestSuccess({ result }: { result: SCMConnectionTestResult }) {
	const { t } = useTranslation();
	if (result.status === "missing_credential") {
		return <span className="text-xs text-error">{t("projects.scm.missingCredential")}</span>;
	}
	return (
		<span role="status" className="inline-flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-success">
			<span>{t("projects.scm.connectedAs", { username: result.identity.username })}</span>
			<span className="inline-flex items-center gap-1">
				<Check className="size-3" aria-hidden="true" /> {t("projects.scm.readAccess")}
			</span>
			<span className={result.capabilities.write ? "inline-flex items-center gap-1" : "text-warning"}>
				{result.capabilities.write ? t("projects.scm.writeAccess") : t("projects.scm.noWriteAccess")}
			</span>
		</span>
	);
}

function ConnectionEditor({
	connection,
	mode,
	onClose,
	onDeleted,
	onSaved,
	provider,
}: {
	connection?: SCMConnection;
	mode: "create" | "edit" | null;
	onClose: () => void;
	onDeleted: () => void;
	onSaved: (connection: SCMConnection) => void;
	provider: SCMProvider;
}) {
	const { t } = useTranslation();
	const queryClient = useQueryClient();
	const tokenRef = useRef<HTMLInputElement>(null);
	const [displayName, setDisplayName] = useState("");
	const [id, setID] = useState("");
	const [idEdited, setIDEdited] = useState(false);
	const [webBaseUrl, setWebBaseUrl] = useState("");
	const [apiBaseUrl, setApiBaseUrl] = useState("");
	const [apiEdited, setApiEdited] = useState(false);
	const [token, setToken] = useState("");
	const [showToken, setShowToken] = useState(false);
	const editing = mode === "edit";

	useEffect(() => {
		if (!mode) return;
		const web = connection?.webBaseUrl || defaultSCMWebBaseUrl(provider);
		setDisplayName(connection?.displayName ?? "");
		setID(connection?.id ?? "");
		setIDEdited(Boolean(connection));
		setWebBaseUrl(web);
		setApiBaseUrl(connection?.apiBaseUrl || defaultSCMApiBaseUrl(provider, web));
		setApiEdited(Boolean(connection));
		setToken("");
		setShowToken(false);
	}, [connection, mode, provider]);

	const updateCache = (next: SCMConnection) => {
		queryClient.setQueryData<SCMConnection[]>(scmConnectionsQueryKey, (current = []) => {
			const existing = current.some((item) => item.id === next.id);
			return existing ? current.map((item) => (item.id === next.id ? next : item)) : [...current, next];
		});
	};

	const saveMutation = useMutation({
		mutationFn: async ({ removeToken = false }: { removeToken?: boolean } = {}) => {
			const tokenField = removeToken ? { token: "" } : token ? { token } : {};
			const body = {
				provider,
				displayName: displayName.trim(),
				webBaseUrl: webBaseUrl.trim() || undefined,
				apiBaseUrl: apiBaseUrl.trim() || undefined,
				...tokenField,
			};
			const response = editing
				? await apiClient.PUT("/api/v1/scm/connections/{id}", {
						params: { path: { id: connection!.id } },
						body,
					})
				: await apiClient.POST("/api/v1/scm/connections", { body: { id: id.trim(), ...body } });
			if (response.error) throw response.error;
			if (!response.data?.connection) throw { localCode: "SAVE_RESULT_MISSING" } satisfies LocalSCMFailure;
			return response.data.connection;
		},
		onSuccess: (next) => {
			updateCache(next);
			onSaved(next);
		},
		onSettled: () => {
			setToken("");
			setShowToken(false);
		},
	});

	const deleteMutation = useMutation({
		mutationFn: async () => {
			const { error } = await apiClient.DELETE("/api/v1/scm/connections/{id}", {
				params: { path: { id: connection!.id } },
			});
			if (error) throw error;
		},
		onSuccess: () => {
			queryClient.setQueryData<SCMConnection[]>(scmConnectionsQueryKey, (current = []) =>
				current.filter((item) => item.id !== connection?.id),
			);
			onDeleted();
		},
	});

	const changeName = (next: string) => {
		setDisplayName(next);
		if (!editing && !idEdited) setID(connectionSlug(provider, next));
	};

	const changeWebBaseUrl = (next: string) => {
		setWebBaseUrl(next);
		if (!apiEdited) setApiBaseUrl(defaultSCMApiBaseUrl(provider, next));
	};

	const error = saveMutation.error ?? deleteMutation.error;
	const busy = saveMutation.isPending || deleteMutation.isPending;

	return (
		<Dialog open={mode !== null} onOpenChange={(open) => !open && !busy && onClose()}>
			<DialogContent className="max-w-md" showCloseButton={false}>
				<DialogHeader className="relative pr-8">
					<DialogTitle className="text-[15px]">
						{editing ? t("projects.scm.editor.editTitle") : t("projects.scm.editor.createTitle")}
					</DialogTitle>
					<DialogDescription>{t("projects.scm.editor.description")}</DialogDescription>
					<button
						type="button"
						className="absolute right-0 top-0 grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-surface hover:text-foreground"
						aria-label={t("projects.scm.editor.close")}
						onClick={onClose}
					>
						<X className="size-icon-base" aria-hidden="true" />
					</button>
				</DialogHeader>

				<form
					className="flex flex-col gap-3"
					onSubmit={(event) => {
						event.preventDefault();
						saveMutation.mutate({});
					}}
				>
					<Field label={t("projects.scm.editor.name")} htmlFor="scmConnectionName">
						<Input
							id="scmConnectionName"
							value={displayName}
							onChange={(event) => changeName(event.target.value)}
							autoFocus
							required
						/>
					</Field>
					<Field label={t("projects.scm.editor.id")} htmlFor="scmConnectionID">
						<Input
							id="scmConnectionID"
							value={id}
							onChange={(event) => {
								setIDEdited(true);
								setID(event.target.value);
							}}
							disabled={editing}
							required
						/>
					</Field>
					<Field label={t("projects.scm.editor.instanceAddress")} htmlFor="scmWebBaseUrl">
						<Input
							id="scmWebBaseUrl"
							type="url"
							value={webBaseUrl}
							onChange={(event) => changeWebBaseUrl(event.target.value)}
							required
						/>
					</Field>
					<Field label={t("projects.scm.editor.apiAddress")} htmlFor="scmApiBaseUrl">
						<Input
							id="scmApiBaseUrl"
							type="url"
							value={apiBaseUrl}
							onChange={(event) => {
								setApiEdited(true);
								setApiBaseUrl(event.target.value);
							}}
							required
						/>
					</Field>
					<Field label={t("projects.scm.editor.accessToken")} htmlFor="scmAccessToken">
						<div className="flex gap-2">
							<div className="relative min-w-0 flex-1">
								<Input
									ref={tokenRef}
									id="scmAccessToken"
									type={showToken ? "text" : "password"}
									value={token}
									onChange={(event) => setToken(event.target.value)}
									placeholder={
										connection?.credentialConfigured ? "********" : t("projects.scm.editor.pasteToken")
									}
									className="pr-10"
									autoComplete="off"
								/>
								<button
									type="button"
									className="absolute right-1 top-1/2 grid size-7 -translate-y-1/2 place-items-center rounded-md text-muted-foreground hover:bg-surface hover:text-foreground"
									aria-label={
										showToken ? t("projects.scm.editor.hideToken") : t("projects.scm.editor.showToken")
									}
									onClick={() => setShowToken((current) => !current)}
								>
									{showToken ? (
										<EyeOff className="size-icon-base" aria-hidden="true" />
									) : (
										<Eye className="size-icon-base" aria-hidden="true" />
									)}
								</button>
							</div>
							{connection?.credentialConfigured && (
								<Button type="button" variant="outline" size="sm" onClick={() => tokenRef.current?.focus()}>
									{t("projects.scm.editor.replace")}
								</Button>
							)}
						</div>
						{connection?.credentialConfigured && (
							<div className="flex items-center justify-between gap-3 text-xs">
								<span className="text-success">{t("projects.scm.editor.configured")}</span>
								<button
									type="button"
									className="text-error hover:underline"
									onClick={() => saveMutation.mutate({ removeToken: true })}
								>
									{t("projects.scm.editor.removeCredential")}
								</button>
							</div>
						)}
					</Field>

					{error && (
						<p className="text-xs text-error">
							{isLocalSCMFailure(error)
								? t("projects.scm.editor.saveFailed")
								: apiErrorMessage(error, t("projects.scm.editor.requestFailed"))}
						</p>
					)}
					<DialogFooter className="flex-row items-center justify-between">
						<div>
							{editing && (
								<Button
									type="button"
									variant="ghost"
									size="sm"
									className="text-error"
									disabled={busy}
									onClick={() => {
										if (
											window.confirm(
												t("projects.scm.editor.deleteConfirm", {
													name: connection?.displayName ?? t("projects.scm.editor.deleteFallback"),
												}),
											)
										) {
											deleteMutation.mutate();
										}
									}}
								>
									<Trash2 className="size-icon-sm" aria-hidden="true" /> {t("projects.scm.editor.delete")}
								</Button>
							)}
						</div>
						<div className="flex gap-2">
							<Button type="button" variant="ghost" disabled={busy} onClick={onClose}>
								{t("ui.cancel")}
							</Button>
							<Button type="submit" variant="primary" disabled={busy || !displayName.trim() || !id.trim()}>
								{busy ? t("projects.scm.editor.saving") : t("projects.scm.editor.save")}
							</Button>
						</div>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

function Field({ label, htmlFor, children }: { label: string; htmlFor: string; children: React.ReactNode }) {
	return (
		<div className="flex min-w-0 flex-col gap-1.5">
			<Label htmlFor={htmlFor} className="text-xs text-muted-foreground">
				{label}
			</Label>
			{children}
		</div>
	);
}

function IconButton({ children, label, onClick }: { children: React.ReactNode; label: string; onClick: () => void }) {
	return (
		<TooltipProvider delayDuration={300}>
			<Tooltip>
				<TooltipTrigger asChild>
					<Button type="button" variant="outline" size="icon-sm" aria-label={label} onClick={onClick}>
						{children}
					</Button>
				</TooltipTrigger>
				<TooltipContent>{label}</TooltipContent>
			</Tooltip>
		</TooltipProvider>
	);
}

function connectionSlug(provider: SCMProvider, name: string): string {
	const slug = name
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 48);
	return slug ? `${provider}-${slug}` : "";
}
