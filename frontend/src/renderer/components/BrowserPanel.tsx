import { useEffect, useState, type FormEvent } from "react";
import { ArrowLeft, ArrowRight, Globe2, Maximize2, Minimize2, RefreshCw, X } from "lucide-react";
import { useBrowserView, type BrowserViewModel } from "../hooks/useBrowserView";
import type { WorkspaceSession } from "../types/workspace";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

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
