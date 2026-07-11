import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getFleetPaused, pauseFleet, resumeFleet } from "../lib/pause-fleet";
import { useWorkspaceQuery, workspaceQueryKey } from "../hooks/useWorkspaceQuery";
import { Button } from "./ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";

export const fleetStatusQueryKey = ["fleet-status"] as const;

// FleetPauseSection is the Global Settings card for the daemon-global pause
// switch. Pausing stops the whole fleet from dispatching new work; in-flight
// workers drain (or are terminated with a hard pause). Config is untouched, so
// resume restores prior behavior. Toggling also invalidates the workspace query
// so per-project pause badges update immediately.
export function FleetPauseSection() {
	const queryClient = useQueryClient();
	// Always enabled (like the workspace query): the query retries on its
	// interval and loads fleet status as soon as the daemon base URL is
	// available, without needing to react to daemon-discovery timing.
	const query = useQuery({
		queryKey: fleetStatusQueryKey,
		queryFn: getFleetPaused,
		refetchInterval: 15_000,
	});

	const mutation = useMutation({
		mutationFn: (action: { pause: boolean; hard?: boolean }) =>
			action.pause ? pauseFleet(action.hard) : resumeFleet(),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: fleetStatusQueryKey });
			void queryClient.invalidateQueries({ queryKey: workspaceQueryKey });
		},
	});

	// Status is only known once the query succeeds. Until then (loading or
	// error) we must NOT assume "running" — that would hide Resume when the
	// fleet is actually paused. Controls stay disabled until status is known.
	const known = query.isSuccess;
	const paused = query.data === true;

	// The /fleet endpoint reports only a boolean, but a soft pause becomes true
	// immediately while workers drain. Surface the documented running →
	// draining → paused lifecycle by aggregating live draining workers from the
	// per-project statuses the workspace query already carries.
	const workspaces = useWorkspaceQuery();
	const drainingWorkers = (workspaces.data ?? []).reduce(
		(sum, w) => sum + (w.pauseState === "draining" ? (w.drainingWorkers ?? 0) : 0),
		0,
	);
	const statusText = !known
		? query.isLoading
			? "…"
			: "Unavailable"
		: paused
			? drainingWorkers > 0
				? `Draining (${drainingWorkers})`
				: "Paused"
			: "Running";

	const hardPause = () => {
		if (
			!window.confirm(
				"Hard-pause the whole fleet?\n\nThis immediately TERMINATES every live worker AND orchestrator across all projects — in-flight, uncommitted work is discarded. Use a normal pause to let workers drain instead.",
			)
		) {
			return;
		}
		mutation.mutate({ pause: true, hard: true });
	};

	return (
		<Card>
			<CardHeader>
				<CardTitle className="text-[13px]">Fleet</CardTitle>
			</CardHeader>
			<CardContent className="flex flex-col gap-4">
				<div className="flex items-center gap-2 text-[12px]">
					<span className="text-passive">Status</span>
					<span
						className={
							!known
								? "font-medium text-muted-foreground"
								: paused
									? "font-medium text-warning"
									: "font-medium text-success"
						}
					>
						{statusText}
					</span>
				</div>
				<p className="text-[12px] leading-5 text-muted-foreground">
					Pausing stops the whole fleet from dispatching new work. In-flight workers finish (drain); a hard pause
					terminates them immediately. Config is left untouched, so resume restores the prior behavior. New projects
					added while paused start paused.
				</p>
				<div className="flex items-center gap-3">
					{!known ? (
						<Button type="button" variant="outline" disabled>
							{query.isError ? "Fleet status unavailable" : "Loading…"}
						</Button>
					) : (
						<>
							{paused ? (
								<Button
									type="button"
									variant="primary"
									onClick={() => mutation.mutate({ pause: false })}
									disabled={mutation.isPending}
								>
									{mutation.isPending ? "Resuming…" : "Resume fleet"}
								</Button>
							) : (
								<Button
									type="button"
									variant="primary"
									onClick={() => mutation.mutate({ pause: true })}
									disabled={mutation.isPending}
								>
									{mutation.isPending ? "Pausing…" : "Pause fleet"}
								</Button>
							)}
							{/* Hard pause stays available while paused/draining too, so an
							    operator can escalate an in-progress drain to an emergency
							    stop without resuming (which would re-enable intake first). */}
							<Button type="button" variant="outline" onClick={hardPause} disabled={mutation.isPending}>
								Pause now (hard)
							</Button>
						</>
					)}
					{mutation.isError && (
						<span className="text-[12px] text-error">
							{mutation.error instanceof Error ? mutation.error.message : "Failed"}
						</span>
					)}
				</div>
			</CardContent>
		</Card>
	);
}
