import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const topbarButtonVariants = cva(
	"reverb-topbar__control inline-flex items-center transition-[filter,background,color,border-color] duration-fast disabled:opacity-60",
	{
		variants: {
			variant: {
				primary:
					"reverb-topbar__control--primary h-control-lg gap-1.5 rounded-md bg-accent-strong px-3.5 text-sm font-semibold leading-none text-accent-foreground hover:brightness-110 active:brightness-95",
				accent:
					"reverb-topbar__control--accent h-control-lg gap-1.5 rounded-md border border-border px-3.5 text-sm font-semibold leading-none bg-raised text-muted-foreground hover:bg-surface hover:text-foreground",
				feature:
					"reverb-topbar__control--feature reverb-topbar__control--labeled h-control-lg gap-1.5 rounded-md border px-3 text-control font-semibold leading-none",
				icon: "reverb-topbar__control--icon grid size-topbar-control place-items-center rounded-md text-muted-foreground hover:bg-interactive-hover hover:text-foreground",
				killIcon:
					"reverb-topbar__control--icon reverb-topbar__control--danger-icon grid size-topbar-control place-items-center rounded-md text-error/80 hover:bg-error/10 hover:text-error",
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
