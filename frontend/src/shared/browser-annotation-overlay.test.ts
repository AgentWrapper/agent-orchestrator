import { describe, expect, it } from "vitest";
import {
	boundingRectOfPoints,
	closeLassoPath,
	pointInPolygon,
	promptPositionForRect,
	sampleGridPoints,
	shouldAppendLassoPoint,
} from "./browser-annotation-overlay";

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

describe("shouldAppendLassoPoint", () => {
	it("always appends the first point", () => {
		expect(shouldAppendLassoPoint(null, { x: 10, y: 10 }, 4)).toBe(true);
	});

	it("rejects a point closer than the minimum distance", () => {
		expect(shouldAppendLassoPoint({ x: 10, y: 10 }, { x: 12, y: 10 }, 4)).toBe(false);
	});

	it("accepts a point at least the minimum distance away", () => {
		expect(shouldAppendLassoPoint({ x: 10, y: 10 }, { x: 14, y: 10 }, 4)).toBe(true);
	});
});

describe("closeLassoPath", () => {
	it("returns an empty path unchanged", () => {
		expect(closeLassoPath([])).toEqual([]);
	});

	it("appends the first point to close an open path", () => {
		const path = [
			{ x: 0, y: 0 },
			{ x: 10, y: 0 },
			{ x: 10, y: 10 },
		];
		expect(closeLassoPath(path)).toEqual([...path, { x: 0, y: 0 }]);
	});

	it("does not duplicate the closing point when the path is already closed", () => {
		const path = [
			{ x: 0, y: 0 },
			{ x: 10, y: 0 },
			{ x: 0, y: 0 },
		];
		expect(closeLassoPath(path)).toEqual(path);
	});
});

describe("boundingRectOfPoints", () => {
	it("computes the axis-aligned bounds of a point set", () => {
		const points = [
			{ x: 10, y: 40 },
			{ x: 60, y: 5 },
			{ x: 25, y: 90 },
		];
		expect(boundingRectOfPoints(points)).toEqual({ left: 10, top: 5, right: 60, bottom: 90 });
	});
});

describe("sampleGridPoints", () => {
	it("samples the center of each grid cell", () => {
		const points = sampleGridPoints({ left: 0, top: 0, right: 100, bottom: 100 }, 2, 2);
		expect(points).toEqual([
			{ x: 25, y: 25 },
			{ x: 75, y: 25 },
			{ x: 25, y: 75 },
			{ x: 75, y: 75 },
		]);
	});
});

describe("pointInPolygon", () => {
	const square = [
		{ x: 0, y: 0 },
		{ x: 100, y: 0 },
		{ x: 100, y: 100 },
		{ x: 0, y: 100 },
	];

	it("treats a point inside the polygon as inside", () => {
		expect(pointInPolygon({ x: 50, y: 50 }, square)).toBe(true);
	});

	it("treats a point outside the polygon as outside", () => {
		expect(pointInPolygon({ x: 150, y: 50 }, square)).toBe(false);
	});

	it("treats a point beyond a triangle's hypotenuse as outside", () => {
		const triangle = [
			{ x: 0, y: 0 },
			{ x: 100, y: 0 },
			{ x: 0, y: 100 },
		];
		// (80, 80) is beyond the hypotenuse (x + y = 100).
		expect(pointInPolygon({ x: 80, y: 80 }, triangle)).toBe(false);
		// (20, 20) is well inside.
		expect(pointInPolygon({ x: 20, y: 20 }, triangle)).toBe(true);
	});
});
