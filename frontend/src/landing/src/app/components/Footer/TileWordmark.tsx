"use client";

import { useEffect, useRef } from "react";
import { TileField } from "./tile-field/engine";

export function TileWordmark() {
	const hostRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const host = hostRef.current;
		if (!host) return;

		const field = new TileField(host);
		field.start();

		const observer = new ResizeObserver(() => field.resize());
		observer.observe(host);

		return () => {
			observer.disconnect();
			field.destroy();
		};
	}, []);

	return (
		<div
			ref={hostRef}
			className="relative h-[230px] w-full overflow-hidden rounded-xl"
			aria-label="Spawn Agents Step Away Ship Faster"
		/>
	);
}
