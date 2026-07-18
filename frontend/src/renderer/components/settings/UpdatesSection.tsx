import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, HardDriveDownload, History, Loader2, RefreshCw } from "lucide-react";
import { aoBridge } from "../../lib/bridge";
import { useUpdateStatus } from "../../hooks/useUpdateStatus";
import type { UpdateChannel, UpdateSettings, UpdateStatus } from "../../../main/update-settings";
import { SettingsOptionMenu } from "./SettingsOptionMenu";
import { SettingsRow } from "./SettingsRow";
import { SettingsSection } from "./SettingsSection";
import { Button } from "../ui/button";

export const updateSettingsQueryKey = ["update-settings"] as const;

const ENABLED_OPTIONS = [
	{ value: "on" as const, label: "Enabled" },
	{ value: "off" as const, label: "Disabled" },
];

const CHANNEL_OPTIONS: { value: UpdateChannel; label: string }[] = [
	{ value: "latest", label: "Stable (Latest)" },
	{ value: "nightly", label: "Nightly (Pre-release)" },
];

const DEFAULT_SETTINGS: UpdateSettings = { enabled: false, channel: "latest", nightlyAck: false };

export function UpdatesSection() {
	const queryClient = useQueryClient();
	const query = useQuery({
		queryKey: updateSettingsQueryKey,
		queryFn: () => aoBridge.updateSettings.get(),
	});

	const [form, setForm] = useState<UpdateSettings>(DEFAULT_SETTINGS);
	const formRef = useRef(form);
	formRef.current = form;

	useEffect(() => {
		if (query.data) setForm(query.data);
	}, [query.data]);

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

	const setEnabled = (enabled: boolean) => {
		const next = { ...formRef.current, enabled };
		setForm(next);
		save.mutate(next);
	};
	const setChannel = (channel: UpdateChannel) => {
		if (!formRef.current.enabled) return;
		const next = { ...formRef.current, channel, nightlyAck: channel === "nightly" };
		setForm(next);
		save.mutate(next);
	};

	return (
		<SettingsSection title="Updates">
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
					value={form.channel}
					options={CHANNEL_OPTIONS}
					onChange={setChannel}
					disabled={!form.enabled || save.isPending}
				/>
			</SettingsRow>

			{form.channel === "nightly" && form.enabled && (
				<p className="flex items-center gap-2 px-1 text-xs leading-row text-warning">
					<AlertTriangle className="size-icon-sm shrink-0" aria-hidden="true" />
					<span>
						Nightly builds are cut every day and can be unstable or lose data. Only use Nightly if you are comfortable
						with that.
					</span>
				</p>
			)}

			{save.isError && (
				<p className="px-1 text-xs text-error">
					{save.error instanceof Error ? save.error.message : "Save failed"}
				</p>
			)}

			<UpdateActions />
		</SettingsSection>
	);
}

function UpdateActions() {
	const status = useUpdateStatus();
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
					<span className="text-control text-settings-muted">
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
				<div className="flex flex-wrap items-center gap-3 px-1">
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
			return <span className="text-xs text-muted-foreground">Checking for updates…</span>;
		case "available":
			return (
				<span className="text-xs text-muted-foreground">
					Update available{status.version ? ` (v${status.version})` : ""}.
				</span>
			);
		case "downloading":
			return <span className="text-xs text-muted-foreground">Downloading… {status.percent ?? 0}%</span>;
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
