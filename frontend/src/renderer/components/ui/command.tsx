"use client";

import * as React from "react";
import { Command as CommandPrimitive } from "cmdk";
import { Search } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";

import { cn } from "@/lib/utils";

function Command({ className, ...props }: React.ComponentProps<typeof CommandPrimitive>) {
	return (
		<CommandPrimitive
			data-slot="command"
			className={cn(
				"flex h-full w-full flex-col overflow-hidden rounded-xl bg-popover text-popover-foreground",
				className,
			)}
			{...props}
		/>
	);
}

function CommandDialog({
	title = "Command palette",
	description = "Search projects, sessions, pull requests, and commands",
	children,
	className,
	commandProps,
	...props
}: React.ComponentProps<typeof DialogPrimitive.Root> & {
	title?: string;
	description?: string;
	className?: string;
	commandProps?: React.ComponentProps<typeof CommandPrimitive>;
}) {
	const { className: commandClassName, ...restCommandProps } = commandProps ?? {};
	return (
		<DialogPrimitive.Root data-slot="command-dialog" {...props}>
			<DialogPrimitive.Portal>
				<DialogPrimitive.Overlay
					data-slot="command-dialog-overlay"
					className="fixed inset-0 z-overlay bg-scrim data-[state=open]:animate-overlay-in"
				/>
				<DialogPrimitive.Content
					data-slot="command-dialog-content"
					aria-label={title}
					className={cn(
						"fixed left-1/2 top-[14vh] z-overlay w-dialog-xl -translate-x-1/2 overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-xl data-[state=open]:animate-modal-in",
						className,
					)}
				>
					<DialogPrimitive.Title className="sr-only">{title}</DialogPrimitive.Title>
					<DialogPrimitive.Description className="sr-only">{description}</DialogPrimitive.Description>
					<Command
						className={cn(
							"**:[[cmdk-group-heading]]:px-2 **:[[cmdk-group-heading]]:py-1.5 **:[[cmdk-group-heading]]:text-2xs **:[[cmdk-group-heading]]:font-semibold **:[[cmdk-group-heading]]:uppercase **:[[cmdk-group-heading]]:tracking-wide-lg **:[[cmdk-group-heading]]:text-passive **:[[cmdk-group]]:px-2 [&_[cmdk-input-wrapper]_svg]:size-icon-lg",
							commandClassName,
						)}
						{...restCommandProps}
					>
						{children}
					</Command>
				</DialogPrimitive.Content>
			</DialogPrimitive.Portal>
		</DialogPrimitive.Root>
	);
}

function CommandInput({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Input>) {
	return (
		<div
			data-slot="command-input-wrapper"
			className="flex items-center gap-2 border-b border-border px-4 focus-within:ring-2 focus-within:ring-inset focus-within:ring-accent-weak"
			cmdk-input-wrapper=""
		>
			<Search className="size-icon-lg shrink-0 text-passive" aria-hidden="true" />
			<CommandPrimitive.Input
				data-slot="command-input"
				className={cn(
					"flex h-12 w-full bg-transparent py-3 text-sm text-foreground outline-none placeholder:text-passive disabled:cursor-not-allowed disabled:opacity-50",
					className,
				)}
				{...props}
			/>
		</div>
	);
}

function CommandList({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.List>) {
	return (
		<CommandPrimitive.List
			data-slot="command-list"
			className={cn(
				"max-h-[min(340px,50vh)] scroll-py-1 overflow-y-auto overflow-x-hidden overscroll-contain p-1",
				className,
			)}
			{...props}
		/>
	);
}

function CommandEmpty({ ...props }: React.ComponentProps<typeof CommandPrimitive.Empty>) {
	return (
		<CommandPrimitive.Empty data-slot="command-empty" className="py-8 text-center text-sm text-passive" {...props} />
	);
}

function CommandGroup({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Group>) {
	return (
		<CommandPrimitive.Group data-slot="command-group" className={cn("overflow-hidden py-1", className)} {...props} />
	);
}

function CommandItem({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Item>) {
	return (
		<CommandPrimitive.Item
			data-slot="command-item"
			className={cn(
				"relative flex cursor-default select-none items-center gap-2.5 rounded-md px-2 py-2 text-control text-foreground outline-none",
				"data-[selected=true]:bg-interactive-active data-[selected=true]:text-foreground",
				"data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50",
				"[&_svg]:size-icon-lg [&_svg]:shrink-0 [&_svg]:text-passive data-[selected=true]:[&_svg]:text-foreground",
				className,
			)}
			{...props}
		/>
	);
}

export { Command, CommandDialog, CommandInput, CommandList, CommandEmpty, CommandGroup, CommandItem };
