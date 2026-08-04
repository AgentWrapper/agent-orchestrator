import { ipcRenderer } from "electron";
import geistLatinWoff2 from "@fontsource-variable/geist/files/geist-latin-wght-normal.woff2?inline";
import geistMonoLatinWoff2 from "@fontsource-variable/geist-mono/files/geist-mono-latin-wght-normal.woff2?inline";
import {
	createBrowserAnnotationContext,
	elementSummary,
	type BrowserAnnotationCancelReason,
	type BrowserAnnotationContext,
	type BrowserAnnotationPageSubmitPayload,
} from "./shared/browser-annotations";
import { promptPositionForRect } from "./shared/browser-annotation-overlay";

let enabled = false;
let selectedElement: Element | null = null;
let selectedContext: BrowserAnnotationContext | null = null;
let host: HTMLDivElement | null = null;
let shadow: ShadowRoot | null = null;
let viewportResizeObserver: ResizeObserver | null = null;

ipcRenderer.on("browser:annotation:setMode", (_event, input: { enabled?: boolean }) => {
	setEnabled(Boolean(input?.enabled), "disabled");
});

window.addEventListener("beforeunload", () => {
	if (enabled) sendCancel("navigation");
	cleanupOverlay();
	enabled = false;
});

function setEnabled(next: boolean, cancelReason: BrowserAnnotationCancelReason): void {
	if (enabled === next) return;
	enabled = next;
	selectedElement = null;
	selectedContext = null;
	if (enabled) {
		ensureOverlay();
		installListeners();
		renderHint();
	} else {
		removeListeners();
		cleanupOverlay();
		if (cancelReason !== "disabled") sendCancel(cancelReason);
	}
}

function installListeners(): void {
	document.addEventListener("pointerover", handlePointerMove, true);
	document.addEventListener("pointermove", handlePointerMove, true);
	document.addEventListener("click", handleClick, true);
	document.addEventListener("keydown", handleKeyDown, true);
	window.addEventListener("scroll", refreshHighlight, true);
	window.addEventListener("resize", refreshHighlight, true);
	window.visualViewport?.addEventListener("resize", refreshHighlight);
	window.visualViewport?.addEventListener("scroll", refreshHighlight);
	if (typeof ResizeObserver !== "undefined") {
		viewportResizeObserver = new ResizeObserver(refreshHighlight);
		viewportResizeObserver.observe(document.documentElement);
	}
}

function removeListeners(): void {
	document.removeEventListener("pointerover", handlePointerMove, true);
	document.removeEventListener("pointermove", handlePointerMove, true);
	document.removeEventListener("click", handleClick, true);
	document.removeEventListener("keydown", handleKeyDown, true);
	window.removeEventListener("scroll", refreshHighlight, true);
	window.removeEventListener("resize", refreshHighlight, true);
	window.visualViewport?.removeEventListener("resize", refreshHighlight);
	window.visualViewport?.removeEventListener("scroll", refreshHighlight);
	viewportResizeObserver?.disconnect();
	viewportResizeObserver = null;
}

function handlePointerMove(event: PointerEvent): void {
	if (!enabled || selectedContext || isOverlayEvent(event)) return;
	const target = annotationTarget(event.target);
	if (!target || target === selectedElement) return;
	selectedElement = target;
	selectedContext = null;
	renderHighlight(target, false);
}

function handleClick(event: MouseEvent): void {
	if (!enabled || isOverlayEvent(event)) return;
	if (selectedContext) {
		event.preventDefault();
		event.stopPropagation();
		event.stopImmediatePropagation();
		return;
	}
	const target = annotationTarget(event.target);
	if (!target) return;
	event.preventDefault();
	event.stopPropagation();
	event.stopImmediatePropagation();
	selectedElement = target;
	selectedContext = createBrowserAnnotationContext(target);
	renderPrompt(target, selectedContext);
}

function handleKeyDown(event: KeyboardEvent): void {
	if (!enabled || event.key !== "Escape") return;
	event.preventDefault();
	event.stopPropagation();
	event.stopImmediatePropagation();
	setEnabled(false, "escape");
}

