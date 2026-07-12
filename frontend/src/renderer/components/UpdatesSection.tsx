import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { aoBridge } from "../lib/bridge";
import type { FeatureBuild } from "../lib/bridge";
import type { UpdateSettings, UpdateStatus } from "../../main/update-settings";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
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

	useEffect(() => {
		if (query.data) setForm(query.data);
	}, [query.data]);

	const save = useMutation({
		mutationFn: async (next: UpdateSettings) => {
			await aoBridge.updateSettings.set(next);
		},
		onSuccess: () => {
			setSavedAt(Date.now());
			void queryClient.invalidateQueries({ queryKey: updateSettingsQueryKey });
		},
	});

	// Derived primary select value: "feature" when a PR is pinned, else the home channel.
	const primaryValue = form.feature != null ? "feature" : form.channel;

	const setEnabled = (enabled: boolean) => {
		setSavedAt(null);
		setForm((f) => ({ ...f, enabled }));
	};

	const handlePrimaryChannel = (v: string) => {
		setSavedAt(null);
		if (v === "latest") setForm((f) => ({ ...f, channel: "latest", nightlyAck: false, feature: null }));
		else if (v === "nightly") setForm((f) => ({ ...f, channel: "nightly", nightlyAck: true, feature: null }));
		// "feature": just reveal the secondary select; do not touch form.channel
	};

	const handlePinBuild = async (pr: number, title: string) => {
		const confirmed = window.confirm(
			`Switch to PR #${pr}: ${title}?\n\nThe app will download the feature build and restart.`,
		);
		if (!confirmed) return;
		const next = { ...form, feature: { pr } };
		setForm(next);
		await aoBridge.updateSettings.set(next);
		void queryClient.invalidateQueries({ queryKey: updateSettingsQueryKey });
		void aoBridge.updates.check();
	};

	const handleReturnToHome = async () => {
		const next = { ...form, feature: null };
		setForm(next);
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

				<UpdateActions />
			</CardContent>
		</Card>
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

// UpdateActions is the on-demand update control unchanged from before.
function UpdateActions() {
	const [status, setStatus] = useState<UpdateStatus>({ state: "idle" });
	const version = useQuery({ queryKey: ["app-version"], queryFn: () => aoBridge.app.getVersion() });

	useEffect(() => {
		let live = true;
		void aoBridge.updates.getStatus().then((s) => {
			if (live) setStatus(s);
		});
		const off = aoBridge.updates.onStatus(setStatus);
		return () => {
			live = false;
			off?.();
		};
	}, []);

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
