import { ipcRenderer } from "electron";
import {
	createBrowserAnnotationContext,
	type BrowserAnnotationCancelReason,
	type BrowserAnnotationContext,
	type BrowserAnnotationPageSubmitPayload,
} from "./shared/browser-annotations";
import {
	boundingRectOfPoints,
	closeLassoPath,
	pointInPolygon,
	promptPositionForRect,
	sampleGridPoints,
	shouldAppendLassoPoint,
	type AnnotationRectLike,
	type LassoBounds,
	type LassoPoint,
} from "./shared/browser-annotation-overlay";

const LASSO_MOVEMENT_THRESHOLD_PX = 4;
const LASSO_GRID_SIZE = 8;
const LASSO_MAX_NEW_ELEMENTS = 15;

let enabled = false;
let selectedElement: Element | null = null;
let selectedContext: BrowserAnnotationContext | null = null;
let multiSelectActive = false;
let multiSelectElements: Element[] = [];
let multiSelectContexts: BrowserAnnotationContext[] | null = null;
let dragStart: LassoPoint | null = null;
let lassoActive = false;
let lassoPoints: LassoPoint[] = [];
let suppressNextClick = false;
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
	multiSelectActive = false;
	multiSelectElements = [];
	multiSelectContexts = null;
	resetLassoState();
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
	document.addEventListener("pointerdown", handlePointerDown, true);
	document.addEventListener("pointerup", handlePointerUp, true);
	document.addEventListener("click", handleClick, true);
	document.addEventListener("keydown", handleKeyDown, true);
	window.addEventListener("scroll", refreshHighlight, true);
	window.addEventListener("resize", refreshHighlight, true);
}

function removeListeners(): void {
	document.removeEventListener("pointerover", handlePointerMove, true);
	document.removeEventListener("pointermove", handlePointerMove, true);
	document.removeEventListener("pointerdown", handlePointerDown, true);
	document.removeEventListener("pointerup", handlePointerUp, true);
	document.removeEventListener("click", handleClick, true);
	document.removeEventListener("keydown", handleKeyDown, true);
	window.removeEventListener("scroll", refreshHighlight, true);
	window.removeEventListener("resize", refreshHighlight, true);
}

function handlePointerMove(event: PointerEvent): void {
	if (!enabled || isOverlayEvent(event)) return;
	if (dragStart) {
		handleLassoPointerMove(event);
		return;
	}
	if (selectedContext || multiSelectContexts) return;
	const target = annotationTarget(event.target);
	if (!target || target === selectedElement) return;
	selectedElement = target;
	selectedContext = null;
	renderHighlight(target, false);
}

function handlePointerDown(event: PointerEvent): void {
	if (!enabled || !multiSelectActive || isOverlayEvent(event) || event.button !== 0) return;
	dragStart = { x: event.clientX, y: event.clientY };
}

function handleLassoPointerMove(event: PointerEvent): void {
	const point: LassoPoint = { x: event.clientX, y: event.clientY };
	if (!lassoActive) {
		if (!shouldAppendLassoPoint(dragStart, point, LASSO_MOVEMENT_THRESHOLD_PX)) return;
		lassoActive = true;
		hideHoverHighlight();
		lassoPoints = dragStart ? [dragStart, point] : [point];
		renderLassoPath(lassoPoints);
		return;
	}
	if (!shouldAppendLassoPoint(lassoPoints[lassoPoints.length - 1] ?? null, point, LASSO_MOVEMENT_THRESHOLD_PX)) return;
	lassoPoints.push(point);
	renderLassoPath(lassoPoints);
}

function handlePointerUp(event: PointerEvent): void {
	if (!enabled || isOverlayEvent(event) || !dragStart) return;
	if (lassoActive) {
		finishLasso();
		suppressNextClick = true;
	}
	dragStart = null;
	lassoActive = false;
	lassoPoints = [];
	clearLassoPath();
}

