"use client";

import * as React from "react";
import { Command as CommandPrimitive } from "cmdk";
import { Dialog as DialogPrimitive } from "radix-ui";

import { cn } from "@/lib/utils";

function Command({ className, ...props }: React.ComponentProps<typeof CommandPrimitive>) {
	return (
		<CommandPrimitive
			data-slot="command"
			className={cn(
				"flex h-full w-full flex-col overflow-hidden rounded-[var(--radius-command-palette)] bg-[var(--color-bg-command-palette)] text-[var(--color-text-command-item)]",
				className,
			)}
			{...props}
		/>
	);
}

function CommandDialog({
	title = "Command palette",
	description = "Search agents, files, actions, and commands",
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
						"fixed left-1/2 top-command-palette z-overlay w-command-palette -translate-x-1/2 overflow-hidden rounded-[var(--radius-command-palette)] border border-[var(--color-border-command-palette)] bg-[var(--color-bg-command-palette)] text-[var(--color-text-command-item)] shadow-[var(--shadow-command-palette)] outline-none focus:outline-none data-[state=open]:animate-modal-in",
						className,
					)}
				>
					<DialogPrimitive.Title className="sr-only">{title}</DialogPrimitive.Title>
					<DialogPrimitive.Description className="sr-only">{description}</DialogPrimitive.Description>
					<Command
						className={cn(
							"**:[[cmdk-group-heading]]:px-[var(--size-command-pad-x)] **:[[cmdk-group-heading]]:pt-3 **:[[cmdk-group-heading]]:pb-1.5 **:[[cmdk-group-heading]]:text-sm **:[[cmdk-group-heading]]:font-normal **:[[cmdk-group-heading]]:text-[var(--color-text-command-muted)] **:[[cmdk-group]]:px-0",
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
			className="flex items-center border-b border-[var(--color-border-command-palette)] px-[var(--size-command-pad-x)] pt-5 pb-4"
			cmdk-input-wrapper=""
		>
			<CommandPrimitive.Input
				data-slot="command-input"
				className={cn(
					"flex h-7 w-full bg-transparent text-[length:var(--font-size-command-input)] leading-7 text-[var(--color-text-command-item)] caret-[var(--color-text-command-item)] outline-none placeholder:text-[var(--color-text-command-placeholder)] disabled:cursor-not-allowed disabled:opacity-50",
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
				"max-h-command-palette-list scroll-py-1 overflow-y-auto overflow-x-hidden overscroll-contain py-1",
				className,
			)}
			{...props}
		/>
	);
}

function CommandEmpty({ ...props }: React.ComponentProps<typeof CommandPrimitive.Empty>) {
	return (
		<CommandPrimitive.Empty
			data-slot="command-empty"
			className="py-8 text-center text-sm text-[var(--color-text-command-muted)]"
			{...props}
		/>
	);
}

function CommandGroup({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Group>) {
	return (
		<CommandPrimitive.Group data-slot="command-group" className={cn("overflow-hidden pb-1", className)} {...props} />
	);
}

function CommandItem({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Item>) {
	return (
		<CommandPrimitive.Item
			data-slot="command-item"
			className={cn(
				"relative mx-[var(--size-command-item-inset)] flex cursor-default select-none items-center gap-2 rounded-[var(--radius-command-item)] px-3 py-2.5 text-[length:var(--font-size-subtitle)] leading-[length:var(--leading-command-item)] text-[var(--color-text-command-item)] outline-none",
				"data-[selected=true]:bg-[var(--color-bg-command-item-active)] data-[selected=true]:text-[var(--color-text-command-item)]",
				"data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50",
				"[&_svg]:size-icon-md [&_svg]:shrink-0 [&_svg]:text-[var(--color-text-command-muted)] data-[selected=true]:[&_svg]:text-[var(--color-text-command-item)]",
				className,
			)}
			{...props}
		/>
	);
}

function CommandFooter({ className, ...props }: React.ComponentProps<"div">) {
	return (
		<div
			data-slot="command-footer"
			className={cn(
				"flex items-center gap-4 border-t border-[var(--color-border-command-palette)] px-[var(--size-command-pad-x)] pt-3 pb-3 text-sm text-[var(--color-text-command-placeholder)]",
				className,
			)}
			{...props}
		/>
	);
}

export {
	Command,
	CommandDialog,
	CommandInput,
	CommandList,
	CommandEmpty,
	CommandGroup,
	CommandItem,
	CommandFooter,
};
