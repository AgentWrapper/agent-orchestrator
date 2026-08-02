import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
	ArrowLeft,
	ArrowRight,
	Check,
	Globe2,
	Layers3,
	Maximize2,
	Minimize2,
	MousePointer2,
	PencilLine,
	RefreshCw,
	X,
} from "lucide-react";
import type { components } from "../../api/schema";
import { apiClient, apiErrorMessage } from "../lib/api-client";
import { useBrowserView, type BrowserViewModel } from "../hooks/useBrowserView";
import {
	formatBrowserAnnotationMessage,
	type BrowserAnnotationSubmitPayload,
	type BrowserTextEditSubmitPayload,
} from "../../shared/browser-annotations";
import type { WorkspaceSession } from "../types/workspace";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { cn } from "../lib/utils";

type BrowserPanelProps = {
	session: WorkspaceSession;
	active: boolean;
	poppedOut: boolean;
	onTogglePopOut: (next: boolean) => void;
};

type AnnotationStatus = "idle" | "picking" | "queued" | "sending" | "sent" | "error";
type WorkspaceTextEditCandidate = components["schemas"]["WorkspaceTextEditCandidate"];
type WorkspaceTextEditTarget = components["schemas"]["WorkspaceTextEditTarget"];
type TextEditStatus = "idle" | "picking" | "saving" | "applied" | "ambiguous" | "error";
type TextEditState = {
	status: TextEditStatus;
	message: string;
	candidates: WorkspaceTextEditCandidate[];
	pending: BrowserTextEditSubmitPayload | null;
};

const idleTextEditState: TextEditState = {
	status: "idle",
	message: "",
	candidates: [],
	pending: null,
};

function isBrowserTextEditURLSupported(currentURL: string, previewURL?: string): boolean {
	const current = parseBrowserTextEditURL(currentURL);
	if (!current) return false;
	if (current.protocol === "file:") {
		const preview = parseBrowserTextEditURL(previewURL);
		return Boolean(preview && preview.protocol === "file:" && browserFileURLsMatch(current, preview));
	}
	if (current.protocol !== "http:" && current.protocol !== "https:") return false;
	const preview = parseBrowserTextEditURL(previewURL);
	return Boolean(
		preview &&
			preview.protocol === current.protocol &&
			preview.host === current.host &&
			isLocalBrowserTextEditHost(current.hostname),
	);
}

function parseBrowserTextEditURL(raw?: string): URL | null {
	const trimmed = raw?.trim();
	if (!trimmed) return null;
	try {
		return new URL(trimmed);
	} catch {
		return null;
	}
}

function isLocalBrowserTextEditHost(hostname: string): boolean {
	const normalized = hostname.trim().toLowerCase().replace(/\.$/, "");
	const ipv4Parts = normalized.split(".");
	return (
		normalized === "localhost" ||
		normalized.endsWith(".localhost") ||
		normalized === "::1" ||
		normalized === "[::1]" ||
		(ipv4Parts.length === 4 &&
			ipv4Parts[0] === "127" &&
			ipv4Parts.every((part) => /^\d+$/.test(part) && Number(part) >= 0 && Number(part) <= 255))
	);
}

function browserFileURLsMatch(current: URL, preview: URL): boolean {
	const currentFile = browserFileURLParts(current);
	const previewFile = browserFileURLParts(preview);
	return Boolean(currentFile && previewFile && currentFile.host === previewFile.host && currentFile.path === previewFile.path);
}

function browserFileURLParts(url: URL): { host: string; path: string } | null {
	const host = url.hostname.trim().toLowerCase();
	if (host && host !== "localhost") return null;
	try {
		return {
			host: "",
			path: decodeURIComponent(url.pathname),
		};
	} catch {
		return null;
	}
}

export type BrowserAnnotationQueueModel = {
	status: AnnotationStatus;
	error: string;
	queuedCount: number;
	beginPicking: () => void;
	cancelPicking: () => void;
	enqueue: (payload: BrowserAnnotationSubmitPayload) => void;
	failPicking: (message: string) => void;
	retryQueued: () => void;
};

