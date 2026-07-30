import { Check, ChevronDown } from "lucide-react";
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
			<DropdownMenuContent
				align="end"
				className={cn("min-w-[10rem]", menuClassName)}
			>
				{options.map((option) => (
					<DropdownMenuItem
						key={option.value}
						disabled={option.disabled}
						onSelect={() => onChange(option.value)}
						className={cn(
							"justify-between gap-3",
							menuItemClassName,
						)}
					>
						{renderMenuItem ? (
							renderMenuItem(option, option.value === value)
						) : (
							<>
								<span className="flex min-w-0 items-center gap-2">
									{option.icon}
									{option.label}
								</span>
								{option.value === value && (
									<Check className="size-icon-sm shrink-0 text-foreground" aria-hidden="true" />
								)}
							</>
						)}
					</DropdownMenuItem>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
