export const MAX_BROWSER_ANNOTATION_MESSAGE_LENGTH = 4096;

const MAX_INSTRUCTION_LENGTH = 1400;
const MAX_TEXT_FIELD_LENGTH = 700;
const MAX_NEARBY_TEXT_LENGTH = 500;
const MAX_SELECTOR_DEPTH = 6;

export type BrowserAnnotationRect = {
	x: number;
	y: number;
	width: number;
	height: number;
};

export type BrowserAnnotationComputedStyle = Partial<{
	display: string;
	position: string;
	color: string;
	backgroundColor: string;
	fontSize: string;
	fontWeight: string;
	padding: string;
	margin: string;
}>;

export type BrowserAnnotationContext = {
	url: string;
	title?: string;
	tag: string;
	id?: string;
	classes: string[];
	selector: string;
	rect: BrowserAnnotationRect;
	visibleText?: string;
	selectedText?: string;
	ariaRole?: string;
	ariaLabel?: string;
	nearbyText: string[];
	computedStyle: BrowserAnnotationComputedStyle;
};

export type BrowserAnnotationModeInput = {
	viewId: string;
	enabled: boolean;
};

export type BrowserAnnotationPageSubmitPayload = {
	instruction: string;
	context: BrowserAnnotationContext;
};

export type BrowserAnnotationSubmitPayload = BrowserAnnotationPageSubmitPayload & {
	viewId: string;
};

export type BrowserAnnotationCancelReason = "escape" | "cancel" | "navigation" | "disabled";

export type BrowserAnnotationPageCancelPayload = {
	reason: BrowserAnnotationCancelReason;
};

export type BrowserAnnotationCancelPayload = BrowserAnnotationPageCancelPayload & {
	viewId: string;
};

export function createBrowserAnnotationContext(element: Element): BrowserAnnotationContext {
	const doc = element.ownerDocument;
	const view = doc.defaultView;
	const rect = element.getBoundingClientRect();
	const classList = Array.from(element.classList).slice(0, 8);
	const visibleText = elementText(element, MAX_TEXT_FIELD_LENGTH);
	const selectedText = compactText(view?.getSelection?.()?.toString() ?? "", MAX_TEXT_FIELD_LENGTH);
	const style = view?.getComputedStyle ? view.getComputedStyle(element) : null;

	return {
		url: view?.location.href ?? "",
		title: doc.title || undefined,
		tag: element.tagName.toLowerCase(),
		id: element.id || undefined,
		classes: classList,
		selector: selectorFor(element),
		rect: {
			x: Math.round(rect.x),
			y: Math.round(rect.y),
			width: Math.round(rect.width),
			height: Math.round(rect.height),
		},
		visibleText: visibleText || undefined,
		selectedText: selectedText || undefined,
		ariaRole: element.getAttribute("role") || undefined,
		ariaLabel: ariaName(element) || undefined,
		nearbyText: nearbyText(element),
		computedStyle: style
			? {
					display: style.display,
					position: style.position,
					color: style.color,
					backgroundColor: style.backgroundColor,
					fontSize: style.fontSize,
					fontWeight: style.fontWeight,
					padding: style.padding,
					margin: style.margin,
				}
			: {},
	};
}

export function formatBrowserAnnotationMessage(payload: BrowserAnnotationSubmitPayload): string {
	const context = payload.context;
	const lines = [
		"The user selected an element in the AO browser preview and asked for a change.",
		"",
		"Change request:",
		compactText(payload.instruction, MAX_INSTRUCTION_LENGTH) || "(empty)",
		"",
		"Selected element context:",
		`- URL: ${context.url || "(unknown)"}`,
		context.title ? `- Title: ${compactText(context.title, 160)}` : null,
		`- Element: ${elementSummary(context)}`,
		`- Selector: ${context.selector}`,
		`- Bounds: x=${context.rect.x}, y=${context.rect.y}, width=${context.rect.width}, height=${context.rect.height}`,
		context.visibleText ? `- Visible text: ${compactText(context.visibleText, MAX_TEXT_FIELD_LENGTH)}` : null,
		context.selectedText ? `- Selected text: ${compactText(context.selectedText, MAX_TEXT_FIELD_LENGTH)}` : null,
		context.ariaRole ? `- ARIA role: ${compactText(context.ariaRole, 120)}` : null,
		context.ariaLabel ? `- ARIA/name: ${compactText(context.ariaLabel, 180)}` : null,
		context.nearbyText.length > 0
			? `- Nearby text: ${compactText(context.nearbyText.join(" | "), MAX_NEARBY_TEXT_LENGTH)}`
			: null,
		Object.keys(context.computedStyle).length > 0
			? `- Computed style: ${compactText(JSON.stringify(context.computedStyle), 700)}`
			: null,
		"",
		"Execution constraints:",
		"- Make the smallest source change that satisfies the request.",
		"- Do not start, restart, or background a dev server.",
		"- Do not run watch-mode or long-running commands.",
		"- If verification is needed, use a finite command only; otherwise rely on the existing preview watcher or dev-server refresh.",
	].filter((line): line is string => line !== null);

	return limitMessage(lines.join("\n"), MAX_BROWSER_ANNOTATION_MESSAGE_LENGTH);
}

