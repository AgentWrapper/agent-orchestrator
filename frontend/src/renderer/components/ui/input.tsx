import * as React from "react";
import { cn } from "../../lib/utils";

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
	({ className, type = "text", ...props }, ref) => (
		<input
			className={cn(
				"flex h-control-form w-full rounded-md border border-border bg-transparent px-3 text-control text-foreground transition-colors placeholder:text-passive focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-weak disabled:cursor-not-allowed disabled:opacity-50",
				className,
			)}
			ref={ref}
			type={type}
			{...props}
		/>
	),
);

Input.displayName = "Input";
