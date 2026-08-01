import { ipcRenderer } from "electron";
import {
	createBrowserAnnotationContext,
	type BrowserAnnotationCancelReason,
	type BrowserAnnotationContext,
	type BrowserAnnotationPageSubmitPayload,
	type BrowserTextEditPageSubmitPayload,
} from "./shared/browser-annotations";
import { promptPositionForRect } from "./shared/browser-annotation-overlay";

type BrowserOverlayMode = "annotation" | "textEdit";

let mode: BrowserOverlayMode | null = null;
let selectedElement: Element | null = null;
let selectedContext: BrowserAnnotationContext | null = null;
let host: HTMLDivElement | null = null;
let shadow: ShadowRoot | null = null;

ipcRenderer.on("browser:annotation:setMode", (_event, input: { enabled?: boolean }) => {
	setMode(Boolean(input?.enabled) ? "annotation" : null, "disabled");
});

ipcRenderer.on("browser:textEdit:setMode", (_event, input: { enabled?: boolean }) => {
	setMode(Boolean(input?.enabled) ? "textEdit" : null, "disabled");
});

window.addEventListener("beforeunload", () => {
	if (mode) sendCancel(mode, "navigation");
	cleanupOverlay();
	mode = null;
});

function setMode(next: BrowserOverlayMode | null, cancelReason: BrowserAnnotationCancelReason): void {
	if (mode === next) return;
	const previous = mode;
	mode = next;
	selectedElement = null;
	selectedContext = null;
	if (mode) {
		ensureOverlay();
		installListeners();
		renderHint(mode);
	} else {
		removeListeners();
		cleanupOverlay();
		if (previous && cancelReason !== "disabled") sendCancel(previous, cancelReason);
	}
}

function installListeners(): void {
	document.addEventListener("pointerover", handlePointerMove, true);
	document.addEventListener("pointermove", handlePointerMove, true);
	document.addEventListener("click", handleClick, true);
	document.addEventListener("keydown", handleKeyDown, true);
	window.addEventListener("scroll", refreshHighlight, true);
	window.addEventListener("resize", refreshHighlight, true);
}

function removeListeners(): void {
	document.removeEventListener("pointerover", handlePointerMove, true);
	document.removeEventListener("pointermove", handlePointerMove, true);
	document.removeEventListener("click", handleClick, true);
	document.removeEventListener("keydown", handleKeyDown, true);
	window.removeEventListener("scroll", refreshHighlight, true);
	window.removeEventListener("resize", refreshHighlight, true);
}

function handlePointerMove(event: PointerEvent): void {
	if (!mode || !event.isTrusted || selectedContext || isOverlayEvent(event)) return;
	const target = mode === "textEdit" ? textEditTarget(event.target) : annotationTarget(event.target);
	if (!target || target === selectedElement) return;
	selectedElement = target;
	selectedContext = null;
	renderHighlight(target, false);
}

function handleClick(event: MouseEvent): void {
	if (!mode || !event.isTrusted || isOverlayEvent(event)) return;
	if (selectedContext) {
		event.preventDefault();
		event.stopPropagation();
		event.stopImmediatePropagation();
		return;
	}
	const target = mode === "textEdit" ? textEditTarget(event.target) : annotationTarget(event.target);
	if (!target) return;
	event.preventDefault();
	event.stopPropagation();
	event.stopImmediatePropagation();
	selectedElement = target;
	selectedContext = createBrowserAnnotationContext(target);
	if (mode === "textEdit") {
		renderTextEditPrompt(target, selectedContext);
	} else {
		renderAnnotationPrompt(target, selectedContext);
	}
}

function handleKeyDown(event: KeyboardEvent): void {
	if (!mode || !event.isTrusted || event.key !== "Escape") return;
	event.preventDefault();
	event.stopPropagation();
	event.stopImmediatePropagation();
	setMode(null, "escape");
}