function elementSummary(context: BrowserAnnotationContext): string {
	const id = context.id ? `#${context.id}` : "";
	const classes = context.classes.length > 0 ? `.${context.classes.join(".")}` : "";
	return `${context.tag}${id}${classes}`;
}

function selectorFor(element: Element): string {
	if (element.id) return `${element.tagName.toLowerCase()}#${cssEscape(element.id)}`;
	const parts: string[] = [];
	let current: Element | null = element;
	while (current && current.nodeType === Node.ELEMENT_NODE && parts.length < MAX_SELECTOR_DEPTH) {
		const tag = current.tagName.toLowerCase();
		if (tag === "html") break;
		let part = tag;
		const classes = Array.from(current.classList).slice(0, 2);
		if (classes.length > 0) part += `.${classes.map(cssEscape).join(".")}`;
		const index = nthOfType(current);
		if (index > 1 || hasSameTagSibling(current)) part += `:nth-of-type(${index})`;
		parts.unshift(part);
		current = current.parentElement;
	}
	return parts.join(" > ") || element.tagName.toLowerCase();
}

function nthOfType(element: Element): number {
	let index = 1;
	let sibling = element.previousElementSibling;
	while (sibling) {
		if (sibling.tagName === element.tagName) index += 1;
		sibling = sibling.previousElementSibling;
	}
	return index;
}

function hasSameTagSibling(element: Element): boolean {
	let sibling = element.previousElementSibling;
	while (sibling) {
		if (sibling.tagName === element.tagName) return true;
		sibling = sibling.previousElementSibling;
	}
	sibling = element.nextElementSibling;
	while (sibling) {
		if (sibling.tagName === element.tagName) return true;
		sibling = sibling.nextElementSibling;
	}
	return false;
}

function ariaName(element: Element): string {
	const label = compactText(element.getAttribute("aria-label") ?? "", 180);
	if (label) return label;
	const labelledBy = element.getAttribute("aria-labelledby");
	if (!labelledBy) return "";
	const doc = element.ownerDocument;
	return compactText(
		labelledBy
			.split(/\s+/)
			.map((id) => doc.getElementById(id)?.textContent ?? "")
			.join(" "),
		180,
	);
}

function nearbyText(element: Element): string[] {
	const values: string[] = [];
	const add = (value: string | null | undefined) => {
		const text = compactText(value ?? "", 180);
		if (text && !values.includes(text)) values.push(text);
	};

	if (element.id) {
		const label = element.ownerDocument.querySelector(`label[for="${cssAttributeEscape(element.id)}"]`);
		add(label?.textContent);
	}
	for (const candidate of Array.from(element.querySelectorAll("label, legend, h1, h2, h3, h4")).slice(0, 4)) {
		add(candidate.textContent);
	}
	const compactTarget = isCompactAnnotationTarget(element);
	if (compactTarget) {
		add(element.previousElementSibling?.textContent);
		add(element.nextElementSibling?.textContent);
	}
	const parent = element.parentElement;
	if (parent && compactTarget) {
		for (const candidate of Array.from(
			parent.querySelectorAll(
				":scope > label, :scope > legend, :scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > p",
			),
		).slice(0, 6)) {
			if (candidate !== element && !element.contains(candidate)) add(candidate.textContent);
		}
	}
	return values.slice(0, 5);
}

function isCompactAnnotationTarget(element: Element): boolean {
	return element.matches("button, a, input, textarea, select, [role]");
}

function elementText(element: Element, maxLength: number): string {
	const htmlElement = element as HTMLElement;
	return compactText(htmlElement.innerText ?? element.textContent ?? "", maxLength);
}

function compactText(value: string, maxLength: number): string {
	const compact = value.replace(/\s+/g, " ").trim();
	if (compact.length <= maxLength) return compact;
	const suffix = " [truncated]";
	return `${compact.slice(0, Math.max(0, maxLength - suffix.length)).trimEnd()}${suffix}`;
}

function limitMessage(message: string, maxLength: number): string {
	if (message.length <= maxLength) return message;
	const suffix = "\n[truncated]";
	return `${message.slice(0, Math.max(0, maxLength - suffix.length)).trimEnd()}${suffix}`;
}

function cssEscape(value: string): string {
	return globalThis.CSS?.escape ? globalThis.CSS.escape(value) : value.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
}

function cssAttributeEscape(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