function refreshHighlight(): void {
	if (!enabled || !selectedElement) return;
	renderHighlight(selectedElement, Boolean(selectedContext));
	if (selectedContext) repositionPrompt(selectedElement);
}

function annotationTarget(target: EventTarget | null): Element | null {
	if (!(target instanceof Element)) return null;
	const element =
		target.closest("button, a, input, textarea, select, [role]") ??
		target.closest("[data-testid], [id], [class]") ??
		target;
	if (element === document.documentElement || element === document.body) return null;
	return element;
}

// Registered as FontFace objects from decoded bytes rather than an @font-face
// `src: url(data:...)` rule: the annotated page's own CSP (font-src) can block
// that url() fetch, silently falling the overlay back to a system font. A
// FontFace built from an in-memory buffer does no fetch, so it is not subject
// to the page's CSP and always loads.
function decodeBase64Font(dataUri: string): ArrayBuffer {
	const base64 = dataUri.slice(dataUri.indexOf(",") + 1);
	const binary = atob(base64);
	const buffer = new ArrayBuffer(binary.length);
	const bytes = new Uint8Array(buffer);
	for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
	return buffer;
}

function registerFonts(root: ShadowRoot): void {
	if (typeof FontFace === "undefined") return;
	const fontSet = (root as ShadowRoot & { fonts?: FontFaceSet }).fonts ?? document.fonts;
	const sans = new FontFace("Geist Variable", decodeBase64Font(geistLatinWoff2), {
		weight: "100 900",
		style: "normal",
	});
	const mono = new FontFace("Geist Mono Variable", decodeBase64Font(geistMonoLatinWoff2), {
		weight: "100 900",
		style: "normal",
	});
	fontSet.add(sans);
	fontSet.add(mono);
	void sans.load();
	void mono.load();
}

