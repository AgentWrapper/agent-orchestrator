export type AnnotationRectLike = Pick<DOMRect, "left" | "top" | "bottom">;

export type AnnotationPromptViewport = {
	width: number;
	height: number;
	promptWidth: number;
	promptHeight: number;
	gutter: number;
	gap: number;
};

export function promptPositionForRect(
	rect: AnnotationRectLike,
	viewport: AnnotationPromptViewport,
): { left: number; top: number } {
	const left = clamp(
		rect.left,
		viewport.gutter,
		Math.max(viewport.gutter, viewport.width - viewport.promptWidth - viewport.gutter),
	);
	const below = rect.bottom + viewport.gap;
	const top =
		below + viewport.promptHeight <= viewport.height - viewport.gutter
			? below
			: Math.max(viewport.gutter, rect.top - viewport.promptHeight - viewport.gap);
	return { left, top };
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

export type LassoPoint = { x: number; y: number };

export type LassoBounds = { left: number; top: number; right: number; bottom: number };

// Simplifies a freehand drag into a manageable point set: a point is kept
// only once the pointer has moved at least `minDistance` from the last kept
// point. Sufficient for v1 in place of full Douglas-Peucker simplification.
export function shouldAppendLassoPoint(lastPoint: LassoPoint | null, next: LassoPoint, minDistance: number): boolean {
	if (!lastPoint) return true;
	return Math.hypot(next.x - lastPoint.x, next.y - lastPoint.y) >= minDistance;
}

export function closeLassoPath(points: LassoPoint[]): LassoPoint[] {
	if (points.length === 0) return points;
	const first = points[0];
	const last = points[points.length - 1];
	if (first.x === last.x && first.y === last.y) return points;
	return [...points, first];
}

export function boundingRectOfPoints(points: LassoPoint[]): LassoBounds {
	const xs = points.map((point) => point.x);
	const ys = points.map((point) => point.y);
	return {
		left: Math.min(...xs),
		top: Math.min(...ys),
		right: Math.max(...xs),
		bottom: Math.max(...ys),
	};
}

export function sampleGridPoints(bounds: LassoBounds, columns: number, rows: number): LassoPoint[] {
	const width = bounds.right - bounds.left;
	const height = bounds.bottom - bounds.top;
	const points: LassoPoint[] = [];
	for (let row = 0; row < rows; row += 1) {
		for (let col = 0; col < columns; col += 1) {
			points.push({
				x: bounds.left + ((col + 0.5) / columns) * width,
				y: bounds.top + ((row + 0.5) / rows) * height,
			});
		}
	}
	return points;
}

// Standard ray-casting point-in-polygon test.
export function pointInPolygon(point: LassoPoint, polygon: LassoPoint[]): boolean {
	let inside = false;
	for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
		const a = polygon[i];
		const b = polygon[j];
		const crosses = a.y > point.y !== b.y > point.y;
		if (!crosses) continue;
		const intersectX = ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x;
		if (point.x < intersectX) inside = !inside;
	}
	return inside;
}
