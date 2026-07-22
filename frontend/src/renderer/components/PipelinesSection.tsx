import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { aoBridge } from "../lib/bridge";
import { pipelinesEnabledQueryKey } from "../hooks/usePipelinesEnabled";
import { usePipelinesSetting, useSetPipelinesSetting } from "../hooks/usePipelinesSetting";
import { Button } from "./ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { Label } from "./ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";

// PipelinesSection is the Global Settings card for the experimental pipelines
// feature (T12). It reads/writes the persisted `settings/pipelines` flag via
// the daemon HTTP API. The flag only takes effect on daemon boot, so saving
// restarts the daemon, then invalidates usePipelinesEnabled's capability probe
// so the sidebar picks up the change without a manual app restart.
export function PipelinesSection() {
	const queryClient = useQueryClient();
	const setting = usePipelinesSetting();
	const save = useSetPipelinesSetting();

	const [enabled, setEnabled] = useState(false);
	const [savedAt, setSavedAt] = useState<number | null>(null);

	// Seed the form once the setting loads (and on refetch), same pattern as
	// UpdatesSection: keying off the loaded value keeps local edits responsive
	// without a controlled-from-query loop.
	useEffect(() => {
		if (setting.enabled !== undefined) setEnabled(setting.enabled);
	}, [setting.enabled]);

	const handleSave = () => {
		setSavedAt(null);
		save.mutate(enabled, {
			onSuccess: async () => {
				// Take effect: restart the daemon so it boots with the new flag, then
				// re-probe pipelines capability so the sidebar reflects it immediately.
				await aoBridge.daemon.restart();
				void queryClient.invalidateQueries({ queryKey: pipelinesEnabledQueryKey });
				setSavedAt(Date.now());
			},
		});
	};

	return (
		<Card>
			<CardHeader>
				<CardTitle className="text-control">Pipelines</CardTitle>
			</CardHeader>
			<CardContent className="flex flex-col gap-4">
				<p className="text-xs leading-row text-passive">
					Experimental. Toggling this restarts the AO daemon to apply the change.
				</p>

				<div className="flex flex-col gap-1.5">
					<Label htmlFor="pipelinesEnabled" className="text-xs text-muted-foreground">
						Pipelines (experimental)
					</Label>
					<EnabledSelect
						id="pipelinesEnabled"
						value={enabled}
						onChange={(next) => {
							setSavedAt(null);
							setEnabled(next);
						}}
					/>
				</div>

				<div className="flex items-center gap-3">
					<Button type="button" variant="primary" onClick={handleSave} disabled={save.isPending}>
						{save.isPending ? "Applying…" : "Apply and restart daemon"}
					</Button>
					{save.isError && (
						<span className="text-xs text-error">
							{save.error instanceof Error ? save.error.message : "Save failed"}
						</span>
					)}
					{savedAt && !save.isPending && !save.isError && (
						<span className="text-xs text-success">Saved. Restarting daemon…</span>
					)}
				</div>
			</CardContent>
		</Card>
	);
}

function EnabledSelect({ id, value, onChange }: { id: string; value: boolean; onChange: (value: boolean) => void }) {
	return (
		<Select value={value ? "on" : "off"} onValueChange={(v) => onChange(v === "on")}>
			<SelectTrigger id={id} className="h-control-form w-full text-control">
				<SelectValue />
			</SelectTrigger>
			<SelectContent>
				<SelectItem value="on">Enabled</SelectItem>
				<SelectItem value="off">Disabled</SelectItem>
			</SelectContent>
		</Select>
	);
}
