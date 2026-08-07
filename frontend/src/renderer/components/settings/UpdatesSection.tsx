import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Loader2, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { aoBridge } from "../../lib/bridge";
import { useUpdateStatus } from "../../hooks/useUpdateStatus";
import type { UpdateChannel, UpdateSettings, UpdateState, UpdateStatus } from "../../../main/update-settings";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { SettingsOptionMenu } from "./SettingsOptionMenu";
import { SettingsRow } from "./SettingsRow";
import { SettingsSection } from "./SettingsSection";
import { captureRendererEvent, releaseChannelFrom, setReleaseChannelContext } from "../../lib/telemetry";

export const updateSettingsQueryKey = ["update-settings"] as const;

type PrimaryValue = UpdateChannel;

const DEFAULT_SETTINGS: UpdateSettings = { enabled: false, channel: "latest", nightlyAck: false, feature: null };

let updateRequestSequence = 0;

function nextUpdateRequestId(): string {
	updateRequestSequence += 1;
	return `feature-update-${updateRequestSequence}`;
}

export function UpdatesSection({ titleHidden }: { titleHidden?: boolean } = {}) {
	const { t } = useTranslation();
	const queryClient = useQueryClient();
	const query = useQuery({
		queryKey: updateSettingsQueryKey,
		queryFn: () => aoBridge.updateSettings.get(),
	});

	const [form, setForm] = useState<UpdateSettings>(DEFAULT_SETTINGS);
	const formRef = useRef(form);
	formRef.current = form;

	const status = useUpdateStatus();
	// Set only for the owned pin/home transition request, so unrelated hourly
	// updater events cannot auto-progress through download/install.
	const autoProgressRef = useRef<string | null>(null);
	const handledStatusRef = useRef<UpdateState | null>(null);

	useEffect(() => {
		if (query.data) setForm(query.data);
	}, [query.data]);

	useEffect(() => {
		const requestId = autoProgressRef.current;
		if (!requestId || status.requestId !== requestId) return;
		if (handledStatusRef.current === status.state) return;
		handledStatusRef.current = status.state;
		if (status.state === "available") {
			void aoBridge.updates.download(requestId);
		} else if (status.state === "downloaded") {
			void aoBridge.updates.install();
			autoProgressRef.current = null;
		} else if (status.state === "error" || status.state === "unsupported" || status.state === "not-available") {
			autoProgressRef.current = null;
		}
	}, [status]);

	const save = useMutation({
		mutationFn: async (next: UpdateSettings) => {
			await aoBridge.updateSettings.set(next);
			return next;
		},
		onSuccess: (next) => {
			setForm(next);
			void queryClient.invalidateQueries({ queryKey: updateSettingsQueryKey });
		},
		onError: () => {
			const previous = queryClient.getQueryData<UpdateSettings>(updateSettingsQueryKey);
			if (previous) setForm(previous);
		},
	});

	const enabledOptions = [
		{ value: "on" as const, label: t("settings.updates.enabled") },
		{ value: "off" as const, label: t("settings.updates.disabled") },
	];

	const channelOptions: { value: PrimaryValue; label: string }[] = [
		{ value: "latest", label: t("settings.updates.channel.stable") },
		{ value: "nightly", label: t("settings.updates.channel.nightly") },
	];
	const primaryValue: PrimaryValue = form.channel;

	const setEnabled = (enabled: boolean) => {
		const next = { ...formRef.current, enabled };
		setForm(next);
		save.mutate(next);
	};

	const handlePrimaryChannel = (value: PrimaryValue) => {
		if (!formRef.current.enabled) return;
		const next = {
			...formRef.current,
			channel: value,
			nightlyAck: value === "nightly",
			feature: null,
		};
		const from = releaseChannelFrom(formRef.current);
		const to = releaseChannelFrom(next);
		setForm(next);
		save.mutate(next);
		if (from !== to) {
			// Reported on the switch rather than inferred later, because someone who
			// moves to nightly and does not update yet is on nightly by intent while
			// still running a stable build.
			setReleaseChannelContext(to);
			void captureRendererEvent("ao.renderer.update_channel_changed", { from_channel: from, to_channel: to });
		}
	};

	const handleReturnToHome = async () => {
		// Optimistic; the main process clears the pin against persisted state.
		setForm({ ...formRef.current, feature: null });
		const requestId = nextUpdateRequestId();
		autoProgressRef.current = requestId;
		handledStatusRef.current = null;
		try {
			// Single updater-serialized op: clears the pin and checks the home channel
			// atomically, so a concurrent settings-write cannot restore the pin.
			await aoBridge.updates.returnHome(requestId);
			void queryClient.invalidateQueries({ queryKey: updateSettingsQueryKey });
		} catch {
			if (autoProgressRef.current === requestId) autoProgressRef.current = null;
			// The optimistic form update may now disagree with disk; re-sync to truth.
			void queryClient.invalidateQueries({ queryKey: updateSettingsQueryKey });
		}
	};

	const activeQuery = useQuery({
		queryKey: ["feature-active"],
		queryFn: () => aoBridge.featureBuilds.getActive(),
	});
	const activeBuild = activeQuery.data ?? null;
	// Show the escape hatch whenever a feature build is running or pinned.
	const featurePr = activeBuild?.pr ?? form.feature?.pr;

	return (
		<>
			<SettingsSection title={t("settings.updates")} sectionId="updates" titleHidden={titleHidden} grouped>
				{featurePr != null && (
					<div className="flex flex-col gap-2">
						<div className="settings-row-bar h-auto min-h-(--size-settings-row) flex-wrap gap-2">
							<Badge variant="accent">PR #{featurePr}</Badge>
							<span className="min-w-0 flex-1 text-sm leading-5 text-settings-label">
								{activeBuild
									? t("settings.updates.onFeatureBuild", { pr: featurePr })
									: t("settings.updates.featurePinned", { pr: featurePr })}
							</span>
							<Button type="button" variant="outline" size="sm" onClick={() => void handleReturnToHome()}>
								{form.channel === "nightly" ? t("settings.updates.returnToNightly") : t("settings.updates.returnToStable")}
							</Button>
						</div>
						<p className="px-1 text-xs text-settings-muted">
							{t("settings.updates.featureTracking", { pr: featurePr })}
						</p>
					</div>
				)}

				<SettingsRow label={t("settings.updates.automatic")}>
					<SettingsOptionMenu
						aria-label={t("settings.updates.automatic")}
						value={form.enabled ? "on" : "off"}
						options={enabledOptions}
						onChange={(next) => setEnabled(next === "on")}
						disabled={save.isPending}
					/>
				</SettingsRow>

				<div className="w-full">
					<SettingsRow label={t("settings.updates.channel")} className="rounded-none">
						<SettingsOptionMenu
							aria-label={t("settings.updates.channel")}
							value={primaryValue}
							options={channelOptions}
							onChange={handlePrimaryChannel}
							disabled={!form.enabled || save.isPending}
						/>
					</SettingsRow>

					{primaryValue === "nightly" && form.enabled && (
						<p className="nightly-warning px-(--size-settings-row-padding) pb-(--size-settings-row-padding) text-xs leading-row text-warning">
							<span className="mr-2 inline-flex align-middle" aria-hidden="true">
								<AlertTriangle className="size-icon-sm" />
							</span>
							{t("settings.updates.nightlyWarning")}
						</p>
					)}
				</div>

				{save.isError && (
					<p className="px-1 text-xs text-error">{save.error instanceof Error ? save.error.message : t("settings.updates.saveFailed")}</p>
				)}

				<UpdateActions status={status} suppressTopBorder={primaryValue === "nightly" && form.enabled} />
			</SettingsSection>

		</>
	);
}

