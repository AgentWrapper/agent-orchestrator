import { DropdownMenu as DropdownMenuPrimitive } from "radix-ui";
import { cn } from "../../lib/utils";

export const DropdownMenu = DropdownMenuPrimitive.Root;
export const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger;
export const DropdownMenuGroup = DropdownMenuPrimitive.Group;
export const DropdownMenuPortal = DropdownMenuPrimitive.Portal;

export function DropdownMenuContent({
	className,
	sideOffset = 6,
	...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Content>) {
	return (
		<DropdownMenuPrimitive.Portal>
			<DropdownMenuPrimitive.Content
				sideOffset={sideOffset}
				className={cn(
					"z-overlay min-w-[10rem] overflow-hidden rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-md",
					"data-[state=open]:animate-overlay-in",
					className,
				)}
				{...props}
			/>
		</DropdownMenuPrimitive.Portal>
	);
}

export function DropdownMenuItem({
	className,
	inset,
	...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Item> & { inset?: boolean }) {
	return (
		<DropdownMenuPrimitive.Item
			className={cn(
				"relative flex cursor-default select-none items-center gap-2.5 rounded-md px-2 py-1.5 text-control outline-none transition-colors",
				"text-muted-foreground focus:bg-surface focus:text-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
				"[&_svg]:size-icon-lg [&_svg]:shrink-0 [&_svg]:text-passive",
				inset && "pl-8",
				className,
			)}
			{...props}
		/>
	);
}

export function DropdownMenuLabel({
	className,
	inset,
	...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Label> & { inset?: boolean }) {
	return (
		<DropdownMenuPrimitive.Label
			className={cn(
				"px-2 py-1.5 font-mono text-micro uppercase tracking-wide-xl text-passive",
				inset && "pl-8",
				className,
			)}
			{...props}
		/>
	);
}

export function DropdownMenuSeparator({
	className,
	...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Separator>) {
	return <DropdownMenuPrimitive.Separator className={cn("-mx-1 my-1 h-px bg-border", className)} {...props} />;
}

export function DropdownMenuShortcut({ className, ...props }: React.ComponentProps<"span">) {
	return <span className={cn("ml-auto font-mono text-micro tracking-wide-md text-passive", className)} {...props} />;
}
