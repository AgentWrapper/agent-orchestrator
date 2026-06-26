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

	const proceed = async () => {
		setBusy(true);
		setError(undefined);
		const { data, error: apiErr } = await apiClient.POST("/api/v1/import");
		if (apiErr) {
			const msg = apiErrorMessage(apiErr);
			setError(msg);
			await aoBridge.appState.setMigration({ status: "failed", lastAttemptAt: nowIso(), error: msg });
			setBusy(false);
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
		setBusy(false);
	};

	const dontMigrate = async () => {
		await aoBridge.appState.setMigration({ status: "declined", lastAttemptAt: nowIso() });
		await queryClient.invalidateQueries({ queryKey: migrationOfferQueryKey });
	};

	return (
		<Dialog.Root
			open
			onOpenChange={(next) => {
				if (!next) setSkipped(true);
			}}
		>
			<Dialog.Portal>
				<Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
				<Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[440px] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-surface p-5 shadow-lg">
					<Dialog.Title className="text-sm font-medium text-foreground">
						Import projects from your earlier AO?
					</Dialog.Title>
					<Dialog.Description className="mt-2 text-[13px] leading-[1.5] text-muted-foreground">
						We found an existing install at <span className="font-mono text-[11px] text-foreground">{legacyRoot}</span>.
						Importing brings in your projects. Your old files are never modified, and you can do this later.
					</Dialog.Description>
					{error && (
						<div className="mt-3 text-[12px] text-destructive">
							Migration failed: {error}. Your legacy projects are untouched (nothing is ever deleted). You can retry.
						</div>
					)}
					<p className="mt-3 text-[11px] text-muted-foreground">You can run this again later.</p>
					<div className="mt-4 flex items-center justify-between gap-2">
						<Button variant="ghost" className="text-destructive" onClick={dontMigrate} disabled={busy} type="button">
							Don't Migrate
						</Button>
						<div className="flex gap-2">
							<Button variant="ghost" onClick={() => setSkipped(true)} disabled={busy} type="button">
								Skip
							</Button>
							<Button variant="primary" onClick={proceed} disabled={busy} type="button">
								{busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
								{error ? "Retry" : "Proceed"}
							</Button>
						</div>
					</div>
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	);
}