export function useBrowserAnnotationQueue({
	sessionId,
	navUrl,
}: {
	sessionId?: string;
	navUrl?: string;
}): BrowserAnnotationQueueModel {
	const [state, setState] = useState<{ status: AnnotationStatus; error: string; queuedCount: number }>({
		status: "idle",
		error: "",
		queuedCount: 0,
	});
	const annotationQueueRef = useRef<BrowserAnnotationSubmitPayload[]>([]);
	const annotationSendingRef = useRef(false);
	const sessionIdRef = useRef(sessionId ?? "");
	const generationRef = useRef(0);
	const sentTimerRef = useRef<number | null>(null);

	const resetQueue = useCallback(() => {
		generationRef.current += 1;
		if (sentTimerRef.current !== null) window.clearTimeout(sentTimerRef.current);
		sentTimerRef.current = null;
		annotationQueueRef.current = [];
		annotationSendingRef.current = false;
		setState({ status: "idle", error: "", queuedCount: 0 });
	}, []);

	const drainAnnotationQueue = useCallback(() => {
		if (annotationSendingRef.current || !sessionIdRef.current) {
			return;
		}

		const payload = annotationQueueRef.current.shift();
		setState((current) => ({ ...current, queuedCount: annotationQueueRef.current.length }));
		if (!payload) return;

		annotationSendingRef.current = true;
		const sendGeneration = generationRef.current;
		const sendSessionId = sessionIdRef.current;
		setState({ status: "sending", error: "", queuedCount: annotationQueueRef.current.length });

		void (async () => {
			let sent = false;
			let failureMessage = "Unable to send annotation.";
			try {
				const message = formatBrowserAnnotationMessage(payload);
				const { error } = await apiClient.POST("/api/v1/sessions/{sessionId}/send", {
					params: { path: { sessionId: sendSessionId } },
					body: { message },
				});
				if (error) {
					failureMessage = apiErrorMessage(error, "Unable to send annotation.");
					return;
				}
				sent = true;
			} catch (error) {
				failureMessage = apiErrorMessage(error, "Unable to send annotation.");
			} finally {
				if (sendGeneration !== generationRef.current || sendSessionId !== sessionIdRef.current) return;
				annotationSendingRef.current = false;
				if (!sent) {
					annotationQueueRef.current.unshift(payload);
					setState({
						status: "error",
						error: failureMessage,
						queuedCount: annotationQueueRef.current.length,
					});
					return;
				}

				const queuedCount = annotationQueueRef.current.length;
				setState({ status: queuedCount > 0 ? "queued" : "sent", error: "", queuedCount });
				if (queuedCount > 0) {
					drainAnnotationQueue();
				} else {
					if (sentTimerRef.current !== null) window.clearTimeout(sentTimerRef.current);
					sentTimerRef.current = window.setTimeout(() => {
						sentTimerRef.current = null;
						setState((current) =>
							current.status === "sent" ? { status: "idle", error: "", queuedCount: 0 } : current,
						);
					}, 2_000);
				}
			}
		})();
	}, []);

	useEffect(() => {
		sessionIdRef.current = sessionId ?? "";
		resetQueue();
	}, [resetQueue, sessionId]);

	useEffect(() => {
		if (navUrl) return;
		resetQueue();
	}, [navUrl, resetQueue]);

	useEffect(
		() => () => {
			if (sentTimerRef.current !== null) window.clearTimeout(sentTimerRef.current);
		},
		[],
	);

	const beginPicking = useCallback(() => {
		setState((current) => ({ ...current, status: "picking", error: "" }));
	}, []);

	const cancelPicking = useCallback(() => {
		setState((current) => ({
			status: annotationQueueRef.current.length > 0 ? "queued" : current.status === "sending" ? "sending" : "idle",
			error: "",
			queuedCount: annotationQueueRef.current.length,
		}));
	}, []);

	const failPicking = useCallback((message: string) => {
		setState({ status: "error", error: message, queuedCount: annotationQueueRef.current.length });
	}, []);

	const enqueue = useCallback(
		(payload: BrowserAnnotationSubmitPayload) => {
			annotationQueueRef.current.push(payload);
			setState({ status: "queued", error: "", queuedCount: annotationQueueRef.current.length });
			drainAnnotationQueue();
		},
		[drainAnnotationQueue],
	);

	const retryQueued = useCallback(() => {
		if (annotationQueueRef.current.length === 0) return;
		setState({ status: "queued", error: "", queuedCount: annotationQueueRef.current.length });
		drainAnnotationQueue();
	}, [drainAnnotationQueue]);

	return {
		status: state.status,
		error: state.error,
		queuedCount: state.queuedCount,
		beginPicking,
		cancelPicking,
		enqueue,
		failPicking,
		retryQueued,
	};
}

