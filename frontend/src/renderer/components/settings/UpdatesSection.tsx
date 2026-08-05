import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, GitPullRequest, HardDriveDownload, History, Loader2, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { aoBridge } from "../../lib/bridge";
import { formatTimeCompact } from "../../lib/format-time";
import { useUpdateStatus } from "../../hooks/useUpdateStatus";
import { useUiStore } from "../../stores/ui-store";
import type { UpdateChannel, UpdateSettings, UpdateState, UpdateStatus } from "../../../main/update-settings";
import { ConfirmDialog } from "../ConfirmDialog";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { SettingsOptionMenu } from "./SettingsOptionMenu";
import { SettingsRow } from "./SettingsRow";
import { SettingsSection } from "./SettingsSection";
import { captureRendererEvent, releaseChannelFrom, setReleaseChannelContext } from "../../lib/telemetry";

export const updateSettingsQueryKey = ["update-settings"] as const;

type PrimaryValue = UpdateChannel | "feature";

const DEFAULT_SETTINGS: UpdateSettings = { enabled: false, channel: "latest", nightlyAck: false, feature: null };

const STALE_THRESHOLD_MS = 5 * 24 * 60 * 60 * 1000; // 5 days
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

	// Reveals the feature-build picker when the user selects "Feature Releases"
	// but has not pinned a build yet (form.feature is still null).
	const [showFeature, setShowFeature] = useState(false);
	const [pendingPin, setPendingPin] = useState<{ pr: number; title: string } | null>(null);

	const developerMode = useUiStore((state) => state.developerMode);

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
		{ value: "feature", label: t("settings.updates.channel.feature") },
	];

	// Feature Releases is developer-only; hide it entirely unless Developer Mode is on.
	const nonFeatureChannelOptions = channelOptions.filter((option) => option.value !== "feature");

	// With Developer Mode off the "feature" value has no matching option, so fall
	// back to the home channel to keep the dropdown showing a valid selection.
	const primaryValue: PrimaryValue = developerMode && (form.feature != null || showFeature) ? "feature" : form.channel;

	const setEnabled = (enabled: boolean) => {
		const next = { ...formRef.current, enabled };
		setForm(next);
		save.mutate(next);
	};

	const handlePrimaryChannel = (value: PrimaryValue) => {
		if (!formRef.current.enabled) return;
		if (value === "feature") {
			setShowFeature(true);
			return;
		}
		setShowFeature(false);
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

	const handlePinBuild = async (pr: number, title: string) => {
		setPendingPin({ pr, title });
	};

	const confirmPinBuild = async () => {
		if (!pendingPin) return;
		const { pr } = pendingPin;
		setPendingPin(null);
		const next = { ...formRef.current, feature: { pr } };
		setForm(next);
		const requestId = nextUpdateRequestId();
		autoProgressRef.current = requestId;
		handledStatusRef.current = null;
		try {
			await aoBridge.updates.check({ settings: next, requestId });
			void queryClient.invalidateQueries({ queryKey: updateSettingsQueryKey });
		} catch {
			if (autoProgressRef.current === requestId) autoProgressRef.current = null;
			// The optimistic form update may now disagree with disk; re-sync to truth.
			void queryClient.invalidateQueries({ queryKey: updateSettingsQueryKey });
		}
	};

	const handleReturnToHome = async () => {
		setShowFeature(false);
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
	// Show the escape hatch whenever a feature build is running. When Developer Mode
	// is off, also surface a merely-pinned build: the pin stays effective in the
	// main-process updater while the picker is hidden, so it must never be silent.
	// With Developer Mode on the visible picker already shows the pin, so Updates
	// behaves exactly as before (banner only for a running build).
	const featurePr = activeBuild?.pr ?? (developerMode ? null : (form.feature?.pr ?? null));

	return (
		<>
			<SettingsSection title={t("settings.updates")} sectionId="updates" titleHidden={titleHidden}>
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

				<SettingsRow icon={History} label={t("settings.updates.automatic")}>
					<SettingsOptionMenu
						aria-label={t("settings.updates.automatic")}
						value={form.enabled ? "on" : "off"}
						options={enabledOptions}
						onChange={(next) => setEnabled(next === "on")}
						disabled={save.isPending}
					/>
				</SettingsRow>

				<SettingsRow icon={HardDriveDownload} label={t("settings.updates.channel")}>
					<SettingsOptionMenu
						aria-label={t("settings.updates.channel")}
						value={primaryValue}
						options={developerMode ? channelOptions : nonFeatureChannelOptions}
						onChange={handlePrimaryChannel}
						disabled={!form.enabled || save.isPending}
					/>
				</SettingsRow>

				{primaryValue === "feature" && (
					<FeatureBuildsSelect currentPr={form.feature?.pr ?? null} onPin={handlePinBuild} />
				)}

				{primaryValue === "nightly" && form.enabled && (
					<p className="flex items-center gap-2 px-1 text-xs leading-row text-warning">
						<AlertTriangle className="size-icon-sm shrink-0" aria-hidden="true" />
						<span>{t("settings.updates.nightlyWarning")}</span>
					</p>
				)}

				{save.isError && (
					<p className="px-1 text-xs text-error">{save.error instanceof Error ? save.error.message : t("settings.updates.saveFailed")}</p>
				)}

				<UpdateActions status={status} />
			</SettingsSection>

			<ConfirmDialog
				open={pendingPin !== null}
				title={t("settings.updates.switchFeatureTitle")}
				description={
					pendingPin
						? t("settings.updates.switchFeatureBody", { pr: pendingPin.pr, title: pendingPin.title })
						: null
				}
				confirmLabel={t("settings.updates.confirm")}
				onConfirm={() => void confirmPinBuild()}
				onOpenChange={(open) => {
					if (!open) setPendingPin(null);
				}}
			/>
		</>
	);
}

function FeatureBuildsSelect({
	currentPr,
	onPin,
}: {
	currentPr: number | null;
	onPin: (pr: number, title: string) => Promise<void>;
}) {
	const { t } = useTranslation();
	const buildsQuery = useQuery({
		queryKey: ["feature-builds"],
		queryFn: () => aoBridge.featureBuilds.list(),
	});

	const builds = buildsQuery.data ?? [];

	if (!buildsQuery.isLoading && builds.length === 0) {
		return (
			<div className="px-1 text-xs text-settings-muted">
				<span className="sr-only">{t("settings.updates.featureBuild")}</span>
				{t("settings.updates.noFeatureReleases")}
			</div>
		);
	}

	const options = builds.map((build) => ({
		value: build.pr.toString(),
		label: `PR #${build.pr}`,
	}));

	return (
		<SettingsRow icon={GitPullRequest} label={t("settings.updates.featureBuild")}>
			<SettingsOptionMenu
				aria-label={t("settings.updates.featureBuild")}
				value={currentPr === null ? "__none__" : currentPr.toString()}
				placeholder={t("settings.updates.selectFeature")}
				options={options}
				disabled={buildsQuery.isLoading}
				onChange={(nextPr) => {
					const pr = Number(nextPr);
					const build = builds.find((b) => b.pr === pr);
					if (!build) return;
					void onPin(build.pr, build.title);
				}}
				renderMenuItem={(option) => {
					const pr = Number(option.value);
					const build = builds.find((b) => b.pr === pr);
					if (!build) return null;

					const ageMs = Date.now() - new Date(build.publishedAt).getTime();
					const isStale = ageMs > STALE_THRESHOLD_MS;
					const ageLabel = formatTimeCompact(build.publishedAt);

					return (
						<div className="flex w-full min-w-0 flex-col gap-0.5">
							<span className="line-clamp-2 break-words">
								PR #{build.pr}: {build.title}
							</span>
							<div className="flex min-w-0 items-center gap-1.5">
								<span className="min-w-0 truncate text-caption text-passive">{build.buildId}</span>
								<Badge variant={isStale ? "warning" : "neutral"} className="h-3.5 px-1 text-[9px] leading-none">
									{ageLabel}
								</Badge>
							</div>
						</div>
					);
				}}
			/>
		</SettingsRow>
	);
}

function UpdateActions({ status }: { status: UpdateStatus }) {
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
			<SettingsRow icon={Check} label={t("settings.updates.checksForUpdates")}>
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