function handleClick(event: MouseEvent): void {
	if (!enabled || isOverlayEvent(event)) return;
	if (suppressNextClick) {
		suppressNextClick = false;
		event.preventDefault();
		event.stopPropagation();
		event.stopImmediatePropagation();
		return;
	}
	if (selectedContext || multiSelectContexts) {
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
	if (multiSelectActive) {
		toggleMultiSelectElement(target);
		return;
	}
	selectedElement = target;
	selectedContext = createBrowserAnnotationContext(target);
	renderPrompt(target, selectedContext);
}

function handleKeyDown(event: KeyboardEvent): void {
	if (!enabled) return;
	if (event.key === "Escape") {
		event.preventDefault();
		event.stopPropagation();
		event.stopImmediatePropagation();
		setEnabled(false, "escape");
		return;
	}
	if (event.key !== "Shift" || event.repeat || selectedContext || multiSelectContexts) return;
	event.preventDefault();
	event.stopPropagation();
	event.stopImmediatePropagation();
	if (multiSelectActive) {
		finishMultiSelect();
	} else {
		startMultiSelect();
	}
}

function startMultiSelect(): void {
	multiSelectActive = true;
	multiSelectElements = [];
	hideHoverHighlight();
	renderMultiSelections();
	renderHint();
}

function finishMultiSelect(): void {
	multiSelectActive = false;
	resetLassoState();
	hideHoverHighlight();
	if (multiSelectElements.length === 0) {
		renderHint();
		return;
	}
	multiSelectContexts = multiSelectElements.map(createBrowserAnnotationContext);
	renderMultiPrompt(multiSelectElements, multiSelectContexts);
}

function toggleMultiSelectElement(target: Element): void {
	const index = multiSelectElements.indexOf(target);
	if (index === -1) {
		multiSelectElements.push(target);
	} else {
		multiSelectElements.splice(index, 1);
	}
	renderMultiSelections();
	renderHint();
}

function finishLasso(): void {
	const polygon = closeLassoPath(lassoPoints);
	const bounds = boundingRectOfPoints(polygon);
	multiSelectElements.push(...elementsInLasso(polygon, bounds));
	renderMultiSelections();
	renderHint();
}

function elementsInLasso(polygon: LassoPoint[], bounds: LassoBounds): Element[] {
	const found: Element[] = [];
	for (const point of sampleGridPoints(bounds, LASSO_GRID_SIZE, LASSO_GRID_SIZE)) {
		if (!pointInPolygon(point, polygon)) continue;
		const target = annotationTarget(document.elementFromPoint(point.x, point.y));
		if (!target || found.includes(target) || multiSelectElements.includes(target)) continue;
		found.push(target);
	}
	return capByVisibleArea(found, LASSO_MAX_NEW_ELEMENTS);
}

function capByVisibleArea(elements: Element[], max: number): Element[] {
	if (elements.length <= max) return elements;
	return [...elements].sort((a, b) => elementArea(b) - elementArea(a)).slice(0, max);
}

function elementArea(element: Element): number {
	const rect = element.getBoundingClientRect();
	return rect.width * rect.height;
}

function resetLassoState(): void {
	dragStart = null;
	lassoActive = false;
	lassoPoints = [];
	suppressNextClick = false;
}

function hideHoverHighlight(): void {
	selectedElement = null;
	const highlight = ensureOverlay().querySelector<HTMLDivElement>(".highlight");
	if (highlight) highlight.hidden = true;
}

function refreshHighlight(): void {
	if (!enabled) return;
	if (selectedElement) renderHighlight(selectedElement, Boolean(selectedContext));
	if (multiSelectElements.length > 0) renderMultiSelections();
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
			.highlight--selected {
				border-color: #74b98a;
				background: rgba(116, 185, 138, 0.14);
				box-shadow:
					0 0 0 1px rgba(255, 255, 255, 0.20),
					0 12px 36px rgba(0, 0, 0, 0.24);
			}
			.lasso {
				position: fixed;
				inset: 0;
				width: 100%;
				height: 100%;
				pointer-events: none;
			}
			.lasso__path {
				fill: rgba(77, 141, 255, 0.10);
				stroke: #4d8dff;
				stroke-width: 1.5;
				stroke-dasharray: 4 3;
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
		<svg class="lasso"><polygon class="lasso__path" points=""></polygon></svg>
		<div class="selections"></div>
		<div class="mount"></div>
	`;
	return shadow;
}

function renderHint(): void {
	const root = ensureOverlay();
	const mount = root.querySelector<HTMLDivElement>(".mount");
	if (!mount) return;
	mount.innerHTML = `<div class="hint">${hintText()}</div>`;
}

function hintText(): string {
	if (!multiSelectActive) {
		return "Click an element to annotate, or press Shift to select multiple. Press Esc to cancel.";
	}
	if (multiSelectElements.length === 0) {
		return "Click elements to select them, or drag to lasso-select several. Press Shift again to finish.";
	}
	const count = multiSelectElements.length;
	return `${count} element${count === 1 ? "" : "s"} selected. Click or drag to add more, or press Shift to finish.`;
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

function renderMultiSelections(): void {
	const root = ensureOverlay();
	const container = root.querySelector<HTMLDivElement>(".selections");
	if (!container) return;
	container.innerHTML = "";
	for (const element of multiSelectElements) {
		const rect = element.getBoundingClientRect();
		const box = document.createElement("div");
		box.className = "highlight highlight--selected";
		box.style.left = `${Math.max(0, rect.left)}px`;
		box.style.top = `${Math.max(0, rect.top)}px`;
		box.style.width = `${Math.max(0, rect.width)}px`;
		box.style.height = `${Math.max(0, rect.height)}px`;
		container.appendChild(box);
	}
}

function renderLassoPath(points: LassoPoint[]): void {
	const root = ensureOverlay();
	const polygon = root.querySelector<SVGPolygonElement>(".lasso__path");
	if (!polygon) return;
	polygon.setAttribute("points", points.map((point) => `${point.x},${point.y}`).join(" "));
}

function clearLassoPath(): void {
	renderLassoPath([]);
}

function renderPrompt(element: Element, context: BrowserAnnotationContext): void {
	renderHighlight(element, true);
	openPrompt(element.getBoundingClientRect(), promptTargetLabel(context), (instruction) => ({
		instruction,
		selection: { kind: "element", context },
	}));
}

function renderMultiPrompt(elements: Element[], contexts: BrowserAnnotationContext[]): void {
	renderMultiSelections();
	openPrompt(unionRect(elements), multiPromptTargetLabel(contexts.length), (instruction) => ({
		instruction,
		selection: { kind: "elements", contexts },
	}));
}

function openPrompt(
	rect: AnnotationRectLike,
	targetLabel: string,
	buildPayload: (instruction: string) => BrowserAnnotationPageSubmitPayload,
): void {
	const root = ensureOverlay();
	const mount = root.querySelector<HTMLDivElement>(".mount");
	if (!mount) return;
	const { left, top } = promptPosition(rect);
	mount.innerHTML = `
		<form class="prompt" style="left: ${left}px; top: ${top}px;">
			<div class="prompt__header">
				<span>Annotate selection</span>
				<span class="prompt__target">${escapeHTML(targetLabel)}</span>
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
		const instruction = textarea.value.trim();
		if (!instruction) {
			textarea.focus();
			return;
		}
		ipcRenderer.send("browser:annotation:submit", buildPayload(instruction));
		setEnabled(false, "disabled");
	});
	form.querySelector<HTMLButtonElement>('[data-action="cancel"]')?.addEventListener("click", () => {
		setEnabled(false, "cancel");
	});
	setTimeout(() => textarea.focus(), 0);
}

function promptPosition(rect: AnnotationRectLike): { left: number; top: number } {
	return promptPositionForRect(rect, {
		width: window.innerWidth,
		height: window.innerHeight,
		promptWidth: Math.min(380, window.innerWidth - 24),
		promptHeight: 180,
		gutter: 12,
		gap: 8,
	});
}

function unionRect(elements: Element[]): AnnotationRectLike {
	const rects = elements.map((element) => element.getBoundingClientRect());
	return {
		left: Math.min(...rects.map((rect) => rect.left)),
		top: Math.min(...rects.map((rect) => rect.top)),
		bottom: Math.max(...rects.map((rect) => rect.bottom)),
	};
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

function promptTargetLabel(context: BrowserAnnotationContext): string {
	if (context.ariaLabel) return context.ariaLabel;
	if (context.visibleText) return context.visibleText;
	if (context.id) return `${context.tag}#${context.id}`;
	if (context.classes.length > 0) return `${context.tag}.${context.classes[0]}`;
	return context.tag;
}

function multiPromptTargetLabel(count: number): string {
	return `${count} element${count === 1 ? "" : "s"} selected`;
}

function escapeHTML(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}
