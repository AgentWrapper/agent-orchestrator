import { RefreshCw } from "lucide-react";
import { useBuildFreshness } from "../lib/build-freshness";
import { Button } from "./ui/button";

export function BuildFreshnessBanner() {
	const freshness = useBuildFreshness();
	const stale = freshness.data?.state === "stale";
	if (!stale) return null;

	return (
		<div
			role="alert"
			className="flex flex-wrap items-center justify-between gap-3 border-b border-warning/40 bg-warning/10 px-4.5 py-2.5 text-[13px] text-foreground"
		>
			<span>A different AO web build is available. Reload before changing settings.</span>
			<Button type="button" variant="outline" size="sm" onClick={() => window.location.reload()}>
				<RefreshCw aria-hidden="true" />
				Reload
			</Button>
		</div>
	);
}
