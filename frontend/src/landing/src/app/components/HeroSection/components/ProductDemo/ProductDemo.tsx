"use client";

import Image from "next/image";
import { AppMockup } from "../AppMockup";

const PREVIEW_BACKGROUND_IMAGE = "/optimized/hero-background.webp";

export function ProductDemo() {
	return (
		<div className="relative w-full max-w-full">
			<div className="relative aspect-[1140/700] overflow-hidden bg-card p-2 shadow-[0_40px_120px_-50px_rgba(0,0,0,0.9)] sm:aspect-auto sm:min-h-[560px] sm:p-4 lg:min-h-[720px] lg:p-6">
				<Image
					src={PREVIEW_BACKGROUND_IMAGE}
					alt=""
					fill
					preload
					sizes="(max-width: 1536px) 100vw, 1536px"
					className="pointer-events-none select-none object-cover"
				/>
				<div className="pointer-events-none absolute inset-0 bg-background/15" />
				<div className="pointer-events-none absolute inset-x-8 top-8 h-24 rounded-full bg-foreground/[0.16] blur-3xl" />
				<div className="pointer-events-none absolute inset-[10%] top-[20%] rounded-3xl bg-white/[0.12] blur-[60px]" />
				<AppMockup />
			</div>
		</div>
	);
}
