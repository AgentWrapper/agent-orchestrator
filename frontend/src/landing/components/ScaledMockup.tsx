"use client";

import { type ReactNode, useEffect, useRef, useState } from "react";
import ScrollTrigger from "gsap/ScrollTrigger";

// Debounced global refresh: several ScaledMockups settle around the same time,
// so coalesce their refreshes into one so ScrollTrigger recomputes positions
// after the mockups have shrunk to their final size.
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleScrollRefresh() {
	if (refreshTimer) clearTimeout(refreshTimer);
	refreshTimer = setTimeout(() => {
		refreshTimer = null;
		ScrollTrigger.refresh();
	}, 120);
}

/**
 * Renders a fixed-design-width mockup and scales it down to fit the available
 * width (never up past 1:1), preserving aspect ratio. This lets the detailed
 * desktop mockups appear fully on tablet/mobile without horizontal scrolling.
 *
 * The inner box keeps its design width so its internal layout never reflows or
 * overlaps; only a CSS transform shrinks it, and the wrapper height is set to
 * the scaled height so surrounding content flows correctly. Because that height
 * is set after mount, we refresh ScrollTrigger so triggers below us stay aligned.
 */
export function ScaledMockup({ designWidth, children }: { designWidth: number; children: ReactNode }) {
	const wrapRef = useRef<HTMLDivElement>(null);
	const innerRef = useRef<HTMLDivElement>(null);
	const [scale, setScale] = useState(1);
	const [height, setHeight] = useState<number | undefined>(undefined);

	useEffect(() => {
		const wrap = wrapRef.current;
		const inner = innerRef.current;
		if (!wrap || !inner) return;

		const measure = () => {
			const available = wrap.clientWidth;
			if (!available) return;
			const next = Math.min(1, available / designWidth);
			setScale(next);
			setHeight(inner.offsetHeight * next);
			scheduleScrollRefresh();
		};

		measure();
		const ro = new ResizeObserver(measure);
		ro.observe(wrap);
		ro.observe(inner);
		return () => ro.disconnect();
	}, [designWidth]);

	return (
		<div ref={wrapRef} className="flex w-full justify-center overflow-hidden" style={{ height }}>
			<div
				ref={innerRef}
				className="shrink-0 self-start"
				style={{ width: designWidth, transform: `scale(${scale})`, transformOrigin: "top center" }}
			>
				{children}
			</div>
		</div>
	);
}