function ensureOverlay(): ShadowRoot {
	if (shadow && host?.isConnected) return shadow;
	host = document.createElement("div");
	host.setAttribute("data-ao-annotation-root", "");
	host.style.position = "fixed";
	host.style.inset = "0";
	host.style.zIndex = "2147483647";
	host.style.pointerEvents = "none";
	(document.documentElement ?? document.body).appendChild(host);
	shadow = host.attachShadow({ mode: "open" });
	registerFonts(shadow);
	shadow.innerHTML = `
		<style>
			:host {
				all: initial;
				--ao-background: oklch(0.185 0.006 285.885);
				--ao-foreground: oklch(0.985 0 0);
				--ao-surface: oklch(0.24 0.008 285.885);
				--ao-muted: oklch(0.274 0.006 286.033);
				--ao-border: oklch(1 0 0 / 7%);
				--ao-input: oklch(1 0 0 / 4%);
				--ao-ring: oklch(0.552 0.016 285.938);
				--ao-passive: oklch(0.442 0.017 285.786);
				--ao-primary: oklch(0.92 0.004 286.32);
				--ao-primary-foreground: oklch(0.21 0.006 285.885);
				--ao-font-sans: "Geist Variable", "Geist", ui-sans-serif, system-ui, sans-serif;
				--ao-font-mono: "Geist Mono Variable", "Geist Mono", "JetBrainsMono Nerd Font Mono", "JetBrainsMono Nerd Font", "FiraCode Nerd Font Mono", "FiraCode Nerd Font", "MesloLGS NF", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
				--ao-text-xs: 12px;
				--ao-control-md: 28px;
				--ao-icon-sm: 13px;
				--ao-radius-md: 8px;
			}
			.highlight {
				position: fixed;
				box-sizing: border-box;
				border: 2px solid #4d8dff;
				border-radius: 8px;
				background: rgba(77, 141, 255, 0.11);
				box-shadow:
					0 0 0 9999px rgba(0, 0, 0, 0.10),
					0 0 0 1px rgba(255, 255, 255, 0.20),
					0 12px 36px rgba(0, 0, 0, 0.24);
				pointer-events: none;
				transition:
					left 120ms ease,
					top 120ms ease,
					width 120ms ease,
					height 120ms ease,
					border-color 120ms ease,
					background 120ms ease;
			}
			.prompt {
				position: fixed;
				width: min(440px, calc(100vw - 28px));
				box-sizing: border-box;
				border: 1px solid color-mix(in oklch, var(--ao-border) 70%, transparent);
				border-radius: var(--ao-radius-md);
				background: var(--ao-surface);
				color: var(--ao-foreground);
				box-shadow: 0 18px 52px rgba(0, 0, 0, 0.48);
				padding: 8px 12px;
				font: 13px/1.5 var(--ao-font-sans);
				font-weight: 400;
				pointer-events: auto;
				animation: prompt-in 140ms ease-out;
			}
			.prompt__header {
				display: block;
				min-width: 0;
				margin: 0 0 6px;
				overflow: hidden;
				color: var(--ao-passive);
				font-family: var(--ao-font-sans);
				font-size: var(--ao-text-xs);
				line-height: 1.5;
				font-weight: 400;
				text-overflow: ellipsis;
				white-space: nowrap;
			}
			.prompt textarea {
				display: block;
				width: 100%;
				min-height: 80px;
				box-sizing: border-box;
				resize: vertical;
				border: 1px solid var(--ao-input);
				border-radius: 6px;
				background: var(--ao-background);
				color: var(--ao-foreground);
				caret-color: var(--ao-foreground);
				padding: 8px 10px;
				font-family: var(--ao-font-sans);
				font-size: var(--ao-text-xs);
				line-height: 1.5;
				font-weight: 400;
				outline: none;
				transition:
					border-color 120ms ease,
					box-shadow 120ms ease,
					background 120ms ease;
			}
			.prompt textarea::placeholder {
				color: var(--ao-passive);
			}
			.prompt textarea:focus,
			.prompt textarea:focus-visible {
				border-color: var(--ao-ring);
				box-shadow: 0 0 0 3px color-mix(in oklch, var(--ao-ring) 30%, transparent);
			}
			.prompt__footer {
				display: flex;
				align-items: center;
				justify-content: flex-end;
				flex-wrap: nowrap;
				gap: 6px;
				margin-top: 8px;
			}
			.prompt__meta {
				display: flex;
				flex: 1 1 auto;
				height: var(--ao-control-md);
				align-items: center;
				gap: 6px;
				margin-right: auto;
				min-width: 0;
				color: var(--ao-passive);
				font-family: var(--ao-font-sans);
				font-size: var(--ao-text-xs);
				line-height: 1.5;
				font-weight: 400;
			}
			.prompt__shortcut {
				display: inline-flex;
				height: 100%;
				align-items: center;
				gap: 4px;
				white-space: nowrap;
			}
			.prompt__shortcut > span {
				display: inline-flex;
				height: 18px;
				align-items: center;
				line-height: 1;
			}
			.prompt__shortcut + .prompt__shortcut::before {
				content: "·";
				color: color-mix(in oklch, var(--ao-passive) 55%, transparent);
				line-height: 1;
			}
			.prompt__shortcut kbd {
				display: inline-flex;
				min-height: 18px;
				align-items: center;
				justify-content: center;
				border: 1px solid color-mix(in oklch, var(--ao-passive) 35%, transparent);
				border-radius: 4px;
				background: color-mix(in oklch, var(--ao-muted) 55%, transparent);
				padding: 0 5px;
				color: color-mix(in oklch, var(--ao-foreground) 78%, transparent);
				font-family: var(--ao-font-mono);
				font-size: 10px;
				line-height: 1;
				box-shadow: inset 0 -1px 0 color-mix(in oklch, var(--ao-passive) 20%, transparent);
			}
			.actions {
				display: flex;
				flex: 0 0 auto;
				align-items: center;
				justify-content: flex-end;
				gap: 6px;
				margin: 0;
			}
			.actions button {
				display: inline-flex;
				flex-shrink: 0;
				height: var(--ao-control-md);
				align-items: center;
				justify-content: center;
				gap: 6px;
				border-radius: 6px;
				border: 1px solid transparent;
				background: transparent;
				color: var(--ao-foreground);
				padding: 0 10px;
				font-family: var(--ao-font-sans);
				font-size: var(--ao-text-xs);
				line-height: 1;
				font-weight: 400;
				white-space: nowrap;
				transition:
					background 120ms ease,
					border-color 120ms ease,
					transform 120ms ease;
			}
			.actions button:hover {
				background: color-mix(in oklch, var(--ao-muted) 50%, transparent);
			}
			.actions button:active {
				transform: translateY(1px);
			}
			.actions button:focus-visible {
				outline: none;
				border-color: var(--ao-ring);
				box-shadow: 0 0 0 3px color-mix(in oklch, var(--ao-ring) 30%, transparent);
			}
			.actions button:disabled {
				opacity: 0.5;
				pointer-events: none;
			}
			.actions button[type="submit"] {
				background: var(--ao-primary);
				color: var(--ao-primary-foreground);
			}
			.actions button[type="submit"]:hover {
				background: color-mix(in oklch, var(--ao-primary) 80%, transparent);
				color: var(--ao-primary-foreground);
			}
			.actions svg {
				width: var(--ao-icon-sm);
				height: var(--ao-icon-sm);
				flex-shrink: 0;
				stroke: currentColor;
				stroke-width: 2;
				stroke-linecap: round;
				stroke-linejoin: round;
				fill: none;
			}
			.hint {
				position: fixed;
				left: 12px;
				bottom: 12px;
				border-radius: 6px;
				background: #15171b;
				color: #c9d1d9;
				padding: 7px 9px;
				font: 12px/1.3 var(--ao-font-sans);
				box-shadow: 0 10px 30px rgba(0, 0, 0, 0.35);
				pointer-events: none;
				animation: prompt-in 140ms ease-out;
			}
			@keyframes prompt-in {
				from { opacity: 0; transform: translateY(4px) scale(0.985); }
				to { opacity: 1; transform: translateY(0) scale(1); }
			}
			@media (prefers-reduced-motion: reduce) {
				.highlight,
				.prompt textarea,
				.actions button {
					transition: none;
				}
				.prompt,
				.hint {
					animation: none;
				}
			}
			@media (max-width: 360px) {
				.prompt__footer {
					align-items: stretch;
					flex-direction: column;
				}
				.actions {
					order: 1;
					width: 100%;
				}
				.prompt__meta {
					order: 2;
					margin-right: 0;
				}
			}
			</style>
		<div class="highlight" hidden></div>
		<div class="mount"></div>
	`;
	return shadow;
}

