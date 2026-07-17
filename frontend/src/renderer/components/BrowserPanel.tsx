import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowLeft, ArrowRight, Globe2, Maximize2, Minimize2, MousePointer2, RefreshCw, X } from "lucide-react";
import { Trans, useTranslation } from "react-i18next";
import { apiClient, apiErrorMessage } from "../lib/api-client";
import { useBrowserView, type BrowserViewModel } from "../hooks/useBrowserView";
import { formatBrowserAnnotationMessage, type BrowserAnnotationSubmitPayload } from "../../shared/browser-annotations";
import { BROWSER_ERROR } from "../../shared/browser-errors";
import type { WorkspaceSession } from "../types/workspace";
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
type AnnotationFailure = { kind: "send"; cause: unknown } | { kind: "picking"; detail: string };

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
	const { t } = useTranslation();
	const [state, setState] = useState<{
		status: AnnotationStatus;
		failure: AnnotationFailure | null;
		queuedCount: number;
	}>({
		status: "idle",
		failure: null,
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
		setState({ status: "idle", failure: null, queuedCount: 0 });
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
		setState({ status: "sending", failure: null, queuedCount: annotationQueueRef.current.length });

		void (async () => {
			let sent = false;
			let failureCause: unknown;
			try {
				const message = formatBrowserAnnotationMessage(payload);
				const { error } = await apiClient.POST("/api/v1/sessions/{sessionId}/send", {
					params: { path: { sessionId: sendSessionId } },
					body: { message },
				});
				if (error) {
					failureCause = error;
					return;
				}
				sent = true;
			} catch (error) {
				failureCause = error;
			} finally {
				if (sendGeneration !== generationRef.current || sendSessionId !== sessionIdRef.current) return;
				annotationSendingRef.current = false;
				if (!sent) {
					annotationQueueRef.current.unshift(payload);
					setState({
						status: "error",
						failure: { kind: "send", cause: failureCause },
						queuedCount: annotationQueueRef.current.length,
					});
					return;
				}

				const queuedCount = annotationQueueRef.current.length;
				setState({ status: queuedCount > 0 ? "queued" : "sent", failure: null, queuedCount });
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
		setState((current) => ({ ...current, status: "picking", failure: null }));
	}, []);

	const cancelPicking = useCallback(() => {
		setState((current) => ({
			status: annotationQueueRef.current.length > 0 ? "queued" : current.status === "sending" ? "sending" : "idle",
			failure: null,
			queuedCount: annotationQueueRef.current.length,
		}));
	}, []);

	const failPicking = useCallback((detail: string) => {
		setState({
			status: "error",
			failure: { kind: "picking", detail },
			queuedCount: annotationQueueRef.current.length,
		});
	}, []);

	const enqueue = useCallback(
		(payload: BrowserAnnotationSubmitPayload) => {
			annotationQueueRef.current.push(payload);
			setState({ status: "queued", failure: null, queuedCount: annotationQueueRef.current.length });
			drainAnnotationQueue();
		},
		[drainAnnotationQueue],
	);

	const retryQueued = useCallback(() => {
		if (annotationQueueRef.current.length === 0) return;
		setState({ status: "queued", failure: null, queuedCount: annotationQueueRef.current.length });
		drainAnnotationQueue();
	}, [drainAnnotationQueue]);
	const error = state.failure
		? state.failure.kind === "send"
			? apiErrorMessage(state.failure.cause, t("browser.annotation.sendFailed"))
			: state.failure.detail
				? t("browser.annotation.startFailedWithDetail", { detail: state.failure.detail })
				: t("browser.annotation.startFailed")
		: "";

	return {
		status: state.status,
		error,
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
	const { t } = useTranslation();
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
	const sessionBusy = session.status === "working";
	const canAnnotate = Boolean(window.ao?.browser && viewId && navState.url);
	const canRetryAnnotation = status === "error" && queuedCount > 0;
	const navigationError =
		navState.error === BROWSER_ERROR.urlRequired
			? t("browser.errors.urlRequired")
			: navState.error === BROWSER_ERROR.urlUnsupported
				? t("browser.errors.urlUnsupported")
				: navState.error === BROWSER_ERROR.loadFailed
					? t("browser.errors.loadFailed")
					: navState.error;

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
			failPicking(error instanceof Error ? error.message : "");
		}
	};

	const annotationStatusLabel =
		status === "picking"
			? t("browser.annotation.pickElement")
			: status === "queued"
				? t("browser.annotation.queued", { count: queuedCount })
				: status === "sending"
					? t("browser.annotation.sending")
					: status === "sent"
						? t("browser.annotation.sent")
						: status === "error"
							? error
							: "";

	return (
		<div
			className="flex h-full min-h-browser-min flex-col overflow-hidden rounded-lg border border-border bg-background"
			role="tabpanel"
		>
			<form
				className="flex shrink-0 min-w-0 items-center gap-1 border-b border-border bg-surface p-1.5"
				onSubmit={submit}
			>
				<Button
					aria-label={t("browser.controls.back")}
					disabled={!navState.canGoBack}
					onClick={() => void goBack()}
					size="icon-sm"
					type="button"
					variant="ghost"
				>
					<ArrowLeft aria-hidden="true" className="size-icon-base" />
				</Button>
				<Button
					aria-label={t("browser.controls.forward")}
					disabled={!navState.canGoForward}
					onClick={() => void goForward()}
					size="icon-sm"
					type="button"
					variant="ghost"
				>
					<ArrowRight aria-hidden="true" className="size-icon-base" />
				</Button>
				<Button
					aria-label={navState.isLoading ? t("browser.controls.stop") : t("browser.controls.reload")}
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
							? t("browser.controls.retryAnnotation")
							: annotationMode || status === "picking"
								? t("browser.controls.cancelAnnotation")
								: t("browser.controls.annotatePage")
					}
					aria-pressed={annotationMode || status === "picking"}
					className="browser-panel__annotate-btn"
					disabled={!canAnnotate || status === "sending"}
					onClick={() => void toggleAnnotationMode()}
					size="icon-sm"
					title={
						canRetryAnnotation
							? t("browser.controls.retryAnnotation")
							: annotationMode || status === "picking"
								? t("browser.controls.cancelAnnotation")
								: t("browser.controls.annotatePage")
					}
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
					<span className="browser-panel__annotation-status">{t("browser.annotation.agentWorking")}</span>
				) : null}
				<div className="relative min-w-0 flex-1">
					<Globe2
						aria-hidden="true"
						className="pointer-events-none absolute left-2.25 top-1/2 size-icon-md -translate-y-1/2 text-passive"
					/>
					<Input
						aria-label={t("browser.controls.url")}
						className="h-browser-url pl-browser-url font-mono text-xs"
						onChange={(event) => setUrlInput(event.target.value)}
						placeholder="localhost:5173"
						value={urlInput}
					/>
				</div>
				<Button
					aria-label={poppedOut ? t("browser.controls.returnToPanel") : t("browser.controls.popOut")}
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
						<p>{t("browser.empty")}</p>
					</div>
				) : null}
				{navigationError ? (
					<p
						className={cn(
							"absolute inset-x-2.5 bottom-2.5 m-0 border border-error/35 bg-error/8 px-2.5 py-2",
							"rounded-md text-xs text-destructive",
						)}
					>
						<span className="font-medium">{t("browser.errors.navigation")}</span> <span>{navigationError}</span>
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
	const { t } = useTranslation();
	const metrics = [
		{ key: "routes", value: t("browser.preview.values.routes") },
		{ key: "build", value: t("browser.preview.values.build") },
		{ key: "latency", value: t("browser.preview.values.latency") },
	] as const;
	return (
		<div className="absolute inset-0 overflow-auto bg-preview text-preview-foreground">
			<div className="border-b border-preview bg-surface px-4 py-3">
				<div className="text-caption font-semibold uppercase tracking-wide-md text-preview-muted">
					{t("browser.preview.label")}
				</div>
				<div className="mt-1 truncate font-mono text-xs text-preview-link">{url}</div>
			</div>
			<div className="mx-auto max-w-preview-max px-5 py-6">
				<div className="rounded-lg border border-preview-card bg-surface p-5 shadow-sm">
					<div className="flex items-center justify-between gap-3">
						<div>
							<h1 className="text-heading-lg font-semibold leading-tight tracking-normal text-preview-heading">
								{t("browser.preview.title")}
							</h1>
							<p className="mt-1 text-control leading-row text-preview-body">
								<Trans components={{ command: <span className="font-mono" /> }} i18nKey="browser.preview.description" />
							</p>
						</div>
						<span className="rounded-md bg-preview-success px-2.5 py-1 text-caption font-semibold text-success">
							{t("browser.preview.loaded")}
						</span>
					</div>
					<div className="mt-5 grid grid-cols-3 gap-3">
						{metrics.map((metric) => (
							<div key={metric.key} className="rounded-md border border-preview-tile bg-preview-tile p-3">
								<div className="text-caption font-medium uppercase tracking-wide text-preview-muted">
									{t(`browser.preview.metrics.${metric.key}`)}
								</div>
								<div className="mt-1 text-subtitle font-semibold text-preview-heading">{metric.value}</div>
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
