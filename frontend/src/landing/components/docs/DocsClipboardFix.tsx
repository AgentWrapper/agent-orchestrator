"use client";

import { useEffect } from "react";

async function writeClipboard(text: string) {
	if (!text) return false;

	if (navigator.clipboard?.writeText) {
		try {
			await navigator.clipboard.writeText(text);
			return true;
		} catch {
			// Fall through to execCommand for browsers that block async clipboard.
		}
	}

	const textarea = document.createElement("textarea");
	textarea.value = text;
	textarea.setAttribute("readonly", "");
	textarea.style.position = "fixed";
	textarea.style.left = "-9999px";
	textarea.style.top = "0";
	document.body.appendChild(textarea);

	const selection = document.getSelection();
	const selectedRange = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;

	textarea.focus();
	textarea.select();

	let copied = false;
	try {
		copied = document.execCommand("copy");
	} catch {
		copied = false;
	}

	document.body.removeChild(textarea);

	if (selectedRange && selection) {
		selection.removeAllRanges();
		selection.addRange(selectedRange);
	}

	return copied;
}

function getCodeText(button: HTMLButtonElement) {
	const figure = button.closest("figure");
	const pre = figure?.querySelector("pre");
	if (!pre) return "";

	const clone = pre.cloneNode(true) as HTMLElement;
	clone.querySelectorAll(".nd-copy-ignore").forEach((node) => {
		node.replaceWith("\n");
	});
	return clone.textContent ?? "";
}

function getLinkText(button: HTMLButtonElement) {
	const header = button.closest("h1,h2,h3,h4,h5,h6");
	const id = header?.id;
	if (!id) return "";

	const url = new URL(window.location.href);
	url.hash = id;
	return url.toString();
}

export function DocsClipboardFix() {
	useEffect(() => {
		const timers = new WeakMap<HTMLButtonElement, number>();

		const onClick = (event: MouseEvent) => {
			const button = (event.target as Element | null)?.closest("button");
			if (!(button instanceof HTMLButtonElement)) return;

			const label = button.getAttribute("aria-label") ?? "";
			const isCodeCopy = label === "Copy Text" || label === "Copied Text";
			const isLinkCopy = label === "Copy Link";
			if (!isCodeCopy && !isLinkCopy) return;

			const text = isCodeCopy ? getCodeText(button) : getLinkText(button);
			if (!text) return;

			event.preventDefault();
			event.stopPropagation();

			void writeClipboard(text).then((copied) => {
				if (!copied) return;
				const activeTimer = timers.get(button);
				if (activeTimer) window.clearTimeout(activeTimer);
				button.dataset.checked = "true";
				button.setAttribute("aria-label", isCodeCopy ? "Copied Text" : "Copied Link");
				const resetTimer = window.setTimeout(() => {
					delete button.dataset.checked;
					button.setAttribute("aria-label", isCodeCopy ? "Copy Text" : "Copy Link");
					timers.delete(button);
				}, 1500);
				timers.set(button, resetTimer);
			});
		};

		document.addEventListener("click", onClick, true);
		return () => {
			document.removeEventListener("click", onClick, true);
		};
	}, []);

	return null;
}
