import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { apiClient } from "../lib/api-client";
import { aoBridge } from "../lib/bridge";
import { formatDateTime } from "../lib/format-time";
import {
	migrationActionError,
	migrationActionErrorMessage,
	migrationFailureFields,
	persistedMigrationErrorMessage,
	type MigrationActionError,
} from "../lib/migration-errors";
import { migrationOfferQueryKey } from "../hooks/useMigrationOffer";
import { workspaceQueryKey } from "../hooks/useWorkspaceQuery";
import type { MigrationState, MigrationStatus } from "../../main/app-state";
import { Button } from "./ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";

export const migrationSettingsQueryKey = ["migration-settings"] as const;

interface MigrationView {
	migration: MigrationState;
	available: boolean;
	legacyRoot: string;
}

// fetchMigrationSettings reads the persisted decision (app marker) and asks the
// daemon whether legacy data is present. Unlike useMigrationOffer it never
// short-circuits on a terminal status: Settings always shows the full state so a
// user who declined or already completed can re-run. A 501/unreachable daemon
// resolves to "not available", never an error.
async function fetchMigrationSettings(): Promise<MigrationView> {
	const migration = await aoBridge.appState.getMigration();
	const { data, error } = await apiClient.GET("/api/v1/import");
	return {
		migration,
		available: !error && (data?.available ?? false),
		legacyRoot: data?.legacyRoot ?? "",
	};
}

function statusClass(status: MigrationStatus): string {
	switch (status) {
		case "completed":
			return "text-success";
		case "failed":
			return "text-error";
		default:
			return "text-muted-foreground";
	}
}

// MigrationSection is a drop-in Settings card for re-running the legacy-AO
// import. It reads the persisted migration decision + the daemon's availability,
// shows the last report/error, and exposes a Run / Re-run button that calls the
// idempotent POST /api/v1/import (safe even when completed/declined/failed).
// Issue #2205.
export function MigrationSection() {
	const { t } = useTranslation();
	const queryClient = useQueryClient();
	const query = useQuery({
		queryKey: migrationSettingsQueryKey,
		queryFn: fetchMigrationSettings,
	});

	const run = useMutation<void, MigrationActionError>({
		mutationFn: async () => {
			const nowIso = () => new Date().toISOString();
			let response: Awaited<ReturnType<typeof apiClient.POST>>;
			try {
				response = await apiClient.POST("/api/v1/import");
			} catch (error) {
				throw migrationActionError("operation", error);
			}
			const { data, error } = response;
			if (error) {
				try {
					await aoBridge.appState.setMigration({
						status: "failed",
						lastAttemptAt: nowIso(),
						...migrationFailureFields(error),
					});
				} catch (writeError) {
					throw migrationActionError("operation", writeError);
				}
				throw migrationActionError("api", error);
			}
			const report = data?.report;
			try {
				await aoBridge.appState.setMigration({
					status: "completed",
					lastAttemptAt: nowIso(),
					completedAt: nowIso(),
					report: report
						? { projectsImported: report.projectsImported, projectsSkipped: report.projectsSkipped }
						: undefined,
				});
			} catch (error) {
				throw migrationActionError("operation", error);
			}
		},
		onSettled: () => {
			void queryClient.invalidateQueries({ queryKey: migrationSettingsQueryKey });
			void queryClient.invalidateQueries({ queryKey: migrationOfferQueryKey });
			void queryClient.invalidateQueries({ queryKey: workspaceQueryKey });
		},
	});

	const migration = query.data?.migration ?? { status: "pending" as MigrationStatus };
	const available = query.data?.available ?? false;
	const legacyRoot = query.data?.legacyRoot ?? "";
	const report = migration.report;
	const persistedError = persistedMigrationErrorMessage(migration, t("migration.errors.failed"));
	const completed = migration.status === "completed";
	const statusLabel = t(
		migration.status === "pending"
			? "migration.status.pending"
			: migration.status === "completed"
				? "migration.status.completed"
				: migration.status === "declined"
					? "migration.status.declined"
					: "migration.status.failed",
	);
	const attemptTime = formatDateTime(migration.completedAt || migration.lastAttemptAt);
	const buttonLabel = run.isPending
		? t("migration.section.running")
		: completed
			? t("migration.section.rerun")
			: migration.status === "failed"
				? t("migration.section.retry")
				: t("migration.section.run");

	return (
		<Card>
			<CardHeader>
				<CardTitle className="text-control">{t("migration.section.title")}</CardTitle>
			</CardHeader>
			<CardContent className="flex flex-col gap-4">
				<p className="text-xs leading-row text-muted-foreground">{t("migration.section.description")}</p>

				<div className="flex flex-col gap-2 text-xs">
					<Row label={t("migration.section.statusLabel")}>
						<span className={statusClass(migration.status)}>{statusLabel}</span>
					</Row>
					{attemptTime && (
						<Row label={completed ? t("migration.section.completedLabel") : t("migration.section.lastAttempt")}>
							<span className="text-foreground">{attemptTime}</span>
						</Row>
					)}
					{report && (
						<Row label={t("migration.section.lastReport")}>
							<span className="text-foreground">
								{t("migration.section.report", {
									projectsImported: report.projectsImported,
									projectsSkipped: report.projectsSkipped,
								})}
							</span>
						</Row>
					)}
					<Row label={t("migration.section.legacyInstall")}>
						{query.isLoading ? (
							<span className="text-passive">{t("migration.section.checking")}</span>
						) : available ? (
							<span className="font-mono text-caption text-foreground">
								{legacyRoot || t("migration.section.found")}
							</span>
						) : (
							<span className="text-passive">{t("migration.section.noneFound")}</span>
						)}
					</Row>
				</div>

				{!run.isError && persistedError && (
					<p className="text-xs leading-row text-error">{t("migration.errors.untouched", { error: persistedError })}</p>
				)}
				{run.isError && (
					<p className="text-xs leading-row text-error">
						{migrationActionErrorMessage(run.error, t("migration.errors.failed"))}
					</p>
				)}
				{run.isSuccess && !run.isPending && (
					<p className="text-xs leading-row text-success">{t("migration.section.complete")}</p>
				)}

				<div className="flex items-center gap-3">
					<Button
						type="button"
						variant="primary"
						onClick={() => run.mutate()}
						disabled={run.isPending || (!available && !completed)}
					>
						{run.isPending && <Loader2 className="mr-2 size-icon-base animate-spin" />}
						{buttonLabel}
					</Button>
					{!available && !query.isLoading && (
						<span className="text-xs text-passive">{t("migration.section.nothingToImport")}</span>
					)}
				</div>
			</CardContent>
		</Card>
	);
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<div className="flex items-center gap-3">
			<span className="w-28 shrink-0 text-passive">{label}</span>
			<span className="min-w-0 flex-1 truncate">{children}</span>
		</div>
	);
}
