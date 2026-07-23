import * as React from "react";
import { cn } from "../../lib/utils";

// Mono pill badges, like emdash. Color is rare and meaningful (DESIGN.md → Color).
type BadgeVariant = "neutral" | "outline" | "accent" | "success" | "warning" | "error";

export function Badge({
	className,
	variant = "neutral",
	...props
}: React.HTMLAttributes<HTMLSpanElement> & { variant?: BadgeVariant }) {
	return (
		<span
			className={cn(
				"inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border border-transparent px-2 font-mono text-micro font-medium",
				variant === "neutral" && "bg-raised text-muted-foreground",
				variant === "outline" && "border-border text-foreground",
				variant === "accent" && "border-accent-dim text-accent",
				variant === "success" && "border-success/40 text-success",
				variant === "warning" && "border-warning/40 text-warning",
				variant === "error" && "border-error/40 text-error",
				className,
			)}
			{...props}
		/>
	);
}
