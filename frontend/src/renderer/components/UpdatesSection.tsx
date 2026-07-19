import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { aoBridge } from "../lib/bridge";
import type { FeatureBuild } from "../lib/bridge";
import { useUpdateStatus } from "../hooks/useUpdateStatus";
import type { UpdateSettings, UpdateState, UpdateStatus } from "../../main/update-settings";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { ConfirmDialog } from "./ConfirmDialog";
import { Label } from "./ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Skeleton } from "./ui/skeleton";

export const updateSettingsQueryKey = ["update-settings"] as const;

// relativeAge converts an ISO timestamp to a short human-readable relative string.
function relativeAge(iso: string): string {
	const diffMs = Date.now() - new Date(iso).getTime();
	const mins = Math.floor(diffMs / 60000);
	if (mins < 1) return "just now";
	if (mins < 60) return `${mins}m ago`;
	const hours = Math.floor(mins / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	return `${days}d ago`;
}

const STALE_THRESHOLD_MS = 5 * 24 * 60 * 60 * 1000; // 5 days

// UpdatesSection is the Global Settings card for the desktop auto-update channel.
// It supports three modes: Stable, Nightly, and Feature Releases (pinned PR build).
// `channel` in UpdateSettings is always the home channel (latest or nightly); the
// `feature` field is a separate overlay that pins a specific PR build.
export function UpdatesSection() {
	const queryClient = useQueryClient();
	const query = useQuery({
		queryKey: updateSettingsQueryKey,
		queryFn: () => aoBridge.updateSettings.get(),
	});

	const [form, setForm] = useState<UpdateSettings>({
		enabled: false,
		channel: "latest",
		nightlyAck: false,
		feature: null,
	});
	const [savedAt, setSavedAt] = useState<number | null>(null);
	// Reveals the feature-build picker when the user selects "Feature Releases"
	// but has not pinned a build yet (form.feature is still null). Without this,
	// the controlled select would snap back to the home channel and the picker
	// could never be opened from a clean state.
	const [showFeature, setShowFeature] = useState(false);
	// Pending confirmation for pinning a feature build (replaces window.confirm).
	const [pendingPin, setPendingPin] = useState<{ pr: number; title: string } | null>(null);

	// Live update status, shared with UpdateActions below so there is a single
	// updates:status subscription for the whole card.
	const status = useUpdateStatus();
	// Set only right after the user pins a build or returns to their home channel,
	// so the check() that follows is allowed to auto-progress through download and
	// install. A normal manual "Check for updates" click never sets this, so it
	// stops at "available"/"downloaded" for the user to act on.
	const autoProgressRef = useRef(false);
	// Last status.state this effect already reacted to, so a status object that is
	// re-delivered with the same state doesn't re-trigger download()/install().
	const handledStatusRef = useRef<UpdateState | null>(null);

	useEffect(() => {
		if (query.data) setForm(query.data);
	}, [query.data]);

	useEffect(() => {
		if (!autoProgressRef.current) return;
		if (handledStatusRef.current === status.state) return;
		handledStatusRef.current = status.state;
		if (status.state === "available") {
			void aoBridge.updates.download();
		} else if (status.state === "downloaded") {
			void aoBridge.updates.install();
			autoProgressRef.current = false;
		} else if (status.state === "error" || status.state === "unsupported" || status.state === "not-available") {
			// Dev/unsupported build, or nothing to update: stop rather than loop.
			autoProgressRef.current = false;
		}
	}, [status]);

	const save = useMutation({
		mutationFn: async (next: UpdateSettings) => {
			await aoBridge.updateSettings.set(next);
		},
		onSuccess: () => {
			setSavedAt(Date.now());
			void queryClient.invalidateQueries({ queryKey: updateSettingsQueryKey });
		},
	});

	// Derived primary select value: "feature" when a PR is pinned OR the user has
	// chosen Feature Releases (showFeature) but not pinned yet; else the home channel.
	const primaryValue = form.feature != null || showFeature ? "feature" : form.channel;

	const setEnabled = (enabled: boolean) => {
		setSavedAt(null);
		setForm((f) => ({ ...f, enabled }));
	};

	const handlePrimaryChannel = (v: string) => {
		setSavedAt(null);
		if (v === "latest") {
			setShowFeature(false);
			setForm((f) => ({ ...f, channel: "latest", nightlyAck: false, feature: null }));
		} else if (v === "nightly") {
			setShowFeature(false);
			setForm((f) => ({ ...f, channel: "nightly", nightlyAck: true, feature: null }));
		} else if (v === "feature") {
			// Reveal the secondary picker; the pin is only written once the user
			// selects a specific build (handlePinBuild). Home channel is untouched.
			setShowFeature(true);
		}
	};

	// Opens the confirmation dialog; the actual pin happens in confirmPinBuild.
	const handlePinBuild = async (pr: number, title: string) => {
		setPendingPin({ pr, title });
	};

	const confirmPinBuild = async () => {
		if (!pendingPin) return;
		const { pr } = pendingPin;
		setPendingPin(null);
		const next = { ...form, feature: { pr } };
		setForm(next);
		autoProgressRef.current = true;
		handledStatusRef.current = null;
		await aoBridge.updateSettings.set(next);
		void queryClient.invalidateQueries({ queryKey: updateSettingsQueryKey });
		void aoBridge.updates.check();
	};

	const handleReturnToHome = async () => {
		setShowFeature(false);
		const next = { ...form, feature: null };
		setForm(next);
		autoProgressRef.current = true;
		handledStatusRef.current = null;
		await aoBridge.updateSettings.set(next);
		void queryClient.invalidateQueries({ queryKey: updateSettingsQueryKey });
		void aoBridge.updates.check();
	};

	const activeQuery = useQuery({
		queryKey: ["feature-active"],
		queryFn: () => aoBridge.featureBuilds.getActive(),
	});
	const activeBuild = activeQuery.data ?? null;

	return (
		<>
			<Card>
				<CardHeader>
					<CardTitle className="text-control">Updates</CardTitle>
				</CardHeader>
				<CardContent className="flex flex-col gap-4">
					{activeBuild && (
						<>
							<div className="flex items-center gap-2 rounded-md border border-border bg-surface px-3 py-2 text-xs">
								<Badge variant="accent">PR #{activeBuild.pr}</Badge>
								<span className="flex-1 text-foreground">You are on PR #{activeBuild.pr}'s build.</span>
								<Button type="button" variant="outline" size="sm" onClick={() => void handleReturnToHome()}>
									Return to {form.channel === "nightly" ? "Nightly" : "Stable"}
								</Button>
							</div>
							<p className="text-xs text-muted-foreground">
								Automatic updates, if enabled, will return you to your home channel on the next check.
							</p>
						</>
					)}

					<div className="flex flex-col gap-1.5">
						<Label htmlFor="updatesEnabled" className="text-xs text-muted-foreground">
							Automatic updates
						</Label>
						<EnabledSelect id="updatesEnabled" value={form.enabled} onChange={setEnabled} />
					</div>

					<div className="flex flex-col gap-1.5">
						<Label htmlFor="updateChannel" className="text-xs text-muted-foreground">
							Update channel
						</Label>
						<Select value={primaryValue} onValueChange={handlePrimaryChannel} disabled={!form.enabled}>
							<SelectTrigger id="updateChannel" className="h-control-form w-full text-control">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="latest">Stable (latest release)</SelectItem>
								<SelectItem value="nightly">Nightly (pre-release)</SelectItem>
								<SelectItem value="feature">Feature Releases</SelectItem>
							</SelectContent>
						</Select>
					</div>

					{primaryValue === "feature" && (
						<FeatureBuildsSelect currentPr={form.feature?.pr ?? null} onPin={handlePinBuild} />
					)}

					{form.channel === "nightly" && form.feature === null && form.enabled && (
						<p className="text-xs leading-row text-warning">
							Nightly builds are cut every day and can be unstable or lose data. Only use Nightly if you are comfortable
							with that.
						</p>
					)}

					<div className="flex items-center gap-3">
						<Button type="button" variant="primary" onClick={() => save.mutate(form)} disabled={save.isPending}>
							{save.isPending ? "Saving..." : "Save changes"}
						</Button>
						{save.isError && (
							<span className="text-xs text-error">
								{save.error instanceof Error ? save.error.message : "Save failed"}
							</span>
						)}
						{savedAt && !save.isPending && !save.isError && <span className="text-xs text-success">Saved.</span>}
					</div>

					<UpdateActions status={status} />
				</CardContent>
			</Card>
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

// FeatureBuildsSelect renders the secondary PR-build picker, shown when "Feature Releases"
// is the active primary channel value. It fetches the list of live feature builds and
// lets the user pick one to pin.
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

	if (buildsQuery.isLoading) {
		return (
			<div className="flex flex-col gap-1.5">
				<Label className="text-xs text-muted-foreground">Feature build</Label>
				<div className="flex flex-col gap-1">
					<Skeleton className="h-control-form w-full" />
					<Skeleton className="h-control-form w-full" />
				</div>
			</div>
		);
	}

	const builds = buildsQuery.data ?? [];

	if (builds.length === 0) {
		return (
			<div className="flex flex-col gap-1.5">
				<Label className="text-xs text-muted-foreground">Feature build</Label>
				<p className="text-xs text-muted-foreground">No live feature releases.</p>
			</div>
		);
	}

	const handleChange = (v: string) => {
		const pr = parseInt(v, 10);
		const build = builds.find((b) => b.pr === pr);
		if (!build) return;
		void onPin(build.pr, build.title);
	};

	return (
		<div className="flex flex-col gap-1.5">
			<Label htmlFor="featureBuild" className="text-xs text-muted-foreground">
				Feature build
			</Label>
			<Select value={currentPr != null ? String(currentPr) : ""} onValueChange={handleChange}>
				<SelectTrigger id="featureBuild" className="h-control-form w-full text-control">
					<SelectValue placeholder="Select a feature build..." />
				</SelectTrigger>
				<SelectContent>
					{builds.map((b) => (
						<FeatureBuildItem key={b.pr} build={b} />
					))}
				</SelectContent>
			</Select>
		</div>
	);
}

function FeatureBuildItem({ build }: { build: FeatureBuild }) {
	const ageMs = Date.now() - new Date(build.publishedAt).getTime();
	const isStale = ageMs > STALE_THRESHOLD_MS;
	const ageLabel = relativeAge(build.publishedAt);

	return (
		<SelectItem value={String(build.pr)}>
			<div className="flex flex-col gap-0.5">
				<span>
					PR #{build.pr}: {build.title}
				</span>
				<div className="flex items-center gap-1.5">
					<span className="font-mono text-caption text-passive">{build.buildId}</span>
					<Badge variant={isStale ? "warning" : "neutral"}>{ageLabel}</Badge>
				</div>
			</div>
		</SelectItem>
	);
}

// UpdateActions is the on-demand update control. `status` is passed down from
// UpdatesSection so the card has a single updates:status subscription shared
// between this manual control and the pin/return-home auto-progress effect.
function UpdateActions({ status }: { status: UpdateStatus }) {
	const version = useQuery({ queryKey: ["app-version"], queryFn: () => aoBridge.app.getVersion() });

	const checking = status.state === "checking";
	const downloading = status.state === "downloading";
	const busy = checking || downloading;

	return (
		<div className="flex flex-col gap-3 border-t border-border pt-4">
			<div className="flex items-center gap-2 text-xs">
				<span className="text-passive">Current version</span>
				<span className="font-mono text-caption text-foreground">{version.data ? `v${version.data}` : "..."}</span>
			</div>
			<div className="flex items-center gap-3">
				<Button type="button" variant="outline" onClick={() => void aoBridge.updates.check()} disabled={busy}>
					{checking && <Loader2 className="mr-2 size-icon-base animate-spin" />}
					Check for updates
				</Button>

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
		</div>
	);
}

function UpdateStatusLine({ status }: { status: UpdateStatus }) {
	switch (status.state) {
		case "checking":
			return <span className="text-xs text-muted-foreground">Checking for updates...</span>;
		case "available":
			return (
				<span className="text-xs text-muted-foreground">
					Update available{status.version ? ` (v${status.version})` : ""}.
				</span>
			);
		case "downloading":
			return <span className="text-xs text-muted-foreground">Downloading... {status.percent ?? 0}%</span>;
		case "downloaded":
			return <span className="text-xs text-success">Downloaded. Restart to finish updating.</span>;
		case "not-available":
			return <span className="text-xs text-muted-foreground">You're on the latest version.</span>;
		case "unsupported":
			return <span className="text-xs text-passive">{status.message ?? "Updates need the installed app."}</span>;
		case "error":
			return <span className="text-xs text-error">{status.message ?? "Update failed."}</span>;
		default:
			return null;
	}
}

function EnabledSelect({ id, value, onChange }: { id: string; value: boolean; onChange: (value: boolean) => void }) {
	return (
		<Select value={value ? "on" : "off"} onValueChange={(v) => onChange(v === "on")}>
			<SelectTrigger id={id} className="h-control-form w-full text-control">
				<SelectValue />
			</SelectTrigger>
			<SelectContent>
				<SelectItem value="on">Enabled</SelectItem>
				<SelectItem value="off">Disabled</SelectItem>
			</SelectContent>
		</Select>
	);
}
