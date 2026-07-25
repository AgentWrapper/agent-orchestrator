import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const topbarButtonVariants = cva(
	"inline-flex items-center transition-[filter,background,color,border-color] duration-fast disabled:opacity-60",
	{
		variants: {
			variant: {
				primary:
					"h-control-md gap-1.5 rounded-md bg-accent-strong px-3 text-xs font-semibold leading-none text-accent-foreground hover:brightness-110 active:brightness-95",
				accent:
					"h-control-md gap-1.5 rounded-md border border-border px-3 text-xs font-semibold leading-none bg-raised text-muted-foreground hover:bg-surface hover:text-foreground",
				icon: "grid size-control-md place-items-center rounded-md text-muted-foreground hover:bg-interactive-hover hover:text-foreground",
				kill: "h-control-md gap-1.5 rounded-md border border-border bg-transparent px-3 text-xs font-semibold leading-none text-error/80 hover:border-error/50 hover:bg-error/10 hover:text-error",
				killConfirm:
					"h-control-lg gap-1.5 rounded-md border border-error/40 bg-error/10 px-3 text-control font-semibold leading-none text-error hover:bg-error/16",
				killCancel:
					"h-control-lg rounded-md px-2.5 text-control font-semibold leading-none text-muted-foreground hover:text-foreground",
			},
		},
		defaultVariants: { variant: "primary" },
	},
);

export function TopbarButton({
	className,
	variant,
	type = "button",
	...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof topbarButtonVariants>) {
	return <button className={cn(topbarButtonVariants({ variant }), className)} type={type} {...props} />;
}

export function TopbarKillError({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) {
	return <span className={cn("text-caption text-destructive", className)} role="alert" {...props} />;
}

export const topbarHeaderClass = "flex h-toolbar shrink-0 items-center gap-3 border-b border-border px-4 z-chrome";

export const topbarProjectLabelClass =
	"text-brand font-semibold tracking-tight leading-none text-foreground whitespace-nowrap";
