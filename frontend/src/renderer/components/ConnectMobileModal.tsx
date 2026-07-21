import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Check, Copy, Info, Loader2, X } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { apiClient, apiErrorMessage } from "../lib/api-client";
import { cn } from "../lib/utils";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";
import { Switch } from "./ui/switch";

export const mobileStatusQueryKey = ["mobile-status"] as const;

/** Matches `--size-settings-mobile-qr-code`; qrcode.react needs a px number. */
const QR_CODE_SIZE = 204;

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
	const copiedTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(() => {
		return () => {
			if (copiedTimeoutRef.current) clearTimeout(copiedTimeoutRef.current);
		};
	}, []);

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

	const clearActionErrors = () => {
		enable.reset();
		disable.reset();
		regenerate.reset();
	};

	const copyPassword = async () => {
		if (!status?.password) return;
		try {
			await navigator.clipboard.writeText(status.password);
			setCopied(true);
			if (copiedTimeoutRef.current) clearTimeout(copiedTimeoutRef.current);
			copiedTimeoutRef.current = setTimeout(() => setCopied(false), 1500);
		} catch {
			// Clipboard can reject (permissions / non-secure context).
		}
	};

	const onToggle = (next: boolean) => {
		if (busy) return;
		clearActionErrors();
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
			<DialogContent
				showCloseButton={false}
				className={cn(
					// Follow the app theme (same tokens as Report a problem) — do not force `dark`.
					// Do not add `relative` (breaks fixed centering).
					"flex w-(--size-settings-mobile-dialog) max-w-(--size-settings-mobile-dialog) flex-col gap-0 overflow-hidden rounded-(--radius-settings-dialog-lg) border border-[var(--color-border-settings-dialog)] bg-settings-dialog p-0 sm:rounded-(--radius-settings-dialog-lg)",
					"shadow-[var(--shadow-settings-dialog)]",
					"outline-none ring-0 focus:outline-none focus:ring-0 focus-visible:outline-none focus-visible:ring-0",
				)}
			>
				<DialogClose asChild>
					<button
						type="button"
						className="settings-dialog-close-button settings-close-button"
						aria-label="Close connect mobile"
					>
						<X className="size-5" aria-hidden="true" />
					</button>
				</DialogClose>
				<div className="flex flex-col px-(--size-settings-mobile-dialog-pad-x) pb-6 pt-8">
					<DialogHeader className="items-center gap-1.5 text-center">
						<DialogTitle className="settings-dialog-title text-center">Connect Mobile</DialogTitle>
						<DialogDescription className="max-w-(--size-settings-mobile-desc) text-center text-control font-normal leading-4 text-settings-muted">
							Pair the Agent Orchestrator mobile app with this desktop over your LAN.
						</DialogDescription>
					</DialogHeader>

					{query.isLoading ? (
						<p className="mt-6 text-center text-xs text-settings-muted">Checking status…</p>
					) : query.isError ? (
						<p className="mt-6 text-center text-xs text-error">
							{query.error instanceof Error ? query.error.message : "Failed to load mobile status."}
						</p>
					) : status ? (
						<div className="mt-6 flex flex-col">
							{/* Toggle row — always visible. Flipping it starts/stops the bridge. */}
							<div className="relative flex items-start justify-between gap-3 rounded-(--radius-settings-dialog-lg) border border-[var(--color-border-settings-input)] bg-[var(--color-bg-settings-input)] px-3.5 py-2.5">
								<div className="flex min-w-0 flex-col gap-1 pr-2">
									<span className="text-subtitle leading-(--leading-settings-mobile-title) text-settings-label">
										Enable mobile
									</span>
									<span className="text-caption leading-(--leading-settings-mobile-hint) text-settings-muted">
										Open a password-protected port on your local network so your phone can connect.
									</span>
								</div>
								<div className="flex shrink-0 items-center gap-2 pt-0.5">
									{busy && <Loader2 className="size-4 animate-spin text-settings-muted" aria-hidden="true" />}
									<Switch
										checked={enabled}
										onCheckedChange={onToggle}
										disabled={busy}
										aria-label="Enable mobile"
										className={cn(
											"h-(--size-settings-mobile-switch-h) w-(--size-settings-mobile-switch-w) transition-colors duration-300 ease-out",
											"data-[state=checked]:bg-settings-switch-on data-[state=unchecked]:bg-[var(--color-border-settings-input)]",
											"focus-visible:ring-0 focus-visible:ring-offset-0",
											"**:data-[slot=switch-thumb]:size-5 **:data-[slot=switch-thumb]:bg-white **:data-[slot=switch-thumb]:transition-transform **:data-[slot=switch-thumb]:duration-300 **:data-[slot=switch-thumb]:ease-out",
											"data-[state=checked]:**:data-[slot=switch-thumb]:translate-x-(--size-settings-mobile-switch-travel)",
											"data-[state=unchecked]:**:data-[slot=switch-thumb]:translate-x-0.5",
										)}
									/>
								</div>
							</div>

							{actionError && <p className="mt-3 text-xs text-error">{actionError}</p>}

							{/* Pairing details — expand/collapse with the enable toggle. */}
							<div
								className={cn(
									"grid transition-[grid-template-rows] duration-300 ease-out",
									enabled ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
								)}
								aria-hidden={!enabled}
							>
								<div className="overflow-hidden">
									<div
										className={cn(
											"mt-6 flex flex-col items-center transition-opacity duration-300 ease-out",
											enabled ? "opacity-100" : "opacity-0",
										)}
									>
										<div className="flex w-(--size-settings-mobile-qr) flex-col items-center">
											<div className="rounded-(--radius-settings-dialog-lg) bg-white p-2 shadow-[var(--shadow-settings-qr)]">
												<QRCodeSVG
													value={pairingPayload(status.host, status.port, status.password)}
													size={QR_CODE_SIZE}
													className="block size-(--size-settings-mobile-qr-code)"
												/>
											</div>
											<p className="mt-4 text-sm leading-5 text-settings-muted">Scan to pair</p>
										</div>

										{status.warning && (
											<p className="mt-6 flex w-full max-w-(--size-settings-mobile-warning) items-start gap-2 text-caption leading-(--leading-settings-mobile-warning) text-warning">
												<Info className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
												<span>{status.warning}</span>
											</p>
										)}

										<div className="mt-6 flex w-full flex-col gap-1 px-(--size-settings-mobile-details-pad-x)">
											<div className="flex items-center gap-6 text-sm leading-5">
												<span className="w-(--size-settings-mobile-label) shrink-0 text-settings-muted">Address</span>
												<span className="tracking-settings-mono text-settings-label">
													{status.host}:{status.port}
												</span>
											</div>
											<div className="flex items-center gap-6 text-sm leading-5">
												<span className="w-(--size-settings-mobile-label) shrink-0 text-settings-muted">Password</span>
												<div className="flex min-w-0 items-center gap-2">
													<span className="tracking-settings-mono text-settings-label">{status.password}</span>
													<button
														type="button"
														aria-label={copied ? "Password copied" : "Copy password"}
														tabIndex={enabled ? 0 : -1}
														className="inline-flex size-6 shrink-0 items-center justify-center text-settings-muted transition-colors hover:text-settings-label"
														onClick={() => void copyPassword()}
													>
														{copied ? (
															<Check className="size-4" aria-hidden="true" />
														) : (
															<Copy className="size-4" aria-hidden="true" />
														)}
													</button>
												</div>
											</div>
										</div>

										<button
											type="button"
											onClick={() => {
												clearActionErrors();
												regenerate.mutate();
											}}
											disabled={busy || !enabled}
											tabIndex={enabled ? 0 : -1}
											className="settings-footer-button mt-5 w-(--size-settings-mobile-regen-width) border-[var(--color-border-settings-input)] bg-[var(--color-bg-settings-input)] text-settings-label transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
										>
											{regenerate.isPending && <Loader2 className="mr-2 size-4 animate-spin" aria-hidden="true" />}
											Regenerate password
										</button>
									</div>
								</div>
							</div>
						</div>
					) : null}
				</div>
			</DialogContent>
		</Dialog>
	);
}
