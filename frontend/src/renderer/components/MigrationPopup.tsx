import * as Dialog from "@radix-ui/react-dialog";
import { Loader2 } from "lucide-react";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "./ui/button";
import { apiClient, apiErrorMessage } from "../lib/api-client";
import { aoBridge } from "../lib/bridge";
import { migrationOfferQueryKey, useMigrationOffer } from "../hooks/useMigrationOffer";
import { workspaceQueryKey } from "../hooks/useWorkspaceQuery";

// MigrationPopup is the first-run legacy-AO import offer. It shows only when the
// app marker is non-terminal (pending/failed) AND the daemon reports legacy data
// available. Proceed runs the idempotent import through the daemon; Skip dismisses
// for this launch (re-prompts next launch); Don't Migrate declines permanently
// (re-runnable later once the Settings entry point lands, issue #2205).
export function MigrationPopup() {
	const offer = useMigrationOffer();
	const queryClient = useQueryClient();
	const [skipped, setSkipped] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | undefined>();

	const open = (offer.data?.show ?? false) && !skipped;
	if (!open) return null;

	const legacyRoot = offer.data?.legacyRoot || "your earlier AO";
	const nowIso = () => new Date().toISOString();

	// Best-effort failure marker: the popup is already reporting the error to the
	// user, so a marker write that ALSO fails must not throw on top of it.
	const recordFailure = async (message: string) => {
		try {
			await aoBridge.appState.setMigration({ status: "failed", lastAttemptAt: nowIso(), error: message });
		} catch {
			// The marker is bookkeeping; the visible error is the contract.
		}
	};

	// Every await here can REJECT, not just return an api error: the fetch can fail
	// (offline daemon), the IPC bridge can throw, and query invalidation can reject.
	// Before #293 those rejections escaped `proceed` uncaught, leaving busy=true —
	// Proceed/Skip/Don't Migrate stayed disabled forever and the popup could not
	// even be dismissed. One try/catch/finally around the whole operation: surface
	// the message, always clear busy.
	const proceed = async () => {
		setBusy(true);
		setError(undefined);
		try {
			const { data, error: apiErr } = await apiClient.POST("/api/v1/import");
			if (apiErr) {
				const msg = apiErrorMessage(apiErr);
				setError(msg);
				await recordFailure(msg);
				return;
			}
			const report = data?.report;
			await aoBridge.appState.setMigration({
				status: "completed",
				lastAttemptAt: nowIso(),
				completedAt: nowIso(),
				report: report
					? { projectsImported: report.projectsImported, projectsSkipped: report.projectsSkipped }
					: undefined,
			});
			await queryClient.invalidateQueries({ queryKey: workspaceQueryKey });
			await queryClient.invalidateQueries({ queryKey: migrationOfferQueryKey });
			setSkipped(true);
		} catch (err) {
			const msg = apiErrorMessage(err, "Migration failed");
			setError(msg);
			await recordFailure(msg);
		} finally {
			setBusy(false);
		}
	};

	const dontMigrate = async () => {
		setBusy(true);
		setError(undefined);
		try {
			await aoBridge.appState.setMigration({ status: "declined", lastAttemptAt: nowIso() });
			await queryClient.invalidateQueries({ queryKey: migrationOfferQueryKey });
		} catch (err) {
			setError(apiErrorMessage(err, "Could not record your choice"));
		} finally {
			setBusy(false);
		}
	};

	return (
		<Dialog.Root
			open
			onOpenChange={(next) => {
				if (!next) setSkipped(true);
			}}
		>
			<Dialog.Portal>
				<Dialog.Overlay className="fixed inset-0 z-overlay bg-scrim" />
				<Dialog.Content className="fixed left-1/2 top-1/2 z-overlay w-dialog-lg -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-surface p-5 shadow-lg">
					<Dialog.Title className="text-sm font-medium text-foreground">
						Import projects from your earlier AO?
					</Dialog.Title>
					<Dialog.Description className="mt-2 text-control leading-body text-muted-foreground">
						We found an existing install at <span className="font-mono text-caption text-foreground">{legacyRoot}</span>
						. Importing brings in your projects. Your old files are never modified, and you can do this later.
					</Dialog.Description>
					{error && (
						<div className="mt-3 text-xs text-destructive">
							Migration failed: {error}. Your legacy projects are untouched (nothing is ever deleted). You can retry.
						</div>
					)}
					<p className="mt-3 text-caption text-muted-foreground">You can run this again later.</p>
					<div className="mt-4 flex items-center justify-between gap-2">
						<Button variant="ghost" className="text-destructive" onClick={dontMigrate} disabled={busy} type="button">
							Don't Migrate
						</Button>
						<div className="flex gap-2">
							<Button variant="ghost" onClick={() => setSkipped(true)} disabled={busy} type="button">
								Skip
							</Button>
							<Button variant="primary" onClick={proceed} disabled={busy} type="button">
								{busy && <Loader2 className="mr-2 size-icon-base animate-spin" />}
								{error ? "Retry" : "Proceed"}
							</Button>
						</div>
					</div>
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	);
}
