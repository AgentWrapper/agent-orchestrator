"use client";

import { useEffect } from "react";

/**
 * Isolates the two design systems that share this Next app: the marketing
 * landing page (globals.css) and the Fumadocs documentation (docs.css, which
 * bundles its own Tailwind inside @layer fumadocs).
 *
 * Next's App Router keeps a route's stylesheet loaded after a client-side
 * navigation, so jumping from /docs back to / via Fumadocs' internal <Link>
 * leaves the docs stylesheet — including its preflight reset — alive on the
 * landing page, which then breaks its spacing, nav and sticky scroll.
 *
 * The landing -> docs direction is safe either way: globals.css lives in the
 * root layout and is present on both routes, so a client-side navigation to
 * /docs just adds docs.css on top. The leak only bites docs -> landing. This
 * guard makes that direction a hard navigation: any in-app link that leaves
 * /docs triggers a full document load, guaranteeing the landing page renders
 * with only its own CSS. Links that stay within /docs keep Fumadocs' fast
 * client routing.
 */
export function DocsHardNav() {
	useEffect(() => {
		const onClick = (event: MouseEvent) => {
			// Respect new-tab / modified clicks and non-primary buttons.
			if (event.defaultPrevented) return;
			if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

			const anchor = (event.target as Element | null)?.closest("a");
			if (!(anchor instanceof HTMLAnchorElement)) return;

			const href = anchor.getAttribute("href");
			if (!href) return;
			if (anchor.target && anchor.target !== "_self") return;
			if (anchor.hasAttribute("download")) return;

			let url: URL;
			try {
				url = new URL(anchor.href, window.location.href);
			} catch {
				return;
			}

			// Only same-origin, and only when leaving the docs subtree.
			if (url.origin !== window.location.origin) return;
			if (url.pathname === "/docs" || url.pathname.startsWith("/docs/")) return;

			event.preventDefault();
			window.location.assign(url.href);
		};

		document.addEventListener("click", onClick, true);
		return () => document.removeEventListener("click", onClick, true);
	}, []);

	return null;
}
