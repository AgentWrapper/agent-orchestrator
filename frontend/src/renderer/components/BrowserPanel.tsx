import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowLeft, ArrowRight, Globe2, Maximize2, Minimize2, MousePointer2, RefreshCw, X } from "lucide-react";
import { apiClient, apiErrorMessage } from "../lib/api-client";
import { useBrowserView, type BrowserViewModel } from "../hooks/useBrowserView";
import { formatBrowserAnnotationMessage, type BrowserAnnotationSubmitPayload } from "../../shared/browser-annotations";
import type { WorkspaceSession } from "../types/workspace";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

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
	sessionStatus,
	navUrl,
}: {
	sessionId?: string;
	sessionStatus?: WorkspaceSession["status"];
	navUrl?: string;
}): BrowserAnnotationQueueModel {
	const [state, setState] = useState<{ status: AnnotationStatus; error: string; queuedCount: number }>({
		status: "idle",
		error: "",
		queuedCount: 0,
	});
	const annotationQueueRef = useRef<BrowserAnnotationSubmitPayload[]>([]);
	const annotationSendingRef = useRef(false);
	const annotationWaitingForAgentCycleRef = useRef(false);
	const annotationWaitAfterCycleRef = useRef(0);
	const annotationSawAgentWorkingRef = useRef(sessionStatus === "working");
	const annotationAgentCycleRef = useRef(0);
	const sessionReadyForAnnotationRef = useRef(sessionStatus === "needs_input");
	const sessionIdRef = useRef(sessionId ?? "");
	const generationRef = useRef(0);

	const resetQueue = useCallback(() => {
		generationRef.current += 1;
		annotationQueueRef.current = [];
		annotationSendingRef.current = false;
		annotationWaitingForAgentCycleRef.current = false;
		annotationWaitAfterCycleRef.current = annotationAgentCycleRef.current;
		setState({ status: "idle", error: "", queuedCount: 0 });
	}, []);

	const drainAnnotationQueue = useCallback(() => {
		if (
			annotationSendingRef.current ||
			!sessionIdRef.current ||
			!sessionReadyForAnnotationRef.current ||
			annotationWaitingForAgentCycleRef.current
		) {
			return;
		}

		const payload = annotationQueueRef.current.shift();
		setState((current) => ({ ...current, queuedCount: annotationQueueRef.current.length }));
		if (!payload) return;

		annotationSendingRef.current = true;
		const sendGeneration = generationRef.current;
		const sendSessionId = sessionIdRef.current;
		const sendCycle = annotationAgentCycleRef.current;
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

				annotationWaitingForAgentCycleRef.current = true;
				annotationWaitAfterCycleRef.current = sendCycle;
				if (
					sessionReadyForAnnotationRef.current &&
					annotationAgentCycleRef.current > annotationWaitAfterCycleRef.current
				) {
					annotationWaitingForAgentCycleRef.current = false;
				}

				const queuedCount = annotationQueueRef.current.length;
				setState({ status: queuedCount > 0 ? "queued" : "sent", error: "", queuedCount });
				if (!annotationWaitingForAgentCycleRef.current && queuedCount > 0) drainAnnotationQueue();
			}
		})();
	}, []);

	useEffect(() => {
		sessionIdRef.current = sessionId ?? "";
		annotationAgentCycleRef.current = 0;
		resetQueue();
	}, [resetQueue, sessionId]);

	useEffect(() => {
		if (navUrl) return;
		resetQueue();
	}, [navUrl, resetQueue]);

	useEffect(() => {
		const nextWorking = sessionStatus === "working";
		const nextReady = sessionStatus === "needs_input";
		sessionReadyForAnnotationRef.current = nextReady;

		if (nextWorking) {
			annotationSawAgentWorkingRef.current = true;
			return;
		}

		if (!nextReady) return;
		if (annotationSawAgentWorkingRef.current) {
			annotationAgentCycleRef.current += 1;
			annotationSawAgentWorkingRef.current = false;
		}
		if (annotationWaitingForAgentCycleRef.current) {
			if (annotationAgentCycleRef.current <= annotationWaitAfterCycleRef.current) return;
			annotationWaitingForAgentCycleRef.current = false;
		}
		drainAnnotationQueue();
	}, [drainAnnotationQueue, sessionStatus]);

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
		sessionStatus: session.status,
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
	const { viewId, navState, slotRef, navigate, goBack, goForward, reload, stop, annotationMode, setAnnotationMode } =
		browserView;
	const [urlInput, setUrlInput] = useState(navState.url);
	const { beginPicking, cancelPicking, enqueue, error, failPicking, queuedCount, retryQueued, status } =
		annotationQueue;
	const showStaticPreview = !window.ao?.browser && navState.url !== "";
	const sessionBusy = session.status === "working";
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
		<div className="browser-panel" role="tabpanel">
			<form className="browser-panel__toolbar" onSubmit={submit}>
				<Button
					aria-label="Back"
					disabled={!navState.canGoBack}
					onClick={() => void goBack()}
					size="icon-sm"
					type="button"
					variant="ghost"
				>
					<ArrowLeft aria-hidden="true" className="h-4 w-4" />
				</Button>
				<Button
					aria-label="Forward"
					disabled={!navState.canGoForward}
					onClick={() => void goForward()}
					size="icon-sm"
					type="button"
					variant="ghost"
				>
					<ArrowRight aria-hidden="true" className="h-4 w-4" />
				</Button>
				<Button
					aria-label={navState.isLoading ? "Stop" : "Reload"}
					onClick={() => void (navState.isLoading ? stop() : reload())}
					size="icon-sm"
					type="button"
					variant="ghost"
				>
					{navState.isLoading ? (
						<X aria-hidden="true" className="h-4 w-4" />
					) : (
						<RefreshCw aria-hidden="true" className="h-4 w-4" />
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
				<div className="browser-panel__url">
					<Globe2 aria-hidden="true" className="browser-panel__url-icon" />
					<Input
						aria-label="Browser URL"
						className="browser-panel__url-input"
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
						<Minimize2 aria-hidden="true" className="h-4 w-4" />
					) : (
						<Maximize2 aria-hidden="true" className="h-4 w-4" />
					)}
				</Button>
			</form>
			<div className="browser-panel__content">
				<div className="browser-panel__slot" ref={slotRef} />
				{showStaticPreview ? <StaticPreview url={navState.url} /> : null}
				{navState.url === "" ? (
					<div className="browser-panel__overlay">
						<p>Enter a dev-server URL to preview it here.</p>
					</div>
				) : null}
				{navState.error ? <p className="browser-panel__error">{navState.error}</p> : null}
			</div>
		</div>
	);
}

