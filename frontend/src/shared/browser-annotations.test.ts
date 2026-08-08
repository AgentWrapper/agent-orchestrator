import { describe, expect, it, vi } from "vitest";
import {
	MAX_BROWSER_ANNOTATION_MESSAGE_LENGTH,
	createBrowserAnnotationContext,
	formatBrowserAnnotationMessage,
} from "./browser-annotations";

describe("createBrowserAnnotationContext", () => {
	it("captures bounded DOM context for the selected element", () => {
		document.body.innerHTML = `
			<main>
				<label for="email">Email address</label>
				<section>
					<button id="save" class="primary cta" aria-label="Save profile" style="font-size: 18px; font-weight: 700;">
						Save changes
					</button>
					<p>Changes apply to the active customer profile.</p>
				</section>
			</main>
		`;
		const button = document.querySelector<HTMLButtonElement>("#save")!;
		button.getBoundingClientRect = vi.fn(() => ({
			x: 16,
			y: 24,
			width: 140,
			height: 36,
			top: 24,
			right: 156,
			bottom: 60,
			left: 16,
			toJSON: () => ({}),
		}));

		const context = createBrowserAnnotationContext(button);

		expect(context.tag).toBe("button");
		expect(context.id).toBe("save");
		expect(context.classes).toEqual(["primary", "cta"]);
		expect(context.selector).toBe("button#save");
		expect(context.size).toEqual({ width: 140, height: 36 });
		expect(context.visibleText).toBe("Save changes");
		expect(context.ariaLabel).toBe("Save profile");
		expect(context.computedStyle.fontSize).toBe("18px");
		expect(context.computedStyle.fontWeight).toBe("700");
	});
});

describe("formatBrowserAnnotationMessage", () => {
	it("formats the user instruction and selected element context for the agent", () => {
		const message = formatBrowserAnnotationMessage({
			viewId: "42:sess-1",
			instruction: "Make the save button blue and larger.",
			selection: {
				kind: "element",
				context: {
					url: "http://localhost:5173/settings",
					title: "Settings",
					tag: "button",
					id: "save",
					classes: ["primary"],
					selector: "button#save",
					size: { width: 140, height: 36 },
					visibleText: "Save changes",
					ariaLabel: "Save profile",
					computedStyle: {
						display: "inline-flex",
						position: "static",
						color: "rgb(255, 255, 255)",
						backgroundColor: "rgb(0, 0, 0)",
						fontSize: "14px",
						fontWeight: "600",
						padding: "8px 12px",
						margin: "0px",
					},
				},
			},
		});

		expect(message).toContain("Browser annotation — apply this change");
		expect(message).toContain("Request: Make the save button blue and larger.");
		expect(message).toContain("Target: button#save.primary (button#save)");
		expect(message).toContain('Page: http://localhost:5173/settings — "Settings"');
		expect(message).toContain("Size: 140×36");
		expect(message).toContain('Text: "Save changes"');
		expect(message).toContain('Aria-label: "Save profile"');
		expect(message).toContain(
			"Style: display:inline-flex; position:static; color:rgb(255,255,255); background:rgb(0,0,0); font:600 14px; padding:8px 12px; margin:0px",
		);
		expect(message).toContain(
			"Constraints: smallest diff that satisfies the request; no watch-mode or long-running commands; use finite verification commands or the existing preview watcher.",
		);
		expect(message).not.toContain("Do not start, restart, or background a dev server");
	});

	it("omits optional lines when the element has no text, aria-label, or style data", () => {
		const message = formatBrowserAnnotationMessage({
			viewId: "1:sess-1",
			instruction: "Move this over.",
			selection: {
				kind: "element",
				context: {
					url: "http://localhost:5173/",
					tag: "div",
					classes: [],
					selector: "div:nth-of-type(3)",
					size: { width: 40, height: 40 },
					computedStyle: {},
				},
			},
		});

		expect(message).not.toContain("Text:");
		expect(message).not.toContain("Aria-label:");
		expect(message).not.toContain("Style:");
		expect(message).toContain("Target: div (div:nth-of-type(3))");
		expect(message).toContain("Page: http://localhost:5173/");
	});

	it("keeps the message below the daemon send-message limit", () => {
		const message = formatBrowserAnnotationMessage({
			viewId: "42:sess-1",
			instruction: "Change this. ".repeat(800),
			selection: {
				kind: "element",
				context: {
					url: "http://localhost:5173/",
					title: "Preview",
					tag: "div",
					classes: [],
					selector: "body > div:nth-of-type(1)",
					size: { width: 100, height: 100 },
					visibleText: "Long visible text ".repeat(500),
					computedStyle: {},
				},
			},
		});

		expect(message.length).toBeLessThanOrEqual(MAX_BROWSER_ANNOTATION_MESSAGE_LENGTH);
		expect(message).toContain("[truncated]");
	});

	it("lists every element for a multi-element selection", () => {
		const elementContext = (overrides: Record<string, unknown>) => ({
			url: "http://localhost:5173/",
			tag: "button",
			classes: [],
			selector: "button",
			size: { width: 80, height: 30 },
			computedStyle: {},
			...overrides,
		});
		const message = formatBrowserAnnotationMessage({
			viewId: "1:sess-1",
			instruction: "Align these two buttons.",
			selection: {
				kind: "elements",
				contexts: [
					elementContext({ id: "save", selector: "button#save" }),
					elementContext({ id: "cancel", selector: "button#cancel" }),
				],
			},
		});

		expect(message).toContain("Browser annotation — apply this change to 2 selected elements");
		expect(message).toContain("Targets @ http://localhost:5173/:");
		expect(message).toContain("1. button#save (selector: button#save) — 80×30");
		expect(message).toContain("2. button#cancel (selector: button#cancel) — 80×30");
	});

	it("pluralizes correctly for a single-element multi-selection", () => {
		const message = formatBrowserAnnotationMessage({
			viewId: "1:sess-1",
			instruction: "Fix this element.",
			selection: {
				kind: "elements",
				contexts: [
					{
						url: "http://localhost:5173/",
						tag: "button",
						classes: [],
						selector: "button#fix-me",
						size: { width: 80, height: 30 },
						computedStyle: {},
					},
				],
			},
		});

		expect(message).toContain("Browser annotation — apply this change to 1 selected element");
		expect(message).not.toContain("1 selected elements");
	});
});
