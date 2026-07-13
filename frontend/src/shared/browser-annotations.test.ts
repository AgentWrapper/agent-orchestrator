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
		expect(context.rect).toEqual({ x: 16, y: 24, width: 140, height: 36 });
		expect(context.visibleText).toBe("Save changes");
		expect(context.ariaLabel).toBe("Save profile");
		expect(context.nearbyText.join(" ")).toContain("Changes apply to the active customer profile.");
		expect(context.computedStyle.fontSize).toBe("18px");
		expect(context.computedStyle.fontWeight).toBe("700");
	});

	it("keeps nearby text local to the selected element instead of capturing the whole page", () => {
		document.body.innerHTML = `
			<main>
				<section id="chart">
					<h2>Revenue chart</h2>
					<p>Monthly sales by region.</p>
				</section>
				<section>
					<h2>Alerts</h2>
					<p>${"Unrelated alert copy. ".repeat(80)}</p>
				</section>
			</main>
		`;
		const chart = document.querySelector<HTMLElement>("#chart")!;

		const context = createBrowserAnnotationContext(chart);

		expect(context.nearbyText.join(" ")).toContain("Revenue chart");
		expect(context.nearbyText.join(" ")).not.toContain("Unrelated alert copy");
	});
});

describe("formatBrowserAnnotationMessage", () => {
	it("formats the user instruction and selected element context for the agent", () => {
		const message = formatBrowserAnnotationMessage({
			viewId: "42:sess-1",
			instruction: "Make the save button blue and larger.",
			context: {
				url: "http://localhost:5173/settings",
				title: "Settings",
				tag: "button",
				id: "save",
				classes: ["primary"],
				selector: "button#save",
				rect: { x: 16, y: 24, width: 140, height: 36 },
				visibleText: "Save changes",
				ariaLabel: "Save profile",
				nearbyText: ["Profile settings"],
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
		});

		expect(message).toContain("Make the save button blue and larger.");
		expect(message).toContain("http://localhost:5173/settings");
		expect(message).toContain("button#save");
		expect(message).toContain("Save changes");
		expect(message).toContain("Do not start, restart, or background a dev server");
		expect(message).toContain("Do not run watch-mode or long-running commands");
	});

	it("keeps the message below the daemon send-message limit", () => {
		const message = formatBrowserAnnotationMessage({
			viewId: "42:sess-1",
			instruction: "Change this. ".repeat(800),
			context: {
				url: "http://localhost:5173/",
				title: "Preview",
				tag: "div",
				classes: [],
				selector: "body > div:nth-of-type(1)",
				rect: { x: 0, y: 0, width: 100, height: 100 },
				visibleText: "Long visible text ".repeat(500),
				nearbyText: ["Nearby copy ".repeat(500)],
				computedStyle: {},
			},
		});

		expect(message.length).toBeLessThanOrEqual(MAX_BROWSER_ANNOTATION_MESSAGE_LENGTH);
		expect(message).toContain("[truncated]");
	});
});