function refreshHighlight(): void {
	if (!mode || !selectedElement) return;
	renderHighlight(selectedElement, Boolean(selectedContext));
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

function textEditTarget(target: EventTarget | null): Element | null {
	if (!(target instanceof Element)) return null;
	const element =
		target.closest(
			"h1, h2, h3, h4, h5, h6, p, span, a, button, label, li, td, th, figcaption, blockquote, summary, legend, input, textarea",
		) ?? target;
	if (element === document.documentElement || element === document.body) return null;
	return editableText(element) ? element : null;
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
	shadow = host.attachShadow({ mode: "closed" });
	shadow.innerHTML = `
		<style>
			:host { all: initial; }
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
				width: min(380px, calc(100vw - 24px));
				box-sizing: border-box;
				border: 1px solid rgba(255, 255, 255, 0.14);
				border-radius: 8px;
				background: rgba(18, 20, 24, 0.98);
				color: #f4f5f7;
				box-shadow:
					0 0 0 1px rgba(255, 255, 255, 0.06),
					0 18px 52px rgba(0, 0, 0, 0.48);
				padding: 12px;
				font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
				pointer-events: auto;
				animation: prompt-in 140ms ease-out;
			}
			.prompt__header {
				display: flex;
				align-items: center;
				justify-content: space-between;
				gap: 10px;
				margin-bottom: 9px;
				color: rgba(244, 245, 247, 0.82);
				font-size: 12px;
				font-weight: 650;
			}
			.prompt__target {
				min-width: 0;
				max-width: 170px;
				overflow: hidden;
				border-radius: 999px;
				background: rgba(77, 141, 255, 0.14);
				color: #9fc0ff;
				padding: 3px 7px;
				font: 11px/1.2 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
				text-overflow: ellipsis;
				white-space: nowrap;
			}
			.prompt textarea {
				width: 100%;
				min-height: 102px;
				box-sizing: border-box;
				resize: vertical;
				border: 1px solid rgba(255, 255, 255, 0.12);
				border-radius: 6px;
				background: rgba(7, 8, 10, 0.92);
				color: #f4f5f7;
				padding: 9px 10px;
				font: inherit;
				outline: none;
				transition:
					border-color 120ms ease,
					box-shadow 120ms ease,
					background 120ms ease;
			}
			.prompt textarea:focus {
				border-color: #4d8dff;
				box-shadow: 0 0 0 3px rgba(77, 141, 255, 0.16);
			}
			.actions {
				display: flex;
				justify-content: flex-end;
				gap: 8px;
				margin-top: 8px;
			}
			.actions button {
				height: 30px;
				border-radius: 6px;
				border: 1px solid rgba(255, 255, 255, 0.12);
				background: #1b1d22;
				color: #f4f5f7;
				padding: 0 10px;
				font: inherit;
				transition:
					background 120ms ease,
					border-color 120ms ease,
					transform 120ms ease;
			}
			.actions button:hover {
				background: #242830;
			}
			.actions button:active {
				transform: translateY(1px);
			}
			.actions button[type="submit"] {
				border-color: #4d8dff;
				background: #4d8dff;
				color: #fff;
			}
			.hint {
				position: fixed;
				left: 12px;
				bottom: 12px;
				border-radius: 6px;
				background: #15171b;
				color: #f4f5f7;
				padding: 7px 9px;
				font: 12px/1.3 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
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
		</style>
		<div class="highlight" hidden></div>
		<div class="mount"></div>
	`;
	return shadow;
}

function renderHint(activeMode: BrowserOverlayMode): void {
	const root = ensureOverlay();
	const mount = root.querySelector<HTMLDivElement>(".mount");
	if (!mount) return;
	const message =
		activeMode === "textEdit"
			? "Click text to edit it. Press Esc to cancel."
			: "Click an element to annotate. Press Esc to cancel.";
	mount.innerHTML = `<div class="hint">${message}</div>`;
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

function renderAnnotationPrompt(element: Element, context: BrowserAnnotationContext): void {
	renderHighlight(element, true);
	const root = ensureOverlay();
	const mount = root.querySelector<HTMLDivElement>(".mount");
	if (!mount) return;
	const rect = element.getBoundingClientRect();
	const { left, top } = promptPosition(rect);
	mount.innerHTML = `
		<form class="prompt" style="left: ${left}px; top: ${top}px;">
			<div class="prompt__header">
				<span>Annotate selection</span>
				<span class="prompt__target">${escapeHTML(promptTargetLabel(context))}</span>
			</div>
			<textarea aria-label="Annotation request" placeholder="Describe what to change"></textarea>
			<div class="actions">
				<button type="button" data-action="cancel">Cancel</button>
				<button type="submit">Send</button>
			</div>
		</form>
	`;
	const form = mount.querySelector<HTMLFormElement>("form")!;
	const textarea = form.querySelector<HTMLTextAreaElement>("textarea")!;
	form.addEventListener("submit", (event) => {
		event.preventDefault();
		if (!event.isTrusted) return;
		const instruction = textarea.value.trim();
		if (!instruction) {
			textarea.focus();
			return;
		}
		const payload: BrowserAnnotationPageSubmitPayload = {
			instruction,
			context,
		};
		ipcRenderer.send("browser:annotation:submit", payload);
		setMode(null, "disabled");
	});
	form.querySelector<HTMLButtonElement>('[data-action="cancel"]')?.addEventListener("click", (event) => {
		event.preventDefault();
		if (!event.isTrusted) return;
		setMode(null, "cancel");
	});
	setTimeout(() => textarea.focus(), 0);
}

function renderTextEditPrompt(element: Element, context: BrowserAnnotationContext): void {
	renderHighlight(element, true);
	const oldText = editableText(element);
	const root = ensureOverlay();
	const mount = root.querySelector<HTMLDivElement>(".mount");
	if (!mount) return;
	const rect = element.getBoundingClientRect();
	const { left, top } = promptPosition(rect);
	mount.innerHTML = `
		<form class="prompt" style="left: ${left}px; top: ${top}px;">
			<textarea aria-label="Text replacement"></textarea>
			<div class="actions">
				<button type="button" data-action="cancel">Cancel</button>
				<button type="submit">Save</button>
			</div>
		</form>
	`;
	const form = mount.querySelector<HTMLFormElement>("form")!;
	const textarea = form.querySelector<HTMLTextAreaElement>("textarea")!;
	textarea.value = oldText;
	form.addEventListener("submit", (event) => {
		event.preventDefault();
		if (!event.isTrusted) return;
		const newText = textarea.value;
		if (newText === oldText) {
			textarea.focus();
			return;
		}
		const payload: BrowserTextEditPageSubmitPayload = {
			oldText,
			newText,
			context,
		};
		ipcRenderer.send("browser:textEdit:submit", payload);
		setMode(null, "disabled");
	});
	form.querySelector<HTMLButtonElement>('[data-action="cancel"]')?.addEventListener("click", (event) => {
		event.preventDefault();
		if (!event.isTrusted) return;
		setMode(null, "cancel");
	});
	setTimeout(() => {
		textarea.focus();
		textarea.select();
	}, 0);
}

function editableText(element: Element): string {
	if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
		return element.value.trim();
	}
	const htmlElement = element as HTMLElement;
	return (htmlElement.innerText ?? element.textContent ?? "").trim();
}

function promptPosition(rect: DOMRect): { left: number; top: number } {
	return promptPositionForRect(rect, {
		width: window.innerWidth,
		height: window.innerHeight,
		promptWidth: Math.min(380, window.innerWidth - 24),
		promptHeight: 180,
		gutter: 12,
		gap: 8,
	});
}

function cleanupOverlay(): void {
	host?.remove();
	host = null;
	shadow = null;
}

function sendCancel(activeMode: BrowserOverlayMode, reason: BrowserAnnotationCancelReason): void {
	const channel = activeMode === "textEdit" ? "browser:textEdit:cancel" : "browser:annotation:cancel";
	ipcRenderer.send(channel, { reason });
}

function isOverlayEvent(event: Event): boolean {
	return Boolean(host && event.composedPath().includes(host));
}

function promptTargetLabel(context: BrowserAnnotationContext): string {
	if (context.ariaLabel) return context.ariaLabel;
	if (context.visibleText) return context.visibleText;
	if (context.id) return `${context.tag}#${context.id}`;
	if (context.classes.length > 0) return `${context.tag}.${context.classes[0]}`;
	return context.tag;
}

function escapeHTML(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}
