import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { cn } from "../../lib/utils";

export const TooltipProvider = TooltipPrimitive.Provider;
export const Tooltip = TooltipPrimitive.Root;
export const TooltipTrigger = TooltipPrimitive.Trigger;

export function TooltipContent({
	className,
	sideOffset = 6,
	...props
}: React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>) {
	return (
		<TooltipPrimitive.Portal>
			<TooltipPrimitive.Content
				className={cn(
					"z-overlay rounded-md border border-border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-md",
					className,
				)}
				sideOffset={sideOffset}
				{...props}
			/>
		</TooltipPrimitive.Portal>
	);
}
