import { describe, expect, it } from "vitest";
import { promptPositionForRect } from "./browser-annotation-overlay";

describe("browser annotation overlay helpers", () => {
	it("places the prompt below the selected element when there is room", () => {
		expect(
			promptPositionForRect(
				{ left: 40, top: 80, bottom: 110 },
				{ width: 800, height: 600, promptWidth: 360, promptHeight: 150, gutter: 12, gap: 8 },
			),
		).toEqual({ left: 40, top: 118 });
	});

	it("clamps the prompt horizontally and flips above near the viewport bottom", () => {
		expect(
			promptPositionForRect(
				{ left: 760, top: 520, bottom: 560 },
				{ width: 800, height: 600, promptWidth: 360, promptHeight: 150, gutter: 12, gap: 8 },
			),
		).toEqual({ left: 428, top: 362 });
	});
});
