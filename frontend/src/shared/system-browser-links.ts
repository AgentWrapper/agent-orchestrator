const SYSTEM_BROWSER_LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

type ModifierClickLike = Pick<MouseEvent, "altKey" | "button" | "defaultPrevented">;

type LinkClickLike = ModifierClickLike & Pick<MouseEvent, "target">;

export function isSystemBrowserModifierClick(event: ModifierClickLike): boolean {
	return event.altKey && event.button === 0 && !event.defaultPrevented;
}

export function isAllowedSystemBrowserHref(href: string): boolean {
	try {
		return SYSTEM_BROWSER_LINK_PROTOCOLS.has(new URL(href).protocol);
	} catch {
		return false;
	}
}

export function systemBrowserHrefFromClick(event: LinkClickLike): string | null {
	if (!isSystemBrowserModifierClick(event)) return null;
	if (typeof Element === "undefined" || !(event.target instanceof Element)) return null;
	const anchor = event.target.closest<HTMLAnchorElement>("a[href]");
	if (!anchor || !isAllowedSystemBrowserHref(anchor.href)) return null;
	return anchor.href;
}
