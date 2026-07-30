import { ContextMenu as ContextMenuPrimitive } from "radix-ui";
import { cn } from "../../lib/utils";

export const ContextMenu = ContextMenuPrimitive.Root;
export const ContextMenuTrigger = ContextMenuPrimitive.Trigger;
export const ContextMenuGroup = ContextMenuPrimitive.Group;
export const ContextMenuPortal = ContextMenuPrimitive.Portal;

export function ContextMenuContent({
	className,
	...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Content>) {
	return (
		<ContextMenuPrimitive.Portal>
			<ContextMenuPrimitive.Content
				className={cn(
					// brighter than sidebar/page: card sits one step above background
					"z-overlay min-w-[10rem] overflow-hidden rounded-lg border border-border bg-card p-[3px] text-popover-foreground",
					"flex flex-col gap-px",
					"shadow-[0_8px_32px_rgba(0,0,0,0.28),0_2px_8px_rgba(0,0,0,0.18)]",
					"data-[state=open]:animate-popover-in data-[state=closed]:animate-popover-out",
					className,
				)}
				{...props}
			/>
		</ContextMenuPrimitive.Portal>
	);
}

export function ContextMenuItem({
	className,
	inset,
	...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Item> & { inset?: boolean }) {
	return (
		<ContextMenuPrimitive.Item
			className={cn(
				"relative flex cursor-default select-none items-center gap-2.5 rounded-md px-2 py-1.5 text-control outline-none transition-colors",
				"text-muted-foreground focus:bg-interactive-hover focus:text-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
				"[&_svg]:size-icon-lg [&_svg]:shrink-0 [&_svg]:text-muted-foreground focus:[&_svg]:text-foreground",
				inset && "pl-8",
				className,
			)}
			{...props}
		/>
	);
}

export function ContextMenuLabel({
	className,
	inset,
	...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Label> & { inset?: boolean }) {
	return (
		<ContextMenuPrimitive.Label
			className={cn(
				"px-2 py-1.5 text-micro tracking-wide text-passive",
				inset && "pl-8",
				className,
			)}
			{...props}
		/>
	);
}

export function ContextMenuSeparator({
	className,
	...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Separator>) {
	return <ContextMenuPrimitive.Separator className={cn("-mx-1 my-1 h-px bg-border", className)} {...props} />;
}
