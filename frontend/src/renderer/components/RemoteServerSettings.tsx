import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Eye, EyeOff, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { safeDaemonStatusDetail, type DaemonStatus } from "../../shared/daemon-status";
import { aoBridge } from "../lib/bridge";
import { daemonStatusMessage } from "../lib/daemon-status";
import { Button } from "./ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

type FormProps = {
	action: "connect" | "save";
	onConnected?: (status: DaemonStatus) => void;
};

type ConnectionError =
	| { kind: "load" | "reveal"; cause?: unknown }
	| { kind: "connect"; status?: DaemonStatus; cause?: unknown };

function ConnectionForm({ action, onConnected }: FormProps) {
	const { t } = useTranslation();
	const id = useId();
	const [host, setHost] = useState("");
	const [port, setPort] = useState("3011");
	const [password, setPassword] = useState("");
	const [passwordConfigured, setPasswordConfigured] = useState(false);
	const [passwordEdited, setPasswordEdited] = useState(false);
	const [revealedSavedPassword, setRevealedSavedPassword] = useState(false);
	const [showPassword, setShowPassword] = useState(false);
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<ConnectionError | null>(null);
	const [saved, setSaved] = useState(false);
	const mounted = useRef(true);
	const passwordRef = useRef("");
	const revealGeneration = useRef(0);

	const updatePassword = (value: string) => {
		passwordRef.current = value;
		setPassword(value);
	};

	useEffect(() => {
		let active = true;
		mounted.current = true;
		void aoBridge.remoteServer
			.get()
			.then((config) => {
				if (!active || !config) return;
				setHost(config.host);
				setPort(String(config.port));
				setPasswordConfigured(config.passwordConfigured);
			})
			.catch((cause) => {
				if (active) {
					setError({ kind: "load", cause });
				}
			})
			.finally(() => {
				if (active) setLoading(false);
			});
		return () => {
			active = false;
			mounted.current = false;
			revealGeneration.current += 1;
			passwordRef.current = "";
		};
	}, []);

	const togglePasswordVisibility = async () => {
		setError(null);
		if (showPassword) {
			revealGeneration.current += 1;
			if (revealedSavedPassword && !passwordEdited) updatePassword("");
			setRevealedSavedPassword(false);
			setShowPassword(false);
			return;
		}
		if (!password && passwordConfigured && !passwordEdited) {
			const generation = revealGeneration.current + 1;
			revealGeneration.current = generation;
			setShowPassword(true);
			let revealed: string | null;
			try {
				revealed = await aoBridge.remoteServer.revealPassword();
			} catch (cause) {
				if (!mounted.current || generation !== revealGeneration.current) return;
				revealGeneration.current += 1;
				updatePassword("");
				setRevealedSavedPassword(false);
				setShowPassword(false);
				setError({ kind: "reveal", cause });
				return;
			}
			if (!mounted.current || generation !== revealGeneration.current) return;
			if (revealed === null) {
				setShowPassword(false);
				return;
			}
			updatePassword(revealed);
			setRevealedSavedPassword(true);
			return;
		}
		setShowPassword(true);
	};

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		setSaving(true);
		setSaved(false);
		setError(null);
		revealGeneration.current += 1;
		setShowPassword(false);
		const input = {
			host,
			port: Number(port),
			...(passwordEdited ? { password } : {}),
		};
		if (revealedSavedPassword && !passwordEdited) {
			updatePassword("");
			setRevealedSavedPassword(false);
			setShowPassword(false);
		}
		try {
			const status = await aoBridge.remoteServer.save(input);
			if (status.state !== "ready") {
				setError({ kind: "connect", status });
				return;
			}
			if (passwordEdited) {
				updatePassword("");
				setPasswordEdited(false);
				setPasswordConfigured(true);
				setShowPassword(false);
			}
			setSaved(true);
			onConnected?.(status);
		} catch (cause) {
			setError({ kind: "connect", cause });
		} finally {
			setSaving(false);
		}
	};

	const errorMessage = (() => {
		if (!error) return "";
		const fallback = t(
			error.kind === "load"
				? "remoteServer.errors.load"
				: error.kind === "reveal"
					? "remoteServer.errors.reveal"
					: "remoteServer.errors.connect",
		);
		if (error.kind === "connect") {
			if (error.status) return daemonStatusMessage(error.status, t, fallback);
			return daemonStatusMessage(
				{
					state: "error",
					code: "daemon_unreachable",
					...(error.cause instanceof Error ? { message: error.cause.message } : {}),
				},
				t,
				fallback,
			);
		}
		const detail = safeDaemonStatusDetail(error.cause);
		return detail ? t("daemonStatus.withDetail", { summary: fallback, detail }) : fallback;
	})();

	if (loading) {
		return <Loader2 aria-label={t("remoteServer.loading")} className="h-4 w-4 animate-spin text-muted-foreground" />;
	}

	return (
		<form className="flex flex-col gap-4" onSubmit={(event) => void submit(event)}>
			<div className="grid grid-cols-[minmax(0,1fr)_7rem] gap-3">
				<div className="flex min-w-0 flex-col gap-1.5">
					<Label htmlFor={`${id}-host`} className="text-xs text-muted-foreground">
						{t("remoteServer.host")}
					</Label>
					<Input id={`${id}-host`} value={host} onChange={(event) => setHost(event.target.value)} required autoFocus />
				</div>
				<div className="flex flex-col gap-1.5">
					<Label htmlFor={`${id}-port`} className="text-xs text-muted-foreground">
						{t("remoteServer.port")}
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
					{t("remoteServer.password")}
				</Label>
				<div className="relative">
					<Input
						id={`${id}-password`}
						className="pr-10"
						type={showPassword ? "text" : "password"}
						value={password}
						placeholder={passwordConfigured && !password ? "********" : undefined}
						onChange={(event) => {
							revealGeneration.current += 1;
							updatePassword(event.target.value);
							setPasswordEdited(true);
							setRevealedSavedPassword(false);
						}}
						autoComplete="new-password"
						required={!passwordConfigured}
					/>
					<Button
						type="button"
						variant="ghost"
						size="icon-sm"
						className="absolute right-1 top-1/2 -translate-y-1/2"
						aria-label={t(showPassword ? "remoteServer.hidePassword" : "remoteServer.showPassword")}
						title={t(showPassword ? "remoteServer.hidePassword" : "remoteServer.showPassword")}
						onClick={() => void togglePasswordVisibility()}
					>
						{showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
					</Button>
				</div>
			</div>
			<div className="flex min-h-8 items-center gap-3">
				<Button type="submit" variant="primary" disabled={saving}>
					{saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
					{t(action === "connect" ? "remoteServer.connect" : "remoteServer.save")}
				</Button>
				{error && <span className="text-xs text-error">{errorMessage}</span>}
				{saved && !error && <span className="text-xs text-success">{t("remoteServer.saved")}</span>}
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
	const { t } = useTranslation();
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
					<DialogTitle className="text-[15px]">{t("remoteServer.dialogTitle")}</DialogTitle>
				</DialogHeader>
				<ConnectionForm action="connect" onConnected={onConnected} />
			</DialogContent>
		</Dialog>
	);
}

export function RemoteServerSettingsSection() {
	const { t } = useTranslation();
	const [remote, setRemote] = useState<boolean | null>(null);
	useEffect(() => {
		void aoBridge.remoteServer.isRemoteClient().then(setRemote);
	}, []);
	if (remote !== true) return null;
	return (
		<Card>
			<CardHeader>
				<CardTitle className="text-control">{t("remoteServer.title")}</CardTitle>
			</CardHeader>
			<CardContent>
				<ConnectionForm action="save" />
			</CardContent>
		</Card>
	);
}
