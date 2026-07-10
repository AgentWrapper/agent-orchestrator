import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { aoBridge } from "../lib/bridge";
import type { UpdateChannel, UpdateSettings, UpdateStatus } from "../../main/update-settings";
import { Button } from "./ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { Label } from "./ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { useTranslation } from "react-i18next";

export const updateSettingsQueryKey = ["update-settings"] as const;


// UpdatesSection is the Global Settings card for the desktop auto-update channel
// (issue #2207). It reads/writes ~/.ao/update-settings.json via the main process
// (the same file auto-updater.ts consumes), letting a user pick Stable vs Nightly.
// Changes apply on the next launch / update check.
export function UpdatesSection() {
	const { t } = useTranslation();
	const CHANNEL_OPTIONS: { value: UpdateChannel; label: string }[] = [
		{ value: "latest", label: t("settings.updates.stable") },
		{ value: "nightly", label:  t("settings.updates.nightly") },
	];
	const queryClient = useQueryClient();
	const query = useQuery({
		queryKey: updateSettingsQueryKey,
		queryFn: () => aoBridge.updateSettings.get(),
	});

	const [form, setForm] = useState<UpdateSettings>({ enabled: false, channel: "latest", nightlyAck: false });
	const [savedAt, setSavedAt] = useState<number | null>(null);

	// Seed the form once settings load (and on refetch). Keying off the loaded
	// value keeps local edits responsive without a controlled-from-query loop.
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

	const setEnabled = (enabled: boolean) => {
		setSavedAt(null);
		setForm((f) => ({ ...f, enabled }));
	};
	const setChannel = (channel: UpdateChannel) => {
		setSavedAt(null);
		// Selecting Nightly in Settings is itself the acknowledgement of the
		// instability warning shown below; Stable clears it.
		setForm((f) => ({ ...f, channel, nightlyAck: channel === "nightly" }));
	};

	return (
		<Card>
			<CardHeader>
				<CardTitle className="text-control">{t("settings.updates.title")}</CardTitle>
			</CardHeader>
			<CardContent className="flex flex-col gap-4">
				<div className="flex flex-col gap-1.5">
					<Label htmlFor="updatesEnabled" className="text-xs text-muted-foreground">
						{t("settings.updates.automaticUpdates")}
					</Label>
					<EnabledSelect id="updatesEnabled" value={form.enabled} onChange={setEnabled} />
				</div>

				<div className="flex flex-col gap-1.5">
					<Label htmlFor="updateChannel" className="text-xs text-muted-foreground">
						{t("settings.updates.updateChannel")}
					</Label>
					<Select value={form.channel} onValueChange={(v) => setChannel(v as UpdateChannel)} disabled={!form.enabled}>
						<SelectTrigger id="updateChannel" className="h-control-form w-full text-control">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{CHANNEL_OPTIONS.map((opt) => (
								<SelectItem key={opt.value} value={opt.value}>
									{opt.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>

				{form.channel === "nightly" && form.enabled && (
					<p className="text-xs leading-row text-warning">
						{t("settings.updates.nightlyWarning")}
					</p>
				)}

				<div className="flex items-center gap-3">
					<Button type="button" variant="primary" onClick={() => save.mutate(form)} disabled={save.isPending}>
						{save.isPending? t("settings.updates.saving") : t("settings.updates.saveChanges")}
					</Button>
					{save.isError && (
						<span className="text-xs text-error">
							{save.error instanceof Error ? save.error.message : t("settings.updates.saveFailed")}
						</span>
					)}
					{savedAt && !save.isPending && !save.isError && <span className="text-xs text-success">{t("settings.updates.saved")}</span>}
				</div>

				<UpdateActions />
			</CardContent>
		</Card>
	);
}

// UpdateActions is the on-demand update control: a Check for updates button plus
// an Update button that downloads then installs. It works even when automatic
// updates are off, so users who never opted in can still pull the latest build.
function UpdateActions() {
	const [status, setStatus] = useState<UpdateStatus>({ state: "idle" });
	const version = useQuery({ queryKey: ["app-version"], queryFn: () => aoBridge.app.getVersion() });
	const { t } = useTranslation();

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
				<span className="text-passive">{t("settings.updates.currentVersion")}</span>
				<span className="font-mono text-caption text-foreground">{version.data ? `v${version.data}` : "…"}</span>
			</div>
			<div className="flex items-center gap-3">
				<Button type="button" variant="outline" onClick={() => void aoBridge.updates.check()} disabled={busy}>
					{checking && <Loader2 className="mr-2 size-icon-base animate-spin" />}
					{t("settings.updates.checkForUpdates")}
				</Button>

				{status.state === "available" && (
					<Button type="button" variant="primary" onClick={() => void aoBridge.updates.download()}>
						{status.version? t("settings.updates.updateTo", {version: `v${status.version}`}) : t("settings.updates.updateLatest")}
					</Button>
				)}
				{status.state === "downloaded" && (
					<Button type="button" variant="primary" onClick={() => void aoBridge.updates.install()}>
						{t("settings.updates.restartInstall")}
					</Button>
				)}

				<UpdateStatusLine status={status} />
			</div>
		</div>
	);
}

function UpdateStatusLine({ status }: { status: UpdateStatus }) {
	const { t } = useTranslation();
	switch (status.state) {
		case "checking":
			return <span className="text-xs text-muted-foreground">{t("settings.updates.checking")}</span>;
		case "available":
			return (
				<span className="text-xs text-muted-foreground">
					{t("settings.updates.updateAvailable", { version: status.version ? ` (v${status.version})` : "" })}
				</span>
			);
		case "downloading":
			return <span className="text-xs text-muted-foreground">{t("settings.updates.downloading", {percent: status.percent ?? 0})}</span>;
		case "downloaded":
			return <span className="text-xs text-success">{t("settings.updates.downloaded")}</span>;
		case "not-available":
			return <span className="text-xs text-muted-foreground">{t("settings.updates.latestVersion")}</span>;
		case "unsupported":
			return <span className="text-xs text-passive">{status.message ?? t("settings.updates.unsupported")}</span>;
		case "error":
			return <span className="text-xs text-error">{status.message ?? t("settings.updates.updateFailed")}</span>;
		default:
			return null;
	}
}

function EnabledSelect({ id, value, onChange }: { id: string; value: boolean; onChange: (value: boolean) => void }) {
	const { t } = useTranslation();
	return (
		<Select value={value ? "on" : "off"} onValueChange={(v) => onChange(v === "on")}>
			<SelectTrigger id={id} className="h-control-form w-full text-control">
				<SelectValue />
			</SelectTrigger>
			<SelectContent>
				<SelectItem value="on">{t("settings.updates.enabled")}</SelectItem>
				<SelectItem value="off">{t("settings.updates.disabled")}</SelectItem>
			</SelectContent>
		</Select>
	);
}