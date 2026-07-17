import * as Dialog from "@radix-ui/react-dialog";
import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "./ui/button";
import { apiClient } from "../lib/api-client";
import { aoBridge } from "../lib/bridge";
import {
	isMigrationActionError,
	migrationActionError,
	migrationActionErrorMessage,
	migrationFailureFields,
	persistedMigrationErrorMessage,
	type MigrationActionError,
} from "../lib/migration-errors";
import { migrationOfferQueryKey, useMigrationOffer } from "../hooks/useMigrationOffer";
import { workspaceQueryKey } from "../hooks/useWorkspaceQuery";

// MigrationPopup is the first-run legacy-AO import offer. It shows only when the
// app marker is non-terminal (pending/failed) AND the daemon reports legacy data
// available. Proceed runs the idempotent import through the daemon; Skip dismisses
// for this launch (re-prompts next launch); Don't Migrate declines permanently
// (re-runnable later once the Settings entry point lands, issue #2205).
export function MigrationPopup() {
	const { t } = useTranslation();
	const [remoteClient, setRemoteClient] = useState<boolean | null>(null);
	useEffect(() => {
		let active = true;
		void aoBridge.remoteServer
			.isRemoteClient()
			.then((remote) => {
				if (active) setRemoteClient(remote);
			})
			.catch(() => {
				if (active) setRemoteClient(false);
			});
		return () => {
			active = false;
		};
	}, []);
	const offer = useMigrationOffer(remoteClient === false);
	const queryClient = useQueryClient();
	const [skipped, setSkipped] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<MigrationActionError>();

	const open = remoteClient === false && (offer.data?.show ?? false) && !skipped;
	if (!open) return null;

	const legacyRoot = offer.data?.legacyRoot || t("migration.popup.earlierAO");
	const nowIso = () => new Date().toISOString();
	const persistedError = offer.data
		? persistedMigrationErrorMessage(offer.data.migration, t("migration.errors.failed"))
		: undefined;
	const errorMessage = error ? migrationActionErrorMessage(error, t("migration.errors.failed")) : persistedError;

	const proceed = async () => {
		setBusy(true);
		setError(undefined);
		try {
			const { data, error: apiErr } = await apiClient.POST("/api/v1/import");
			if (apiErr) {
				await aoBridge.appState.setMigration({
					status: "failed",
					lastAttemptAt: nowIso(),
					...migrationFailureFields(apiErr),
				});
				throw migrationActionError("api", apiErr);
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
		} catch (failure) {
			setError(isMigrationActionError(failure) ? failure : migrationActionError("operation", failure));
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
			setSkipped(true);
		} catch (failure) {
			setError(migrationActionError("operation", failure));
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
					<Dialog.Title className="text-sm font-medium text-foreground">{t("migration.popup.title")}</Dialog.Title>
					<Dialog.Description className="mt-2 text-control leading-body text-muted-foreground">
						{t("migration.popup.foundAt")} <span className="font-mono text-caption text-foreground">{legacyRoot}</span>
						{t("migration.popup.descriptionAfter")}
					</Dialog.Description>
					{errorMessage && (
						<div className="mt-3 text-xs text-destructive">
							{t("migration.errors.popup", {
								error: errorMessage,
							})}
						</div>
					)}
					<p className="mt-3 text-caption text-muted-foreground">{t("migration.popup.runLater")}</p>
					<div className="mt-4 flex items-center justify-between gap-2">
						<Button variant="ghost" className="text-destructive" onClick={dontMigrate} disabled={busy} type="button">
							{t("migration.popup.dontMigrate")}
						</Button>
						<div className="flex gap-2">
							<Button variant="ghost" onClick={() => setSkipped(true)} disabled={busy} type="button">
								{t("migration.popup.skip")}
							</Button>
							<Button variant="primary" onClick={proceed} disabled={busy} type="button">
								{busy && <Loader2 className="mr-2 size-icon-base animate-spin" />}
								{errorMessage ? t("migration.popup.retry") : t("migration.popup.proceed")}
							</Button>
						</div>
					</div>
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	);
}
