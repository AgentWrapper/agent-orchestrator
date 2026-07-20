import { cn } from "../lib/utils";

type SessionTerminationLabelProps = {
	title: string;
	isTerminating?: boolean;
	className?: string;
	titleClassName?: string;
	terminalClassName?: string;
};

export function SessionTerminationLabel({
	title,
	isTerminating = false,
	className,
	titleClassName,
	terminalClassName,
}: SessionTerminationLabelProps) {
	return (
		<span className={cn("block min-w-0", className)} aria-label={isTerminating ? "Terminated" : undefined}>
			<span
				className={cn(
					"block",
					isTerminating ? "truncate font-semibold text-passive" : titleClassName,
					isTerminating && terminalClassName,
				)}
			>
				{isTerminating ? "Terminated" : title}
			</span>
		</span>
	);
}
