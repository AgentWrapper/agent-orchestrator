"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";

export function HomeScrollReset() {
	const pathname = usePathname();

	useEffect(() => {
		if ("scrollRestoration" in window.history) {
			window.history.scrollRestoration = "manual";
		}
	}, []);

	useEffect(() => {
		if (pathname !== "/") return;

		const frame = window.requestAnimationFrame(() => {
			window.scrollTo({ top: 0, left: 0, behavior: "instant" });
		});

		return () => window.cancelAnimationFrame(frame);
	}, [pathname]);

	return null;
}
