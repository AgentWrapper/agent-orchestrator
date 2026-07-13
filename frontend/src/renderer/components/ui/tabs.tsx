import * as TabsPrimitive from "@radix-ui/react-tabs";
import { cn } from "../../lib/utils";

export const Tabs = TabsPrimitive.Root;

export function TabsList({ className, ...props }: React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>) {
	return (
		<TabsPrimitive.List
			className={cn("inline-flex h-control-form items-center justify-center gap-1 rounded-md bg-raised p-1", className)}
			{...props}
		/>
	);
}

export function TabsTrigger({ className, ...props }: React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>) {
	return (
		<TabsPrimitive.Trigger
			className={cn(
				"inline-flex h-6 items-center justify-center whitespace-nowrap rounded px-2.5 text-xs font-normal text-muted-foreground transition-colors data-[state=active]:bg-background data-[state=active]:text-foreground",
				className,
			)}
			{...props}
		/>
	);
}

export function TabsContent({ className, ...props }: React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>) {
	return <TabsPrimitive.Content className={cn("focus-visible:outline-none", className)} {...props} />;
}
