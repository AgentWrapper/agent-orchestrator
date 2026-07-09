const SCROLLBAR_VISIBLE_MS = 900;
const MIN_INDICATOR_HEIGHT = 24;
const INDICATOR_WIDTH = 5;
const EDGE_OFFSET = 2;

let activeElement: Element | null = null;
let hideTimer: number | undefined;
let indicator: HTMLDivElement | null = null;

function isScrollable(element: Element) {
	const style = window.getComputedStyle(element);
	const overflowY = style.overflowY;
	const canScrollY = element.scrollHeight > element.clientHeight && overflowY !== "hidden" && overflowY !== "clip";

	return canScrollY;
}

function findScrollableElement(target: EventTarget | null) {
	if (!(target instanceof Element)) {
		return document.scrollingElement ?? document.documentElement;
	}

	let current: Element | null = target;
	while (current && current !== document.documentElement) {
		if (isScrollable(current)) {
			return current;
		}
		current = current.parentElement;
	}

	return document.scrollingElement ?? document.documentElement;
}

function getIndicator() {
	if (!indicator) {
		indicator = document.createElement("div");
		indicator.className = "ao-scrollbar-indicator";
		document.body.appendChild(indicator);
	}
	return indicator;
}

function updateIndicator(element: Element) {
	if (element.scrollHeight <= element.clientHeight) return;

	const rect = element.getBoundingClientRect();
	const heightRatio = element.clientHeight / element.scrollHeight;
	const indicatorHeight = Math.max(MIN_INDICATOR_HEIGHT, rect.height * heightRatio);
	const maxScrollTop = element.scrollHeight - element.clientHeight;
	const scrollRatio = maxScrollTop > 0 ? element.scrollTop / maxScrollTop : 0;
	const maxTop = rect.height - indicatorHeight;
	const top = rect.top + maxTop * scrollRatio;
	const node = getIndicator();

	node.style.height = `${indicatorHeight}px`;
	node.style.transform = `translate3d(${Math.round(rect.right - EDGE_OFFSET - INDICATOR_WIDTH)}px, ${Math.round(top)}px, 0)`;
	node.classList.add("is-visible");
}

function showScrollbarFor(element: Element) {
	activeElement = element;
	updateIndicator(element);

	if (hideTimer) {
		window.clearTimeout(hideTimer);
	}

	hideTimer = window.setTimeout(() => {
		indicator?.classList.remove("is-visible");
		activeElement = null;
		hideTimer = undefined;
	}, SCROLLBAR_VISIBLE_MS);
}

export function initMinimalScrollbars() {
	const showForEventTarget = (event: Event) => {
		showScrollbarFor(findScrollableElement(event.target));
	};

	window.addEventListener("wheel", showForEventTarget, { capture: true, passive: true });
	window.addEventListener("touchmove", showForEventTarget, { capture: true, passive: true });
	window.addEventListener("scroll", showForEventTarget, { capture: true, passive: true });
	window.addEventListener("resize", () => {
		if (activeElement) updateIndicator(activeElement);
	});
}
