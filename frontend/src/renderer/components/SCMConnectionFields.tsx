import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, Eye, EyeOff, Pencil, Plus, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
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
	| { key: string; kind: "error"; label: string; message: string };

const GITHUB_DEFAULT_ID = "github-default";

const STATUS_LABELS: Record<SCMConnection["status"], string> = {
	unknown: "Not tested",
	connected: "Connected",
	missing_credential: "Missing credential",
	unauthorized: "Unauthorized",
	forbidden: "Forbidden",
	unreachable: "Unreachable",
	tls_error: "TLS error",
	rate_limited: "Rate limited",
};

const ERROR_STATUS_LABELS: Record<string, string> = {
	SCM_AUTH_FAILED: "Unauthorized",
	SCM_FORBIDDEN: "Forbidden",
	SCM_INSTANCE_UNREACHABLE: "Unreachable",
	SCM_TLS_FAILED: "TLS error",
	SCM_RATE_LIMITED: "Rate limited",
};

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
		mutationFn: async () => {
			const { data, error } = await apiClient.POST("/api/v1/scm/connections/{id}/test", {
				params: { path: { id: value.connectionId } },
				body: { repository: effectiveRepo },
			});
			if (error) {
				const failure = new Error(apiErrorMessage(error)) as Error & { code?: string };
				failure.code = apiErrorCode(error);
				throw failure;
			}
			if (!data?.result) throw new Error("Connection test returned no result");
			return data.result;
		},
		onSuccess: (result) => {
			setTestState({ key: testKey, kind: "success", result });
			queryClient.setQueryData<SCMConnection[]>(scmConnectionsQueryKey, (current = []) =>
				current.map((connection) =>
					connection.id === value.connectionId
						? { ...connection, status: result.status, username: result.identity.username }
						: connection,
				),
			);
		},
		onError: (error) => {
			const code = error instanceof Error && "code" in error ? String(error.code) : "";
			setTestState({
				key: testKey,
				kind: "error",
				label: ERROR_STATUS_LABELS[code] ?? "Connection failed",
				message: error instanceof Error ? error.message.replace(/\s*\([A-Z0-9_]+\)$/, "") : "Connection failed",
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
			<Field label="Provider" htmlFor="scmProvider">
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

			<Field label="Connection" htmlFor="scmConnection">
				<div className="flex min-w-0 gap-2">
					<Select value={value.connectionId} onValueChange={changeConnection}>
						<SelectTrigger id="scmConnection" size="sm" className="min-w-0 flex-1 text-control">
							<SelectValue placeholder="Select connection" />
						</SelectTrigger>
						<SelectContent>
							{value.provider === "github" && <SelectItem value={GITHUB_DEFAULT_ID}>GitHub default</SelectItem>}
							{providerConnections.map((connection) => (
								<SelectItem key={connection.id} value={connection.id}>
									{connection.displayName}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					<IconButton label="Create SCM connection" onClick={() => setDialogMode("create")}>
						<Plus className="size-icon-base" aria-hidden="true" />
					</IconButton>
					{selected && (
						<IconButton label={`Edit ${selected.displayName}`} onClick={() => setDialogMode("edit")}>
							<Pencil className="size-icon-sm" aria-hidden="true" />
						</IconButton>
					)}
				</div>
			</Field>
		</div>

		<Field label="Repository" htmlFor="scmRepository">
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
			<p className="text-xs text-error">
				{connectionsQuery.error instanceof Error ? connectionsQuery.error.message : "Could not load connections"}
			</p>
		)}

		<div className="flex flex-wrap items-center gap-2">
			{isGitHubDefault ? (
				<span className="text-xs text-muted-foreground">Built-in GitHub connection</span>
			) : (
				<>
					<Button
						type="button"
						variant="outline"
						size="sm"
						disabled={!selected || !effectiveRepo || testMutation.isPending}
						onClick={() => testMutation.mutate()}
					>
						{testMutation.isPending ? "Testing..." : "Test connection"}
					</Button>
					{testState?.key === testKey ? (
						testState.kind === "success" ? (
							<ConnectionTestSuccess result={testState.result} />
						) : (
							<span role="status" className="text-xs text-error">
								<b>{testState.label}</b> · {testState.message}
							</span>
						)
					) : selected ? (
						<span className="text-xs text-muted-foreground">{STATUS_LABELS[selected.status]}</span>
					) : (
						<span className="text-xs text-muted-foreground">Select or create a connection</span>
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

function ConnectionTestSuccess({ result }: { result: SCMConnectionTestResult }) {
	if (result.status === "missing_credential") {
		return <span className="text-xs text-error">Missing credential</span>;
	}
	return (
		<span role="status" className="inline-flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-success">
			<span>Connected as {result.identity.username}</span>
			<span className="inline-flex items-center gap-1">
				<Check className="size-3" aria-hidden="true" /> Read access
			</span>
			<span className={result.capabilities.write ? "inline-flex items-center gap-1" : "text-warning"}>
				{result.capabilities.write ? "Write access" : "No write access"}
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
			if (response.error) throw new Error(apiErrorMessage(response.error));
			if (!response.data?.connection) throw new Error("Connection save returned no connection");
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
			if (error) throw new Error(apiErrorMessage(error));
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
					<DialogTitle className="text-[15px]">{editing ? "Edit connection" : "Create connection"}</DialogTitle>
					<DialogDescription>Connection details are reusable; project selection stays project-specific.</DialogDescription>
					<button
						type="button"
						className="absolute right-0 top-0 grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-surface hover:text-foreground"
						aria-label="Close connection dialog"
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
					<Field label="Connection name" htmlFor="scmConnectionName">
						<Input
							id="scmConnectionName"
							value={displayName}
							onChange={(event) => changeName(event.target.value)}
							autoFocus
							required
						/>
					</Field>
					<Field label="Connection ID" htmlFor="scmConnectionID">
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
					<Field label="Instance address" htmlFor="scmWebBaseUrl">
						<Input
							id="scmWebBaseUrl"
							type="url"
							value={webBaseUrl}
							onChange={(event) => changeWebBaseUrl(event.target.value)}
							required
						/>
					</Field>
					<Field label="API address" htmlFor="scmApiBaseUrl">
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
					<Field label="Access token" htmlFor="scmAccessToken">
						<div className="flex gap-2">
							<div className="relative min-w-0 flex-1">
								<Input
									ref={tokenRef}
									id="scmAccessToken"
									type={showToken ? "text" : "password"}
									value={token}
									onChange={(event) => setToken(event.target.value)}
									placeholder={connection?.credentialConfigured ? "********" : "Paste access token"}
									className="pr-10"
									autoComplete="off"
								/>
								<button
									type="button"
									className="absolute right-1 top-1/2 grid size-7 -translate-y-1/2 place-items-center rounded-md text-muted-foreground hover:bg-surface hover:text-foreground"
									aria-label={showToken ? "Hide access token" : "Show access token"}
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
									Replace
								</Button>
							)}
						</div>
						{connection?.credentialConfigured && (
							<div className="flex items-center justify-between gap-3 text-xs">
								<span className="text-success">Configured</span>
								<button
									type="button"
									className="text-error hover:underline"
									onClick={() => saveMutation.mutate({ removeToken: true })}
								>
									Remove credential
								</button>
							</div>
						)}
					</Field>

					{error && <p className="text-xs text-error">{error instanceof Error ? error.message : "Request failed"}</p>}
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
										if (window.confirm(`Delete ${connection?.displayName ?? "this connection"}?`)) {
											deleteMutation.mutate();
										}
									}}
								>
									<Trash2 className="size-icon-sm" aria-hidden="true" /> Delete
								</Button>
							)}
						</div>
						<div className="flex gap-2">
							<Button type="button" variant="ghost" disabled={busy} onClick={onClose}>
								Cancel
							</Button>
							<Button type="submit" variant="primary" disabled={busy || !displayName.trim() || !id.trim()}>
								{busy ? "Saving..." : "Save connection"}
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