function renderHint(): void {
	const root = ensureOverlay();
	const mount = root.querySelector<HTMLDivElement>(".mount");
	if (!mount) return;
	mount.innerHTML = `<div class="hint">Click an element to annotate. Press Esc to cancel.</div>`;
}

function renderHighlight(element: Element, locked: boolean): void {
	const root = ensureOverlay();
	const highlight = root.querySelector<HTMLDivElement>(".highlight");
	if (!highlight) return;
	const rect = element.getBoundingClientRect();
	highlight.hidden = false;
	highlight.style.left = `${Math.max(0, rect.left)}px`;
	highlight.style.top = `${Math.max(0, rect.top)}px`;
	highlight.style.width = `${Math.max(0, rect.width)}px`;
	highlight.style.height = `${Math.max(0, rect.height)}px`;
	highlight.style.borderColor = locked ? "#74b98a" : "#4d8dff";
}

function renderPrompt(element: Element, context: BrowserAnnotationContext): void {
	renderHighlight(element, true);
	const root = ensureOverlay();
	const mount = root.querySelector<HTMLDivElement>(".mount");
	if (!mount) return;
	mount.innerHTML = `
		<form class="prompt">
			<div class="prompt__header">Annotate on selected components</div>
			<textarea aria-label="Annotation request" placeholder="Describe to agent what you want to change..."></textarea>
			<div class="prompt__footer">
				<div class="prompt__meta" aria-label="Command or Control plus Enter to send. Escape to cancel.">
					<span class="prompt__shortcut"><kbd>⌘/Ctrl + Enter</kbd><span>Send</span></span>
					<span class="prompt__shortcut"><kbd>Esc</kbd><span>Cancel</span></span>
				</div>
				<div class="actions">
					<button disabled type="submit">
						<svg viewBox="0 0 24 24" aria-hidden="true">
							<path d="m22 2-7 20-4-9-9-4Z"></path>
							<path d="M22 2 11 13"></path>
						</svg>
						<span>Send feedback</span>
					</button>
				</div>
			</div>
		</form>
	`;
	const form = mount.querySelector<HTMLFormElement>("form")!;
	repositionPrompt(element);
	const header = form.querySelector<HTMLDivElement>(".prompt__header")!;
	header.title = elementSummary(context);
	const textarea = form.querySelector<HTMLTextAreaElement>("textarea")!;
	const submitButton = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
	const updateSubmitState = (): void => {
		submitButton.disabled = textarea.value.trim().length === 0;
	};
	const submitAnnotation = (): boolean => {
		const instruction = textarea.value.trim();
		if (!instruction) {
			textarea.focus();
			return false;
		}
		const payload: BrowserAnnotationPageSubmitPayload = { instruction, context };
		ipcRenderer.send("browser:annotation:submit", payload);
		setEnabled(false, "disabled");
		return true;
	};
	form.addEventListener("submit", (event) => {
		event.preventDefault();
		submitAnnotation();
	});
	textarea.addEventListener("input", updateSubmitState);
	textarea.addEventListener("keydown", (event) => {
		if (event.key === "Escape") {
			event.preventDefault();
			setEnabled(false, "escape");
		} else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
			event.preventDefault();
			submitAnnotation();
		}
	});
	setTimeout(() => textarea.focus(), 0);
}

