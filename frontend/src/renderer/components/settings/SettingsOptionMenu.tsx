import { ChevronDown } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../../lib/utils";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../ui/dropdown-menu";

export type SettingsOption<T extends string> = {
	value: T;
	label: string;
	icon?: ReactNode;
	disabled?: boolean;
};

export function SettingsOptionMenu<T extends string>({
	value,
	options,
	onChange,
	disabled,
	placeholder,
	renderMenuItem,
	renderTrigger,
	triggerClassName,
	menuClassName,
	menuItemClassName,
	menuAlign = "end",
	"aria-label": ariaLabel,
}: {
	value: T;
	options: SettingsOption<T>[];
	onChange: (value: T) => void;
	disabled?: boolean;
	placeholder?: string;
	renderMenuItem?: (option: SettingsOption<T>, selected: boolean) => ReactNode;
	renderTrigger?: (selected: SettingsOption<T> | undefined, placeholder?: string) => ReactNode;
	triggerClassName?: string;
	menuClassName?: string;
	menuItemClassName?: string;
	menuAlign?: "start" | "center" | "end";
	"aria-label": string;
}) {
	const selected = options.find((option) => option.value === value);

	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild disabled={disabled}>
				<button
					type="button"
					className={cn(
						"settings-option-trigger max-w-full min-w-0 hover:text-settings-label focus:outline-none focus-visible:outline-none focus-visible:ring-0 data-[state=open]:outline-none data-[state=open]:ring-0 disabled:cursor-not-allowed disabled:opacity-50",
						triggerClassName,
					)}
					aria-label={ariaLabel}
				>
					{renderTrigger ? (
						renderTrigger(selected, placeholder)
					) : (
						<>
							{selected?.icon}
							<span className="min-w-0 truncate">{selected?.label ?? placeholder}</span>
						</>
					)}
					<ChevronDown className="size-icon-sm shrink-0 opacity-70" aria-hidden="true" />
				</button>
			</DropdownMenuTrigger>
			{/* bg-settings-menu / border-settings-menu / rounded-(--radius-settings-panel) must
			    be real utilities so twMerge drops DropdownMenuContent's bg-popover, border-border,
			    and rounded-lg. */}
			<DropdownMenuContent
				align={menuAlign}
				className={cn(
					"settings-menu-surface overflow-y-auto! overflow-x-hidden! max-h-select-menu-max! rounded-(--radius-settings-panel) border-settings-menu bg-settings-menu",
					menuClassName,
				)}
			>
				{options.map((option) => (
					<DropdownMenuItem
						key={option.value}
						disabled={option.disabled}
						onSelect={() => onChange(option.value)}
						className={cn(
							"settings-menu-item min-w-0 cursor-default outline-none",
							"focus:border-settings-menu focus:bg-settings-menu-selected focus:text-settings-label",
							"data-highlighted:border-settings-menu data-highlighted:bg-settings-menu-selected data-highlighted:text-settings-label",
							option.value === value && "border-settings-menu bg-settings-menu-selected",
							menuItemClassName,
						)}
					>
						{renderMenuItem ? (
							renderMenuItem(option, option.value === value)
						) : (
							<>
								{option.icon}
								{option.label}
							</>
						)}
					</DropdownMenuItem>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
