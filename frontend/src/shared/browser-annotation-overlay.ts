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
