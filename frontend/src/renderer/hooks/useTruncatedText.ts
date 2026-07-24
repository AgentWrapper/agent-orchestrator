import { useEffect, useRef, useState } from "react";

// Reports whether an element's text is actually truncated (scrollWidth exceeds
// clientWidth), so a tooltip with the full label can appear only when the tab
// strip is crowded enough to cut it off. Re-measures on resize and when the
// text changes.
export function useTruncatedText<T extends HTMLElement>(text: string) {
	const ref = useRef<T | null>(null);
	const [isTruncated, setIsTruncated] = useState(false);

	useEffect(() => {
		const el = ref.current;
		if (!el) return;
		const update = () => setIsTruncated(el.scrollWidth > el.clientWidth);
		update();
		const observer = new ResizeObserver(update);
		observer.observe(el);
		return () => observer.disconnect();
	}, [text]);

	return { ref, isTruncated };
}
