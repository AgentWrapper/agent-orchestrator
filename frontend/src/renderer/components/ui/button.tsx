import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/utils";

// emdash buttons are font-normal (400) with 6px radius; blue is the live edge
// (primary). See DESIGN.md → Spacing / Color.
const buttonVariants = cva(
	"inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-[13px] font-normal transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 disabled:pointer-events-none disabled:opacity-45",
	{
		variants: {
			variant: {
				primary: "border border-primary bg-primary text-primary-foreground hover:opacity-90",
				outline: "border border-border bg-background text-foreground hover:bg-surface",
				secondary: "bg-raised text-muted-foreground hover:text-foreground",
				ghost: "text-muted-foreground hover:bg-surface hover:text-foreground",
			},
			size: {
				default: "h-8 px-3",
				sm: "h-7 px-2.5 text-xs",
				icon: "h-8 w-8",
				"icon-sm": "h-7 w-7",
			},
		},
		defaultVariants: {
			variant: "primary",
			size: "default",
		},
	},
);

export interface ButtonProps
	extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
	asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
	({ asChild = false, className, size, variant, ...props }, ref) => {
		const Comp = asChild ? Slot : "button";
		return <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />;
	},
);

Button.displayName = "Button";