function StaticPreview({ url }: { url: string }) {
	return (
		<div className="absolute inset-0 overflow-auto bg-[#f7f8fb] text-[#17202a]">
			<div className="border-b border-[#dfe4ea] bg-white px-4 py-3">
				<div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[#687384]">AO Preview</div>
				<div className="mt-1 truncate font-mono text-[12px] text-[#2f5b9d]">{url}</div>
			</div>
			<div className="mx-auto max-w-[760px] px-5 py-6">
				<div className="rounded-[8px] border border-[#d7dee8] bg-white p-5 shadow-sm">
					<div className="flex items-center justify-between gap-3">
						<div>
							<h1 className="text-[22px] font-semibold leading-tight tracking-normal text-[#111827]">
								Demo app preview
							</h1>
							<p className="mt-1 text-[13px] leading-5 text-[#526070]">
								The worker exposed a local Vite app with <span className="font-mono">ao preview</span>.
							</p>
						</div>
						<span className="rounded-[6px] bg-[#e7f8ed] px-2.5 py-1 text-[11px] font-semibold text-[#177245]">
							Loaded
						</span>
					</div>
					<div className="mt-5 grid grid-cols-3 gap-3">
						{[
							["Routes", "12 passing"],
							["Build", "ready"],
							["Latency", "42 ms"],
						].map(([label, value]) => (
							<div key={label} className="rounded-[7px] border border-[#e1e7ef] bg-[#fbfcfe] p-3">
								<div className="text-[11px] font-medium uppercase tracking-[0.06em] text-[#687384]">{label}</div>
								<div className="mt-1 text-[15px] font-semibold text-[#111827]">{value}</div>
							</div>
						))}
					</div>
					<div className="mt-5 rounded-[7px] border border-[#dce4ef] bg-[#0f172a] p-3 font-mono text-[12px] leading-5 text-[#cbd5e1]">
						<div>$ npm run dev -- --host 127.0.0.1</div>
						<div className="text-[#86efac]">ready in 418 ms</div>
						<div>Local: http://localhost:5173/</div>
					</div>
				</div>
			</div>
		</div>
	);
}
