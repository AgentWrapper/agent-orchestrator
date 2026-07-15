import { useEffect, useId, useState, type FormEvent } from "react";
import { Eye, EyeOff, Loader2 } from "lucide-react";
import type { DaemonStatus } from "../../shared/daemon-status";
import { aoBridge } from "../lib/bridge";
import { Button } from "./ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

type FormProps = {
	actionLabel: string;
	onConnected?: (status: DaemonStatus) => void;
};

function ConnectionForm({ actionLabel, onConnected }: FormProps) {
	const id = useId();
	const [host, setHost] = useState("");
	const [port, setPort] = useState("3011");
	const [password, setPassword] = useState("");
	const [showPassword, setShowPassword] = useState(false);
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [saved, setSaved] = useState(false);

	useEffect(() => {
		let active = true;
		void aoBridge.remoteServer
			.get()
			.then((config) => {
				if (!active || !config) return;
				setHost(config.host);
				setPort(String(config.port));
				setPassword(config.password);
			})
			.catch((cause) => {
				if (active) setError(cause instanceof Error ? cause.message : "Could not load server settings.");
			})
			.finally(() => {
				if (active) setLoading(false);
			});
		return () => {
			active = false;
		};
	}, []);

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		setSaving(true);
		setSaved(false);
		setError(null);
		try {
			const status = await aoBridge.remoteServer.save({ host, port: Number(port), password });
			if (status.state !== "ready") {
				setError(status.message || "Could not connect to the AO server.");
				return;
			}
			setSaved(true);
			onConnected?.(status);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Could not connect to the AO server.");
		} finally {
			setSaving(false);
		}
	};

	if (loading) {
		return <Loader2 aria-label="Loading server settings" className="h-4 w-4 animate-spin text-muted-foreground" />;
	}

	return (
		<form className="flex flex-col gap-4" onSubmit={(event) => void submit(event)}>
			<div className="grid grid-cols-[minmax(0,1fr)_7rem] gap-3">
				<div className="flex min-w-0 flex-col gap-1.5">
					<Label htmlFor={`${id}-host`} className="text-xs text-muted-foreground">
						Server IP or hostname
					</Label>
					<Input id={`${id}-host`} value={host} onChange={(event) => setHost(event.target.value)} required autoFocus />
				</div>
				<div className="flex flex-col gap-1.5">
					<Label htmlFor={`${id}-port`} className="text-xs text-muted-foreground">
						Port
					</Label>
					<Input
						id={`${id}-port`}
						type="number"
						min={1}
						max={65535}
						value={port}
						onChange={(event) => setPort(event.target.value)}
						required
					/>
				</div>
			</div>
			<div className="flex flex-col gap-1.5">
				<Label htmlFor={`${id}-password`} className="text-xs text-muted-foreground">
					Connection password
				</Label>
				<div className="relative">
					<Input
						id={`${id}-password`}
						className="pr-10"
						type={showPassword ? "text" : "password"}
						value={password}
						onChange={(event) => setPassword(event.target.value)}
						autoComplete="new-password"
						required
					/>
					<Button
						type="button"
						variant="ghost"
						size="icon-sm"
						className="absolute right-1 top-1/2 -translate-y-1/2"
						aria-label={showPassword ? "Hide password" : "Show password"}
						title={showPassword ? "Hide password" : "Show password"}
						onClick={() => setShowPassword((visible) => !visible)}
					>
						{showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
					</Button>
				</div>
			</div>
			<div className="flex min-h-8 items-center gap-3">
				<Button type="submit" variant="primary" disabled={saving}>
					{saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
					{actionLabel}
				</Button>
				{error && <span className="text-xs text-error">{error}</span>}
				{saved && !error && <span className="text-xs text-success">Saved.</span>}
			</div>
		</form>
	);
}

export function RemoteServerDialog({
	open,
	onConnected,
}: {
	open: boolean;
	onConnected?: (status: DaemonStatus) => void;
}) {
	const [remote, setRemote] = useState(false);
	useEffect(() => {
		void aoBridge.remoteServer.isRemoteClient().then(setRemote);
	}, []);
	if (!remote) return null;
	return (
		<Dialog open={open}>
			<DialogContent
				className="max-w-md"
				showCloseButton={false}
				onEscapeKeyDown={(event) => event.preventDefault()}
				onPointerDownOutside={(event) => event.preventDefault()}
			>
				<DialogHeader>
					<DialogTitle className="text-[15px]">Connect to AO server</DialogTitle>
				</DialogHeader>
				<ConnectionForm actionLabel="Connect" onConnected={onConnected} />
			</DialogContent>
		</Dialog>
	);
}

export function RemoteServerSettingsSection() {
	const [remote, setRemote] = useState<boolean | null>(null);
	useEffect(() => {
		void aoBridge.remoteServer.isRemoteClient().then(setRemote);
	}, []);
	if (remote !== true) return null;
	return (
		<Card>
			<CardHeader>
				<CardTitle className="text-control">Remote server</CardTitle>
			</CardHeader>
			<CardContent>
				<ConnectionForm actionLabel="Save connection" />
			</CardContent>
		</Card>
	);
}