function repositionPrompt(element: Element): void {
	const form = shadow?.querySelector<HTMLFormElement>(".prompt");
	if (!form) return;
	const documentWidth = document.documentElement.clientWidth;
	const documentHeight = document.documentElement.clientHeight;
	const layoutWidth = Math.min(window.innerWidth, documentWidth > 0 ? documentWidth : window.innerWidth);
	const layoutHeight = Math.min(window.innerHeight, documentHeight > 0 ? documentHeight : window.innerHeight);
	const viewportWidth = Math.min(layoutWidth, window.visualViewport?.width ?? layoutWidth);
	const viewportHeight = Math.min(layoutHeight, window.visualViewport?.height ?? layoutHeight);
	const promptWidth = Math.max(0, Math.min(440, viewportWidth - 28));
	form.style.width = `${promptWidth}px`;
	const measuredHeight = form.getBoundingClientRect().height;
	const { left, top } = promptPosition(element.getBoundingClientRect(), promptWidth, measuredHeight || 178, {
		width: viewportWidth,
		height: viewportHeight,
	});
	form.style.left = `${left}px`;
	form.style.top = `${top}px`;
}

function promptPosition(
	rect: DOMRect,
	promptWidth: number,
	promptHeight: number,
	viewport = { width: window.innerWidth, height: window.innerHeight },
): { left: number; top: number } {
	return promptPositionForRect(rect, {
		width: viewport.width,
		height: viewport.height,
		promptWidth,
		promptHeight,
		gutter: 14,
		gap: 10,
	});
}

function cleanupOverlay(): void {
	host?.remove();
	host = null;
	shadow = null;
}

function sendCancel(reason: BrowserAnnotationCancelReason): void {
	ipcRenderer.send("browser:annotation:cancel", { reason });
}

function isOverlayEvent(event: Event): boolean {
	return Boolean(host && event.composedPath().includes(host));
}
