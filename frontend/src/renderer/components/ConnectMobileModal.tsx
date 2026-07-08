import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Loader2 } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
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
	if (error || !data) throw new Error(apiErrorMessage(error));
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
	const queryClient = useQueryClient();
	const [copied, setCopied] = useState(false);

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
			if (error) throw new Error(apiErrorMessage(error));
			return data;
		},
		onSuccess: invalidate,
	});

	const disable = useMutation({
		mutationFn: async () => {
			const { data, error } = await apiClient.POST("/api/v1/mobile/disable");
			if (error) throw new Error(apiErrorMessage(error));
			return data;
		},
		onSuccess: invalidate,
	});

	const regenerate = useMutation({
		mutationFn: async () => {
			const { data, error } = await apiClient.POST("/api/v1/mobile/regenerate");
			if (error) throw new Error(apiErrorMessage(error));
			return data;
		},
		onSuccess: invalidate,
	});

	const status = query.data;
	const enabled = status?.enabled ?? false;
	const busy = enable.isPending || disable.isPending || regenerate.isPending;

	const copyPassword = async () => {
		if (!status?.password) return;
		await navigator.clipboard.writeText(status.password);
		setCopied(true);
		setTimeout(() => setCopied(false), 1500);
	};

	const onToggle = (next: boolean) => {
		if (busy) return;
		if (next) enable.mutate();
		else disable.mutate();
	};

	const actionError =
		(enable.error instanceof Error && enable.error.message) ||
		(disable.error instanceof Error && disable.error.message) ||
		(regenerate.error instanceof Error && regenerate.error.message) ||
		null;

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-md">
				<DialogHeader>
					<DialogTitle className="text-[15px]">Connect Mobile</DialogTitle>
					<DialogDescription>Pair the Agent Orchestrator mobile app with this desktop over your LAN.</DialogDescription>
				</DialogHeader>

				{query.isLoading ? (
					<p className="text-[12px] text-muted-foreground">Checking status…</p>
				) : query.isError ? (
					<p className="text-[12px] text-error">
						{query.error instanceof Error ? query.error.message : "Failed to load mobile status."}
					</p>
				) : status ? (
					<div className="flex flex-col gap-4">
						{/* Toggle row — always visible. Flipping it starts/stops the bridge. */}
						<div className="flex items-center justify-between gap-4 rounded-md border border-border bg-surface/40 p-3">
							<div className="flex min-w-0 flex-col">
								<span className="text-[13px] text-foreground">Enable mobile</span>
								<span className="text-[12px] leading-5 text-muted-foreground">
									Open a password-protected port on your local network so your phone can connect.
								</span>
							</div>
							<div className="flex shrink-0 items-center gap-2">
								{busy && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
								<Switch checked={enabled} onCheckedChange={onToggle} disabled={busy} aria-label="Enable mobile" />
							</div>
						</div>

						{actionError && <p className="text-[12px] text-error">{actionError}</p>}

						{/* Pairing details — revealed below the toggle only when enabled. */}
						{enabled && (
							<div className="flex flex-col gap-4">
								<div className="flex justify-center rounded-md bg-white p-4">
									<QRCodeSVG value={pairingPayload(status.host, status.port, status.password)} size={200} />
								</div>

								<div className="flex flex-col gap-2 text-[12px]">
									<Row label="Address">
										<span className="font-mono text-[11px] text-foreground">
											{status.host}:{status.port}
										</span>
									</Row>
									<Row label="Password">
										<div className="flex min-w-0 flex-1 items-center gap-2">
											<span className="truncate font-mono text-[11px] text-foreground">{status.password}</span>
											<Button type="button" variant="outline" size="sm" onClick={() => void copyPassword()}>
												{copied ? "Copied" : "Copy"}
											</Button>
										</div>
									</Row>
								</div>

								{status.warning && (
									<p className="rounded-md border border-warning/40 bg-warning/10 p-3 text-[12px] leading-5 text-warning">
										{status.warning}
									</p>
								)}

								<div>
									<Button type="button" variant="outline" onClick={() => regenerate.mutate()} disabled={busy}>
										{regenerate.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
										Regenerate password
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