function UpdateActions({ status, suppressTopBorder = false }: { status: UpdateStatus; suppressTopBorder?: boolean }) {
	const { t } = useTranslation();
	const version = useQuery({ queryKey: ["app-version"], queryFn: () => aoBridge.app.getVersion() });

	const checking = status.state === "checking";
	const downloading = status.state === "downloading";
	const busy = checking || downloading;
	const showStatus =
		status.state === "checking" ||
		status.state === "available" ||
		status.state === "downloading" ||
		status.state === "downloaded" ||
		status.state === "not-available" ||
		status.state === "unsupported" ||
		status.state === "error";

	return (
		<>
			<SettingsRow label={t("settings.updates.checksForUpdates")} className={suppressTopBorder ? "!border-t-0" : undefined}>
				<div className="flex items-center gap-2">
					<span className="text-control text-settings-muted" data-testid="app-version">
						{t("settings.updates.currentVersion", { version: version.data ? `v${version.data}` : "…" })}
					</span>
					<button
						type="button"
						aria-label={t("settings.updates.check")}
						className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-settings-muted transition-colors hover:text-settings-label disabled:cursor-not-allowed disabled:opacity-50"
						onClick={() => void aoBridge.updates.check()}
						disabled={busy}
					>
						{checking ? (
							<Loader2 className="size-icon-base animate-spin" aria-hidden="true" />
						) : (
							<RefreshCw className="size-icon-base" aria-hidden="true" />
						)}
					</button>
				</div>
			</SettingsRow>

			{showStatus && (
				<div className="settings-row-bar h-auto min-h-0 flex-wrap justify-start gap-3 py-3">
					{status.state === "available" && (
						<Button type="button" variant="primary" onClick={() => void aoBridge.updates.download()}>
							{status.version ? t("settings.updates.updateTo", { version: `v${status.version}` }) : t("settings.updates.updateToLatest")}
						</Button>
					)}
					{status.state === "downloaded" && (
						<Button type="button" variant="primary" onClick={() => void aoBridge.updates.install()}>
							{t("settings.updates.restartInstall")}
						</Button>
					)}
					<UpdateStatusLine status={status} />
				</div>
			)}
		</>
	);
}

function UpdateStatusLine({ status }: { status: UpdateStatus }) {
	const { t } = useTranslation();
	switch (status.state) {
		case "checking":
			return <span className="text-xs text-settings-muted">{t("settings.updates.checking")}</span>;
		case "available":
			return (
				<span className="text-xs text-settings-muted">
					{t("settings.updates.available", { version: status.version ? ` (v${status.version})` : "" })}
				</span>
			);
		case "downloading":
			return <span className="text-xs text-settings-muted">{t("settings.updates.downloading", { percent: status.percent ?? 0 })}</span>;
		case "downloaded":
			return <span className="text-xs text-success">{t("settings.updates.downloaded")}</span>;
		case "not-available":
			return <span className="text-xs text-settings-muted">{t("settings.updates.latest")}</span>;
		case "unsupported":
			return <span className="text-xs text-settings-muted">{status.message ?? t("settings.updates.needInstalledApp")}</span>;
		case "error":
			return <span className="text-xs text-error">{status.message ?? t("settings.updates.updateFailed")}</span>;
		default:
			return null;
	}
}
