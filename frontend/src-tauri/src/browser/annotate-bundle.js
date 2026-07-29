(function() {
	//#region src/shared/browser-annotations.ts
	var MAX_TEXT_FIELD_LENGTH = 700;
	var MAX_SELECTOR_DEPTH = 6;
	function createBrowserAnnotationContext(element) {
		const doc = element.ownerDocument;
		const view = doc.defaultView;
		const rect = element.getBoundingClientRect();
		const classList = Array.from(element.classList).slice(0, 8);
		const visibleText = elementText(element, MAX_TEXT_FIELD_LENGTH);
		const selectedText = compactText(view?.getSelection?.()?.toString() ?? "", MAX_TEXT_FIELD_LENGTH);
		const style = view?.getComputedStyle ? view.getComputedStyle(element) : null;
		return {
			url: view?.location.href ?? "",
			title: doc.title || void 0,
			tag: element.tagName.toLowerCase(),
			id: element.id || void 0,
			classes: classList,
			selector: selectorFor(element),
			rect: {
				x: Math.round(rect.x),
				y: Math.round(rect.y),
				width: Math.round(rect.width),
				height: Math.round(rect.height)
			},
			visibleText: visibleText || void 0,
			selectedText: selectedText || void 0,
			ariaRole: element.getAttribute("role") || void 0,
			ariaLabel: ariaName(element) || void 0,
			nearbyText: nearbyText(element),
			computedStyle: style ? {
				display: style.display,
				position: style.position,
				color: style.color,
				backgroundColor: style.backgroundColor,
				fontSize: style.fontSize,
				fontWeight: style.fontWeight,
				padding: style.padding,
				margin: style.margin
			} : {}
		};
	}
	function selectorFor(element) {
		if (element.id) return `${element.tagName.toLowerCase()}#${cssEscape(element.id)}`;
		const parts = [];
		let current = element;
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
	function nthOfType(element) {
		let index = 1;
		let sibling = element.previousElementSibling;
		while (sibling) {
			if (sibling.tagName === element.tagName) index += 1;
			sibling = sibling.previousElementSibling;
		}
		return index;
	}
	function hasSameTagSibling(element) {
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
	function ariaName(element) {
		const label = compactText(element.getAttribute("aria-label") ?? "", 180);
		if (label) return label;
		const labelledBy = element.getAttribute("aria-labelledby");
		if (!labelledBy) return "";
		const doc = element.ownerDocument;
		return compactText(labelledBy.split(/\s+/).map((id) => doc.getElementById(id)?.textContent ?? "").join(" "), 180);
	}
	function nearbyText(element) {
		const values = [];
		const add = (value) => {
			const text = compactText(value ?? "", 180);
			if (text && !values.includes(text)) values.push(text);
		};
		if (element.id) add(element.ownerDocument.querySelector(`label[for="${cssAttributeEscape(element.id)}"]`)?.textContent);
		for (const candidate of Array.from(element.querySelectorAll("label, legend, h1, h2, h3, h4")).slice(0, 4)) add(candidate.textContent);
		const compactTarget = isCompactAnnotationTarget(element);
		if (compactTarget) {
			add(element.previousElementSibling?.textContent);
			add(element.nextElementSibling?.textContent);
		}
		const parent = element.parentElement;
		if (parent && compactTarget) {
			for (const candidate of Array.from(parent.querySelectorAll(":scope > label, :scope > legend, :scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > p")).slice(0, 6)) if (candidate !== element && !element.contains(candidate)) add(candidate.textContent);
		}
		return values.slice(0, 5);
	}
	function isCompactAnnotationTarget(element) {
		return element.matches("button, a, input, textarea, select, [role]");
	}
	function elementText(element, maxLength) {
		return compactText(element.innerText ?? element.textContent ?? "", maxLength);
	}
	function compactText(value, maxLength) {
		const compact = value.replace(/\s+/g, " ").trim();
		if (compact.length <= maxLength) return compact;
		return `${compact.slice(0, Math.max(0, maxLength - 12)).trimEnd()} [truncated]`;
	}
	function cssEscape(value) {
		return globalThis.CSS?.escape ? globalThis.CSS.escape(value) : value.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
	}
	function cssAttributeEscape(value) {
		return value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
	}
	//#endregion
	//#region src/browser-annotate/main.ts
	var enabled = false;
	var selectedElement = null;
	var selectedContext = null;
	var host = null;
	var shadow = null;
	function viewId() {
		return window.__AO_BROWSER_VIEW_ID__ ?? "";
	}
	function invoke(cmd, payload) {
		window.__TAURI_INTERNALS__?.invoke(cmd, payload)?.catch(() => void 0);
	}
	window.__AO_SET_ANNOTATION_MODE__ = (next) => {
		setEnabled(Boolean(next), "disabled");
	};
	window.addEventListener("beforeunload", () => {
		if (enabled) sendCancel("navigation");
		cleanupOverlay();
		enabled = false;
	});
	function setEnabled(next, cancelReason) {
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
	function installListeners() {
		document.addEventListener("pointerover", handlePointerMove, true);
		document.addEventListener("pointermove", handlePointerMove, true);
		document.addEventListener("click", handleClick, true);
		document.addEventListener("keydown", handleKeyDown, true);
		window.addEventListener("scroll", refreshHighlight, true);
		window.addEventListener("resize", refreshHighlight, true);
	}
	function removeListeners() {
		document.removeEventListener("pointerover", handlePointerMove, true);
		document.removeEventListener("pointermove", handlePointerMove, true);
		document.removeEventListener("click", handleClick, true);
		document.removeEventListener("keydown", handleKeyDown, true);
		window.removeEventListener("scroll", refreshHighlight, true);
		window.removeEventListener("resize", refreshHighlight, true);
	}
	function handlePointerMove(event) {
		if (!enabled || isOverlayEvent(event)) return;
		const target = annotationTarget(event.target);
		if (!target || target === selectedElement) return;
		selectedElement = target;
		selectedContext = null;
		renderHighlight(target, false);
	}
	function handleClick(event) {
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
	function handleKeyDown(event) {
		if (!enabled || event.key !== "Escape") return;
		event.preventDefault();
		event.stopPropagation();
		event.stopImmediatePropagation();
		setEnabled(false, "escape");
	}
	function refreshHighlight() {
		if (!enabled || !selectedElement) return;
		renderHighlight(selectedElement, Boolean(selectedContext));
	}
	function annotationTarget(target) {
		if (!(target instanceof Element)) return null;
		const element = target.closest("button, a, input, textarea, select, [role]") ?? target.closest("[data-testid], [id], [class]") ?? target;
		if (element === document.documentElement || element === document.body) return null;
		return element;
	}
	function ensureOverlay() {
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
	function renderHint() {
		const mount = ensureOverlay().querySelector(".mount");
		if (!mount) return;
		mount.innerHTML = `<div class="hint">Click an element to annotate. Press Esc to cancel.</div>`;
	}
	function renderHighlight(element, locked) {
		const highlight = ensureOverlay().querySelector(".highlight");
		if (!highlight) return;
		const rect = element.getBoundingClientRect();
		highlight.hidden = false;
		highlight.style.left = `${Math.max(0, rect.left)}px`;
		highlight.style.top = `${Math.max(0, rect.top)}px`;
		highlight.style.width = `${Math.max(0, rect.width)}px`;
		highlight.style.height = `${Math.max(0, rect.height)}px`;
		highlight.style.borderColor = locked ? "#74b98a" : "#4d8dff";
	}
	function renderPrompt(element, context) {
		renderHighlight(element, true);
		const mount = ensureOverlay().querySelector(".mount");
		if (!mount) return;
		const { left, top } = promptPosition(element.getBoundingClientRect());
		mount.innerHTML = `
		<form class="prompt" style="left: ${left}px; top: ${top}px;">
			<textarea aria-label="Annotation request" placeholder="Describe what to change"></textarea>
			<div class="actions">
				<button type="button" data-action="cancel">Cancel</button>
				<button type="submit">Send</button>
			</div>
		</form>
	`;
		const form = mount.querySelector("form");
		const textarea = form.querySelector("textarea");
		form.addEventListener("submit", (event) => {
			event.preventDefault();
			const instruction = textarea.value.trim();
			if (!instruction) {
				textarea.focus();
				return;
			}
			invoke("browser_annotation_submit", {
				viewId: viewId(),
				instruction,
				context
			});
			setEnabled(false, "disabled");
		});
		form.querySelector("[data-action=\"cancel\"]")?.addEventListener("click", () => {
			setEnabled(false, "cancel");
		});
		setTimeout(() => textarea.focus(), 0);
	}
	function promptPosition(rect) {
		const width = Math.min(360, window.innerWidth - 24);
		const height = 150;
		const left = clamp(rect.left, 12, Math.max(12, window.innerWidth - width - 12));
		const below = rect.bottom + 8;
		return {
			left,
			top: below + height <= window.innerHeight - 12 ? below : Math.max(12, rect.top - height - 8)
		};
	}
	function cleanupOverlay() {
		host?.remove();
		host = null;
		shadow = null;
	}
	function sendCancel(reason) {
		invoke("browser_annotation_cancel", {
			viewId: viewId(),
			reason
		});
	}
	function isOverlayEvent(event) {
		return Boolean(host && event.composedPath().includes(host));
	}
	function clamp(value, min, max) {
		return Math.min(max, Math.max(min, value));
	}
	function isForwardableChord(event) {
		if (event.ctrlKey || event.metaKey) return true;
		return event.code === "Backquote" && event.shiftKey;
	}
	function forwardShortcut(event) {
		if (event.repeat) return;
		if (!isForwardableChord(event)) return;
		invoke("browser_forward_shortcut", {
			viewId: viewId(),
			key: event.key,
			code: event.code,
			ctrl: event.ctrlKey,
			meta: event.metaKey,
			shift: event.shiftKey,
			alt: event.altKey
		});
	}
	window.addEventListener("keydown", forwardShortcut, true);
	//#endregion
})();
