import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Loader2 } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { apiClient, apiErrorMessage } from "../lib/api-client";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";

export const mobileStatusQueryKey = ["mobile-status"] as const;

interface MobileStatus {
	enabled: boolean;
	host: string;
	port: number;
	password: string;
	warning: string;
}

// pairingPayload is the QR code contents scanned by the mobile app to discover
// the desktop's LAN bridge. It deliberately excludes the password — the QR
// code can be seen by anyone nearby, so the password is only ever shown as
// plaintext in this modal and typed in by hand on the phone.
export function pairingPayload(host: string, port: number): string {
	return JSON.stringify({ v: 1, host, port });
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
// the LAN bridge (issue: mobile phone bridge). It reads the daemon's mobile
// status; when disabled it offers an Enable button, and when enabled it shows
// a QR code (host/port only, no password), the plaintext password with a
// copy affordance, and Regenerate/Disable actions.
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
	const busy = enable.isPending || disable.isPending || regenerate.isPending;

	const copyPassword = async () => {
		if (!status?.password) return;
		await navigator.clipboard.writeText(status.password);
		setCopied(true);
		setTimeout(() => setCopied(false), 1500);
	};

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
				) : status && !status.enabled ? (
					<div className="flex flex-col gap-4">
						<p className="text-[12px] leading-5 text-muted-foreground">
							Enable the mobile bridge to let your phone connect to this desktop while both are on the same network.
						</p>
						{enable.isError && (
							<p className="text-[12px] text-error">
								{enable.error instanceof Error ? enable.error.message : "Failed to enable."}
							</p>
						)}
						<DialogFooter>
							<Button type="button" variant="primary" onClick={() => enable.mutate()} disabled={busy}>
								{enable.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
								Enable
							</Button>
						</DialogFooter>
					</div>
				) : status ? (
					<div className="flex flex-col gap-4">
						<div className="flex justify-center rounded-md bg-white p-4">
							<QRCodeSVG value={pairingPayload(status.host, status.port)} size={200} />
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

						{(disable.isError || regenerate.isError) && (
							<p className="text-[12px] text-error">
								{disable.error instanceof Error
									? disable.error.message
									: regenerate.error instanceof Error
										? regenerate.error.message
										: "Request failed."}
							</p>
						)}

						<DialogFooter className="flex-row justify-between">
							<Button type="button" variant="outline" onClick={() => regenerate.mutate()} disabled={busy}>
								{regenerate.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
								Regenerate password
							</Button>
							<Button
								type="button"
								variant="outline"
								className="border-error text-error hover:bg-error/10"
								onClick={() => disable.mutate()}
								disabled={busy}
							>
								{disable.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
								Disable
							</Button>
						</DialogFooter>
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
