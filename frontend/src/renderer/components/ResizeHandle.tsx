import { cn } from "@/lib/utils";

type ResizeHandleProps = React.HTMLAttributes<HTMLDivElement> & {
	side: "left" | "right";
};

/** Sidebar / panel drag handle — visual line via `after:` pseudo. */
export function ResizeHandle({ className, side, ...props }: ResizeHandleProps) {
	return (
		<div
			data-slot="resize-handle"
			data-testid="resize-handle"
			className={cn(
				"absolute top-0 bottom-0 z-[5] w-[length:var(--size-resize-handle)] cursor-col-resize touch-none bg-transparent",
				"after:absolute after:inset-y-0 after:left-1/2 after:w-[length:var(--size-hairline)] after:-translate-x-1/2 after:bg-transparent after:transition-[background] after:duration-fast after:content-['']",
				"hover:after:bg-border",
				side === "right" && "right-[calc(-1*var(--size-resize-handle-offset))]",
				side === "left" && "left-[calc(-1*var(--size-resize-handle-offset))]",
				className,
			)}
			{...props}
		/>
	);
}
