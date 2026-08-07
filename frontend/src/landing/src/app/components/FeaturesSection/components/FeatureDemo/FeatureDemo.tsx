import Image from "next/image";
import type { ReactNode } from "react";

interface FeatureDemoProps {
	children: ReactNode;
	backgroundImage: string;
	className?: string;
	preload?: boolean;
}

export function FeatureDemo({
	children,
	backgroundImage,
	className = "",
	preload = false,
}: FeatureDemoProps) {
	return (
		<div
			className={`relative w-full overflow-hidden sm:min-h-[300px] lg:aspect-4/3 ${className}`}
		>
			<Image
				src={backgroundImage}
				alt=""
				fill
				preload={preload}
				loading={preload ? "eager" : "lazy"}
				fetchPriority={preload ? "high" : "auto"}
				sizes="(max-width: 640px) 100vw, (max-width: 1279px) 92vw, 50vw"
				className="pointer-events-none select-none object-cover"
			/>
			<div className="absolute inset-0 bg-background/35" />

			{/* Content overlay */}
			<div className="relative z-10 flex h-full w-full items-center justify-start p-4 sm:justify-center sm:p-6">
				{children}
			</div>
		</div>
	);
}
