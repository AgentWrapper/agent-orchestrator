import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const topbarButtonVariants = cva(
	"reverb-topbar__control inline-flex items-center transition-[filter,background,color,border-color] duration-fast disabled:opacity-60",
	{
		variants: {
			variant: {
				// `bg-primary`/`text-primary-foreground` is the one pair guaranteed to
				// contrast in both themes; `accent-foreground` is claimed by shadcn's
				// `bg-accent` and does not pair with `accent-strong`.
				primary:
					"reverb-topbar__control--primary h-control-lg gap-1.5 rounded-md bg-primary px-3.5 text-sm font-semibold leading-none text-primary-foreground hover:brightness-110 active:brightness-95",
				accent:
					"reverb-topbar__control--accent h-control-lg gap-1.5 rounded-md border border-border px-3.5 text-sm font-semibold leading-none bg-raised text-muted-foreground hover:bg-surface hover:text-foreground",
				icon: "reverb-topbar__control--icon grid size-topbar-control place-items-center rounded-md text-muted-foreground hover:bg-interactive-hover hover:text-foreground",
				killIcon:
					"reverb-topbar__control--icon reverb-topbar__control--danger-icon grid size-topbar-control place-items-center rounded-md text-error/80 hover:bg-error/10 hover:text-error",
				kill: "reverb-topbar__control--danger h-control-lg gap-1.5 rounded-md border border-border bg-transparent px-3.5 text-sm font-semibold leading-none text-error/80 hover:border-error/50 hover:bg-error/10 hover:text-error",
				killConfirm:
					"reverb-topbar__control--danger h-control-lg gap-1.5 rounded-md border border-error/40 bg-error/10 px-3 text-control font-semibold leading-none text-error hover:bg-error/16",
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
