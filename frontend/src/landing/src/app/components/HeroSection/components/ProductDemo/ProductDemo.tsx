"use client";

import Image from "next/image";
import { useEffect, useState } from "react";
import { AppMockup } from "../AppMockup";

const PREVIEW_BACKGROUND_IMAGE = "/hero-background.jpeg";

function useImageLoaded(src: string) {
	const [isLoaded, setIsLoaded] = useState(false);

	useEffect(() => {
		let isMounted = true;
		const image = new window.Image();
		image.src = src;

		if (image.complete) {
			setIsLoaded(true);
			return () => {
				isMounted = false;
			};
		}

		const markLoaded = () => {
			if (!isMounted) return;
			setIsLoaded(true);
		};

		image.addEventListener("load", markLoaded);
		image.addEventListener("error", markLoaded);
		return () => {
			isMounted = false;
			image.removeEventListener("load", markLoaded);
			image.removeEventListener("error", markLoaded);
		};
	}, [src]);

	return isLoaded;
}

export function ProductDemo() {
	const isPreviewBackgroundLoaded = useImageLoaded(PREVIEW_BACKGROUND_IMAGE);

	return (
		<div className="relative w-full max-w-full">
			<div className="relative min-h-[440px] overflow-hidden bg-card p-2 shadow-[0_40px_120px_-50px_rgba(0,0,0,0.9)] sm:min-h-[560px] sm:p-4 lg:min-h-[720px] lg:p-6">
				<Image
					src={PREVIEW_BACKGROUND_IMAGE}
					alt=""
					fill
					priority
					quality={80}
					sizes="(max-width: 1536px) 100vw, 1536px"
					className="pointer-events-none select-none object-cover"
				/>
				<div className="pointer-events-none absolute inset-0 bg-background/15" />
				<div className="pointer-events-none absolute inset-x-8 top-8 h-24 rounded-full bg-foreground/[0.16] blur-3xl" />
				<div className="pointer-events-none absolute inset-[10%] top-[20%] rounded-3xl bg-white/[0.12] blur-[60px]" />
				{isPreviewBackgroundLoaded ? (
					<AppMockup />
				) : (
					<div className="absolute inset-0 grid place-items-center">
						<div className="h-10 w-10 animate-spin rounded-full border border-white/25 border-t-white/80" />
					</div>
				)}
			</div>
		</div>
	);
}