export function BrowserPanel({ session, active, poppedOut, onTogglePopOut }: BrowserPanelProps) {
	const browserView = useBrowserView({
		sessionId: session.id,
		active,
		poppedOut,
		previewUrl: session.previewUrl,
		previewRevision: session.previewRevision,
	});
	const annotationQueue = useBrowserAnnotationQueue({
		sessionId: session.id,
		navUrl: browserView.navState.url,
	});
	return (
		<BrowserPanelView
			active={active}
			annotationQueue={annotationQueue}
			browserView={browserView}
			onTogglePopOut={onTogglePopOut}
			poppedOut={poppedOut}
			session={session}
		/>
	);
}

export function BrowserPanelView({
	session,
	poppedOut,
	onTogglePopOut,
	browserView,
	annotationQueue,
}: BrowserPanelProps & { annotationQueue: BrowserAnnotationQueueModel; browserView: BrowserViewModel }) {
	const queryClient = useQueryClient();
	const {
		viewId,
		navState,
		mirrorUrl,
		mirrorStream,
		slotRef,
		navigate,
		goBack,
		goForward,
		reload,
		stop,
		tabs,
		activeTabId,
		tabNotice,
		selectTab,
		closeTab,
		agentBrowserActive,
		annotationMode,
		setAnnotationMode,
		textEditMode,
		setTextEditMode,
	} = browserView;
	const [urlInput, setUrlInput] = useState(navState.url);
	const {
		beginPicking,
		cancelPicking,
		enqueue,
		error,
		failPicking,
		queuedCount,
		retryQueued,
		status: annotationStatus,
	} = annotationQueue;
	const [textEditState, setTextEditState] = useState<TextEditState>(idleTextEditState);
	const showStaticPreview = !window.ao?.browser && navState.url !== "";
	const canAnnotate = Boolean(window.ao?.browser && viewId && navState.url);
	const canTextEdit = Boolean(
		window.ao?.browser && viewId && isBrowserTextEditURLSupported(navState.url, session.previewUrl),
	);
	const canRetryAnnotation = annotationStatus === "error" && queuedCount > 0;
	const textEditActive = textEditMode || textEditState.status === "picking";
	const textEditScopeRef = useRef({ sessionId: session.id, url: navState.url });
	const textEditRequestRef = useRef(0);

	useEffect(() => {
		setUrlInput(navState.url);
	}, [navState.url]);

	useEffect(() => {
		textEditScopeRef.current = { sessionId: session.id, url: navState.url };
		textEditRequestRef.current += 1;
	}, [navState.url, session.id]);

	const applyTextEdit = useCallback(
		async (payload: BrowserTextEditSubmitPayload, target?: WorkspaceTextEditTarget) => {
			const requestGeneration = ++textEditRequestRef.current;
			const requestSessionId = session.id;
			const requestURL = payload.context.url;
			const requestIsCurrent = () =>
				textEditRequestRef.current === requestGeneration &&
				textEditScopeRef.current.sessionId === requestSessionId &&
				textEditScopeRef.current.url === requestURL;
			setTextEditState({
				status: "saving",
				message: "",
				candidates: [],
				pending: payload,
			});
			try {
				const { data, error } = await apiClient.POST("/api/v1/sessions/{sessionId}/workspace/text-edit", {
					params: { path: { sessionId: requestSessionId } },
					body: {
						oldText: payload.oldText,
						newText: payload.newText,
						url: payload.context.url,
						selector: payload.context.selector,
						tag: payload.context.tag,
						...(target ? { target } : {}),
					},
				});
				if (error) {
					if (!requestIsCurrent()) return;
					setTextEditState({
						status: "error",
						message: apiErrorMessage(error, "Unable to apply text edit."),
						candidates: [],
						pending: null,
					});
					return;
				}
				if (!data) {
					if (!requestIsCurrent()) return;
					setTextEditState({
						status: "error",
						message: "Text edit response was empty.",
						candidates: [],
						pending: null,
					});
					return;
				}
				if (data.status === "applied") {
					void queryClient.invalidateQueries({
						queryKey: ["session-workspace-files", requestSessionId],
					});
					void queryClient.invalidateQueries({
						queryKey: ["session-workspace-file", requestSessionId],
					});
					if (!requestIsCurrent()) return;
					setTextEditState({
						status: "applied",
						message: "Applied",
						candidates: [],
						pending: null,
					});
					return;
				}
				if (data.status === "ambiguous") {
					if (!requestIsCurrent()) return;
					setTextEditState({
						status: "ambiguous",
						message: data.message || "Choose source file",
						candidates: data.candidates,
						pending: payload,
					});
					return;
				}
				const fallback =
					data.status === "conflict"
						? "Selected text changed. Pick the text again."
						: data.status === "not_found"
							? "Could not find that text in workspace files."
							: "This text edit is not supported.";
				if (!requestIsCurrent()) return;
				setTextEditState({
					status: "error",
					message: data.message || fallback,
					candidates: [],
					pending: null,
				});
			} catch (error) {
				if (!requestIsCurrent()) return;
				setTextEditState({
					status: "error",
					message: apiErrorMessage(error, "Unable to apply text edit."),
					candidates: [],
					pending: null,
				});
			}
		},
		[queryClient, session.id],
	);

	useEffect(() => {
		const offSubmit = window.ao?.browser.onAnnotationSubmit((payload) => {
			if (payload.viewId !== viewId) return;
			enqueue(payload);
		});
		const offCancel = window.ao?.browser.onAnnotationCancel((payload) => {
			if (payload.viewId !== viewId) return;
			cancelPicking();
		});
		return () => {
			offSubmit?.();
			offCancel?.();
		};
	}, [cancelPicking, enqueue, viewId]);

	useEffect(() => {
		const offSubmit = window.ao?.browser.onTextEditSubmit((payload) => {
			if (payload.viewId !== viewId) return;
			void applyTextEdit(payload);
		});
		const offCancel = window.ao?.browser.onTextEditCancel((payload) => {
			if (payload.viewId !== viewId) return;
			setTextEditState(idleTextEditState);
		});
		return () => {
			offSubmit?.();
			offCancel?.();
		};
	}, [applyTextEdit, viewId]);

	useEffect(() => {
		if (navState.url) return;
		setTextEditState(idleTextEditState);
	}, [navState.url]);

	useEffect(() => {
		setTextEditState(idleTextEditState);
	}, [session.id]);

	useEffect(() => {
		if (!textEditState.pending || !navState.url) return;
		if (textEditState.pending.context.url !== navState.url) {
			setTextEditState(idleTextEditState);
		}
	}, [navState.url, textEditState.pending]);

	const submit = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		const nextURL = urlInput.trim();
		if (nextURL) void navigate(nextURL);
	};

	const toggleAnnotationMode = async () => {
		if (!canAnnotate || annotationStatus === "sending") return;
		if (canRetryAnnotation) {
			retryQueued();
			return;
		}
		const next = !(annotationMode || annotationStatus === "picking");
		try {
			await setAnnotationMode(next);
			if (next) {
				setTextEditState(idleTextEditState);
				beginPicking();
			} else {
				cancelPicking();
			}
		} catch (error) {
			failPicking(error instanceof Error ? error.message : "Unable to start annotation.");
		}
	};

	const toggleTextEditMode = async () => {
		if (!canTextEdit || textEditState.status === "saving") return;
		const next = !textEditActive;
		try {
			await setTextEditMode(next);
			if (next) {
				cancelPicking();
				setTextEditState({
					status: "picking",
					message: "",
					candidates: [],
					pending: null,
				});
			} else {
				setTextEditState(idleTextEditState);
			}
		} catch (error) {
			setTextEditState({
				status: "error",
				message: error instanceof Error ? error.message : "Unable to start text edit.",
				candidates: [],
				pending: null,
			});
		}
	};

	const chooseTextEditCandidate = (candidate: WorkspaceTextEditCandidate) => {
		if (!textEditState.pending || textEditState.status === "saving") return;
		void applyTextEdit(textEditState.pending, {
			path: candidate.path,
			occurrence: candidate.occurrence,
			line: candidate.line,
			snippet: candidate.snippet,
			matchCount: candidate.matchCount,
		});
	};

	const annotationStatusLabel =
		annotationStatus === "picking"
			? "Pick element"
			: annotationStatus === "queued"
				? queuedCount > 1
					? `Queued (${queuedCount})`
					: "Queued"
				: annotationStatus === "sending"
					? "Sending"
					: annotationStatus === "sent"
						? "Sent"
						: annotationStatus === "error"
							? error
							: "";
	const textEditStatusLabel =
		textEditState.status === "picking"
			? "Pick text"
			: textEditState.status === "saving"
				? "Saving"
				: textEditState.status === "applied"
					? "Applied"
					: textEditState.status === "ambiguous"
						? "Choose source file"
						: textEditState.status === "error"
							? textEditState.message
							: "";

	return (
		<div
			className="flex h-full min-h-browser-min flex-col overflow-hidden rounded-lg border border-border bg-background"
			data-testid="browser-panel"
			role="tabpanel"
		>
			<form
				className="flex shrink-0 min-w-0 items-center gap-1 border-b border-border bg-surface p-1.5"
				onSubmit={submit}
			>
				<Button
					aria-label="Back"
					disabled={!navState.canGoBack}
					onClick={() => void goBack()}
					size="icon-sm"
					type="button"
					variant="ghost"
				>
					<ArrowLeft aria-hidden="true" className="size-icon-base" />
				</Button>
				<Button
					aria-label="Forward"
					disabled={!navState.canGoForward}
					onClick={() => void goForward()}
					size="icon-sm"
					type="button"
					variant="ghost"
				>
					<ArrowRight aria-hidden="true" className="size-icon-base" />
				</Button>
				<Button
					aria-label={navState.isLoading ? "Stop" : "Reload"}
					onClick={() => void (navState.isLoading ? stop() : reload())}
					size="icon-sm"
					type="button"
					variant="ghost"
				>
					{navState.isLoading ? (
						<X aria-hidden="true" className="size-icon-base" />
					) : (
						<RefreshCw aria-hidden="true" className="size-icon-base" />
					)}
				</Button>
				<Button
					aria-label={
						canRetryAnnotation
							? "Retry annotation"
							: annotationMode || annotationStatus === "picking"
								? "Cancel annotation"
								: "Annotate page"
					}
					aria-pressed={annotationMode || annotationStatus === "picking"}
					className="browser-panel__annotate-btn"
					disabled={!canAnnotate || annotationStatus === "sending"}
					onClick={() => void toggleAnnotationMode()}
					size="icon-sm"
					title={canRetryAnnotation ? "Retry annotation" : "Annotate page"}
					type="button"
					variant="ghost"
				>
					<MousePointer2 aria-hidden="true" className="h-4 w-4" />
				</Button>
				<Button
					aria-label={textEditActive ? "Cancel text edit" : "Edit page text"}
					aria-pressed={textEditActive}
					className="browser-panel__text-edit-btn"
					disabled={!canTextEdit || textEditState.status === "saving"}
					onClick={() => void toggleTextEditMode()}
					size="icon-sm"
					title={textEditActive ? "Cancel text edit" : "Edit page text"}
					type="button"
					variant="ghost"
				>
					<PencilLine aria-hidden="true" className="h-4 w-4" />
				</Button>
				{textEditStatusLabel ? (
					<span
						className={
							textEditState.status === "error"
								? "browser-panel__annotation-status browser-panel__annotation-status--error"
								: "browser-panel__annotation-status"
						}
					>
						{textEditStatusLabel}
					</span>
				) : null}
				{annotationStatusLabel ? (
					<span
						className={
							annotationStatus === "error"
								? "browser-panel__annotation-status browser-panel__annotation-status--error"
								: "browser-panel__annotation-status"
						}
					>
						{annotationStatusLabel}
					</span>
				) : agentBrowserActive ? (
					<span className="browser-panel__annotation-status" role="status" aria-live="polite">
						Agent using browser
					</span>
				) : null}
				<div className="relative min-w-0 flex-1">
					<Globe2
						aria-hidden="true"
						className="pointer-events-none absolute left-2.25 top-1/2 size-icon-md -translate-y-1/2 text-passive"
					/>
					<Input
						aria-label="Browser URL"
						className="h-browser-url pl-browser-url font-mono text-xs"
						onChange={(event) => setUrlInput(event.target.value)}
						placeholder="localhost:5173"
						value={urlInput}
					/>
				</div>
				{tabNotice ? (
					<span className="max-w-24 truncate text-caption text-accent" role="status">
						{tabNotice}
					</span>
				) : null}
				<DropdownMenu modal={false}>
					<DropdownMenuTrigger asChild>
						<Button
							aria-label={`Browser tabs (${tabs.length})`}
							className={cn("gap-1 px-2", tabs.length > 1 && "bg-accent-weak text-accent")}
							disabled={tabs.length === 0}
							size="sm"
							title={`${tabs.length} browser ${tabs.length === 1 ? "tab" : "tabs"}`}
							type="button"
							variant="ghost"
						>
							<Layers3 aria-hidden="true" className="size-icon-base" />
							<span className="font-mono text-caption">{tabs.length}</span>
						</Button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end" className="w-72" sideOffset={8}>
						<DropdownMenuLabel>Browser tabs</DropdownMenuLabel>
						{tabs.map((tab) => {
							const label = browserTabLabel(tab.title, tab.url);
							return (
								<div className="flex min-w-0 items-center gap-0.5" key={tab.id}>
									<DropdownMenuItem
										className="min-w-0 flex-1 py-2"
										onSelect={() => void selectTab(tab.id)}
										textValue={`${label.title} ${label.subtitle}`}
									>
										<span className="flex size-4 shrink-0 items-center justify-center">
											{tab.id === activeTabId ? <Check aria-hidden="true" className="text-accent" /> : null}
										</span>
										<span className="min-w-0 flex-1">
											<span className="block truncate text-xs text-foreground">{label.title}</span>
											<span className="block truncate font-mono text-caption text-passive">{label.subtitle}</span>
										</span>
									</DropdownMenuItem>
									<DropdownMenuItem
										aria-label={`Close tab ${label.title}`}
										className="size-8 shrink-0 justify-center px-0"
										disabled={tabs.length === 1}
										onSelect={() => void closeTab(tab.id)}
										title={tabs.length === 1 ? "The only tab cannot be closed" : `Close ${label.title}`}
									>
										<X aria-hidden="true" className="size-icon-sm" />
									</DropdownMenuItem>
								</div>
							);
						})}
					</DropdownMenuContent>
				</DropdownMenu>
				<Button
					aria-label={poppedOut ? "Return to panel" : "Pop out"}
					onClick={() => onTogglePopOut(!poppedOut)}
					size="icon-sm"
					type="button"
					variant="ghost"
				>
					{poppedOut ? (
						<Minimize2 aria-hidden="true" className="size-icon-base" />
					) : (
						<Maximize2 aria-hidden="true" className="size-icon-base" />
					)}
				</Button>
			</form>
			<div className="relative min-h-0 flex-1 overflow-hidden bg-background">
				<div className="absolute inset-0 min-h-px min-w-px" ref={slotRef} />
				{mirrorStream ? (
					<MirrorVideo stream={mirrorStream} />
				) : mirrorUrl ? (
					<img alt="" className="absolute inset-0 h-full w-full object-cover" src={mirrorUrl} />
				) : null}
				{showStaticPreview ? <StaticPreview url={navState.url} /> : null}
				{navState.url === "" ? (
					<div className="pointer-events-none absolute inset-0 grid place-items-center p-5 text-center font-mono text-xs text-passive">
						<p>Enter a URL or click one in the terminal.</p>
					</div>
				) : null}
				{navState.error ? (
					<p
						className={cn(
							"absolute inset-x-2.5 bottom-2.5 m-0 border border-error/35 bg-error/8 px-2.5 py-2",
							"rounded-md text-xs text-destructive",
						)}
						data-testid="browser-preview-error"
					>
						{navState.error}
					</p>
				) : null}
				{textEditState.status === "ambiguous" && textEditState.pending ? (
					<div
						className={cn(
							"absolute left-2.5 top-2.5 z-10 w-[min(420px,calc(100%-1.25rem))] overflow-hidden rounded-md",
							"border border-border bg-surface shadow-lg",
						)}
						data-testid="browser-text-edit-candidates"
					>
						<div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
							<div className="min-w-0 text-xs font-semibold text-foreground">Choose source file</div>
							<Button
								aria-label="Cancel text edit source selection"
								onClick={() => setTextEditState(idleTextEditState)}
								size="icon-sm"
								type="button"
								variant="ghost"
							>
								<X aria-hidden="true" className="size-icon-sm" />
							</Button>
						</div>
						<div className="max-h-72 overflow-y-auto py-1">
							{textEditState.candidates.map((candidate) => (
								<button
									aria-label={`Apply edit to ${candidate.path} line ${candidate.line}`}
									className="block w-full min-w-0 px-3 py-2 text-left hover:bg-interactive-hover focus-visible:bg-interactive-hover focus-visible:outline-none"
									key={`${candidate.path}:${candidate.occurrence}`}
									onClick={() => chooseTextEditCandidate(candidate)}
									type="button"
								>
									<span className="block truncate font-mono text-xs font-semibold text-foreground">
										{candidate.path}:{candidate.line}
									</span>
									<span className="mt-1 block max-h-10 overflow-hidden font-mono text-xs leading-tight text-muted-foreground">
										{candidate.snippet}
									</span>
								</button>
							))}
						</div>
					</div>
				) : null}
			</div>
		</div>
	);
}

