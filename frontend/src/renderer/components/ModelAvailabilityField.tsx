import { RefreshCw, TriangleAlert } from "lucide-react";
import { useMemo, useId } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { AgentModelAvailabilityResponse, AgentModelAvailability } from "../hooks/useModelAvailabilityQuery";
import { fetchModelAvailability, modelAvailabilityQueryKey } from "../hooks/useModelAvailabilityQuery";
import { Button } from "./ui/button";
import { Label } from "./ui/label";

type ModelAvailabilityFieldProps = {
	id: string;
	label: string;
	value: string;
	onChange: (value: string) => void;
	availability?: AgentModelAvailabilityResponse;
	isRefreshing: boolean;
	onRefresh: () => void;
	placeholder?: string;
};

export function ModelAvailabilityField({
	id,
	label,
	value,
	onChange,
	availability,
	isRefreshing,
	onRefresh,
	placeholder = "(agent default)",
}: ModelAvailabilityFieldProps) {
	const datalistId = useId();
	const options = useMemo(() => modelOptions(availability), [availability]);
	const current = options.find((opt) => opt.model === value.trim());
	const statusLabel = current ? modelAvailabilityStatusLabel(current) : "";
	const statusText = statusLabel ? `${statusLabel}${current?.reason ? `: ${current.reason}` : ""}` : "";

	return (
		<div className="flex flex-col gap-1.5">
			<div className="flex items-center justify-between gap-2">
				<Label htmlFor={id} className="text-[12px] font-medium text-muted-foreground">
					{label}
				</Label>
				<Button type="button" variant="ghost" className="h-7 px-2" disabled={isRefreshing} onClick={onRefresh}>
					<RefreshCw className={`size-3.5 ${isRefreshing ? "animate-spin" : ""}`} aria-hidden="true" />
					<span className="sr-only">Refresh models</span>
				</Button>
			</div>
			<input
				id={id}
				list={datalistId}
				className="h-8 w-full rounded-md border border-input bg-transparent px-2.5 text-[13px] text-foreground placeholder:text-passive focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-weak"
				value={value}
				onChange={(event) => onChange(event.target.value)}
				placeholder={placeholder}
			/>
			<datalist id={datalistId}>
				{options.map((opt) => (
					<option
						key={`${opt.harness}:${opt.model}`}
						value={opt.model}
						label={`${opt.harness}${modelAvailabilityStatusLabel(opt) ? ` · ${modelAvailabilityStatusLabel(opt)}` : ""}`}
					/>
				))}
			</datalist>
			{statusText && (
				<p className="flex items-start gap-1.5 text-[12px] leading-5 text-warning">
					<TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
					<span>{statusText}</span>
				</p>
			)}
		</div>
	);
}

export function useRefreshModelAvailability() {
	const queryClient = useQueryClient();
	return () =>
		queryClient.fetchQuery({
			queryKey: modelAvailabilityQueryKey,
			queryFn: () => fetchModelAvailability({ force: true }),
		});
}

function modelOptions(
	availability?: AgentModelAvailabilityResponse,
): Array<AgentModelAvailability & { harness: string }> {
	if (!availability) return [];
	const seen = new Set<string>();
	const out: Array<AgentModelAvailability & { harness: string }> = [];
	for (const harness of availability.harnesses ?? []) {
		for (const model of harness.models ?? []) {
			const key = `${harness.id}:${model.model}`;
			if (seen.has(key)) continue;
			seen.add(key);
			out.push({ ...model, harness: harness.id });
		}
	}
	return out.sort((a, b) => a.model.localeCompare(b.model));
}

export function modelAvailabilityStatusLabel(
	model: Pick<AgentModelAvailability, "status" | "reason" | "reasonCode">,
): string {
	if (model.status === "reachable") return "";
	if (model.status === "unknown" && (model.reasonCode === "not-probed" || model.reason?.startsWith("not probed;"))) {
		return "";
	}
	if (model.status === "unknown" && model.reasonCode === "no-capability") return "no discovery";
	return model.status;
}
