import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, GitPullRequest, HardDriveDownload, History, Loader2, RefreshCw } from "lucide-react";
import { aoBridge } from "../../lib/bridge";
import { formatTimeCompact } from "../../lib/format-time";
import { useUpdateStatus } from "../../hooks/useUpdateStatus";
import type { UpdateChannel, UpdateSettings, UpdateState, UpdateStatus } from "../../../main/update-settings";
import { ConfirmDialog } from "../ConfirmDialog";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { SettingsOptionMenu } from "./SettingsOptionMenu";
import { SettingsRow } from "./SettingsRow";
import { SettingsSection } from "./SettingsSection";

export const updateSettingsQueryKey = ["update-settings"] as const;

type PrimaryValue = UpdateChannel | "feature";

const ENABLED_OPTIONS = [
	{ value: "on" as const, label: "Enabled" },
	{ value: "off" as const, label: "Disabled" },
];

const CHANNEL_OPTIONS: { value: PrimaryValue; label: string }[] = [
	{ value: "latest", label: "Stable (Latest)" },
	{ value: "nightly", label: "Nightly (Pre-release)" },
	{ value: "feature", label: "Feature Releases" },
];

const DEFAULT_SETTINGS: UpdateSettings = { enabled: false, channel: "latest", nightlyAck: false, feature: null };

const STALE_THRESHOLD_MS = 5 * 24 * 60 * 60 * 1000; // 5 days
let updateRequestSequence = 0;

function nextUpdateRequestId(): string {
	updateRequestSequence += 1;
	return `feature-update-${updateRequestSequence}`;
}

export function UpdatesSection() {
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

	const primaryValue: PrimaryValue = form.feature != null || showFeature ? "feature" : form.channel;

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
		setForm(next);
		save.mutate(next);
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
		}
	};

	const handleReturnToHome = async () => {
		setShowFeature(false);
		const next = { ...formRef.current, feature: null };
		setForm(next);
		const requestId = nextUpdateRequestId();
		autoProgressRef.current = requestId;
		handledStatusRef.current = null;
		try {
			await aoBridge.updates.check({ settings: next, requestId });
			void queryClient.invalidateQueries({ queryKey: updateSettingsQueryKey });
		} catch {
			if (autoProgressRef.current === requestId) autoProgressRef.current = null;
		}
	};

	const activeQuery = useQuery({
		queryKey: ["feature-active"],
		queryFn: () => aoBridge.featureBuilds.getActive(),
	});
	const activeBuild = activeQuery.data ?? null;

	return (
		<>
			<SettingsSection title="Updates" sectionId="updates">
				{activeBuild && (
					<div className="flex flex-col gap-2">
						<div className="settings-row-bar h-auto min-h-(--size-settings-row) flex-wrap gap-2">
							<Badge variant="accent">PR #{activeBuild.pr}</Badge>
							<span className="min-w-0 flex-1 text-sm leading-5 text-settings-label">
								You are on PR #{activeBuild.pr}'s build.
							</span>
							<Button type="button" variant="outline" size="sm" onClick={() => void handleReturnToHome()}>
								Return to {form.channel === "nightly" ? "Nightly" : "Stable"}
							</Button>
						</div>
						<p className="px-1 text-xs text-settings-muted">
							Automatic updates, if enabled, will return you to your home channel on the next check.
						</p>
					</div>
				)}

				<SettingsRow icon={History} label="Automatic Updates">
					<SettingsOptionMenu
						aria-label="Automatic Updates"
						value={form.enabled ? "on" : "off"}
						options={ENABLED_OPTIONS}
						onChange={(next) => setEnabled(next === "on")}
						disabled={save.isPending}
					/>
				</SettingsRow>

				<SettingsRow icon={HardDriveDownload} label="Updates channel">
					<SettingsOptionMenu
						aria-label="Updates channel"
						value={primaryValue}
						options={CHANNEL_OPTIONS}
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
						<span>
							Nightly builds are cut every day and can be unstable or lose data. Only use Nightly if you are comfortable
							with that.
						</span>
					</p>
				)}

				{save.isError && (
					<p className="px-1 text-xs text-error">{save.error instanceof Error ? save.error.message : "Save failed"}</p>
				)}

				<UpdateActions status={status} />
			</SettingsSection>

			<ConfirmDialog
				open={pendingPin !== null}
				title="Switch feature build?"
				description={
					pendingPin
						? `Switch to PR #${pendingPin.pr}: ${pendingPin.title}? The app will download the feature build and restart.`
						: null
				}
				confirmLabel="Confirm"
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
	const buildsQuery = useQuery({
		queryKey: ["feature-builds"],
		queryFn: () => aoBridge.featureBuilds.list(),
	});

	const builds = buildsQuery.data ?? [];

	if (!buildsQuery.isLoading && builds.length === 0) {
		return (
			<div className="px-1 text-xs text-settings-muted">
				<span className="sr-only">Feature build</span>
				No live feature releases.
			</div>
		);
	}

	const options = builds.map((build) => ({
		value: build.pr.toString(),
		label: `PR #${build.pr}`,
	}));

	return (
		<SettingsRow icon={GitPullRequest} label="Feature build">
			<SettingsOptionMenu
				aria-label="Feature build"
				value={currentPr === null ? "__none__" : currentPr.toString()}
				placeholder="Select a feature build..."
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
								<span className="min-w-0 truncate font-mono text-caption text-passive">{build.buildId}</span>
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
			<SettingsRow icon={Check} label="Checks for Updates">
				<div className="flex items-center gap-2">
					<span className="text-control text-settings-muted" data-testid="app-version">
						Current version - {version.data ? `v${version.data}` : "…"}
					</span>
					<button
						type="button"
						aria-label="Check for updates"
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
							Update to {status.version ? `v${status.version}` : "latest"}
						</Button>
					)}
					{status.state === "downloaded" && (
						<Button type="button" variant="primary" onClick={() => void aoBridge.updates.install()}>
							Restart &amp; install
						</Button>
					)}
					<UpdateStatusLine status={status} />
				</div>
			)}
		</>
	);
}

function UpdateStatusLine({ status }: { status: UpdateStatus }) {
	switch (status.state) {
		case "checking":
			return <span className="text-xs text-settings-muted">Checking for updates…</span>;
		case "available":
			return (
				<span className="text-xs text-settings-muted">
					Update available{status.version ? ` (v${status.version})` : ""}.
				</span>
			);
		case "downloading":
			return <span className="text-xs text-settings-muted">Downloading… {status.percent ?? 0}%</span>;
		case "downloaded":
			return <span className="text-xs text-success">Downloaded. Restart to finish updating.</span>;
		case "not-available":
			return <span className="text-xs text-settings-muted">You're on the latest version.</span>;
		case "unsupported":
			return <span className="text-xs text-settings-muted">{status.message ?? "Updates need the installed app."}</span>;
		case "error":
			return <span className="text-xs text-error">{status.message ?? "Update failed."}</span>;
		default:
			return null;
	}
}