function browserTabLabel(title: string, url: string): { title: string; subtitle: string } {
	const cleanTitle = title.trim();
	if (!url) return { title: cleanTitle || "New tab", subtitle: "Blank page" };
	try {
		const parsed = new URL(url);
		const subtitle = parsed.protocol === "file:" ? parsed.pathname.split("/").filter(Boolean).at(-1) || url : parsed.host;
		return { title: cleanTitle || subtitle, subtitle };
	} catch {
		return { title: cleanTitle || url, subtitle: url };
	}
}

function MirrorVideo({ stream }: { stream: MediaStream }) {
	const attach = useCallback(
		(node: HTMLVideoElement | null) => {
			if (node && node.srcObject !== stream) {
				node.srcObject = stream;
			}
		},
		[stream],
	);
	return <video autoPlay className="absolute inset-0 h-full w-full object-cover" muted playsInline ref={attach} />;
}

function StaticPreview({ url }: { url: string }) {
	return (
		<div className="absolute inset-0 overflow-auto bg-preview text-preview-foreground">
			<div className="border-b border-preview bg-surface px-4 py-3">
				<div className="text-caption font-semibold uppercase tracking-wide-md text-preview-muted">AO Preview</div>
				<div className="mt-1 truncate font-mono text-xs text-preview-link">{url}</div>
			</div>
			<div className="mx-auto max-w-preview-max px-5 py-6">
				<div className="rounded-lg border border-preview-card bg-surface p-5 shadow-sm">
					<div className="flex items-center justify-between gap-3">
						<div>
							<h1 className="text-heading-lg font-semibold leading-tight tracking-normal text-preview-heading">
								Demo app preview
							</h1>
							<p className="mt-1 text-control leading-row text-preview-body">
								The worker exposed a local Vite app with <span className="font-mono">ao preview</span>.
							</p>
						</div>
						<span className="rounded-md bg-preview-success px-2.5 py-1 text-caption font-semibold text-success">
							Loaded
						</span>
					</div>
					<div className="mt-5 grid grid-cols-3 gap-3">
						{[
							["Routes", "12 passing"],
							["Build", "ready"],
							["Latency", "42 ms"],
						].map(([label, value]) => (
							<div key={label} className="rounded-md border border-preview-tile bg-preview-tile p-3">
								<div className="text-caption font-medium uppercase tracking-wide text-preview-muted">{label}</div>
								<div className="mt-1 text-subtitle font-semibold text-preview-heading">{value}</div>
							</div>
						))}
					</div>
					<div className="mt-5 rounded-md border border-preview-terminal bg-preview-terminal p-3 font-mono text-xs leading-row text-preview-terminal">
						<div>$ npm run dev -- --host 127.0.0.1</div>
						<div className="text-success-bright">ready in 418 ms</div>
						<div>Local: http://localhost:5173/</div>
					</div>
				</div>
			</div>
		</div>
	);
}
