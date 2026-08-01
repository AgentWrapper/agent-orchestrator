import { ipcRenderer } from "electron";
import {
	createBrowserAnnotationContext,
	type BrowserAnnotationCancelReason,
	type BrowserAnnotationContext,
	type BrowserAnnotationPageSubmitPayload,
	type BrowserTextEditPageSubmitPayload,
} from "./shared/browser-annotations";

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
	if (!mode || !event.isTrusted || isOverlayEvent(event)) return;
	const target = mode === "textEdit" ? textEditTarget(event.target) : annotationTarget(event.target);
	if (!target || target === selectedElement) return;
	selectedElement = target;
	selectedContext = null;
	renderHighlight(target, false);
}

function handleClick(event: MouseEvent): void {
	if (!mode || !event.isTrusted || isOverlayEvent(event)) return;
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
				border-radius: 6px;
				background: rgba(77, 141, 255, 0.12);
				box-shadow: 0 0 0 9999px rgba(0, 0, 0, 0.08);
				pointer-events: none;
			}
			.prompt {
				position: fixed;
				width: min(360px, calc(100vw - 24px));
				box-sizing: border-box;
				border: 1px solid rgba(255, 255, 255, 0.14);
				border-radius: 8px;
				background: #15171b;
				color: #f4f5f7;
				box-shadow: 0 16px 40px rgba(0, 0, 0, 0.42);
				padding: 10px;
				font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
				pointer-events: auto;
			}
			.prompt textarea {
				width: 100%;
				min-height: 92px;
				box-sizing: border-box;
				resize: vertical;
				border: 1px solid rgba(255, 255, 255, 0.12);
				border-radius: 6px;
				background: #0a0b0d;
				color: #f4f5f7;
				padding: 8px;
				font: inherit;
				outline: none;
			}
			.prompt textarea:focus { border-color: #4d8dff; }
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
	const width = Math.min(360, window.innerWidth - 24);
	const height = 150;
	const left = clamp(rect.left, 12, Math.max(12, window.innerWidth - width - 12));
	const below = rect.bottom + 8;
	const top = below + height <= window.innerHeight - 12 ? below : Math.max(12, rect.top - height - 8);
	return { left, top };
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

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}
