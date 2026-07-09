import { useEffect, useState, type FormEvent } from "react";
import { ArrowLeft, ArrowRight, Globe2, Maximize2, Minimize2, RefreshCw, X } from "lucide-react";
import { useBrowserView, type BrowserViewModel } from "../hooks/useBrowserView";
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

export function BrowserPanel({ session, active, poppedOut, onTogglePopOut }: BrowserPanelProps) {
	const browserView = useBrowserView({
		sessionId: session.id,
		active,
		poppedOut,
		previewUrl: session.previewUrl,
		previewRevision: session.previewRevision,
	});
	return (
		<BrowserPanelView
			active={active}
			browserView={browserView}
			onTogglePopOut={onTogglePopOut}
			poppedOut={poppedOut}
			session={session}
		/>
	);
}

export function BrowserPanelView({
	poppedOut,
	onTogglePopOut,
	browserView,
}: BrowserPanelProps & { browserView: BrowserViewModel }) {
	const { navState, slotRef, navigate, goBack, goForward, reload, stop } = browserView;
	const [urlInput, setUrlInput] = useState(navState.url);
	const showStaticPreview = !window.ao?.browser && navState.url !== "";

	useEffect(() => {
		setUrlInput(navState.url);
	}, [navState.url]);

	const submit = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		const nextURL = urlInput.trim();
		if (nextURL) void navigate(nextURL);
	};

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
				{showStaticPreview ? <StaticPreview url={navState.url} /> : null}
				{navState.url === "" ? (
					<div className="pointer-events-none absolute inset-0 grid place-items-center p-5 text-center font-mono text-xs text-passive">
						<p>Enter a dev-server URL to preview it here.</p>
					</div>
				) : null}
				{navState.error ? (
					<p
						className={cn(
							"absolute inset-x-2.5 bottom-2.5 m-0 border border-error/35 bg-error/8 px-2.5 py-2",
							"rounded-md text-xs text-destructive",
						)}
					>
						{navState.error}
					</p>
				) : null}
			</div>
		</div>
	);
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
