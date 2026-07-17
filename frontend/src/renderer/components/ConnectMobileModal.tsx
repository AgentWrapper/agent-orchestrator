import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useTranslation } from "react-i18next";
import { apiClient, apiErrorMessage } from "../lib/api-client";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";
import { Switch } from "./ui/switch";

export const mobileStatusQueryKey = ["mobile-status"] as const;

interface MobileStatus {
	enabled: boolean;
	host: string;
	port: number;
	password: string;
	warning: string;
}

// pairingPayload is the QR code contents scanned by the mobile app to connect
// to the desktop's LAN bridge. It includes the password so a single scan
// autofills everything and connects with no typing. The bridge is a trusted-
// home-network tool over plaintext HTTP, so a QR that grants access is an
// acceptable trade-off; regenerating the password invalidates any old QR.
export function pairingPayload(host: string, port: number, password: string): string {
	return JSON.stringify({ v: 1, host, port, password });
}

async function fetchMobileStatus(): Promise<MobileStatus> {
	const { data, error } = await apiClient.GET("/api/v1/mobile/status");
	if (error || !data) throw error ?? {};
	return data;
}

interface ConnectMobileModalProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

// ConnectMobileModal lets a user pair the mobile app with this desktop over
// the LAN bridge. A single "Enable mobile" toggle sits at the top; flipping it
// on starts the bridge and reveals the pairing details below the toggle row —
// a QR code (host/port/password), the plaintext address + password with a copy
// affordance, and a Regenerate action. Flipping it off tears the bridge down.
export function ConnectMobileModal({ open, onOpenChange }: ConnectMobileModalProps) {
	const { t } = useTranslation();
	const queryClient = useQueryClient();
	const [copied, setCopied] = useState(false);
	const [copyError, setCopyError] = useState<{ detail?: string } | null>(null);
	const copyTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(
		() => () => {
			if (copyTimeout.current) clearTimeout(copyTimeout.current);
		},
		[],
	);

	const query = useQuery({
		queryKey: mobileStatusQueryKey,
		queryFn: fetchMobileStatus,
		enabled: open,
	});

	const invalidate = () => {
		void queryClient.invalidateQueries({ queryKey: mobileStatusQueryKey });
	};

	const enable = useMutation({
		mutationFn: async () => {
			const { data, error } = await apiClient.POST("/api/v1/mobile/enable");
			if (error) throw error;
			return data;
		},
		onSuccess: invalidate,
	});

	const disable = useMutation({
		mutationFn: async () => {
			const { data, error } = await apiClient.POST("/api/v1/mobile/disable");
			if (error) throw error;
			return data;
		},
		onSuccess: invalidate,
	});

	const regenerate = useMutation({
		mutationFn: async () => {
			const { data, error } = await apiClient.POST("/api/v1/mobile/regenerate");
			if (error) throw error;
			return data;
		},
		onSuccess: invalidate,
	});

	const status = query.data;
	const enabled = status?.enabled ?? false;
	const busy = enable.isPending || disable.isPending || regenerate.isPending;

	const copyPassword = async () => {
		if (!status?.password) return;
		setCopyError(null);
		try {
			await navigator.clipboard.writeText(status.password);
			setCopied(true);
			if (copyTimeout.current) clearTimeout(copyTimeout.current);
			copyTimeout.current = setTimeout(() => {
				copyTimeout.current = null;
				setCopied(false);
			}, 1500);
		} catch (cause) {
			setCopyError({ detail: cause instanceof Error ? cause.message || undefined : undefined });
		}
	};

	const onToggle = (next: boolean) => {
		if (busy) return;
		if (next) enable.mutate();
		else disable.mutate();
	};

	const actionError = enable.error ?? disable.error ?? regenerate.error ?? null;

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-md">
				<DialogHeader>
					<DialogTitle className="text-[15px]">{t("connectMobile.title")}</DialogTitle>
					<DialogDescription>{t("connectMobile.description")}</DialogDescription>
				</DialogHeader>

				{query.isLoading ? (
					<p className="text-[12px] text-muted-foreground">{t("connectMobile.checking")}</p>
				) : query.isError ? (
					<p className="text-[12px] text-error">{apiErrorMessage(query.error, t("connectMobile.errors.load"))}</p>
				) : status ? (
					<div className="flex flex-col gap-4">
						{/* Toggle row — always visible. Flipping it starts/stops the bridge. */}
						<div className="flex items-center justify-between gap-4 rounded-md border border-border bg-surface/40 p-3">
							<div className="flex min-w-0 flex-col">
								<span className="text-[13px] text-foreground">{t("connectMobile.enable.title")}</span>
								<span className="text-[12px] leading-5 text-muted-foreground">
									{t("connectMobile.enable.description")}
								</span>
							</div>
							<div className="flex shrink-0 items-center gap-2">
								{busy && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
								<Switch
									checked={enabled}
									onCheckedChange={onToggle}
									disabled={busy}
									aria-label={t("connectMobile.enable.aria")}
								/>
							</div>
						</div>

						{actionError && (
							<p className="text-[12px] text-error">{apiErrorMessage(actionError, t("connectMobile.errors.action"))}</p>
						)}

						{/* Pairing details — revealed below the toggle only when enabled. */}
						{enabled && (
							<div className="flex flex-col gap-4">
								<div className="flex justify-center rounded-md bg-white p-4">
									<QRCodeSVG value={pairingPayload(status.host, status.port, status.password)} size={200} />
								</div>

								<div className="flex flex-col gap-2 text-[12px]">
									<Row label={t("connectMobile.address")}>
										<span className="font-mono text-[11px] text-foreground">
											{status.host}:{status.port}
										</span>
									</Row>
									<Row label={t("connectMobile.password")}>
										<div className="flex min-w-0 flex-1 items-center gap-2">
											<span className="truncate font-mono text-[11px] text-foreground">{status.password}</span>
											<Button type="button" variant="outline" size="sm" onClick={() => void copyPassword()}>
												{copied ? t("connectMobile.copied") : t("connectMobile.copy")}
											</Button>
										</div>
									</Row>
									{copyError && (
										<p className="text-[12px] text-error">{copyError.detail ?? t("connectMobile.errors.copy")}</p>
									)}
								</div>

								{status.warning && (
									<p className="rounded-md border border-warning/40 bg-warning/10 p-3 text-[12px] leading-5 text-warning">
										{t("connectMobile.warning")}
									</p>
								)}

								<div>
									<Button type="button" variant="outline" onClick={() => regenerate.mutate()} disabled={busy}>
										{regenerate.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
										{t("connectMobile.regenerate")}
									</Button>
								</div>
							</div>
						)}
					</div>
				) : null}
			</DialogContent>
		</Dialog>
	);
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<div className="flex items-center gap-3">
			<span className="w-20 shrink-0 text-passive">{label}</span>
			<span className="min-w-0 flex-1">{children}</span>
		</div>
	);
}
