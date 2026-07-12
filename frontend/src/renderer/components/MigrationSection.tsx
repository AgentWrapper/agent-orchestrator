import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { apiClient, apiErrorMessage } from "../lib/api-client";
import { aoBridge } from "../lib/bridge";
import { migrationOfferQueryKey } from "../hooks/useMigrationOffer";
import { workspaceQueryKey } from "../hooks/useWorkspaceQuery";
import type { MigrationState, MigrationStatus } from "../../main/app-state";
import { Button } from "./ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { useTranslation } from "react-i18next";

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

function formatTime(iso?: string): string {
	if (!iso) return "";
	const d = new Date(iso);
	return Number.isNaN(d.getTime()) ? "" : d.toLocaleString();
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

	const run = useMutation({
		mutationFn: async () => {
			const nowIso = () => new Date().toISOString();
			const { data, error } = await apiClient.POST("/api/v1/import");
			if (error) {
				const msg = apiErrorMessage(error);
				await aoBridge.appState.setMigration({ status: "failed", lastAttemptAt: nowIso(), error: msg });
				throw new Error(msg);
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
	const completed = migration.status === "completed";
	const buttonLabel = run.isPending
		? t("settings.migration.buttons.running")
		: completed
			? t("settings.migration.buttons.rerun")
			: migration.status === "failed"
				? t("settings.migration.buttons.retry")
				: t("settings.migration.buttons.run");

	const STATUS_LABEL: Record<MigrationStatus, string> = {
		pending: t("settings.migration.status.pending"),
		completed: t("settings.migration.status.completed"),
		declined: t("settings.migration.status.declined"),
		failed: t("settings.migration.status.failed"),
	};

	return (
		<Card>
			<CardHeader>
				<CardTitle className="text-control">{t("settings.migration.title")}</CardTitle>
			</CardHeader>
			<CardContent className="flex flex-col gap-4">
				<p className="text-xs leading-row text-muted-foreground">
					{t("settings.migration.description")}
				</p>

				<div className="flex flex-col gap-2 text-xs">
					<Row label={t("settings.migration.labels.status")}>
						<span className={statusClass(migration.status)}>{STATUS_LABEL[migration.status]}</span>
					</Row>
					{formatTime(migration.completedAt || migration.lastAttemptAt) && (
						<Row label={completed ? t("settings.migration.labels.completed") : t("settings.migration.labels.lastAttempt")}>
							<span className="text-foreground">{formatTime(migration.completedAt || migration.lastAttemptAt)}</span>
						</Row>
					)}
					{report && (
						<Row label={t("settings.migration.labels.lastReport")}>
							<span className="text-foreground">
								{t("settings.migration.messages.report",{imported: report.projectsImported,skipped: report.projectsSkipped,})}
							</span>
						</Row>
					)}
					<Row label={t("settings.migration.labels.legacyInstall")}>
						{query.isLoading ? (
							<span className="text-passive">{t("settings.migration.messages.checking")}</span>
						) : available ? (
							<span className="font-mono text-caption text-foreground">{legacyRoot || t("settings.migration.messages.found")}</span>
						) : (
							<span className="text-passive">{t("settings.migration.messages.noneFound")}</span>
						)}
					</Row>
				</div>

				{migration.status === "failed" && migration.error && (
					<p className="text-xs leading-row text-error">
						{migration.error}.{" "}
						{t("settings.migration.messages.legacyUntouched")}
					</p>
				)}
				{run.isError && (
					<p className="text-xs leading-row text-error">
						{run.error instanceof Error ? run.error.message : t("settings.migration.messages.migrationFailed")}
					</p>
				)}
				{run.isSuccess && !run.isPending && <p className="text-xs leading-row text-success">{t("settings.migration.messages.migrationComplete")}</p>}

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
						<span className="text-xs text-passive">{t("settings.migration.messages.nothingToImport")}</span>
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