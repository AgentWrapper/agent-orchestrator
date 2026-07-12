/** Convert camelCase to kebab-case (`titlebarContentOffset` → `titlebar-content-offset`). */
export function kebab(key: string): string {
	return key.replace(/([A-Z])/g, (match) => `-${match.toLowerCase()}`);
}

/** `icon2xs`, `iconXs`, … — not a generic `icon*` prefix match. */
export const LAYOUT_ICON_KEY_PATTERN = /^icon[A-Z0-9]/;

export function isLayoutIconKey(key: string): boolean {
	return LAYOUT_ICON_KEY_PATTERN.test(key);
}

/**
 * Maps a `layout` key to its `:root` custom property name.
 * Convention: `ringWidth*` → `ring-width-*`; `icon*` → `size-icon-*`; else → `size-{kebab}`.
 */
export function layoutCssVarName(key: string): string {
	if (key.startsWith("ringWidth")) {
		return kebab(key);
	}
	if (isLayoutIconKey(key)) {
		const suffix = key.slice(4);
		const normalized = suffix.charAt(0).toLowerCase() + suffix.slice(1);
		return `size-icon-${normalized}`;
	}
	return `size-${kebab(key)}`;
}

/** Parse a pixel dimension token (`12px` → `12`). */
export function parsePx(value: string): number {
	const parsed = Number.parseFloat(value);
	if (!Number.isFinite(parsed)) {
		throw new Error(`Expected a pixel dimension, got ${value}`);
	}
	return parsed;
}
