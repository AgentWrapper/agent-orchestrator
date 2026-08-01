import { ipcRenderer } from "electron";
import {
	createBrowserAnnotationContext,
	type BrowserAnnotationCancelReason,
	type BrowserAnnotationContext,
	type BrowserAnnotationPageSubmitPayload,
} from "./shared/browser-annotations";

let enabled = false;
let selectedElement: Element | null = null;
let selectedContext: BrowserAnnotationContext | null = null;
let host: HTMLDivElement | null = null;
let shadow: ShadowRoot | null = null;

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
	if (!enabled || isOverlayEvent(event)) return;
	const target = annotationTarget(event.target);
	if (!target || target === selectedElement) return;
	selectedElement = target;
	selectedContext = null;
	renderHighlight(target, false);
}

function handleClick(event: MouseEvent): void {
	if (!enabled || isOverlayEvent(event)) return;
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
		const instruction = textarea.value.trim();
		if (!instruction) {
			textarea.focus();
			return;
		}
		const payload: BrowserAnnotationPageSubmitPayload = { instruction, context };
		ipcRenderer.send("browser:annotation:submit", payload);
		setEnabled(false, "disabled");
	});
	form.querySelector<HTMLButtonElement>('[data-action="cancel"]')?.addEventListener("click", () => {
		setEnabled(false, "cancel");
	});
	setTimeout(() => textarea.focus(), 0);
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

function sendCancel(reason: BrowserAnnotationCancelReason): void {
	ipcRenderer.send("browser:annotation:cancel", { reason });
}

function isOverlayEvent(event: Event): boolean {
	return Boolean(host && event.composedPath().includes(host));
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}
