import * as Dialog from "@radix-ui/react-dialog";
import { useTranslation } from "react-i18next";
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
// for this launch (re-prompts next launch); {t("migration.dontMigrate")} declines permanently
// (re-runnable later once the Settings entry point lands, issue #2205).
export function MigrationPopup() {
	const { t } = useTranslation();
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
				<Dialog.Overlay className="fixed inset-0 z-overlay bg-scrim" />
				<Dialog.Content className="fixed left-1/2 top-1/2 z-overlay w-dialog-lg -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-surface p-5 shadow-lg">
					<Dialog.Title className="text-sm font-medium text-foreground">{t("migration.title")}</Dialog.Title>
					<Dialog.Description className="mt-2 text-control leading-body text-muted-foreground">
						{t("migration.bodyLead")}{" "}
						<span className="font-mono text-caption text-foreground">{legacyRoot}</span>
						. {t("migration.bodyTrail")}
					</Dialog.Description>
					{error && (
						<div className="mt-3 text-xs text-destructive">
							{t("migration.failed", { error })}
						</div>
					)}
					<p className="mt-3 text-caption text-muted-foreground">{t("migration.againLater")}</p>
					<div className="mt-4 flex items-center justify-between gap-2">
						<Button variant="ghost" className="text-destructive" onClick={dontMigrate} disabled={busy} type="button">
							{t("migration.dontMigrate")}
						</Button>
						<div className="flex gap-2">
							<Button variant="ghost" onClick={() => setSkipped(true)} disabled={busy} type="button">
								{t("migration.skip")}
							</Button>
							<Button variant="primary" onClick={proceed} disabled={busy} type="button">
								{busy && <Loader2 className="mr-2 size-icon-base animate-spin" />}
								{error ? t("migration.retry") : t("migration.proceed")}
							</Button>
						</div>
					</div>
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	);
}
