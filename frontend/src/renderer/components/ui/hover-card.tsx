import { HoverCard as HoverCardPrimitive } from "radix-ui";
import { cn } from "../../lib/utils";

export const HoverCard = HoverCardPrimitive.Root;
export const HoverCardTrigger = HoverCardPrimitive.Trigger;

export function HoverCardContent({
	className,
	sideOffset = 8,
	...props
}: React.ComponentProps<typeof HoverCardPrimitive.Content>) {
	return (
		<HoverCardPrimitive.Portal>
			<HoverCardPrimitive.Content
				className={cn(
					"z-overlay w-80 max-w-[calc(100vw-1rem)] rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-md outline-none",
					"data-[state=open]:animate-overlay-in",
					className,
				)}
				sideOffset={sideOffset}
				{...props}
			/>
		</HoverCardPrimitive.Portal>
	);
}
