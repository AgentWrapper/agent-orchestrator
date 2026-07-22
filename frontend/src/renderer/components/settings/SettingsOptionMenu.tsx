import { ChevronDown } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../../lib/utils";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../ui/dropdown-menu";

export type SettingsOption<T extends string> = {
	value: T;
	label: string;
	icon?: ReactNode;
};

export function SettingsOptionMenu<T extends string>({
	value,
	options,
	onChange,
	disabled,
	placeholder,
	renderMenuItem,
	triggerClassName,
	"aria-label": ariaLabel,
}: {
	value: T;
	options: SettingsOption<T>[];
	onChange: (value: T) => void;
	disabled?: boolean;
	placeholder?: string;
	renderMenuItem?: (option: SettingsOption<T>, selected: boolean) => ReactNode;
	triggerClassName?: string;
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
					<span className="min-w-0 truncate">{selected?.label ?? placeholder}</span>
					<ChevronDown className="size-icon-sm shrink-0 opacity-70" aria-hidden="true" />
				</button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="settings-menu-surface">
				{options.map((option) => (
					<DropdownMenuItem
						key={option.value}
						onSelect={() => onChange(option.value)}
						className={cn(
							"settings-menu-item min-w-0 cursor-default outline-none",
							"focus:border-settings-menu focus:bg-settings-menu-selected focus:text-settings-label",
							"data-highlighted:border-settings-menu data-highlighted:bg-settings-menu-selected data-highlighted:text-settings-label",
							option.value === value && "border-settings-menu bg-settings-menu-selected",
							"[&_svg]:size-icon-lg [&_svg]:shrink-0 [&_svg]:text-settings-muted",
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
