import { useEffect, useState, type FormEvent } from "react";
import { ArrowLeft, ArrowRight, Globe2, Maximize2, Minimize2, RefreshCw, X } from "lucide-react";
import { useBrowserView, type BrowserViewModel } from "../hooks/useBrowserView";
import type { WorkspaceSession } from "../types/workspace";
import { MARKDOWN_FILE_RE } from "../../shared/markdown-types";
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
		workspacePath: session.workspacePath,
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

	useEffect(() => {
		setUrlInput(navState.url);
	}, [navState.url]);

	const submit = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		const raw = urlInput.trim();
		if (!raw) return;
		// Normalise bare filesystem paths to file:// so that MarkdownHost can
		// detect them as local files and set up file watching.
		let nextURL = raw;
		if (raw.startsWith("\\\\") || raw.startsWith("//")) {
			// UNC path: \\host\share\path → file:////host/share/path
			nextURL = `file://${raw.replace(/\\/g, "/")}`;
		} else if (raw.startsWith("/") || raw.startsWith("\\")) {
			// Unix absolute or backslash-prefixed: /path → file:///path
			nextURL = `file://${raw.replace(/\\/g, "/")}`;
		} else if (/^[a-zA-Z]:[\\/]/.test(raw)) {
			// Windows drive letter: C:\path → file:///C:/path
			nextURL = `file:///${raw.replace(/\\/g, "/")}`;
		}
		if (MARKDOWN_FILE_RE.test(nextURL)) {
			void browserView.renderMarkdown({ kind: "url", url: nextURL });
		} else {
			void navigate(nextURL);
		}
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
