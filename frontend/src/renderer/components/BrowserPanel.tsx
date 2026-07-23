import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowLeft, ArrowRight, Globe2, Maximize2, Minimize2, MousePointer2, RefreshCw, X } from "lucide-react";
import { apiClient, apiErrorMessage } from "../lib/api-client";
import { useBrowserView, type BrowserViewModel } from "../hooks/useBrowserView";
import { formatBrowserAnnotationMessage, type BrowserAnnotationSubmitPayload } from "../../shared/browser-annotations";
import type { WorkspaceSession } from "../types/workspace";
import { isAgentActivityWorking } from "../lib/session-presentation";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { cn } from "../lib/utils";

type BrowserPanelProps = {
	session: WorkspaceSession;
	active: boolean;
	poppedOut: boolean;
	onTogglePopOut: (next: boolean) => void;
};

type AnnotationStatus = "idle" | "picking" | "queued" | "sending" | "sent" | "error";

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

	const resetQueue = useCallback(() => {
		generationRef.current += 1;
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
				if (queuedCount > 0) drainAnnotationQueue();
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
		annotationMode,
		setAnnotationMode,
	} = browserView;
	const [urlInput, setUrlInput] = useState(navState.url);
	const { beginPicking, cancelPicking, enqueue, error, failPicking, queuedCount, retryQueued, status } =
		annotationQueue;
	const showStaticPreview = !window.ao?.browser && navState.url !== "";
	const sessionBusy = isAgentActivityWorking(session.activity);
	const canAnnotate = Boolean(window.ao?.browser && viewId && navState.url);
	const canRetryAnnotation = status === "error" && queuedCount > 0;

	useEffect(() => {
		setUrlInput(navState.url);
	}, [navState.url]);

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

	const submit = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		const nextURL = urlInput.trim();
		if (nextURL) void navigate(nextURL);
	};

	const toggleAnnotationMode = async () => {
		if (!canAnnotate || status === "sending") return;
		if (canRetryAnnotation) {
			retryQueued();
			return;
		}
		const next = !(annotationMode || status === "picking");
		try {
			await setAnnotationMode(next);
			if (next) {
				beginPicking();
			} else {
				cancelPicking();
			}
		} catch (error) {
			failPicking(error instanceof Error ? error.message : "Unable to start annotation.");
		}
	};

	const annotationStatusLabel =
		status === "picking"
			? "Pick element"
			: status === "queued"
				? queuedCount > 1
					? `Queued (${queuedCount})`
					: "Queued"
				: status === "sending"
					? "Sending"
					: status === "sent"
						? "Sent"
						: status === "error"
							? error
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
							: annotationMode || status === "picking"
								? "Cancel annotation"
								: "Annotate page"
					}
					aria-pressed={annotationMode || status === "picking"}
					className="browser-panel__annotate-btn"
					disabled={!canAnnotate || status === "sending"}
					onClick={() => void toggleAnnotationMode()}
					size="icon-sm"
					title={canRetryAnnotation ? "Retry annotation" : "Annotate page"}
					type="button"
					variant="ghost"
				>
					<MousePointer2 aria-hidden="true" className="h-4 w-4" />
				</Button>
				{annotationStatusLabel ? (
					<span
						className={
							status === "error"
								? "browser-panel__annotation-status browser-panel__annotation-status--error"
								: "browser-panel__annotation-status"
						}
					>
						{annotationStatusLabel}
					</span>
				) : sessionBusy ? (
					<span className="browser-panel__annotation-status">Agent working</span>
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
			</div>
		</div>
	);
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
