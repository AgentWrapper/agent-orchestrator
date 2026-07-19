import { useEffect, useState } from "react";
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
	const [showTerminalLabel, setShowTerminalLabel] = useState(false);

	useEffect(() => {
		if (!isTerminating) {
			setShowTerminalLabel(false);
			return;
		}
		const timer = window.setTimeout(() => setShowTerminalLabel(true), 20);
		return () => window.clearTimeout(timer);
	}, [isTerminating]);

	return (
		<span className={cn("relative block min-w-0", className)} aria-label={isTerminating ? "Terminated" : undefined}>
			<span
				aria-hidden={isTerminating}
				className={cn(
					"block transition-opacity duration-200 ease-out motion-reduce:transition-none",
					isTerminating && showTerminalLabel ? "opacity-0" : "opacity-100",
					titleClassName,
				)}
			>
				{title}
			</span>
			{isTerminating && (
				<span
					className={cn(
						"absolute inset-0 block truncate font-semibold text-passive opacity-0 transition-opacity delay-75 duration-200 ease-out motion-reduce:opacity-100 motion-reduce:transition-none",
						showTerminalLabel && "opacity-100",
						terminalClassName,
					)}
				>
					Terminated
				</span>
			)}
		</span>
	);
}
