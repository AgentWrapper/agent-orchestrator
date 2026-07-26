import type { ReactNode } from "react";

interface FeatureDemoProps {
	children: ReactNode;
	backgroundImage: string;
	className?: string;
}

export function FeatureDemo({
	children,
	backgroundImage,
	className = "",
}: FeatureDemoProps) {
	return (
		<div
			className={`relative w-full min-h-[300px] lg:aspect-4/3 overflow-hidden ${className}`}
		>
			<div
				className="absolute inset-0 h-full w-full bg-cover bg-center"
				style={{ backgroundImage: `url('${backgroundImage}')` }}
			/>
			<div className="absolute inset-0 bg-background/35" />

			{/* Content overlay */}
			<div className="relative z-10 w-full h-full flex items-center justify-start sm:justify-center p-4 sm:p-6">
				{children}
			</div>
		</div>
	);
}
